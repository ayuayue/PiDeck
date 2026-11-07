/**
 * 二进制预览路由：决定一个二进制文件用哪种内置预览器，或回退到「不支持」。
 *
 * 只做扩展名分类，不读盘；文件大小上限由预览器自己按类型取，避免大文件
 * 一次性把 base64 拉进渲染进程。
 */
export type BinaryFilePreviewKind = "docx" | "spreadsheet" | "archive" | "audio" | "video";

const DOCX_EXTENSIONS = new Set(["docx", "docm"]);
const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xlsm", "xls"]);
const ARCHIVE_EXTENSIONS = new Set(["zip"]);

/** 音视频只列 Chromium 能直接解码的容器；mkv/avi 等仍交给 <video>，失败时给系统打开提示。 */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
};

const VIDEO_MIME_BY_EXT: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
};

export const BINARY_PREVIEW_MAX_BYTES: Record<"docx" | "spreadsheet" | "archive", number> = {
	docx: 32 * 1024 * 1024,
	spreadsheet: 32 * 1024 * 1024,
	archive: 64 * 1024 * 1024,
};

export function fileExtensionOf(filePath: string): string {
	const name = filePath.split(/[\\/]/).pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function getBinaryPreviewKind(filePath: string): BinaryFilePreviewKind | null {
	const ext = fileExtensionOf(filePath);
	if (DOCX_EXTENSIONS.has(ext)) return "docx";
	if (SPREADSHEET_EXTENSIONS.has(ext)) return "spreadsheet";
	if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
	if (ext in AUDIO_MIME_BY_EXT) return "audio";
	if (ext in VIDEO_MIME_BY_EXT) return "video";
	return null;
}

export function getMediaMimeForPath(filePath: string): string | undefined {
	const ext = fileExtensionOf(filePath);
	return AUDIO_MIME_BY_EXT[ext] ?? VIDEO_MIME_BY_EXT[ext];
}
