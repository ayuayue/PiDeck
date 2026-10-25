import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import type { ChatMessage, ImageContent } from "../../shared/types";
import { IMAGE_BLOB_REF_RE, ImageBlobStore, imageBlobMimeType } from "./ImageBlobStore";

/**
 * "Image session" 独立存储：生图记录不依赖 pi 会话文件。
 *
 * 为什么：生图直连供应商 API、不启动 pi agent，纯生图 draft 会话没有 pi 会话文件，
 * persistImageGen 的 filePath 落盘分支会跳过 → 生图历史重启即失（2026-08 用户反馈）。
 * 本存储把 user（含参考图）+ assistant（结果图）消息按渲染层 ChatMessage 结构
 * 逐行写进 userData/imagegen/sessions/<sessionId>.jsonl，重启后由会话读取回退恢复。
 *
 * ── 体积治理（2026-09 OOM 事故后重做）──
 * 旧实现把每张图的完整 base64 内联进 JSONL：单张 2560×1440 PNG 达 6 MB，
 * 28 轮（56 行）即 246 MB。`MAX_MESSAGES=2000` 只限行数不限字节，`append()` 每轮
 * 全量读 + 全量重写，`readMessages()` 把整段历史（含全部 base64）一次性回传渲染层
 * → 渲染进程 OOM（`reason:"oom"`）→ 自动重载死循环 → 恢复额度耗尽后白屏。
 * 现在的三条硬约束：
 *
 * 1. **base64 不进 JSONL**：图片落盘到 ImageBlobStore（内容寻址去重），
 *    消息里只留 `{type:"image", ref, mimeType}`，单行从 MB 级降到百字节级；
 * 2. **写入不做全量重写**：`append()` 走 `appendFile` 只追加；只有超过字节上限时
 *    才压缩重写一次（把最旧的行丢掉），不再每轮读写整个文件；
 * 3. **读取有字节上界**：`readMessages()` 只读文件尾部预算内的字节，主进程
 *    永远不会把整个文件 materialize 成字符串，渲染层拿到的图片数据量因此有上限。
 *
 * 附带的自愈：首次读写旧版（内联 base64）文件时按行流式改写为引用格式——
 * 迁移过程一次只持有一行（最大 10 MB 量级），不 materialize 整个大文件。
 *
 * 设计边界：
 * - 会话有 pi 文件时生图仍写 pi 文件（单一真相）；本存储仅兜底无文件的草稿/孤儿；
 * - sessionId 白名单（UUID）防路径注入；
 * - 写失败静默（best-effort：生图结果已在响应里，历史记录尽力而为）。
 */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 单会话生图历史行数上限（每轮 2 行：user + assistant）。 */
const MAX_MESSAGES = 2000;
/**
 * 单会话 JSONL 字节上限：引用格式下每行约百字节（2000 行 ≈ 400 KB），
 * 4 MB 是给「未迁移 / 异常内容」留的兜底水位，超限即压缩掉最旧的行。
 */
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
/** 单次读取的字节预算（尾部窗口），同时决定回传渲染层的最大图片数据量。 */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** 旧格式头部探测窗口：内联 base64 图片只要出现在前 256 KB 即可判定为旧格式。 */
const LEGACY_PROBE_BYTES = 256 * 1024;
/**
 * 旧格式特征（任一命中即触发迁移）：
 * 1. 结构化标记——旧代码构造图片对象用 `{type,data,mimeType}` 字面量，键序固定；
 * 2. 长 base64 字面量——兜住键序不同的写法，也是「体积异常」的直接证据。
 * 引用格式永远写 `"type":"image","ref":`，两条都不会误命中。
 */
const LEGACY_INLINE_IMAGE_MARKERS: readonly RegExp[] = [/"type":"image","data":/, /"data":"[A-Za-z0-9+/]{256,}/];

function looksLikeLegacyInlineImages(head: string): boolean {
	return LEGACY_INLINE_IMAGE_MARKERS.some((marker) => marker.test(head));
}
/** 引用提取：与 IMAGE_BLOB_REF_RE 同源，用于孤儿 blob 回收。 */
const BLOB_REF_RE_G = /"ref":"([0-9a-f]{64}\.[a-z]+)"/g;

function isMessageShape(value: unknown): value is ChatMessage {
	return value !== null && typeof value === "object" && typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "role") === "string";
}

/** 读文件头部窗口（不存在/不可读返回 null）。 */
async function readHead(file: string, bytes: number): Promise<string | null> {
	let handle;
	try {
		handle = await open(file, "r");
	} catch {
		return null;
	}
	try {
		const info = await handle.stat();
		const length = Math.min(bytes, info.size);
		if (length <= 0) return "";
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, 0);
		return buffer.toString("utf8");
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * 读文件尾部预算内的完整行。
 * 起点若落在行中间，整个半截行丢弃——base64 与多字节字符都可能被切断，
 * 保留下来只会得到半截数据（这也保证了读取内存 ≤ budget）。
 */
async function readTailLines(file: string, budget: number): Promise<string[]> {
	const handle = await open(file, "r");
	try {
		const info = await handle.stat();
		if (info.size <= 0) return [];
		const start = Math.max(0, info.size - budget);
		const length = info.size - start;
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		let text = buffer.toString("utf8");
		if (start > 0) {
			const firstBreak = text.indexOf("\n");
			text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
		}
		return text.split("\n").filter((line) => line.trim().length > 0);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** 原子替换：先写临时文件再 rename，避免压缩过程中崩在半个文件上。 */
async function writeFileAtomic(file: string, content: string): Promise<void> {
	const tmp = `${file}.compact.tmp`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, file);
}

/**
 * 从尾部往前累积行，直到字节水位为止；返回可写入内容。
 * 引用格式下单行只有百字节级，水位实质由 MAX_MESSAGES 决定；
 * 这里保证的是「写盘后的文件不会超过 MAX_SESSION_BYTES」这一不变式。
 * 单独一行就超水位时仍保留它——把文件清空比超一点点更糟。
 */
function tailPayloadWithinBudget(lines: readonly string[]): string {
	if (lines.length === 0) return "";
	let bytes = 0;
	let start = lines.length;
	while (start > 0) {
		const size = Buffer.byteLength(lines[start - 1], "utf8") + 1;
		if (bytes + size > MAX_SESSION_BYTES) break;
		bytes += size;
		start -= 1;
	}
	if (start === lines.length) start = lines.length - 1;
	return `${lines.slice(start).join("\n")}\n`;
}

/** 流式收集一个会话文件里出现的所有 blob 引用（有界内存）。 */
async function collectBlobRefs(file: string, out: Set<string>): Promise<void> {
	const reader = createInterface({
		input: createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of reader) {
			for (const match of line.matchAll(BLOB_REF_RE_G)) out.add(match[1]);
		}
	} finally {
		reader.close();
	}
}

export class ImageSessionStore {
	constructor(
		private readonly deps: {
			getStorePath: () => string;
			blobs: ImageBlobStore;
		},
	) {}

	/**
	 * 每会话文件的串行锁（M6）：迁移是「全量流式读 → 快照重写」，必须与
	 * append/其他迁移互斥，否则迁移窗口内落盘的新行会被不含它的快照覆盖，
	 * 且孤儿回收在 1 小时宽限期后把新行引用的 blob 一并删掉。
	 */
	private readonly fileLocks = new Map<string, Promise<unknown>>();

	/**
	 * 按文件串行执行临界段；返回值/异常原样透传给调用方。
	 * 链条吞掉前一段的错误（上一段失败不应卡死后续写入），锁条目在结束后清理，
	 * Map 不随会话数无界增长。
	 */
	private withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
		const run = (this.fileLocks.get(file) ?? Promise.resolve()).catch(() => undefined).then(action);
		this.fileLocks.set(file, run);
		void run
			.finally(() => {
				if (this.fileLocks.get(file) === run) this.fileLocks.delete(file);
			})
			.catch(() => undefined);
		return run;
	}

	/** sessionId 白名单校验后映射到存储文件；非法 id 返回 null（防路径注入）。 */
	private fileFor(sessionId: string): string | null {
		if (!SESSION_ID_RE.test(sessionId)) return null;
		return join(this.deps.getStorePath(), `${sessionId}.jsonl`);
	}

	/** 把待落盘消息里的内联图片换成 blob 引用；图片落盘失败时该条被丢弃（不回退写 base64）。 */
	private async toStoredMessage(message: ChatMessage): Promise<ChatMessage> {
		const images = message.images;
		if (!images || images.length === 0) return message;
		const stored: ImageContent[] = [];
		for (const image of images) {
			if (image.ref && IMAGE_BLOB_REF_RE.test(image.ref)) {
				stored.push({
					type: "image",
					ref: image.ref,
					mimeType: imageBlobMimeType(image.ref),
				});
				continue;
			}
			if (typeof image.data !== "string" || image.data.length === 0) continue;
			const ref = await this.deps.blobs.put(image.data, image.mimeType);
			if (!ref) continue;
			stored.push({ type: "image", ref, mimeType: imageBlobMimeType(ref) });
		}
		return stored.length > 0 ? { ...message, images: stored } : { ...message, images: undefined };
	}

	/** 追加一轮生图记录（user + assistant 两条）。白名单外/目录不可写时静默降级。 */
	async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
		const file = this.fileFor(sessionId);
		if (!file || messages.length === 0) return;
		// 迁移是全量流式重写：必须与追加互相串行（M6），
		// 否则迁移窗口内 append 的行会被不含它的快照覆盖，孤儿回收再把图删掉。
		await this.withFileLock(file, async () => {
			try {
				await mkdir(dirname(file), { recursive: true });
				// 旧格式先自愈，避免新行与内联 base64 混在同一个文件里；
				// 迁移失败不阻断新记录落盘（读取侧按行判断格式，混存也能正确处理）
				try {
					await this.migrateLegacyFile(file);
				} catch {
					// best-effort
				}
				const lines: string[] = [];
				for (const message of messages) {
					lines.push(JSON.stringify(await this.toStoredMessage(message)));
				}
				// 只追加，不重写：文件大小靠 compactIfOversized 单点收敛
				await appendFile(file, `${lines.join("\n")}\n`, "utf8");
				await this.compactIfOversized(file);
			} catch {
				// best-effort：落盘失败不阻断生图返回（响应已在，历史记录尽力而为）
			}
		});
	}

	/** 读回该会话生图记录（损坏行跳过）；文件缺失/非法 id 返回空数组。 */
	async readMessages(sessionId: string): Promise<ChatMessage[]> {
		const file = this.fileFor(sessionId);
		if (!file) return [];
		// 首读即自愈：旧版巨型内联 base64 文件在这里被改写为引用格式；
		// 与 append 共用文件锁（M6）：读触发的迁移同样会覆盖并发 append 的新行
		try {
			await this.withFileLock(file, () => this.migrateLegacyFile(file));
		} catch {
			// 迁移失败不阻断读取：下面的尾部有界读取仍成立
		}
		try {
			const lines = await readTailLines(file, MAX_READ_BYTES);
			const messages: ChatMessage[] = [];
			for (const line of lines) {
				try {
					const parsed: unknown = JSON.parse(line);
					if (isMessageShape(parsed)) messages.push(parsed);
				} catch {
					// 单行损坏不应阻断整段历史
				}
			}
			return messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
		} catch {
			// 文件缺失 = 无 ImageSession 记录
			return [];
		}
	}

	/**
	 * 旧格式（内联 base64）自愈迁移：按行流式改写为引用格式。
	 * 返回是否发生了迁移。文件不存在或无旧格式特征时直接返回 false（只读一个探测窗口）。
	 */
	private async migrateLegacyFile(file: string): Promise<boolean> {
		let size = 0;
		try {
			size = (await stat(file)).size;
		} catch {
			return false;
		}
		if (size <= 0) return false;
		const head = await readHead(file, LEGACY_PROBE_BYTES);
		// 头部窗口没命中、文件也没超过水位 → 不是旧格式（只读一个探测窗口即可判定，代价极低）
		if (!head || (size <= MAX_SESSION_BYTES && !looksLikeLegacyInlineImages(head))) return false;

		const lines: string[] = [];
		const reader = createInterface({
			input: createReadStream(file, { encoding: "utf8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		try {
			// 一次只持有一行（最大 10 MB 量级）；改写后的行只有百字节级，
			// 因此累积输出很小——不会像旧 append 那样把整个 246 MB 文件读进内存。
			for await (const line of reader) {
				const rewritten = await this.rewriteLegacyLine(line);
				if (rewritten) lines.push(rewritten);
			}
		} finally {
			reader.close();
		}
		if (lines.length > MAX_MESSAGES) lines.splice(0, lines.length - MAX_MESSAGES);
		await writeFileAtomic(file, tailPayloadWithinBudget(lines));
		await this.pruneOrphanBlobs();
		return true;
	}

	/** 单行迁移：带内联图片的行改写为引用格式，其余行原样保留（含损坏行）。 */
	private async rewriteLegacyLine(line: string): Promise<string | null> {
		const trimmed = line.trim();
		if (!trimmed) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// 损坏行原样保留：读取侧本来就按「跳过」处理，不在这里替用户丢弃
			return trimmed;
		}
		if (!isMessageShape(parsed)) return trimmed;
		const images = parsed.images;
		const hasInline = images?.some((image) => typeof image?.data === "string" && image.data.length > 0);
		if (!hasInline) return trimmed;
		const stored = await this.toStoredMessage(parsed);
		// 迁移不丢图（M5）：原图数 ≠ 落库后图数说明有图片没能换成 ref
		//（base64 非法 / 超 IMAGE_BLOB_MAX_BYTES / blob 写盘失败），该行原样保留——
		// 与损坏行同策略。迁移的 writeFileAtomic 会覆盖原文件，旧 base64 一旦被
		// 无图行替换就永久丢失；宁可保留旧行也不静默删掉用户唯一的图片副本。
		// 注意计数口径是「原始 images 总数（含已带合法 ref 的图）」：toStoredMessage
		// 对既无 ref 又无 data 的畸形图同样丢弃，按总数比较可一并兜住。
		const before = images?.length ?? 0;
		const after = stored.images?.length ?? 0;
		if (before !== after) return trimmed;
		return JSON.stringify(stored);
	}

	/** 超过字节水位时压缩：保留尾部预算内的行，重写一次文件并回收孤儿图片。 */
	private async compactIfOversized(file: string): Promise<void> {
		let size = 0;
		try {
			size = (await stat(file)).size;
		} catch {
			return;
		}
		if (size <= MAX_SESSION_BYTES) return;
		const lines = await readTailLines(file, MAX_READ_BYTES);
		const kept = lines.length > MAX_MESSAGES ? lines.slice(lines.length - MAX_MESSAGES) : lines;
		// 压缩可能丢掉仍被引用的图片行 → 需要在重写后统一回收孤儿 blob
		await writeFileAtomic(file, tailPayloadWithinBudget(kept));
		await this.pruneOrphanBlobs();
	}

	/**
	 * 回收不再被任何会话引用的 blob。
	 * 扫描失败时整体放弃（fail-closed）：宁可留垃圾文件，也不能因为读不到某个
	 * 会话文件就把它引用的图片删掉。
	 */
	async pruneOrphanBlobs(): Promise<number> {
		const store = this.deps.getStorePath();
		let names: string[];
		try {
			names = (await readdir(store)).filter((name) => name.endsWith(".jsonl"));
		} catch {
			return 0;
		}
		const referenced = new Set<string>();
		for (const name of names) {
			try {
				await collectBlobRefs(join(store, name), referenced);
			} catch {
				return 0;
			}
		}
		return this.deps.blobs.pruneUnreferenced(referenced);
	}
}
