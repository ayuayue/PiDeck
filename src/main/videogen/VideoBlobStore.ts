import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * 生视频产物存储：内容寻址（sha256）+ 流式落盘。
 *
 * 与生图 ImageBlobStore 的关键差别：视频从上游下载开始就是流，绝不整体进内存
 * 再 base64（一段 1080P/10s 的 mp4 轻松过 20MB，整体缓冲既撑主进程内存又放大
 * IPC 体积）。流程：响应流 → 临时文件 → 完整后 sha256 命名 rename → ref。
 *
 * - 下载中途超限/失败：删临时文件，调用方按 downloadFailed 处理；
 * - 同内容（重跑同任务）命中已有文件直接复用；
 * - 读取路径（协议处理器）按 Range 切片流式吐给 Chromium，主进程仍不整读。
 */

/** 允许的引用名：sha256 十六进制 + 视频扩展名。 */
export const VIDEO_BLOB_REF_RE = /^[0-9a-f]{64}\.(?:mp4|webm|mov)$/;

/** 单个视频文件体积上限：512MB（1080P/30s 量级以内都放得下）。 */
export const VIDEO_BLOB_MAX_BYTES = 512 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
};

/** 引用名的 mime（未知扩展名回退 mp4，与主流产物一致）。 */
export function videoBlobMimeType(ref: string): string {
	const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
	return MIME_BY_EXT[ext] ?? "video/mp4";
}

/** 按 Content-Type 推扩展名（上游常给 application/octet-stream，回退 mp4）。 */
function extensionForMime(mimeType: string | null): string {
	const normalized = (mimeType ?? "").split(";")[0].trim().toLowerCase();
	switch (normalized) {
		case "video/webm":
			return "webm";
		case "video/quicktime":
			return "mov";
		default:
			return "mp4";
	}
}

export class VideoBlobStore {
	constructor(private readonly deps: { getBlobsPath: () => string }) {}

	/**
	 * 把下载响应流式落盘并返回引用名。
	 * 超过 VIDEO_BLOB_MAX_BYTES 中止并清理；写盘失败返回 null（调用方映射 downloadFailed）。
	 */
	async putFromResponse(response: { body?: ReadableStream<Uint8Array> | null; headers?: { get(name: string): string | null } }): Promise<string | null> {
		const body = response.body;
		if (!body || typeof body.getReader !== "function") return null;
		const dir = this.deps.getBlobsPath();
		const tmpFile = join(dir, `.incoming-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
		try {
			await mkdir(dir, { recursive: true });
			// 边写边哈希：内容寻址不需要先落盘再读一遍
			const hash = createHash("sha256");
			let total = 0;
			const reader = body.getReader();
			const handle = await open(tmpFile, "w");
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value || typeof value.byteLength !== "number" || value.byteLength === 0) continue;
					total += value.byteLength;
					if (total > VIDEO_BLOB_MAX_BYTES) {
						throw new Error("video exceeds size cap");
					}
					hash.update(value);
					await handle.write(value);
				}
			} finally {
				await handle.close().catch(() => undefined);
			}
			if (total === 0) return null;
			try {
				await reader.cancel();
			} catch {
				// 已读完的流 cancel 报错可忽略
			}
			const ext = extensionForMime(response.headers?.get("content-type") ?? null);
			const ref = `${hash.digest("hex")}.${ext}`;
			const finalFile = join(dir, ref);
			try {
				await rename(tmpFile, finalFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
				// 目标已存在（同名内容）：临时文件清掉，复用现有文件
				await unlink(tmpFile).catch(() => undefined);
			}
			return ref;
		} catch {
			await unlink(tmpFile).catch(() => undefined);
			return null;
		}
	}

	/** 引用名 → 绝对路径（白名单校验，越界一律 null）。 */
	resolvePath(ref: string): string | null {
		if (typeof ref !== "string" || !VIDEO_BLOB_REF_RE.test(ref)) return null;
		const root = resolve(this.deps.getBlobsPath());
		const file = resolve(root, ref);
		// 引用名已限制为无分隔符的 64hex+扩展名，这里再做一次目录归属兜底
		if (file !== join(root, ref) || !file.startsWith(root + sep)) return null;
		return file;
	}

	/** 引用名列表（孤儿回收用）。 */
	async listRefs(): Promise<string[]> {
		try {
			return (await readdir(this.deps.getBlobsPath())).filter((name) => VIDEO_BLOB_REF_RE.test(name));
		} catch {
			return [];
		}
	}

	/**
	 * 删除不再被任何会话引用、且已存在超过 graceMs 的 blob（与生图同策略）。
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
				// 已被并发删除 / 不可删：跳过
			}
		}
		return removed;
	}

	/** 确保目录存在（装配期预热）。 */
	async ensureDir(): Promise<void> {
		try {
			await mkdir(this.deps.getBlobsPath(), { recursive: true });
		} catch {
			// 目录创建失败时由 putFromResponse 的写盘失败兜底
		}
	}
}
