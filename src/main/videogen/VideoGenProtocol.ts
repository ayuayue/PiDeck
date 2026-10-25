import { protocol } from "electron";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { VIDEO_BLOB_PROTOCOL } from "../../shared/videoContentSrc";
import { videoBlobMimeType, type VideoBlobStore } from "./VideoBlobStore";

/** 展示路径的读取字节上界：与 VideoBlobStore.VIDEO_BLOB_MAX_BYTES 对齐。 */
const VIDEO_PROTOCOL_MAX_BYTES = 512 * 1024 * 1024;

/**
 * pideck-video:// 协议：把落盘的生视频产物交给渲染层 `<video>` 直接加载。
 *
 * 为什么需要它：视频文件 MB 级起步，走 IPC/base64 回传渲染层等于把整个文件搬进
 * 两个进程的堆。交给协议后 Chromium 自己按需拉取与缓冲，渲染层只持 URL 字符串。
 *
 * 与 pideck-img 的差别：`<video>` 元素依赖 Range 请求实现进度条拖拽/seek，
 * 协议层必须返回 206 Partial Content——只回 200 的话视频能播但不能seek。
 * Range 解析只支持单区间（bytes=start-end），多区间/后缀区间回退整文件 200。
 *
 * 只服务 `pideck-video://blob/<sha256>.<ext>`：引用名经 VIDEO_BLOB_REF_RE 白名单
 * 校验且必须落回 blobs 目录内，杜绝 ../ 逃逸与任意文件读取。
 * 内容寻址 ⇒ 长缓存安全。
 */
function parseBlobRef(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "blob") return null;
		const ref = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
		return ref || null;
	} catch {
		return null;
	}
}

/** 解析 Range 头里的单区间（bytes=start-end / bytes=start- / bytes=-suffix）。 */
function parseRangeHeader(header: string | null, size: number): { start: number; end: number } | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, rawStart, rawEnd] = match;
	if (rawStart === "" && rawEnd === "") return null;
	// 后缀区间 bytes=-N：最后 N 字节
	if (rawStart === "") {
		const suffix = Number(rawEnd);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		const start = Math.max(0, size - suffix);
		return { start, end: size - 1 };
	}
	const start = Number(rawStart);
	if (!Number.isFinite(start) || start < 0 || start >= size) return null;
	// 开区间 bytes=N-：到文件尾
	if (rawEnd === "") return { start, end: size - 1 };
	const end = Number(rawEnd);
	if (!Number.isFinite(end) || end < start) return null;
	return { start, end: Math.min(end, size - 1) };
}

export function registerVideoGenProtocol(blobs: VideoBlobStore): void {
	protocol.handle(VIDEO_BLOB_PROTOCOL, async (request) => {
		const ref = parseBlobRef(request.url);
		if (!ref) return new Response("forbidden", { status: 403 });
		const file = blobs.resolvePath(ref);
		if (!file) return new Response("forbidden", { status: 403 });
		let info;
		try {
			info = await stat(file);
		} catch {
			return new Response("not found", { status: 404 });
		}
		if (info.size > VIDEO_PROTOCOL_MAX_BYTES) return new Response("payload too large", { status: 413 });
		const mime = videoBlobMimeType(ref);
		const range = parseRangeHeader(request.headers.get("range"), info.size);
		if (range) {
			// 206：按区间切片流式吐字节（Chromium seek 依赖）
			const stream = createReadStream(file, { start: range.start, end: range.end });
			return new Response(Readable.toWeb(stream) as ReadableStream, {
				status: 206,
				headers: {
					"Content-Type": mime,
					"Content-Length": String(range.end - range.start + 1),
					"Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
					"Accept-Ranges": "bytes",
					"Cache-Control": "public, max-age=31536000, immutable",
				},
			});
		}
		const stream = createReadStream(file);
		return new Response(Readable.toWeb(stream) as ReadableStream, {
			status: 200,
			headers: {
				"Content-Type": mime,
				"Content-Length": String(info.size),
				"Accept-Ranges": "bytes",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	});
}
