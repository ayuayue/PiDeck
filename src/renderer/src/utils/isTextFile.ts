/**
 * isTextFile — 根据文件扩展名判断是否支持内联编辑/预览。
 *
 * 二进制扩展名集合与 FileDiffViewer 共享，避免在两处维护。
 */

const BINARY_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"mp3",
	"wav",
	"ogg",
	"flac",
	"m4a",
	"mp4",
	"avi",
	"mkv",
	"mov",
	"webm",
	"zip",
	"tar",
	"gz",
	"bz2",
	"7z",
	"rar",
	"exe",
	"dll",
	"so",
	"dylib",
	"wasm",
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"ttf",
	"otf",
	"woff",
	"woff2",
	"eot",
	"o",
	"a",
	"lib",
	"obj",
	"class",
	"pyc",
	"pyo",
	"db",
	"sqlite",
	"sqlite3",
]);

/** 根据扩展名判断文件是否二进制（不可在编辑器中编辑）。 */
export function isBinaryExtension(path: string): boolean {
	if (!path) return false;
	const ext = path.split(".").pop()?.toLowerCase();
	return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

/** 内置预览支持的图片扩展名（Chromium img 原生解码，无需转码） */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** 判断是否为可内联预览的图片文件 */
export function isImageFile(path: string): boolean {
	if (!path) return false;
	const ext = path.split(".").pop()?.toLowerCase();
	return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

/** 判断是否为 PDF 文件（Chromium 内置 PDF viewer 渲染） */
export function isPdfFile(path: string): boolean {
	if (!path) return false;
	return path.toLowerCase().endsWith(".pdf");
}

/** 根据扩展名判断文件是否可在内置编辑器中编辑（非二进制）。 */
export function isTextFile(path: string): boolean {
	return !isBinaryExtension(path);
}
