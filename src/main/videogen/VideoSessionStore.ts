import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import type { ChatMessage } from "../../shared/types";
import { VIDEO_BLOB_REF_RE, type VideoBlobStore } from "./VideoBlobStore";

/**
 * "Video session" 独立存储：生视频会话历史（与 ImageSessionStore 同构的瘦身版）。
 *
 * 与生图版的差异（新域直接按三条硬约束构造，没有历史包袱）：
 * 1. **视频永远没有 base64 内联形态**：产物由主进程流式落盘，消息里只有 ref，
 *    不需要旧格式迁移/自愈逻辑；
 * 2. **同 id 后写覆盖**：任务占位（queued）与终态（complete/error）是同一条消息
 *    的两个阶段，读取时按 message id 折叠，最后一条生效——占位写一次、终态再写
 *    一次，时间线恢复时只剩终态（或仍在跑的最新状态）；
 * 3. 读取字节上界 + 追加式写入 + 孤儿回收与生图版同口径（OOM 事故的教训直接继承）。
 *
 * 设计边界：
 * - sessionId 白名单（UUID）防路径注入；
 * - 写失败静默（best-effort：任务表 jobs.json 才是任务的真相源）。
 */
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 单会话行数上限（每任务 2 行：user + assistant）。 */
const MAX_MESSAGES = 2000;
/** 单会话 JSONL 字节上限：引用格式单行百字节级，4MB 是异常内容兜底水位。 */
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
/** 单次读取的字节预算（尾部窗口）。 */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** 会话文件里视频引用的提取（孤儿回收用）。 */
const VIDEO_REF_RE_G = /"ref":"([0-9a-f]{64}\.(?:mp4|webm|mov))"/g;

function isMessageShape(value: unknown): value is ChatMessage {
	return value !== null && typeof value === "object" && typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "role") === "string";
}

/** 读文件尾部预算内的完整行（起点落在行中间时丢弃半截行，保证读取内存 ≤ budget）。 */
async function readTailLines(file: string, budget: number): Promise<string[]> {
	let handle;
	try {
		handle = await open(file, "r");
	} catch {
		return [];
	}
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

/** 流式收集一个会话文件里出现的所有视频引用（有界内存）。 */
async function collectVideoRefs(file: string, out: Set<string>): Promise<void> {
	const reader = createInterface({
		input: createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	try {
		for await (const line of reader) {
			for (const match of line.matchAll(VIDEO_REF_RE_G)) out.add(match[1]);
		}
	} finally {
		reader.close();
	}
}

export class VideoSessionStore {
	constructor(
		private readonly deps: {
			getStorePath: () => string;
			blobs: VideoBlobStore;
		},
	) {}

	private fileFor(sessionId: string): string | null {
		if (!SESSION_ID_RE.test(sessionId)) return null;
		return join(this.deps.getStorePath(), `${sessionId}.jsonl`);
	}

	/** 追加消息（只追加不重写；体积靠 compactIfOversized 单点收敛）。 */
	async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
		const file = this.fileFor(sessionId);
		if (!file || messages.length === 0) return;
		try {
			await mkdir(dirname(file), { recursive: true });
			// 消息里的视频只允许 ref 形态（构造性保证，畸形 data 一律丢弃）
			const lines = messages.map((message) => sanitizeMessageVideos(message)).map((message) => JSON.stringify(message));
			await appendFile(file, `${lines.join("\n")}\n`, "utf8");
			await this.compactIfOversized(file);
		} catch {
			// best-effort：任务真相在 jobs.json，历史落盘失败不阻断任务流
		}
	}

	/**
	 * 读回会话消息：按 message id 折叠（后写覆盖），保持首现顺序。
	 * 同 id 的占位/终态两行只留最后一行——时间线恢复即最新状态。
	 */
	async readMessages(sessionId: string): Promise<ChatMessage[]> {
		const file = this.fileFor(sessionId);
		if (!file) return [];
		try {
			const lines = await readTailLines(file, MAX_READ_BYTES);
			const byId = new Map<string, ChatMessage>();
			for (const line of lines) {
				try {
					const parsed: unknown = JSON.parse(line);
					if (!isMessageShape(parsed)) continue;
					byId.set(parsed.id, parsed);
				} catch {
					// 单行损坏不阻断整段历史
				}
			}
			return [...byId.values()].slice(-MAX_MESSAGES);
		} catch {
			return [];
		}
	}

	/** 超过字节水位时压缩：保留尾部预算内的行并回收孤儿视频。 */
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
		const tmp = `${file}.compact.tmp`;
		await writeFile(tmp, `${kept.join("\n")}\n`, "utf8");
		await rename(tmp, file);
		await this.pruneOrphanBlobs();
	}

	/**
	 * 回收不再被任何会话引用的视频 blob（fail-closed：扫描失败整体放弃）。
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
				await collectVideoRefs(join(store, name), referenced);
			} catch {
				return 0;
			}
		}
		return this.deps.blobs.pruneUnreferenced(referenced);
	}
}

/** 消息级视频引用白名单：只保留合法 ref 形态，其余丢弃（不伪造、不落 base64）。 */
function sanitizeMessageVideos(message: ChatMessage): ChatMessage {
	if (!message.videos || message.videos.length === 0) return message;
	const videos = message.videos.filter((video) => typeof video?.ref === "string" && VIDEO_BLOB_REF_RE.test(video.ref));
	return videos.length > 0 ? { ...message, videos } : { ...message, videos: undefined };
}
