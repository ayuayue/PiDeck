/**
 * `pideck-html://` 协议：给文件预览的 `<iframe>` 提供独立 CSP 的 HTML 文档。
 *
 * 背景见 #377：`iframe srcDoc` 会继承渲染层主窗口的 CSP，导致用户单文件 HTML 里的
 * 内联脚本被拦截、由 JS 绘制的元素消失。本协议把内容编码在 URL 里，由主进程返回，
 * CSP 走响应头 —— 文档策略与主窗口解耦，同时保持 iframe sandbox 的隔离。
 *
 * 只有在 app ready 前声明过 scheme 特权（见 index.ts 的 registerSchemesAsPrivileged）
 * 时，这个 handler 才可能被渲染层引用。
 */
import { protocol } from "electron";
import { decodeHtmlPreviewUrl, HTML_PREVIEW_CSP, HTML_PREVIEW_SCHEME } from "../shared/htmlPreview";

export function registerHtmlPreviewProtocol(): void {
	protocol.handle(HTML_PREVIEW_SCHEME, async (request) => {
		// 只有 GET：预览是一次性读取，不存在写入或缓存语义
		if (request.method !== "GET") return new Response(null, { status: 405 });
		const html = decodeHtmlPreviewUrl(request.url);
		if (html === null) return new Response("forbidden", { status: 403 });
		return new Response(html, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": HTML_PREVIEW_CSP,
				// 内容来自用户文件，禁止 MIME 嗅探；不缓存，避免同一 URL 复用旧内容
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
			},
		});
	});
}
