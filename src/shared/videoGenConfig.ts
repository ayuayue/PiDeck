/**
 * 生视频独立配置（不进 pi models.json / auth.json，与生图 imagegen.json 平行）。
 *
 * 视频生成与生图的关键差异：协议不是 OpenAI 兼容事实标准，而是「提交-轮询-下载」
 * 三段式异步协议，且各家字段/状态命名不一致（见 main/videogen/videoAdapters.ts）。
 * 因此供应商必须显式声明 protocol（协议族），提交体/查询体/产物 URL 解析全部按
 * protocol 分发；baseUrl 是网关根（如 https://example.com），路径由适配器拼接。
 */

/** 协议族：已验证可用的两类（TokenDance 聚合网关方言）。 */
export const VIDEO_GEN_PROTOCOLS = ["minimax-v2", "seedance-ark"] as const;
export type VideoGenProtocolFamily = (typeof VIDEO_GEN_PROTOCOLS)[number];

/** 协议族展示名（设置页/选择器用）。 */
export const VIDEO_GEN_PROTOCOL_LABELS: Record<VideoGenProtocolFamily, string> = {
	"minimax-v2": "MiniMax 视频协议 v2",
	"seedance-ark": "字节 Seedance（Ark）",
};

/**
 * 各协议族的参数预设（供 composer 下拉预填，允许自定义值——各家模型支持矩阵
 * 差异大且会演进，预设只保证「最省钱的默认」而非全集）。
 */
export const VIDEO_GEN_RESOLUTION_PRESETS: Record<VideoGenProtocolFamily, string[]> = {
	// MiniMax 用大写 P（480P/768P/1080P，实测 480P 通过）
	"minimax-v2": ["480P", "768P", "1080P"],
	// Ark 用小写 p（文档 720p/1080p）
	"seedance-ark": ["480p", "720p", "1080p"],
};

export const VIDEO_GEN_RATIO_PRESETS: Record<VideoGenProtocolFamily, string[]> = {
	// 文生视频 ratio 不能为 adaptive（MiniMax 约束）
	"minimax-v2": ["16:9", "9:16", "4:3", "3:4", "1:1"],
	"seedance-ark": ["16:9", "9:16", "4:3", "3:4", "1:1", "adaptive"],
};

export const VIDEO_GEN_DURATION_PRESETS: readonly string[] = ["5", "10"];

export type VideoGenProviderConfig = {
	id: string;
	name: string;
	/** 网关根地址（https://…），路径由协议适配器拼接 */
	baseUrl: string;
	apiKey: string;
	/** 协议族：决定提交/查询/下载的请求形态 */
	protocol: VideoGenProtocolFamily;
	/** 该供应商下可选的视频模型 id（手填） */
	models: string[];
	/** 该供应商的默认参数（composer 切到该供应商时预填） */
	defaults?: {
		resolution?: string;
		duration?: string;
		ratio?: string;
	};
	/**
	 * 单价备注（自由文本，仅提交确认框展示用，如「480P≈¥0.28/秒」）。
	 * 各家计费口径不一且随时调整，PiDeck 不做真实成本核算，只透传这条提示。
	 */
	priceNote?: string;
};

export type VideoGenConfigFile = {
	providers: VideoGenProviderConfig[];
	/** composer 上次选中的供应商；空 = 尚未选择 */
	activeProviderId: string;
	/** composer 上次选中的模型 id */
	activeModel: string;
	/** composer 上次使用的参数（切供应商时按 defaults 预填，用户改过的值优先保留） */
	activeParams: { resolution?: string; duration?: string; ratio?: string };
	/** 提交前弹成本确认框（默认开；关掉后点发送直接提交） */
	costConfirm: boolean;
};

export const EMPTY_VIDEO_GEN_CONFIG: VideoGenConfigFile = {
	providers: [],
	activeProviderId: "",
	activeModel: "",
	activeParams: {},
	costConfirm: true,
};

const MAX_NAME = 64;
const MAX_URL = 512;
const MAX_KEY = 512;
const MAX_MODEL_ID = 128;
const MAX_MODELS = 80;
const MAX_PROVIDERS = 20;
const MAX_PARAM = 32;
const MAX_PRICE_NOTE = 128;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

function sanitizeId(value: unknown, fallback: string): string {
	if (typeof value === "string" && ID_RE.test(value.trim())) return value.trim();
	return fallback;
}

function sanitizeParam(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().slice(0, MAX_PARAM);
	return trimmed || undefined;
}

/** 协议枚举校验：非法/缺省回落 minimax-v2（唯一实测过的族，行为最可预期）。 */
export function sanitizeVideoGenProtocol(value: unknown): VideoGenProtocolFamily {
	if (typeof value === "string" && (VIDEO_GEN_PROTOCOLS as readonly string[]).includes(value)) {
		return value as VideoGenProtocolFamily;
	}
	return "minimax-v2";
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
 * 白名单校验生视频配置。非法字段丢弃；整份不是对象返回空配置。
 * apiKey 允许写入（与 auth.json 同级信任域），调用方禁止记入日志。
 */
export function sanitizeVideoGenConfig(input: unknown): VideoGenConfigFile {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ...EMPTY_VIDEO_GEN_CONFIG };
	}
	const raw = input as Record<string, unknown>;
	const providersIn = Array.isArray(raw.providers) ? raw.providers : [];
	const providers: VideoGenProviderConfig[] = [];
	const seenIds = new Set<string>();
	for (let index = 0; index < providersIn.length && providers.length < MAX_PROVIDERS; index += 1) {
		const item = providersIn[index];
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const row = item as Record<string, unknown>;
		const fallbackId = `vg-${index + 1}`;
		const id = sanitizeId(row.id, fallbackId);
		if (seenIds.has(id)) continue;
		seenIds.add(id);
		const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, MAX_NAME) : "Video";
		const baseUrl = typeof row.baseUrl === "string" && /^https?:\/\/[^\s]+$/i.test(row.baseUrl.trim()) ? row.baseUrl.trim().replace(/\/+$/, "").slice(0, MAX_URL) : "";
		const apiKey = typeof row.apiKey === "string" ? row.apiKey.trim().slice(0, MAX_KEY) : "";
		const defaultsRow = row.defaults && typeof row.defaults === "object" && !Array.isArray(row.defaults) ? (row.defaults as Record<string, unknown>) : {};
		const defaults = {
			resolution: sanitizeParam(defaultsRow.resolution),
			duration: sanitizeParam(defaultsRow.duration),
			ratio: sanitizeParam(defaultsRow.ratio),
		};
		const priceNote = typeof row.priceNote === "string" && row.priceNote.trim() ? row.priceNote.trim().slice(0, MAX_PRICE_NOTE) : undefined;
		providers.push({
			id,
			name,
			baseUrl,
			apiKey,
			protocol: sanitizeVideoGenProtocol(row.protocol),
			models: uniqueModels(row.models),
			defaults: defaults.resolution || defaults.duration || defaults.ratio ? defaults : undefined,
			priceNote,
		});
	}
	const requestedProvider = typeof raw.activeProviderId === "string" ? raw.activeProviderId.trim() : "";
	// 空值和失效 id 都表示「尚未选择」：不能因为供应商数组非空就静默选第一个。
	const activeProvider = requestedProvider ? providers.find((provider) => provider.id === requestedProvider) : undefined;
	const requestedModel = typeof raw.activeModel === "string" ? raw.activeModel.trim().slice(0, MAX_MODEL_ID) : "";
	const activeModel = activeProvider?.models.includes(requestedModel) ? requestedModel : "";
	const paramsRow = raw.activeParams && typeof raw.activeParams === "object" && !Array.isArray(raw.activeParams) ? (raw.activeParams as Record<string, unknown>) : {};
	const activeParams = {
		resolution: sanitizeParam(paramsRow.resolution),
		duration: sanitizeParam(paramsRow.duration),
		ratio: sanitizeParam(paramsRow.ratio),
	};
	return {
		providers,
		activeProviderId: activeProvider?.id ?? "",
		activeModel,
		activeParams,
		costConfirm: raw.costConfirm !== false,
	};
}

export function findVideoGenProvider(config: VideoGenConfigFile, providerId: string): VideoGenProviderConfig | undefined {
	return config.providers.find((provider) => provider.id === providerId);
}

/** 底栏合并选择器用：与生图 encodeImageGenSelection 同构（US 分隔符避免模型 id 含 / 拆错）。 */
const VIDEO_GEN_SELECTION_SEP = "\u001f";

export function encodeVideoGenSelection(providerId: string, modelId: string): string {
	return `${providerId}${VIDEO_GEN_SELECTION_SEP}${modelId}`;
}

export function decodeVideoGenSelection(value: string): { providerId: string; modelId: string } | null {
	const index = value.indexOf(VIDEO_GEN_SELECTION_SEP);
	if (index <= 0) return null;
	const providerId = value.slice(0, index);
	const modelId = value.slice(index + VIDEO_GEN_SELECTION_SEP.length);
	if (!providerId || !modelId) return null;
	return { providerId, modelId };
}
