import { extractFileLinkLocation, resolveFileLinkPath } from "../../utils/filePathLinks";

/**
 * Markdown 图片目标的解析（纯函数，零 React 依赖，可直接被 node:test 导入）。
 *
 * 背景（2026-10，对话内图片渲染改造）：模型给用户看图最自然的方式就是写
 * `![](path)`，但作者会写出四种路径写法——`file:///C:/…`、`C:\…`、`./chart.png`、
 * 带空格的畸形写法。`markdownUrlTransform` 只放行 `file://` 与 http(s)，盘符路径被
 * 原样塞进 `<img src>`（`C:` 被 Chromium 当 scheme）→ 静默白块。
 *
 * 这里的职责只有一件：把「作者写的目标」收敛成「能交给 <img> 的 URL」或
 * `undefined`（调用方据此降级成 alt 文本，绝不产出空 src 的白图）。
 *
 * 路径判定复用 `utils/filePathLinks`（与文件链接、存在性校验同一口径：百分号解码、
 * `/C:/…` 前导斜杠、`path:line` 位置标记），避免两套解析规则漂移。
 */

/** 远程图片：原样交给浏览器与 CSP 决定（CSP 的 img-src 才是唯一白名单）。 */
const REMOTE_IMAGE_URL = /^https?:\/\//i;
/** 已是 PiDeck 自定义图片协议的 URL：协议侧自己校验白名单，这里不重复解析。 */
const PASSTHROUGH_IMAGE_URL = /^pideck-(?:img|file):/i;
const FILE_URL = /^file:\/\//i;
/** 任意 scheme（data:/blob:/javascript:/vbscript: …）：除 file:// 外一律不渲染。 */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** UNC 路径（`\\server\share`）：既无白名单覆盖也无浏览器支持，直接降级。 */
const UNC_PATH = /^[\\/]{2}[^\\/]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type MarkdownImageSrcContext = {
	/** 会话执行目录（runtime cwd，缺失时回退项目根）：相对路径的唯一基准。 */
	baseDir?: string;
	/**
	 * 绝对路径 → 可加载 URL。当前注入的是 `shared/localImage.ts` 的 `localImageUrl`
	 * （`pideck-file://` 协议，能否读取由主进程白名单把关）。
	 */
	toLocalUrl: (absolutePath: string) => string;
};

/** 百分号解码；编码不完整时保留原文（宁可当未知目标降级，也不猜）。 */
function decodePercentEscapes(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** 剥掉 `file://` 与请求后缀；非本地可解析的目标返回 undefined。 */
function localPathFromDestination(raw: string): string | undefined {
	// mdast-util-to-hast 会把路径里的反斜杠编码成 %5C（`C:\Users\a` → `C:%5CUsers%5Ca`），
	// 所以必须先解码再判形态：否则 `C:` 后面跟着 `%`，盘符前缀匹配不上，紧接着被
	// 「带 scheme」分支当未知协议丢弃 → 渲染成 alt，图静默消失（2026-10-19 真机复现）。
	// 远程 URL 已在调用方直接返回，不经过这里，不会被二次解码。
	const decoded = decodePercentEscapes(raw);
	// 盘符必须先于「带 scheme」判定：`C:` 形态上就是一个 scheme（与 defaultUrlTransform 同一坑）
	if (/^[a-zA-Z]:[\\/]/.test(decoded)) return decoded;
	if (FILE_URL.test(decoded)) {
		const rest = decoded.replace(FILE_URL, "");
		// file://localhost/C:/x 与 file:///C:/x 同义；file://C:/x 是模型常写的畸形形态
		const hostless = rest.replace(/^localhost(?=\/)/i, "");
		if (/^[a-zA-Z]:[\\/]/.test(hostless)) return hostless;
		// 其余不以 / 开头的 = 主机名（UNC / 远程共享），不走本地取图
		return hostless.startsWith("/") ? hostless : undefined;
	}
	return ANY_SCHEME.test(decoded) ? undefined : decoded;
}

/**
 * 解析一条 Markdown 图片目标。
 * @param destination 作者写的目标（已由 markdownUrlTransform 处理过一遍）。
 * @param context 会话路径上下文与本地 URL 构造器。
 * @returns 可交给 `<img src>` 的 URL；任何不确定的情况返回 undefined（调用方降级为 alt）。
 */
export function resolveMarkdownImageSrc(destination: string, context: MarkdownImageSrcContext): string | undefined {
	const raw = destination.trim();
	if (raw === "" || CONTROL_CHARS.test(raw)) return undefined;
	if (REMOTE_IMAGE_URL.test(raw)) return raw;
	if (PASSTHROUGH_IMAGE_URL.test(raw)) return raw;

	const authored = localPathFromDestination(raw);
	if (authored === undefined) return undefined;

	// `?v=2` / `#frag` 是缓存后缀，不参与路径解析（解码前先剥，避免把 %3F 误当后缀）
	const withoutSuffix = authored.replace(/[?#].*$/, "").trim();
	if (withoutSuffix === "" || withoutSuffix.startsWith("#") || withoutSuffix.startsWith("?")) return undefined;
	// ~ 家目录需要宿主目录信息，渲染层拿不到；UNC 无白名单覆盖
	if (withoutSuffix.startsWith("~") || UNC_PATH.test(withoutSuffix)) return undefined;

	// extractFileLinkLocation：解码百分号转义、剥 `/C:/` 前导斜杠、剥 `path:line` 位置标记
	const { path } = extractFileLinkLocation(withoutSuffix);
	const candidate = path.trim();
	if (candidate === "") return undefined;

	// 绝对路径做词法规范化，相对路径按会话 cwd 拼接（无基准 → 不猜）
	const absolute = resolveFileLinkPath(candidate, context.baseDir);
	if (absolute === null) return undefined;
	return context.toLocalUrl(absolute);
}
