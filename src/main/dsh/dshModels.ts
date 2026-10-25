import type { AvailableModel, DshDiscoveredModel, FetchedModel } from "../../shared/types";
import type { ModelCatalog, ModelSelection } from "@deepseek-ai/dsh-api-session-controller/types";

/** 按上游 wire 形状验证；描述文字允许空串，不替适配器发明额外约束。 */
function isModelSelection(value: unknown): value is ModelSelection {
	return isRecord(value) && typeof value.provider === "string" && value.provider.length > 0 && typeof value.model === "string" && value.model.length > 0 && (value.reasoningEffort === undefined || typeof value.reasoningEffort === "string");
}

/**
 * DSH prompt 准入拒绝带图消息（模型输入模态声明为纯文本）。
 *
 * dsh-api-session-controller 在受理 prompt 前检查 `model.inputModalities`：
 * 已声明且不含 image 时直接抛 session/attachment-invalid + reason
 * MODEL_DOES_NOT_SUPPORT_IMAGES，请求不会到达模型。配置侧的修法是给模型把
 * 输入模态设为 text+image（见 DSH 配置页模型编辑器的「输入模态」）。
 * 这里只负责把该结构化错误识别出来，供发送层映射成可操作文案，而不是把
 * 原始 JSON 丢给用户。
 */
export function isDshModelImageUnsupportedRejection(error: unknown): boolean {
	if (!isRecord(error) || error.code !== "session/attachment-invalid") return false;
	const details = isRecord(error.details) ? error.details : undefined;
	if (details?.reason === "MODEL_DOES_NOT_SUPPORT_IMAGES") return true;
	// 旧版宿主可能不带 details.reason，按稳定文案兜底。
	return typeof error.message === "string" && error.message.includes("does not support image input");
}

function isModelReasoning(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.defaultEffort === undefined || typeof value.defaultEffort === "string") &&
		Array.isArray(value.efforts) &&
		value.efforts.every((effort: unknown) => isRecord(effort) && typeof effort.id === "string" && typeof effort.name === "string" && (effort.description === undefined || typeof effort.description === "string"))
	);
}

function isCatalogModel(value: unknown): boolean {
	return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && (value.description === undefined || typeof value.description === "string") && (value.reasoning === undefined || isModelReasoning(value.reasoning));
}

function isModelCatalog(value: unknown): value is ModelCatalog {
	return (
		isRecord(value) &&
		isModelSelection(value.default) &&
		Array.isArray(value.routableProviders) &&
		value.routableProviders.every((provider: unknown) => typeof provider === "string") &&
		Array.isArray(value.groups) &&
		value.groups.every((group: unknown) => isRecord(group) && typeof group.id === "string" && typeof group.name === "string" && Array.isArray(group.models) && group.models.every(isCatalogModel)) &&
		Array.isArray(value.failures) &&
		value.failures.every((failure: unknown) => isRecord(failure) && typeof failure.id === "string" && typeof failure.name === "string" && typeof failure.message === "string")
	);
}

/** RPC 结果仍是 unknown；消费前验证，不引入运行时 SDK 依赖或用断言伪装 wire 安全。 */
export function parseDshModelCatalog(value: unknown): ModelCatalog {
	if (!isModelCatalog(value)) throw new Error("Invalid DSH model catalog");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 官方 modelSelection 投影：下一次请求的选择优先，不能拿 host 默认覆盖已有会话。 */
export function readDshModelSelection(value: unknown): ModelSelection | null {
	if (!isRecord(value)) throw new Error("DSH model selection projection is unavailable");
	if ((value.next !== null && !isModelSelection(value.next)) || (value.lastUsed !== null && !isModelSelection(value.lastUsed))) throw new Error("DSH model selection projection is invalid");
	return value.next ?? value.lastUsed;
}

/** 目录与冷读投影合成旧宿主视图；目录成员资格不决定 provider 是否可路由。 */
export function resolveDshModelDirectory(catalog: ModelCatalog, projection: unknown): { current: ModelSelection; routable: boolean } {
	if (!isRecord(projection) || !isRecord(projection.values)) throw new Error("DSH model selection projection is unavailable");
	const current = readDshModelSelection(projection.values.modelSelection) ?? catalog.default;
	return { current, routable: catalog.routableProviders.includes(current.provider) };
}

/**
 * DSH host 模型目录 → PiDeck AvailableModel 列表（纯函数，可单测）。
 *
 * 输入是 host wire 的 ModelProviderGroup[]（llm.models / session.models 同构），
 * 输出透传每个模型声明支持的思考档位（reasoning.efforts）——选择器按模型过滤档位，
 * 否则 DSH deepseek 适配器只接受 off/high/max、llm-pi-ai 按模型声明，选不支持的档位
 * 会在下次 LLM 请求抛 UNSUPPORTED_REASONING_EFFORT（回合失败）。
 *
 * 结构性收窄（非 as 断言）：wire 类型（ModelProviderGroup/ModelCatalogModel/ModelReasoning）
 * 与本结构逐字段兼容，仅声明本项目消费的字段，避免主进程模块与 proxy 包类型耦合过深。
 */
export type DshModelGroupInput = {
	id: string;
	models?: ReadonlyArray<{
		id: string;
		name?: string;
		reasoning?: {
			efforts?: ReadonlyArray<{ id: string; name?: string; description?: string }>;
			defaultEffort?: string;
		};
	}>;
};

/** DSH host 模型目录 → PiDeck AvailableModel 列表（纯函数，可单测）。 */
export function toDshAvailableModels(groups: readonly DshModelGroupInput[]): AvailableModel[] {
	const result: AvailableModel[] = [];
	for (const group of groups) {
		for (const model of group.models ?? []) {
			const efforts = Array.isArray(model.reasoning?.efforts)
				? model
						.reasoning!.efforts.map((effort) => {
							const id = typeof effort.id === "string" ? effort.id : "";
							if (!id) return undefined;
							return {
								id,
								...(typeof effort.name === "string" ? { name: effort.name } : {}),
								...(typeof effort.description === "string" ? { description: effort.description } : {}),
							};
						})
						.filter((effort): effort is { id: string; name?: string; description?: string } => effort !== undefined)
				: undefined;
			result.push({
				id: model.id,
				name: model.name,
				provider: group.id,
				...(efforts && efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
				...(typeof model.reasoning?.defaultEffort === "string" && model.reasoning.defaultEffort ? { defaultEffort: model.reasoning.defaultEffort } : {}),
			});
		}
	}
	return result;
}

/** DSH 适配器只认这两种输入模态；其余噪声一律丢弃。 */
function asDshInputModalities(value: unknown): Array<"text" | "image"> | undefined {
	if (!Array.isArray(value)) return undefined;
	const modalities = [...new Set(value.filter((item): item is "text" | "image" => item === "text" || item === "image"))];
	return modalities.length > 0 ? modalities : undefined;
}

/** DSH discovery candidates → the shared config-page fetched-model shape. */
export function toDshFetchedModels(models: DshDiscoveredModel[]): FetchedModel[] {
	const result: FetchedModel[] = [];
	for (const model of models) {
		const id = model.id.trim();
		if (!id) continue;
		// 目录/端点声明的图片能力必须原样带到配置页：否则新增的视觉模型会被写成
		// text-only（DSH llm-pi-ai 缺省 defaultInput=["text"]），带图消息在 prompt
		// 准入阶段被 session/attachment-invalid 直接拒绝（用户反馈「发图片识别不了」）。
		const input = asDshInputModalities(model.inputModalities);
		result.push({
			id,
			...(typeof model.name === "string" && model.name ? { name: model.name } : {}),
			...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
			...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
			...(input ? { input } : {}),
		});
	}
	return result;
}

/**
 * llm/discoverModels RPC 结果解包（纯函数，可单测）。
 *
 * 0.1.5 typert 的线上结果 schema 是**纯数组**（`z.array(z.object({ id, ... }))`，
 * 见 dsh-llm typert.remote-client），但历史上 `DshHost.discoverModels` 曾写成
 * `value.models ?? []`——对数组取 `.models` 恒为 undefined → 配置页「获取模型列表」
 * 永远提示「已获取 0 个模型」。这里按两种可能形态防御性解包：数组本体，或
 * `{ models: [...] }` 包装（宿主若改为对象包装仍兼容）。
 */
export function unwrapDshDiscoveryModels(value: unknown): DshDiscoveredModel[] {
	if (Array.isArray(value)) return value as DshDiscoveredModel[];
	if (typeof value === "object" && value !== null && Array.isArray((value as { models?: unknown }).models)) {
		return (value as { models: DshDiscoveredModel[] }).models;
	}
	return [];
}
