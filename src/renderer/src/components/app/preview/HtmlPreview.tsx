import { useEffect, useMemo, useRef } from "react";
import { encodeHtmlPreviewUrl, readHtmlPreviewOpenRequest, withPreviewLinkBridge } from "../../../../../shared/htmlPreview";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";

/**
 * 预览里的外链统一走宿主出口：与 markdown 正文、公告同一条链路（主进程 openExternalUrl
 * 只放行 http/https，forceSystem 落系统浏览器，否则按 linkOpenMode 选内置浏览器）。
 * 必须是模块级稳定引用：内联箭头函数会打破 MarkdownStream 的 memo → 整篇重解析。
 */
export function openPreviewExternal(url: string, forceSystem?: boolean): void {
	void desktopApi.app.openExternal(url, forceSystem).catch(() => undefined);
}

/**
 * HTML previews intentionally use an opaque-origin iframe. This restores the
 * dev preview interaction without giving project HTML the renderer's origin,
 * Electron bridge, popups, or file-system navigation privileges.
 *
 * 链接：沙箱不含 allow-popups、frame-src 也不含 https，文档里的链接点击默认是死路
 * （点击 → iframe 自身导航 → 被 frame-src 拒绝，毫无反馈）。修复方式与 markdown 正文同形：
 * 点击交给宿主处理。区别是宿主拿不到 opaque-origin 文档的 DOM，所以靠注入的桥接脚本
 * 在文档内 capture 阶段拦下绝对 http(s) 链接 → postMessage → 宿主核对 event.source
 * 后调用同一个 onOpenExternal。沙箱权限一条不改。
 */
export function HtmlPreview({ content, onOpenExternal }: { content: string; onOpenExternal: (url: string, forceSystem?: boolean) => void }) {
	// 走 pideck-html: 协议而非 srcDoc：srcdoc 会继承主窗口 CSP，把文件里的内联脚本整段拦掉（#377）。
	// 协议文档的 CSP 由主进程响应头下发，与主窗口策略解耦，内联 <script> 才能正常执行。
	const src = useMemo(() => encodeHtmlPreviewUrl(withPreviewLinkBridge(content)), [content]);
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			// opaque origin 下 event.origin 恒为 "null"，无法按 origin 校验；改比对发起窗口身份：
			// 只接受本预览文档发出的打开请求，其它 iframe / 插件页的消息一律丢弃。
			if (event.source !== frameRef.current?.contentWindow) return;
			const request = readHtmlPreviewOpenRequest(event.data);
			if (!request) return;
			onOpenExternal(request.url, request.forceSystem);
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [onOpenExternal]);
	// 超大文件不为跑脚本把整份内容塞进 URL：退回 srcDoc，至少能看到静态内容
	const source = src ? { src } : { srcDoc: content };
	return <iframe ref={frameRef} className="h-full w-full border-0 bg-[var(--color-bg-panel)]" {...source} title={t("editor.htmlPreview")} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", border: "none" }} />;
}
