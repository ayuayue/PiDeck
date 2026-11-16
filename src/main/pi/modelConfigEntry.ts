/**
 * models.json 单个模型条目 → 会话选择器模型。
 *
 * 为什么单独成模块：这是 CLI 失败时唯一的模型来源（见 modelListCache.modelsFromPiConfig），
 * 而兜底列表必须带上思考能力——没有 thinkingLevels，选择器就不会按模型裁剪档位，
 * 旧的 xhigh/max 会一路写进会话记录，底栏显示与 pi 收敛后的实际档位不一致（#545）。
 * 与 PiModelCapabilityCache 的分工：这里只解析配置文件本身，不跑 pi 探测；
 * 档位按 pi `getSupportedThinkingLevels` 的同一套规则（见 enabledModelThinkingLevels）推导。
 */

import type { AvailableModel } from "../../shared/types";
import type { ThinkingLevelMap } from "../../shared/types/modelSpecs";
import { enabledModelThinkingLevels } from "../../shared/modelThinkingLevels";

/** 形状不合法（无 id / 非对象）返回 undefined，由调用方跳过该条目。 */
export function modelFromPiConfigEntry(provider: string, item: unknown): AvailableModel | undefined {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	if (typeof record.id !== "string" || !record.id) return undefined;
	const reasoning = record.reasoning === true;
	const rawMap = record.thinkingLevelMap;
	const thinkingLevelMap = rawMap && typeof rawMap === "object" && !Array.isArray(rawMap) ? (rawMap as ThinkingLevelMap) : undefined;
	const input = record.input;
	return {
		provider,
		id: record.id,
		name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : record.id,
		reasoning,
		contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : undefined,
		maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : undefined,
		images: Array.isArray(input) ? input.includes("image") : undefined,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		thinkingLevels: enabledModelThinkingLevels({ reasoning, thinkingLevelMap }),
	};
}
