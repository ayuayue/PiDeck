/**
 * 模型规格自动补全（与 dsh-web 添加模型语义对齐）。
 *
 * 优先级：listing 已有字段 > 当前 Pi/内置能力目录匹配 > 留空。
 * 只填空字段；手填 / 明确关掉的 reasoning=false 一律不覆盖。
 * 不再写入 128k/8k 猜的默认值。
 *
 * 例外（用户决策）：自适应未匹配到任何推理声明时，默认支持思考并开放全部档位
 * （reasoning: true + DEFAULT_OPEN_THINKING_MAP），否则 Pi 只会给 off，用户没得选。
 */

import type { ThinkingLevelMap } from "../../../shared/types/modelSpecs";
import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { FetchedModel } from "../../../shared/types/fetchedModel";
import type { ModelItem, ModelsFile, ProviderCompat, ProviderConfig } from "../config/configTypes";

/** 自适应未匹配到任何档位声明时的默认开放映射。
 *
 * Pi 的档位算法：reasoning:true 时基础五档（off~high）默认可用，
 * xhigh/max 必须存在非 null 映射才提供。这里用档位原串映射开放全部七档，
 * 让用户至少有得选；openai 兼容网关多把 reasoning_effort 原样透传。
 */
export const DEFAULT_OPEN_THINKING_MAP: ThinkingLevelMap = {
	xhigh: "xhigh",
	max: "max",
};

/**
 * 视觉/多模态模型 ID 启发式：目录未收录时据此补图片能力。
 *
 * 只认独立 token（vision/vl/vlm/multimodal/4v），前后必须是边界字符，
 * 避免 "revision"、"visual"、"vlx" 这类子串误判；不含 "image"——它同时是
 * 图片生成模型的常见命名（gpt-image-*），输入能力并不相同。
 * 典型命中：deepseek-v4-flash-vision-exp、qwen2.5-vl、glm-4v。
 */
export const VISION_MODEL_ID_PATTERN = /(^|[^a-z0-9])(vision|vl|vlm|multimodal|4v)($|[^a-z0-9])/i;

export function isVisionModelId(modelId: string): boolean {
	return VISION_MODEL_ID_PATTERN.test(modelId);
}

/**
 * 保存时的 provider compat 归一化：布尔值显式落盘（不依赖后端默认）。
 *
 * supportsReasoningEffort 联动：该 provider 任一模型存在非空档位映射且未显式
 * 关掉推理（reasoning !== false）时自动写 true——否则用户选了思考强度，pi 也
 * 不会真正发送 reasoning_effort 参数（pi 用 provider 级 compat 覆盖模型定义）。
 * 旧版本保存会无条件写 false，配置里已存的 false 是 PiDeck 自己写的陈旧值而非
 * 用户意图，因此自动判定优先于已存在的 false；用户显式写的 true 始终保留。
 */
export function deriveProviderCompat(provider: ProviderConfig): ProviderCompat {
	const anyThinking = (provider.models ?? []).some(
		(model) =>
			model.thinkingLevelMap != null &&
			Object.keys(model.thinkingLevelMap).length > 0 &&
			model.reasoning !== false,
	);
	const compat: ProviderCompat = { ...(provider.compat ?? {}) };
	if (compat.supportsDeveloperRole !== true) compat.supportsDeveloperRole = false;
	compat.supportsReasoningEffort = compat.supportsReasoningEffort === true || anyThinking;
	return compat;
}

/** 单模型补全 patch：返回 [字段, 值] 列表，无可补字段时为空数组 */
export function computeModelSpecPatches(
	model: ModelItem,
	spec: ModelSpec | null | undefined,
): Array<[string, unknown]> {
	const updates: Array<[string, unknown]> = [];
	if (spec) {
		if (model.contextWindow == null && spec.contextWindow != null) {
			updates.push(["contextWindow", spec.contextWindow]);
		}
		if (model.maxTokens == null && spec.maxTokens != null) {
			updates.push(["maxTokens", spec.maxTokens]);
		}
	}
	// input（输入模态）：目录明确声明时优先；仅当模型 ID 明显是视觉变体且目录
	// 未声明 input 时兜底补图片能力（否则 vision 模型会被当成 text-only 走视觉桥）。
	// 已有 input（含手填）一律不动——覆盖由「重置为自适应」负责。
	if (model.input == null) {
		if (spec?.input && spec.input.length > 0) {
			updates.push(["input", [...spec.input]]);
		} else if (spec?.images === true) {
			// 兼容尚未返回完整 input 的旧目录。
			updates.push(["input", ["text", "image"]]);
		} else if (isVisionModelId(model.id)) {
			// 目录未收录的视觉模型：ID 本身就是能力声明（如 -vision-exp/-vl），
			// 补上图片能力而不是留空让 Pi 按 text-only 处理（图片会走视觉桥）。
			updates.push(["input", ["text", "image"]]);
		}
	}
	// reasoning / thinkingLevelMap 是一组：目录明确给出时同时填空，用户明确关掉的 false
	// 或手写映射始终优先，避免代理特有 wire 值被目录覆盖。
	// 目录/端点都没声明时默认支持思考（reasoning: true）并开放全部档位，
	// 否则 Pi 按 `if (!model.reasoning) return ["off"]` 只给 off，用户没有任何思考强度可选。
	const specReasoning = spec?.reasoning;
	if (model.reasoning === undefined) {
		updates.push(["reasoning", specReasoning !== undefined ? specReasoning : true]);
	}
	const reasoningIsOff = model.reasoning === false || specReasoning === false;
	if (model.thinkingLevelMap == null && !reasoningIsOff) {
		updates.push([
			"thinkingLevelMap",
			spec?.thinkingLevelMap
				? { ...spec.thinkingLevelMap }
				: { ...DEFAULT_OPEN_THINKING_MAP },
		]);
	}
	return updates;
}

export function applyModelPatches(
	model: ModelItem,
	updates: Array<[string, unknown]>,
): ModelItem {
	if (updates.length === 0) return model;
	const next: ModelItem = { ...model };
	for (const [field, value] of updates) next[field] = value;
	return next;
}

export type ModelSpecLookup = (
	providerName: string,
	modelId: string,
	modelName?: string,
) => Promise<ModelSpec | null>;

/**
 * 批量补全整个 ModelsFile：空字段才填，未命中时仅补默认思考开放（reasoning/map），
 * 其余容量/模态字段不猜。
 * 不修改入参。
 */
export async function collectModelSpecPatches(
	models: ModelsFile,
	lookup: ModelSpecLookup,
): Promise<{ providers: Record<string, ProviderConfig>; filledCount: number }> {
	// 先浅拷贝全部 provider，避免只遍历到「有模型行」的供应商时把空列表冲掉
	const providers: Record<string, ProviderConfig> = {};
	for (const [providerName, provider] of Object.entries(models.providers)) {
		providers[providerName] = { ...provider, models: [...provider.models] };
	}
	let filledCount = 0;
	const entries = Object.entries(models.providers).flatMap(([providerName, provider]) =>
		provider.models.map((model, index) => ({ providerName, provider, model, index })),
	);
	const results = await Promise.all(
		entries.map(({ providerName, model }) =>
			model.id ? lookup(providerName, model.id, model.name).catch(() => null) : Promise.resolve(null),
		),
	);
	for (let i = 0; i < entries.length; i++) {
		const { providerName, model, index } = entries[i];
		if (!model.id) continue;
		const updates = computeModelSpecPatches(model, results[i]);
		if (updates.length === 0) continue;
		filledCount++;
		providers[providerName].models[index] = applyModelPatches(model, updates);
	}
	return { providers, filledCount };
}

// ── 自适应模板（endpoint 实报 + bundled catalog 合并；重置语义） ──────

/**
 * 自适应模板：对单个模型行建议的能力值。
 * endpoint `/models` 实报字段优先，bundled pi-ai catalog 模板补空。
 * 字段缺省 = 不写入、不落盘（让 Pi 按其默认行为处理）。
 */
export type AdaptiveModelTemplate = {
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	/** bundled catalog 匹配到的标准模型 id（未命中则无）。 */
	matchedId?: string;
};

/**
 * 合并 endpoint listing 与 bundled catalog 模板。
 * 优先级：endpoint 实报字段 > catalog 模板 > 空。
 * 用户当前模型行已填的值不参与合并——它属于「当前有效配置」，由 applyAdaptiveTemplateReset 决定取舍。
 * modelId 用于视觉模型 ID 兜底（目录未收录且 endpoint 未实报时）；
 * 不传时保持旧行为（不猜 input）。
 */
export function mergeAdaptiveModelTemplate(
	listing: FetchedModel | undefined,
	spec: ModelSpec | null | undefined,
	modelId?: string,
): AdaptiveModelTemplate {
	const template: AdaptiveModelTemplate = {};
	// endpoint 实报优先
	if (listing?.contextWindow != null) template.contextWindow = listing.contextWindow;
	if (listing?.maxTokens != null) template.maxTokens = listing.maxTokens;
	if (listing?.reasoning !== undefined) template.reasoning = listing.reasoning;
	if (listing?.input && listing.input.length > 0) template.input = [...listing.input];
	if (listing?.thinkingLevelMap) template.thinkingLevelMap = { ...listing.thinkingLevelMap };
	// bundled catalog 补空
	if (template.contextWindow === undefined && spec?.contextWindow != null) {
		template.contextWindow = spec.contextWindow;
	}
	if (template.maxTokens === undefined && spec?.maxTokens != null) {
		template.maxTokens = spec.maxTokens;
	}
	if (template.reasoning === undefined && spec?.reasoning !== undefined) {
		template.reasoning = spec.reasoning;
	}
	if (!template.input && spec?.input && spec.input.length > 0) {
		template.input = [...spec.input];
	} else if (!template.input && spec?.images === true) {
		// 兼容尚未返回完整 input 的旧目录。
		template.input = ["text", "image"];
	} else if (!template.input && modelId && isVisionModelId(modelId)) {
		// 目录未收录的视觉模型：ID 即能力声明，「重置为自适应」同样补图片能力。
		template.input = ["text", "image"];
	}
	if (!template.thinkingLevelMap && spec?.thinkingLevelMap) {
		template.thinkingLevelMap = { ...spec.thinkingLevelMap };
	}
	// 自适应未匹配到任何推理声明时，默认开放思考档位（用户至少有得选）：
	// reasoning 缺省视为 true；xhigh/max 用默认映射开放全部七档。
	// 端点/目录显式声明的 reasoning:false 或档位映射仍然优先，不被默认值覆盖。
	if (template.reasoning === undefined) {
		template.reasoning = true;
	}
	if (!template.thinkingLevelMap && template.reasoning !== false) {
		template.thinkingLevelMap = { ...DEFAULT_OPEN_THINKING_MAP };
	}
	if (spec?.matchedId) template.matchedId = spec.matchedId;
	return template;
}

/**
 * 重置为自适应：只覆盖模板有值的字段。
 * - 容量字段（contextWindow / maxTokens / input）：模板未提供（未匹配到目录、
 *   endpoint 未实报）时保留用户当前值——旧实现先清空再写，未匹配时会把用户手填的
 *   1000000 一并删掉，落盘为空后 Pi 按 128k 回退，等于静默降级；
 * - reasoning / thinkingLevelMap：模板总是有立场（未声明也默认开放思考档位），
 *   始终按模板重置，模板没有映射时清空（如 reasoning:false 的纯文本模型）。
 */
export function applyAdaptiveTemplateReset(
	model: ModelItem,
	template: AdaptiveModelTemplate,
): ModelItem {
	const next: ModelItem = { ...model };
	if (template.contextWindow != null) next.contextWindow = template.contextWindow;
	if (template.maxTokens != null) next.maxTokens = template.maxTokens;
	if (template.input && template.input.length > 0) next.input = [...template.input];
	if (template.reasoning !== undefined) next.reasoning = template.reasoning;
	if (template.thinkingLevelMap) next.thinkingLevelMap = { ...template.thinkingLevelMap };
	else delete next.thinkingLevelMap;
	return next;
}
