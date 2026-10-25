import type { ImageGenApiStyle, ImageGenProviderExtraParams } from "./imageGenConfig";
import { DEFAULT_IMAGE_GEN_EXTRA_PARAMS } from "./imageGenConfig";
import type { ImageContent } from "./types/session";

/**
 * 生图可选参数：OpenAI Images 与火山方舟都走同一套 OpenAI 兼容 /images/generations。
 *
 * 是否发送某个字段由供应商 extraParams 决定（用户在生图配置里勾选），
 * 不再按 URL / API 类型猜测。官方字段名：size、output_format、watermark。
 * output_format 是文件编码（png/jpeg），与运输层 response_format=b64_json（本服务写死）不是一回事。
 */

export const IMAGE_GEN_SIZE_PRESETS = ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024", "2048x2048", "1K", "2K", "4K"] as const;

export type ImageGenSizePreset = (typeof IMAGE_GEN_SIZE_PRESETS)[number];

/** 底栏「不设置」：请求体不带 size，交给模型默认。不能用空字符串（Radix Select 禁止 empty value）。 */
export const IMAGE_GEN_SIZE_UNSET = "unset";
/** 默认不指定分辨率，避免把 1024x1024 强加给只认 2K/4K 的模型。 */
export const DEFAULT_IMAGE_GEN_SIZE = IMAGE_GEN_SIZE_UNSET;
/** 用户显式选择；不跟火山官方默认 true，避免没开开关却带水印。 */
export const DEFAULT_IMAGE_GEN_WATERMARK = false;

export const IMAGE_GEN_OUTPUT_FORMATS = ["png", "jpeg"] as const;
export type ImageGenOutputFormat = (typeof IMAGE_GEN_OUTPUT_FORMATS)[number];
/** 默认 png：与现有 b64 mime/复制保存路径一致；火山 5.0 官方默认常为 jpeg。 */
export const DEFAULT_IMAGE_GEN_OUTPUT_FORMAT: ImageGenOutputFormat = "png";

const PIXEL_SIZE_RE = /^\d{2,5}x\d{2,5}$/;
const VOLC_SCALE_RE = /^[1-4]K$/i;

/** 解析生图尺寸：unset / 空 = 不发送；预设、1K/2K/4K，或 宽x高。非法返回 null。 */
export function parseImageGenSize(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === IMAGE_GEN_SIZE_UNSET) return IMAGE_GEN_SIZE_UNSET;
	if (trimmed.length > 16) return null;
	if (VOLC_SCALE_RE.test(trimmed)) return trimmed.toUpperCase();
	if (PIXEL_SIZE_RE.test(trimmed)) return trimmed;
	return null;
}

/** 写入请求体的 size：unset 视为未指定。 */
export function resolveImageGenApiSize(value: unknown): string | undefined {
	const parsed = parseImageGenSize(value);
	if (!parsed || parsed === IMAGE_GEN_SIZE_UNSET) return undefined;
	return parsed;
}

export function parseImageGenWatermark(value: unknown, fallback = DEFAULT_IMAGE_GEN_WATERMARK): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function parseImageGenOutputFormat(value: unknown, fallback: ImageGenOutputFormat | null = DEFAULT_IMAGE_GEN_OUTPUT_FORMAT): ImageGenOutputFormat | null {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase();
	const jpg = normalized === "jpg" ? "jpeg" : normalized;
	if ((IMAGE_GEN_OUTPUT_FORMATS as readonly string[]).includes(jpg)) {
		return jpg as ImageGenOutputFormat;
	}
	return fallback;
}

export function imageGenOutputMimeType(format: ImageGenOutputFormat | null | undefined): string {
	return format === "jpeg" ? "image/jpeg" : "image/png";
}

/** 参考图数量上限：主流供应商（seedream/gpt-image-1）多为 1-10 张，取保守值 */
export const IMAGE_GEN_REFERENCE_LIMIT = 4;
/** 单张参考图 base64 上限（约 8MB 原始数据），防止 IPC 载荷失控 */
export const IMAGE_GEN_REFERENCE_MAX_BASE64 = 11_000_000;
const REFERENCE_MIME_RE = /^image\/(png|jpeg|webp)$/;

/** 校验渲染层传来的参考图：数量、mime、base64 体积全部受限；非法整体丢弃返回 null。 */
export function parseImageGenReferenceImages(value: unknown): ImageContent[] | null {
	if (!Array.isArray(value)) return null;
	if (value.length > IMAGE_GEN_REFERENCE_LIMIT) return null;
	const images: ImageContent[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return null;
		// IPC 边界逐字段收窄；type 必须是 image，防止把任意对象透传进网络层
		const type = Reflect.get(item, "type");
		const data = Reflect.get(item, "data");
		const mimeType = Reflect.get(item, "mimeType");
		if (type !== "image") return null;
		if (typeof data !== "string" || typeof mimeType !== "string") return null;
		if (!REFERENCE_MIME_RE.test(mimeType)) return null;
		if (!data || data.length > IMAGE_GEN_REFERENCE_MAX_BASE64) return null;
		images.push({ type: "image", data, mimeType });
	}
	return images;
}

/** image-field 模式：参考图转 dataURI 数组（方舟 seedream 官方格式）。 */
export function buildImageGenImageField(images: Array<{ data: string; mimeType: string }>): string[] {
	return images.map((image) => `data:${image.mimeType};base64,${image.data}`);
}

/**
 * edits 模式请求体：OpenAI /images/edits 只收 multipart form。
 * gpt-image-1 支持多张 image[]；size 仅在勾选 extraParams.size 时发送。
 */
export function buildImageGenEditsForm(input: { model: string; prompt: string; images: Array<{ data: string; mimeType: string }>; extraParams?: Partial<ImageGenProviderExtraParams> | null; size?: string }): FormData {
	const form = new FormData();
	form.append("model", input.model.trim());
	form.append("prompt", input.prompt);
	form.append("n", "1");
	for (const image of input.images) {
		const bytes = Uint8Array.from(atob(image.data), (ch) => ch.charCodeAt(0));
		form.append("image[]", new Blob([bytes], { type: image.mimeType }), "reference.png");
	}
	const extra = resolveExtraParams(input.extraParams ?? DEFAULT_IMAGE_GEN_EXTRA_PARAMS);
	if (extra.size) {
		const size = resolveImageGenApiSize(input.size);
		if (size) form.append("size", size);
	}
	return form;
}

function resolveExtraParams(extraParams?: Partial<ImageGenProviderExtraParams> | null): ImageGenProviderExtraParams {
	return {
		size: extraParams?.size === true,
		output_format: extraParams?.output_format === true,
		watermark: extraParams?.watermark === true,
	};
}

/**
 * 组装 /images/generations JSON body（不含鉴权）。
 * 方言（apiStyle）按供应商声明选择：openai（OpenAI/火山方舟）与 siliconflow 的
 * 字段名/参考图形态/响应结构不同（见 imageGenConfig.ts 的 IMAGE_GEN_API_STYLES 注释），
 * 不按 URL 猜测，全部由用户配置驱动。
 */
export function buildImageGenApiBody(input: { model: string; prompt: string; extraParams?: Partial<ImageGenProviderExtraParams> | null; size?: string; watermark?: boolean; outputFormat?: string; apiStyle?: ImageGenApiStyle; referenceImages?: Array<{ data: string; mimeType: string }> }): Record<string, unknown> {
	if ((input.apiStyle ?? "openai") === "siliconflow") {
		return buildSiliconFlowApiBody(input);
	}
	const body: Record<string, unknown> = {
		model: input.model.trim(),
		prompt: input.prompt,
		n: 1,
		// 运输层固定 b64_json：结果直接进时间线，不依赖 24h url 下载
		response_format: "b64_json",
	};
	const extra = resolveExtraParams(input.extraParams ?? DEFAULT_IMAGE_GEN_EXTRA_PARAMS);
	// 只发用户勾选的官方字段，避免中转/OpenAI 因未知字段 400
	if (extra.size) {
		const size = resolveImageGenApiSize(input.size);
		if (size) body.size = size;
	}
	if (extra.watermark && typeof input.watermark === "boolean") {
		body.watermark = input.watermark;
	}
	if (extra.output_format) {
		const outputFormat = parseImageGenOutputFormat(input.outputFormat, null);
		if (outputFormat) body.output_format = outputFormat;
	}
	// image-field 参考图：OpenAI/方舟用 dataURI 数组（seedream 官方格式）
	if (input.referenceImages && input.referenceImages.length > 0) {
		body.image = buildImageGenImageField(input.referenceImages);
	}
	return body;
}

/**
 * SiliconFlow 方言 body：字段名与 OpenAI 兼容不同，按官方 schema 组装。
 * - 尺寸字段是 image_size（不是 size），仍受 extraParams.size 开关控制；
 * - 参考图是单个 string（不认数组），只取第一张 dataURI；
 * - 无 watermark / output_format / response_format 概念，一律不发；
 * - 批量默认 1（官方 batch_size 默认值），不额外发送。
 */
function buildSiliconFlowApiBody(input: { model: string; prompt: string; extraParams?: Partial<ImageGenProviderExtraParams> | null; size?: string; referenceImages?: Array<{ data: string; mimeType: string }> }): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: input.model.trim(),
		prompt: input.prompt,
	};
	const extra = resolveExtraParams(input.extraParams ?? DEFAULT_IMAGE_GEN_EXTRA_PARAMS);
	if (extra.size) {
		const size = resolveImageGenApiSize(input.size);
		if (size) body.image_size = size;
	}
	const first = input.referenceImages?.[0];
	if (first) {
		// 硅基官方 image 字段："data:image/png;base64,..." 或 URL，单个 string
		body.image = `data:${first.mimeType};base64,${first.data}`;
	}
	return body;
}
