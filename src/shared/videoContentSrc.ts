import type { VideoContent } from "./types/videogen";

/**
 * 视频显示源的统一入口（与生图 imageContentSrc 同构）。
 *
 * 视频没有内联 base64 形态：主进程把上游产物流式下载落盘后只回 ref，
 * 渲染层 <video src> 一律经 videoContentSrc() 解析成 pideck-video:// URL，
 * 由协议处理器按 Range 流式吐字节——渲染进程从头到尾不持有视频字节。
 */

/** 落盘视频的自定义协议名；主进程注册见 main/videogen/VideoGenProtocol.ts。 */
export const VIDEO_BLOB_PROTOCOL = "pideck-video";

/** ref 形态 blob 的 URL（内容寻址，内容不随 ref 变化，可长缓存）。 */
export function videoBlobUrl(ref: string): string {
	return `${VIDEO_BLOB_PROTOCOL}://blob/${encodeURIComponent(ref)}`;
}

/** 解析 `<video src>`：缺 ref 返回 null（调用方按「无产物」渲染，不要拼出 undefined URL）。 */
export function videoContentSrc(video: Pick<VideoContent, "ref"> | null | undefined): string | null {
	if (!video || !video.ref) return null;
	return videoBlobUrl(video.ref);
}
