import { protocol } from "electron";
import { LOCAL_IMAGE_MAX_BYTES, LOCAL_IMAGE_PROTOCOL, localImageMimeType, parseLocalImageUrl } from "../../shared/localImage";
import { classifyLocalImagePath, isInsideAnyRoot, type LocalImageRejection } from "./localImageAccess";
import { readBoundedImageFile } from "./localImageRead";
import type { CanonicalRootsProvider } from "./localImageRoots";
import { nativeRealpath } from "./nativeRealpath";

/**
 * `pideck-file://` 协议：把白名单目录内的本地图片交给渲染层 `<img>` 直接加载。
 *
 * 为什么不是 `file://`：dev 下渲染层页源是 `http://localhost`，Chromium 拒绝 `file://`
 * 子资源（同一段 Markdown 在 dev 白图、打包版才显示）；此外 `file://` 对渲染层是
 * 「任意本地图片可读」，这里换成一等协议后能把可读范围收窄成白名单。
 *
 * 与生图协议（`pideck-img://`）的分工：生图是**内容寻址的入库对象**（ref 永不变），
 * 这里服务的是**会话/工作区里随时可能被删改的普通文件**，因此 `no-store` 不缓存。
 *
 * 判定全部在 `localImageAccess.ts`（纯函数、可单测）里，本文件只负责 I/O 与响应头。
 * 注意顺序：**先形态、再 realpath、最后边界**——边界必须在真实路径上判（防符号链接逃逸），
 * 而根目录也要先 realpath（Windows 8.3 短名与长名不是同一个字符串，2026-10 实测事故）。
 */

const BASE_HEADERS = {
	// 本地文件随时可能被改写/删除：缓存住旧字节只会让「改了图但界面不变」更难解释
	"Cache-Control": "private, no-store",
	// 扩展名与真实字节可能不一致（改名的文件），禁止浏览器按内容嗅探出别的类型
	"X-Content-Type-Options": "nosniff",
	// 万一是 HTML/SVG 被直接打开，也不允许它执行任何东西
	"Content-Security-Policy": "sandbox; default-src 'none'",
};

function failure(status: LocalImageRejection): Response {
	const text = status === 413 ? "payload too large" : status === 404 ? "not found" : status === 403 ? "forbidden" : "bad request";
	return new Response(text, { status, headers: BASE_HEADERS });
}

/** realpath 包装：失败返回 null（不抛给协议层）。必须用 native 变体，见 nativeRealpath 说明。 */
function safeRealpath(path: string): string | null {
	try {
		return nativeRealpath(path);
	} catch {
		return null;
	}
}

/**
 * 注册协议处理器（必须在 `app.whenReady()` 之后调用；scheme 特权声明在 ready 前完成）。
 * @param resolveRoots 已规范化的白名单根提供者（带 5s 缓存，见 `localImageRoots.ts`）。
 */
export function registerLocalImageProtocol(resolveRoots: CanonicalRootsProvider): void {
	protocol.handle(LOCAL_IMAGE_PROTOCOL, async (request) => {
		if (request.method !== "GET") return failure(403);

		const shape = classifyLocalImagePath(parseLocalImageUrl(request.url));
		if (!shape.ok) return failure(shape.status);

		// realpath 一次解决两件事：短名/符号链接归一，以及逃逸检测（必须用真实路径判边界）
		const realPath = safeRealpath(shape.path);
		if (!realPath) return failure(404);
		const roots = await resolveRoots();
		if (!isInsideAnyRoot(realPath, roots)) return failure(403);

		const mediaType = localImageMimeType(realPath);
		if (!mediaType) return failure(403);

		// 有界读取：stat 与内容读取之间文件可能被换（TOCTOU），定长读 + 长度校验兜住
		const data = await readBoundedImageFile(realPath, LOCAL_IMAGE_MAX_BYTES);
		if (!data) return failure(413);
		return new Response(data, {
			headers: {
				...BASE_HEADERS,
				"Content-Type": mediaType,
				"Content-Length": String(data.byteLength),
			},
		});
	});
}
