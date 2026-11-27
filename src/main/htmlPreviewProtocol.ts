/**
 * `pideck-html://` 协议：给文件预览与内置浏览器提供独立 CSP 的 HTML 文档。
 *
 * 背景见 #377：`iframe srcDoc` 会继承渲染层主窗口的 CSP，导致用户单文件 HTML 里的
 * 内联脚本被拦截、由 JS 绘制的元素消失。编辑器 iframe 使用编码内容，浏览器使用主进程快照。
 * 两者均使用独立 CSP 与 sandbox。
 *
 * 只有在 app ready 前声明过 scheme 特权（见 index.ts 的 registerSchemesAsPrivileged）
 * 时，这个 handler 才可能被渲染层引用。
 */
import { protocol, type Protocol } from "electron";
import { decodeHtmlPreviewUrl, HTML_PREVIEW_CSP, HTML_PREVIEW_SCHEME } from "../shared/htmlPreview";
import { readBrowserHtmlSnapshot } from "./browser/browserHtmlSnapshots";

// 浏览器预览是顶层文档，用响应头代替编辑器 iframe 的 sandbox 属性。
const BROWSER_PREVIEW_CSP = `${HTML_PREVIEW_CSP}; sandbox allow-scripts`;

export function registerHtmlPreviewProtocol(target: Protocol = protocol, surface: "editor" | "browser" = "editor"): void {
	const browser = surface === "browser";
	target.handle(HTML_PREVIEW_SCHEME, async (request) => {
		// 只有 GET：预览是一次性读取，不存在写入或缓存语义
		if (request.method !== "GET") return new Response(null, { status: 405 });
		const html = browser ? readBrowserHtmlSnapshot(request.url) : decodeHtmlPreviewUrl(request.url);
		if (html === null) return new Response("forbidden", { status: 403 });
		return new Response(html, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": browser ? BROWSER_PREVIEW_CSP : HTML_PREVIEW_CSP,
				"Referrer-Policy": "no-referrer",
				// 内容来自用户文件，禁止 MIME 嗅探；不缓存，避免同一 URL 复用旧内容
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
			},
		});
	});
}
