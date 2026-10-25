/**
 * 解析 provider `/models` 响应（与 dsh-web llm-pi-ai/discovery.readListing 对齐）。
 *
 * 容量只在端点真正给出时保留：context_window / context_length（Gemini 的
 * inputTokenLimit 也算 listing 已返回）；max_output_tokens / max_tokens /
 * outputTokenLimit。缺字段不猜默认值——后续由 pi-ai 目录补，再缺就空着。
 *
 * 推理能力声明（reasoning / input / thinkingLevelMap）同样只在端点实报时保留：
 * 自家 pi-ai 等网关会在 /models 直接下发这些字段，自适应模板以端点实报优先。
 */

import type { FetchedModel } from "../../shared/types/fetchedModel";
// 排序键收敛到 shared：/models 结果、配置页保存、模型下拉列表用同一套顺序。
import { sortModelRows } from "../../shared/modelOrder";
import { positiveInt } from "../pi/piAiBuiltinCatalog";
import { parseThinkingLevelMap, plausibleCapacity, plausibleMaxTokens } from "../pi/modelCapabilityMatch";

function nonEmptyString(...candidates: readonly unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

/** 多个候选里取第一个正整数容量（dsh discovery.capacity）；再过一次值域护栏。
 *  转站端点常回荒唐值（实测 max_output_tokens=32763840008），超上限或 max>ctx 一律视为未提供。 */
function capacity(...candidates: readonly unknown[]): number | undefined {
	for (const candidate of candidates) {
		const value = plausibleCapacity(positiveInt(candidate));
		if (value != null) return value;
	}
	return undefined;
}

/**
 * @param body 端点 JSON
 * @param apiType 已规范化的 api（如 google-generative-ai）；用于剥 Gemini `models/` 前缀
 */

/** 保留端点声明的完整输入模态（text/image），其余值一律丢弃 */
function declaredInput(value: unknown): Array<"text" | "image"> | undefined {
	if (!Array.isArray(value)) return undefined;
	const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
	return input.length > 0 ? input : undefined;
}
export function parseProviderModelsResponse(body: unknown, apiType?: string): FetchedModel[] {
	const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	const rawData = Array.isArray(record?.data) ? record.data : Array.isArray(body) ? body : Array.isArray(record?.models) ? record.models : [];

	const models: FetchedModel[] = [];
	for (const raw of rawData) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const model = raw as Record<string, unknown>;
		// id 是字符串就用它（空串跳过，不回落到 name）；无 id 才用 name（Gemini `models/xxx`）
		const rawId = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
		if (!rawId) continue;
		const id = apiType === "google-generative-ai" ? rawId.replace(/^models\//, "") : rawId;
		if (!id) continue;
		const name = nonEmptyString(model.displayName, model.display_name, typeof model.name === "string" ? model.name.replace(/^models\//, "") : undefined);
		const contextWindow = capacity(model.context_window, model.context_length, model.inputTokenLimit, model.contextWindow);
		const maxTokens = plausibleMaxTokens(capacity(model.max_output_tokens, model.max_tokens, model.outputTokenLimit, model.maxTokens), contextWindow);
		// 自家 pi-ai / 网关可在 /models 实报推理与思考档位声明（camelCase，与 FetchedModel 对齐）。
		// 端点实报优先级高于 bundled catalog 模板（mergeAdaptiveModelTemplate 中体现），
		// 这里必须完整保留，不能只留容量字段。
		const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : undefined;
		const input = declaredInput(model.input);
		const thinkingLevelMap = parseThinkingLevelMap(model.thinkingLevelMap);
		models.push({
			id,
			...(name ? { name } : {}),
			...(contextWindow != null ? { contextWindow } : {}),
			...(maxTokens != null ? { maxTokens } : {}),
			...(reasoning !== undefined ? { reasoning } : {}),
			...(input ? { input } : {}),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		});
	}
	// 按展示名正序排列（排序键收敛到 shared/modelOrder，与下拉列表/配置页一致），
	// 避免下拉列表与保存后的顺序随 API 返回乱序。
	return sortModelRows(models);
}
