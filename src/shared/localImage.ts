/**
 * 对话内本地图片的只读协议契约（渲染层生成 URL / 主进程注册与校验共用）。
 *
 * 为什么需要它：模型把图给用户看时最自然的写法是 `![](C:\…\shot.png)`。旧实现只能靠
 * `file://` 加载，而渲染层在 dev 下页源是 `http://localhost`，Chromium 直接拒绝 `file://`
 * 子资源 → 同一段 Markdown 在 dev 里是白图、打包版才显示。换成自定义协议后两种加载方式
 * 走同一条路径，并且把「能读哪些目录」收窄成主进程里的白名单（`file://` 是任意本地图片）。
 *
 * 线格式：`pideck-file://local/?path=<encodeURIComponent(绝对路径)>`
 * - 用 query 而不是 path 段：Windows 盘符、空格、中文在 path 段里编码歧义太多；
 * - `local` 是固定 host，任何其它 host 一律拒绝（避免被当成远程 URL 误加载）。
 */

export const LOCAL_IMAGE_PROTOCOL = "pideck-file";

/** 单张本地图片的展示上限：与生图 blob 协议同口径（`ImageGenImageProtocol` 的 32MiB）。 */
export const LOCAL_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** 扩展名 → Content-Type。SVG 也放行：`<img>` 上下文不执行脚本，响应另有 CSP sandbox。 */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
};

function extensionOf(path: string): string {
	const leaf = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = leaf.lastIndexOf(".");
	return dot < 0 ? "" : leaf.slice(dot + 1).toLowerCase();
}

/** 图片扩展名对应的 MIME；不认识的返回 null（调用方按 403 拒绝）。 */
export function localImageMimeType(path: string): string | null {
	return IMAGE_MIME_BY_EXTENSION[extensionOf(path)] ?? null;
}

/** 是否是允许通过本地图片协议展示的扩展名（渲染层白名单与主进程共用同一份）。 */
export function isLocalImageExtension(path: string): boolean {
	return localImageMimeType(path) !== null;
}

/** 按需读取的本地图片字节（保存/复制用；展示走协议，不经过这里）。 */
export type LocalImageBytes = { data: string; mimeType: string };

/** 绝对路径 → 可直接放进 `<img src>` 的协议 URL。 */
export function localImageUrl(absolutePath: string): string {
	return `${LOCAL_IMAGE_PROTOCOL}://local/?path=${encodeURIComponent(absolutePath)}`;
}

/**
 * 协议 URL → 请求的绝对路径；host/protocol/参数不合规返回 null。
 * 只做形态解析，路径白名单由主进程的访问判定负责。
 */
export function parseLocalImageUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== `${LOCAL_IMAGE_PROTOCOL}:` || parsed.hostname !== "local") return null;
	const requested = parsed.searchParams.get("path");
	return requested === null || requested === "" ? null : requested;
}
