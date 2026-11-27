/**
 * HTML 预览的 URL 编解码与 CSP 策略。
 *
 * 为什么不用 `iframe srcDoc`：srcdoc 文档会继承渲染层主窗口的 CSP
 * （`script-src 'self' 'unsafe-eval' blob: 'sha256-...'`，没有 `'unsafe-inline'`），
 * 用户单文件 HTML 里的内联 `<script>` 被整段拦掉，由 JS 动态绘制的元素直接消失。
 *
 * 改走自定义协议 `pideck-html:` 后，文档的 CSP 来自主进程返回的响应头，与主窗口
 * 彻底解耦；内容用 base64url 承载在路径里，不需要额外 IPC 通道和跨进程状态清理。
 *
 * 安全边界：iframe 仍带 `sandbox="allow-scripts allow-forms"`（无 allow-same-origin），
 * 预览文档是独立 opaque origin，拿不到父窗口与 Electron API；协议 CSP 只放开
 * 内联脚本/样式与本地图片，网络访问一律禁止。
 *
 * 文档里的外链因此点不开（无 allow-popups、frame-src 也不含 https）。解法不是放宽沙箱，
 * 而是注入 {@link withPreviewLinkBridge} 的桥接脚本：文档内 capture 阶段拦下绝对 http(s)
 * 链接，postMessage 给宿主，宿主核对来源后复用 markdown 正文那条 openExternal 出口。
 */

export const HTML_PREVIEW_SCHEME = "pideck-html";
export const HTML_PREVIEW_HOST = "preview";
const BROWSER_HTML_PREVIEW_PREFIX = `${HTML_PREVIEW_SCHEME}://browser/`;
export const MAX_BROWSER_HTML_PREVIEW_BYTES = 16 * 1024 * 1024;

/** 单次预览的内容字符上限（粗筛，避免对超大内容做无谓编码）。 */
export const MAX_HTML_PREVIEW_CHARS = 1_500_000;

/**
 * 编码后 URL 的长度上限。
 *
 * 为什么不能只按 {@link MAX_HTML_PREVIEW_CHARS} 判（评审实测）：content.length 是 UTF-16 码元数，
 * 而 URL 承载的是 base64(UTF-8)——一个汉字 3 字节、emoji 4 字节，编码后分别膨胀到 4 / 5.33 个
 * URL 字符。Chromium 的 URL 上限约 2MB（url::kMaxURLChars），超限时导航根本不会发起，iframe
 * 直接白屏且不会走 srcDoc 回退：实测 60 万汉字（content.length 仍在限内）→ 2.4MB URL → 白屏。
 * 因此以「编码后长度」为准，1.5MB 给 Chromium 上限留足余量。
 */
export const MAX_HTML_PREVIEW_URL_CHARS = 1_500_000;

/**
 * 预览文档的 CSP。
 *
 * - `script-src 'unsafe-inline' 'unsafe-eval'`：单文件 HTML 的交互/绘图依赖内联脚本，
 *   这正是本修复要放开的；风险由 iframe sandbox（独立 origin、无 same-origin）兜底。
 * - `connect-src 'none'` / `frame-src 'none'`：预览不应成为网络客户端或再嵌套页面。
 * - 图片允许 data:/blob: 与项目已有的本地图片协议，对齐源文件引用本地图片的常见写法。
 */
export const HTML_PREVIEW_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
	"style-src 'unsafe-inline' data:",
	"img-src data: blob: pideck-file: pideck-img:",
	"font-src data:",
	"media-src data: blob: pideck-sound:",
	"connect-src 'none'",
	"frame-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

/**
 * 预览文档 → 宿主唯一的一条消息类型：只承载「在宿主里打开这个链接」。
 * 不要扩成通用桥（不认命令、不认文件路径、不认 IPC 名），新用途先改 docs/host-boundaries.md。
 */
export const HTML_PREVIEW_OPEN_MESSAGE = "pideck-preview:open-external";

/** 单条打开请求的 URL 上限（远超正常链接长度，仅用于挡住畸形/超大载荷）。 */
export const MAX_HTML_PREVIEW_OPEN_URL_CHARS = 4096;

/**
 * 注入预览文档的链接桥：capture 阶段拦下绝对 http(s) 链接，postMessage 给宿主。
 *
 * - 只拦绝对 http(s)：`#anchor` 与相对路径交给文档自己（相对路径在预览里跨文件导航本来就被 CSP 挡住）。
 * - `preventDefault` 是必要的：否则未带 target 的链接会尝试 iframe 自身导航，被 frame-src 拒绝后毫无反馈。
 * - 不 stopPropagation：页面自己的点击处理（埋点、高亮选中项）保持原样。
 */
const PREVIEW_LINK_BRIDGE_SCRIPT = `(function () {
	if (window.__pideckPreviewLinkBridge) return;
	window.__pideckPreviewLinkBridge = true;
	document.addEventListener("click", function (event) {
		if (event.defaultPrevented || (typeof event.button === "number" && event.button !== 0)) return;
		var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
		if (!anchor) return;
		var href = anchor.getAttribute("href") || "";
		if (!/^https?:\\/\\//i.test(href)) return;
		event.preventDefault();
		try {
			parent.postMessage({ type: "${HTML_PREVIEW_OPEN_MESSAGE}", url: href, forceSystem: !!(event.ctrlKey || event.metaKey) }, "*");
		} catch (error) {}
	}, true);
})();`;

const PREVIEW_LINK_BRIDGE_ATTR = "data-pideck-preview-bridge";

/**
 * 给预览 HTML 注入链接桥（幂等：文档里已带同名标记就不再注入，避免一次点击发两条消息）。
 * 注入点在 `</body>` 之前，脚本解析期即注册监听，用户首次点击前一定已就位。
 */
export function withPreviewLinkBridge(html: string): string {
	if (html.includes(PREVIEW_LINK_BRIDGE_ATTR)) return html;
	const tag = `<script ${PREVIEW_LINK_BRIDGE_ATTR}>${PREVIEW_LINK_BRIDGE_SCRIPT}</script>`;
	const bodyClose = html.toLowerCase().lastIndexOf("</body>");
	if (bodyClose < 0) return html + tag;
	return html.slice(0, bodyClose) + tag + html.slice(bodyClose);
}

/**
 * 校验宿主收到的预览消息。opaque origin 下 `event.origin` 恒为 `"null"`，来源身份由调用方
 * 比对 `event.source === iframe.contentWindow`，这里只负责形状与协议白名单。
 */
export function readHtmlPreviewOpenRequest(data: unknown): { url: string; forceSystem: boolean } | null {
	if (!data || typeof data !== "object") return null;
	const message = data as { type?: unknown; url?: unknown; forceSystem?: unknown };
	if (message.type !== HTML_PREVIEW_OPEN_MESSAGE) return null;
	if (typeof message.url !== "string") return null;
	if (message.url.length === 0 || message.url.length > MAX_HTML_PREVIEW_OPEN_URL_CHARS) return null;
	// 宿主只认 http(s)：javascript:/data:/file: 一律不交给主进程
	if (!/^https?:\/\//i.test(message.url)) return null;
	return { url: message.url, forceSystem: message.forceSystem === true };
}

/** UTF-8 字符串 → base64url（不依赖 Buffer，主进程与渲染层共用）。 */
function toBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	// 分块转换：String.fromCharCode(...bigArray) 会因参数过多爆栈
	const CHUNK_SIZE = 0x8000;
	for (let index = 0; index < bytes.length; index += CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK_SIZE));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → UTF-8 字符串。 */
function fromBase64Url(value: string): string {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return new TextDecoder().decode(bytes);
}

/** 编码前后分别限制大小，避免生成 Chromium 无法导航的 URL。 */
function encodePreviewPayload(content: string): string | null {
	if (!content || content.length > MAX_HTML_PREVIEW_CHARS) return null;
	const encoded = toBase64Url(content);
	return encoded.length <= MAX_HTML_PREVIEW_URL_CHARS ? encoded : null;
}

/** 生成编辑器 iframe 的预览地址。内容超限时由调用方降级。 */
export function encodeHtmlPreviewUrl(content: string): string | null {
	const payload = encodePreviewPayload(content);
	return payload ? `${HTML_PREVIEW_SCHEME}://${HTML_PREVIEW_HOST}/${payload}` : null;
}

/** 主进程签发的浏览器快照地址。文件名仅用于显示。 */
export function browserHtmlPreviewUrl(fileName: string, token: string): string | null {
	try {
		const url = `${BROWSER_HTML_PREVIEW_PREFIX}${encodeURIComponent(fileName)}/${token}`;
		return browserHtmlPreviewFileName(url) ? url : null;
	} catch {
		return null;
	}
}

/** 校验浏览器快照路由并提取文件名。锚点由文档处理。 */
export function browserHtmlPreviewFileName(url: string): string | null {
	if (!url.startsWith(BROWSER_HTML_PREVIEW_PREFIX)) return null;
	const match = /^([^/?#]{1,3072})\/([a-f0-9-]{36})$/.exec(url.slice(BROWSER_HTML_PREVIEW_PREFIX.length).split("#", 1)[0]);
	if (!match) return null;
	try {
		const fileName = decodeURIComponent(match[1]);
		return /^[^/\\\u0000-\u001f\u007f]*\.html?$/i.test(fileName) ? fileName : null;
	} catch {
		return null;
	}
}

/** 从 `pideck-html://` URL 还原 HTML 内容；格式不符或解码失败返回 null。 */
export function decodeHtmlPreviewUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== `${HTML_PREVIEW_SCHEME}:` || parsed.hostname !== HTML_PREVIEW_HOST) return null;
		const encoded = parsed.pathname.replace(/^\/+/, "");
		if (!encoded) return null;
		return fromBase64Url(encoded);
	} catch {
		return null;
	}
}
