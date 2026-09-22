/**
 * 生图独立配置（不进 pi models.json / auth.json）。
 *
 * 接口一律按 OpenAI 兼容 /images/generations 发；火山只是换 baseUrl + 额外字段。
 * 用户不选 API 类型，只配名称 / baseUrl / apiKey / 模型，再勾选该供应商真正支持的字段。
 */

/** 官方字段名：勾选后 composer 才出对应控件，请求体才带该字段。 */
export const IMAGE_GEN_EXTRA_PARAMS = ["size", "output_format", "watermark"] as const;
export type ImageGenExtraParam = (typeof IMAGE_GEN_EXTRA_PARAMS)[number];

/**
 * 生图接口方言：同一 /images/generations 路径下字段名与响应结构不一致的供应商。
 * - openai（缺省）：OpenAI / 火山方舟 / GPT-Image——size / watermark / output_format、
 *   image 参考图为 dataURI 数组、响应 data[0].{b64_json|url}。
 * - siliconflow：SiliconFlow——尺寸字段是 image_size（不是 size），
 *   参考图 image 是单个 string（base64/URL，不认数组），
 *   响应是 images[].url（无 b64_json、无 data 数组）；无 watermark / output_format 概念。
 */
export const IMAGE_GEN_API_STYLES = ["openai", "siliconflow"] as const;
export type ImageGenApiStyle = (typeof IMAGE_GEN_API_STYLES)[number];

/**
 * 参考图输入方式：不同供应商带图输入的 API 形态不同，由用户按供应商声明：
 * - none（缺省）：不支持参考图；附了图的生图请求直接报错提示，不发无效请求。
 * - edits：OpenAI gpt-image-1 风格，走 POST {base}/images/edits multipart（image 可多张）。
 * - image-field：方舟 seedream 等风格，/images/generations JSON 体里加 image:[dataURI...]。
 */
export const IMAGE_GEN_REFERENCE_MODES = ["none", "edits", "image-field"] as const;
export type ImageGenReferenceMode = (typeof IMAGE_GEN_REFERENCE_MODES)[number];

export type ImageGenProviderExtraParams = {
	size: boolean;
	output_format: boolean;
	watermark: boolean;
};

/** 新供应商默认全关：没勾选就不发，避免 OpenAI 官方因未知字段 400。 */
export const DEFAULT_IMAGE_GEN_EXTRA_PARAMS: ImageGenProviderExtraParams = {
	size: false,
	output_format: false,
	watermark: false,
};

export type ImageGenProviderConfig = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	/** 该供应商下可选的生图模型 id（拉取或手填） */
	models: string[];
	/** 该供应商支持、需要发送的官方字段 */
	extraParams: ImageGenProviderExtraParams;
	/** 参考图输入方式；缺省 none（旧配置无此字段时向后兼容为不支持） */
	referenceMode?: ImageGenReferenceMode;
	/** 接口方言；缺省 openai（旧配置无此字段时按 OpenAI 兼容理解） */
	apiStyle?: ImageGenApiStyle;
};

export type ImageGenConfigFile = {
	providers: ImageGenProviderConfig[];
	/** composer 上次选中的供应商；空 = 尚未选择 */
	activeProviderId: string;
	/** composer 上次选中的模型 id */
	activeModel: string;
};

export const EMPTY_IMAGE_GEN_CONFIG: ImageGenConfigFile = {
	providers: [],
	activeProviderId: "",
	activeModel: "",
};

const MAX_NAME = 64;
const MAX_URL = 512;
const MAX_KEY = 512;
const MAX_MODEL_ID = 128;
const MAX_MODELS = 80;
const MAX_PROVIDERS = 20;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

function sanitizeId(value: unknown, fallback: string): string {
	if (typeof value === "string" && ID_RE.test(value.trim())) return value.trim();
	return fallback;
}

function uniqueModels(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const seen = new Set<string>();
	const models: string[] = [];
	for (const item of values) {
		if (typeof item !== "string") continue;
		const id = item.trim().slice(0, MAX_MODEL_ID);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		models.push(id);
		if (models.length >= MAX_MODELS) break;
	}
	return models;
}

/**
 * 解析参考图模式：只接受枚举值；缺省/非法返回 undefined（与旧配置兼容，语义等同 none）。
 */
export function sanitizeImageGenReferenceMode(value: unknown): ImageGenReferenceMode | undefined {
	if (typeof value !== "string") return undefined;
	return (IMAGE_GEN_REFERENCE_MODES as readonly string[]).includes(value) ? (value as ImageGenReferenceMode) : undefined;
}

/**
 * 解析接口方言：只接受枚举值；缺省/非法返回 undefined（旧配置兼容，语义等同 openai）。
 */
export function sanitizeImageGenApiStyle(value: unknown): ImageGenApiStyle | undefined {
	if (typeof value !== "string") return undefined;
	return (IMAGE_GEN_API_STYLES as readonly string[]).includes(value) ? (value as ImageGenApiStyle) : undefined;
}

/**
 * 解析 extraParams。旧文件只有 kind=ark、没有 extraParams 时，默认打开火山三项，
 * 避免升级后底栏参数突然消失。
 */
export function sanitizeImageGenExtraParams(value: unknown, legacyKind?: unknown): ImageGenProviderExtraParams {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const raw = value as Record<string, unknown>;
		return {
			size: raw.size === true,
			output_format: raw.output_format === true,
			watermark: raw.watermark === true,
		};
	}
	if (legacyKind === "ark") {
		return { size: true, output_format: true, watermark: true };
	}
	return { ...DEFAULT_IMAGE_GEN_EXTRA_PARAMS };
}

/**
 * 白名单校验生图配置。非法字段丢弃；整份不是对象则返回空配置。
 * apiKey 允许写入（与 auth.json 同级信任域），调用方禁止记入日志。
 * 旧 kind 字段只用于 extraParams 迁移，落盘不再写出。
 */
export function sanitizeImageGenConfig(input: unknown): ImageGenConfigFile {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ...EMPTY_IMAGE_GEN_CONFIG };
	}
	const raw = input as Record<string, unknown>;
	const providersIn = Array.isArray(raw.providers) ? raw.providers : [];
	const providers: ImageGenProviderConfig[] = [];
	const seenIds = new Set<string>();
	for (let index = 0; index < providersIn.length && providers.length < MAX_PROVIDERS; index += 1) {
		const item = providersIn[index];
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const row = item as Record<string, unknown>;
		const fallbackId = `ig-${index + 1}`;
		const id = sanitizeId(row.id, fallbackId);
		if (seenIds.has(id)) continue;
		seenIds.add(id);
		const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, MAX_NAME) : "Image";
		const baseUrl = typeof row.baseUrl === "string" && /^https?:\/\/[^\s]+$/i.test(row.baseUrl.trim()) ? row.baseUrl.trim().replace(/\/+$/, "").slice(0, MAX_URL) : "";
		const apiKey = typeof row.apiKey === "string" ? row.apiKey.trim().slice(0, MAX_KEY) : "";
		providers.push({
			id,
			name,
			baseUrl,
			apiKey,
			models: uniqueModels(row.models),
			extraParams: sanitizeImageGenExtraParams(row.extraParams, row.kind),
			// 参考图模式：非法值回退 none（不发无效请求）；旧配置无字段 → undefined 同样视为 none
			referenceMode: sanitizeImageGenReferenceMode(row.referenceMode),
			// 接口方言：非法值回退 openai（未知字段按 OpenAI 兼容理解，不猜 URL）
			apiStyle: sanitizeImageGenApiStyle(row.apiStyle),
		});
	}
	const requestedProvider = typeof raw.activeProviderId === "string" ? raw.activeProviderId.trim() : "";
	// 空值和失效 id 都表示“尚未选择”：不能因为供应商数组非空就静默选第一个。
	const activeProvider = requestedProvider ? providers.find((provider) => provider.id === requestedProvider) : undefined;
	const requestedModel = typeof raw.activeModel === "string" ? raw.activeModel.trim().slice(0, MAX_MODEL_ID) : "";
	const activeModel = activeProvider?.models.includes(requestedModel) ? requestedModel : "";
	return {
		providers,
		activeProviderId: activeProvider?.id ?? "",
		activeModel,
	};
}

export function findImageGenProvider(config: ImageGenConfigFile, providerId: string): ImageGenProviderConfig | undefined {
	return config.providers.find((provider) => provider.id === providerId);
}

/** 底栏合并选择器用：供应商 id 与模型 id 用 ASCII Unit Separator 拼接，避免模型 id 含 `/` 时拆错。 */
const IMAGE_GEN_SELECTION_SEP = "\u001f";

export function encodeImageGenSelection(providerId: string, modelId: string): string {
	return `${providerId}${IMAGE_GEN_SELECTION_SEP}${modelId}`;
}

export function decodeImageGenSelection(value: string): { providerId: string; modelId: string } | null {
	const index = value.indexOf(IMAGE_GEN_SELECTION_SEP);
	if (index <= 0) return null;
	const providerId = value.slice(0, index);
	const modelId = value.slice(index + 1);
	if (!providerId || !modelId) return null;
	return { providerId, modelId };
}
