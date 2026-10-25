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
 */

export const HTML_PREVIEW_SCHEME = "pideck-html";
export const HTML_PREVIEW_HOST = "preview";

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

/**
 * 把 HTML 内容编码成 `pideck-html://preview/<base64url>`。
 *
 * 超过 {@link MAX_HTML_PREVIEW_CHARS}、或编码后长度超过 {@link MAX_HTML_PREVIEW_URL_CHARS}
 * 时返回 null，由调用方决定降级方式（预览大文件不值得为了跑脚本把整份内容塞进 URL）。
 */
export function encodeHtmlPreviewUrl(content: string): string | null {
	if (!content || content.length > MAX_HTML_PREVIEW_CHARS) return null;
	const encoded = toBase64Url(content);
	// 编码后仍超上限：宁可退回 srcDoc（至少能看到静态内容），也不给一个导航不起来的 URL
	if (encoded.length > MAX_HTML_PREVIEW_URL_CHARS) return null;
	return `${HTML_PREVIEW_SCHEME}://${HTML_PREVIEW_HOST}/${encoded}`;
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
