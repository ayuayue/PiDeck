import type { ImageBlobPayload } from "./types/imagegen";
import type { ImageContent } from "./types/session";

/**
 * 图片显示源与 base64 取回的统一入口。
 *
 * 背景：生图历史里的每张图都会把完整 base64 追加进会话 JSONL（单张 2560×1440 PNG
 * 可达 6 MB），几十轮就能撑到 200 MB+，渲染进程加载该会话时内存耗尽（OOM）。
 * 现在的契约是「base64 只在内存里活一轮，进历史即落盘成文件，消息只留 ref」：
 *
 * - `ImageContent.data`：内联 base64（正在生成 / 正在发送的图）。
 * - `ImageContent.ref`：`userData/imagegen/blobs` 下的内容寻址文件名。
 *
 * 渲染层所有 `<img src>` 都必须经 `imageContentSrc()` 解析，不要再手写
 * `data:${mimeType};base64,${data}` —— 否则 ref 形态的历史图会渲染成
 * `data:image/png;base64,undefined`（不报错、只是白图，很难排查）。
 */

/** 落盘图片的自定义协议名；主进程注册见 main/imagegen/ImageGenImageProtocol.ts。 */
export const IMAGE_BLOB_PROTOCOL = "pideck-img";

/** ref 形态 blob 的 URL（内容寻址，内容不随 ref 变化，可长缓存）。 */
export function imageBlobUrl(ref: string): string {
	return `${IMAGE_BLOB_PROTOCOL}://blob/${encodeURIComponent(ref)}`;
}

/**
 * 解析 `<img src>`：内联 base64 优先，其次落盘引用；两者都缺失返回 null
 * （调用方不要回退成空串 data URL，那会得到一张白图而不是「无图」）。
 */
export function imageContentSrc(image: Pick<ImageContent, "data" | "mimeType" | "ref"> | null | undefined): string | null {
	if (!image) return null;
	if (image.data) return `data:${image.mimeType};base64,${image.data}`;
	if (image.ref) return imageBlobUrl(image.ref);
	return null;
}

/** 图片是否可显示（有 data 或 ref）。 */
export function hasImageSource(image: Pick<ImageContent, "data" | "ref"> | null | undefined): boolean {
	return Boolean(image && (image.data || image.ref));
}

/** 按需取回图片 base64 的读取器（渲染层由 preload 的 imagegen.readImageBlob 提供）。 */
export type ImageBlobReader = (ref: string) => Promise<ImageBlobPayload | null>;

/**
 * 取回单张图片的 base64：内联形态直接返回，ref 形态走 IPC 按需读取。
 * 供「复制 / 保存 / 重发带回参考图」这类需要真实字节的路径使用——
 * 展示路径不要调它，直接用 `imageContentSrc()` 交给 Chromium 流式加载。
 */
export async function loadImageBase64(image: Pick<ImageContent, "data" | "mimeType" | "ref"> | null | undefined, readBlob: ImageBlobReader): Promise<ImageBlobPayload | null> {
	if (!image) return null;
	if (image.data) return { data: image.data, mimeType: image.mimeType };
	if (!image.ref) return null;
	try {
		const payload = await readBlob(image.ref);
		if (!payload?.data) return null;
		return { data: payload.data, mimeType: payload.mimeType || image.mimeType };
	} catch {
		// blob 缺失 / IPC 失败：按「取不到图」处理，不抛给 UI 事件链
		return null;
	}
}

/**
 * 批量回填成可发送的内联图片（丢掉取不到字节的条目）。
 * 重发带参考图时用：历史消息里是 ref，composer/请求体要的是 base64。
 */
export async function hydrateImageContents(images: readonly ImageContent[] | undefined, readBlob: ImageBlobReader): Promise<ImageContent[]> {
	if (!images || images.length === 0) return [];
	const hydrated = await Promise.all(
		images.map(async (image): Promise<ImageContent | null> => {
			const payload = await loadImageBase64(image, readBlob);
			if (!payload) return null;
			return { type: "image", data: payload.data, mimeType: payload.mimeType };
		}),
	);
	return hydrated.filter((image): image is ImageContent => image !== null);
}
