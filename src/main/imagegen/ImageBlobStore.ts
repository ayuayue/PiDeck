import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ImageBlobPayload } from "../../shared/types/imagegen";
/**
 * 生图图片二进制存储：内容寻址（sha256）+ 落盘去重。
 *
 * 为什么：生图历史（ImageSessionStore）过去把每张图的完整 base64 内联进 JSONL，
 * 单张 2560×1440 PNG 可达 6 MB，几十轮即 200 MB+。会话文件一旦被渲染进程加载
 * 就 OOM（`reason:"oom"` → 自动重载死循环 → 白屏）。现在图片走这里落盘为文件，
 * JSONL 只留 `<sha256>.<ext>` 引用：
 *
 * - 同一张图（含被重复引用的参考图）按内容哈希只存一份；
 * - 文件名即内容，天然不可变，渲染层可用长缓存协议加载（见 ImageGenImageProtocol）；
 * - 路径白名单严格限制为「blobs 目录 + 64 位十六进制文件名」，防路径注入。
 *
 * 设计边界：
 * - 只做存取，不做会话归属：引用清理由 ImageSessionStore 的孤儿回收负责；
 * - 写失败（磁盘满等）返回 null，调用方按「这张图没存下」处理，不抛给生图响应链。
 */

/** 允许的引用名：sha256 十六进制 + 已知图片扩展名。 */
export const IMAGE_BLOB_REF_RE = /^[0-9a-f]{64}\.(?:png|jpe?g|webp|gif|bmp|avif)$/;

/** 单张图片解码后的体积上限：超过视为异常输入（正常 2560×1440 PNG 约 6 MB）。 */
export const IMAGE_BLOB_MAX_BYTES = 32 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/avif": "avif",
};

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	avif: "image/avif",
};

/** 引用名的 mime（未知扩展名回退 png，与生图默认输出一致）。 */
export function imageBlobMimeType(ref: string): string {
	const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
	return MIME_BY_EXT[ext] ?? "image/png";
}

/** 去掉 data URL 前缀与空白，返回纯 base64；非法返回 null。 */
function normalizeBase64(raw: string): string | null {
	let text = raw.trim();
	const comma = text.indexOf(",");
	if (comma >= 0 && text.slice(0, comma).startsWith("data:")) text = text.slice(comma + 1);
	text = text.replace(/\s+/g, "");
	if (!text || text.length % 4 !== 0) return null;
	// Node 的 base64 解码器会静默忽略非法字符（可能解出半张图），这里先做字符集校验
	return /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? text : null;
}

/** 魔数嗅探：供应商常把 PNG/JPEG 标成 application/octet-stream，扩展名按真实内容定。 */
function sniffExtension(buffer: Buffer): string | null {
	if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
		return "png";
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
	if (buffer.length >= 6) {
		const head = buffer.toString("ascii", 0, 6);
		if (head === "GIF87a" || head === "GIF89a") return "gif";
	}
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
		return "webp";
	}
	return null;
}

function extensionFor(mimeType: string, buffer: Buffer): string {
	const byMime = EXT_BY_MIME[mimeType.trim().toLowerCase()];
	if (byMime) return byMime;
	return sniffExtension(buffer) ?? "png";
}

export class ImageBlobStore {
	constructor(private readonly deps: { getBlobsPath: () => string }) {}

	/**
	 * 写入一张图片并返回引用名；已存在同内容时直接复用（不重复写盘）。
	 * 输入非法 / 超大 / 写盘失败时返回 null。
	 */
	async put(data: string, mimeType: string): Promise<string | null> {
		const normalized = normalizeBase64(data);
		if (!normalized) return null;
		let buffer: Buffer;
		try {
			buffer = Buffer.from(normalized, "base64");
		} catch {
			return null;
		}
		if (buffer.byteLength === 0 || buffer.byteLength > IMAGE_BLOB_MAX_BYTES) return null;
		const ref = `${createHash("sha256").update(buffer).digest("hex")}.${extensionFor(mimeType, buffer)}`;
		const dir = this.deps.getBlobsPath();
		const file = join(dir, ref);
		try {
			await mkdir(dir, { recursive: true });
			// wx：内容寻址下同名即同内容，命中 EEXIST 说明早已落盘，直接复用
			await writeFile(file, buffer, { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
		}
		return ref;
	}

	/** 引用名 → 绝对路径（白名单校验，越界一律 null）。 */
	resolvePath(ref: string): string | null {
		if (typeof ref !== "string" || !IMAGE_BLOB_REF_RE.test(ref)) return null;
		const root = resolve(this.deps.getBlobsPath());
		const file = resolve(root, ref);
		// 引用名已限制为无分隔符的 64hex+扩展名，这里再做一次目录归属兜底
		if (file !== join(root, ref) || !file.startsWith(root + sep)) return null;
		return file;
	}

	/** 引用名 → base64（按需读取；缺失/非法/超限返回 null）。 */
	async readPayload(ref: string): Promise<ImageBlobPayload | null> {
		const file = this.resolvePath(ref);
		if (!file) return null;
		try {
			// 读取字节上界（AGENTS.md 生图硬约束）：put() 已限 32MB，但 blobs 目录可能被
			// 外部篡改/误放超大合法命名文件，读取前先 stat 拦截，避免整读+base64 膨胀 OOM。
			const info = await stat(file);
			if (info.size > IMAGE_BLOB_MAX_BYTES) return null;
			const buffer = await readFile(file);
			return { data: buffer.toString("base64"), mimeType: imageBlobMimeType(ref) };
		} catch {
			return null;
		}
	}

	/** 引用名列表（孤儿回收用）。 */
	async listRefs(): Promise<string[]> {
		try {
			return (await readdir(this.deps.getBlobsPath())).filter((name) => IMAGE_BLOB_REF_RE.test(name));
		} catch {
			// 目录不存在 = 还没有任何落盘图片
			return [];
		}
	}

	/**
	 * 删除不再被任何会话引用、且已存在超过 graceMs 的 blob。
	 * grace 是必要的：一次 append 里 blob 先落盘、引用后写进 JSONL，
	 * 没有宽限期会把刚写好的图误删。
	 */
	async pruneUnreferenced(referenced: ReadonlySet<string>, graceMs = 60 * 60 * 1000): Promise<number> {
		const refs = await this.listRefs();
		const now = Date.now();
		let removed = 0;
		for (const ref of refs) {
			if (referenced.has(ref)) continue;
			const file = this.resolvePath(ref);
			if (!file) continue;
			try {
				const info = await stat(file);
				if (now - info.mtimeMs < graceMs) continue;
				await unlink(file);
				removed += 1;
			} catch {
				// 已被并发删除 / 不可删：跳过，不影响其他文件
			}
		}
		return removed;
	}

	/** 确保目录存在（装配期预热，避免首次写入时才 mkdir）。 */
	async ensureDir(): Promise<void> {
		try {
			await mkdir(this.deps.getBlobsPath(), { recursive: true });
		} catch {
			// 目录创建失败时由 put() 的写盘失败兜底
		}
	}
}
