import type { ModelSpec } from "../../shared/types/modelSpecs";
import { findModelCapabilityMatch, modelCapabilityMatchToSpec, plausibleContextWindow, plausibleMaxTokens, type ModelCapabilityCandidate, type ModelCapabilityLookupInput } from "./modelCapabilityMatch";
import { getPiAiCatalogEntries, piAiCatalogEntryType, type PiAiCatalogIndex } from "./piAiBuiltinCatalog";

function asInput(values: readonly string[] | undefined): Array<"text" | "image"> | undefined {
	if (!values) return undefined;
	const input = values.filter((value): value is "text" | "image" => value === "text" || value === "image");
	return input.length > 0 ? input : undefined;
}

/**
 * bundled 官方目录 → 能力补全候选。
 *
 * 只收 chat 条目：这个入口服务的是「给聊天模型填容量/图片/思考档位模板」，而旧版产物
 * 混进了 image / classifier 模型（同名时会把生图条目的空容量当作聊天模型规格）。
 * 容量在这里过一次值域护栏：目录产物可能被覆盖层/未来版本写坏，坏值不参与匹配。
 */
function piAiCandidates(index: PiAiCatalogIndex): ModelCapabilityCandidate[] {
	return getPiAiCatalogEntries(index).flatMap((entry) => {
		if (piAiCatalogEntryType(entry) !== "chat") return [];
		const provider = entry.provider?.trim();
		if (!provider || !entry.id.trim()) return [];
		const contextWindow = plausibleContextWindow(entry.contextWindow);
		const maxTokens = plausibleMaxTokens(entry.maxTokens, contextWindow);
		return [
			{
				source: "pi-ai" as const,
				provider,
				id: entry.id,
				...(entry.name ? { name: entry.name } : {}),
				...(contextWindow !== undefined ? { contextWindow } : {}),
				...(maxTokens !== undefined ? { maxTokens } : {}),
				...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
				...(asInput(entry.input) ? { input: asInput(entry.input) } : {}),
				...(entry.thinkingLevelMap ? { thinkingLevelMap: { ...entry.thinkingLevelMap } } : {}),
			},
		];
	});
}

/**
 * 配置阶段的自适应模板解析：**只读官方 pi-ai 目录**。
 *
 * 为什么不再读运行中 pi 的模型列表（pi --list-models）：那条链是 pi 对 models.json 的
 * **解析后视图**，对自定义条目会套上 `contextWindow ?? 128000`、`maxTokens ?? 16384`、
 * `reasoning ?? false`、`input ?? ["text"]` 的兜底（见 pi dist/core/provider-composer.js）；
 * 于是「空字段」与「真的是 128K / 不支持思考」在数据上无法区分，我们自己的配置被回显成
 * 事实并压过官方目录（实测：新加一行 deepseek-v4.1-flash 会被写成 128000/16400/false，
 * 而官方目录的正确值是 1048576/384000/text+image）。表格还是人类可读格式（1.0M/16.4K），
 * 回读另有 <1% 的精度损失。
 *
 * 端点 /models 实报字段仍由渲染层在 mergeAdaptiveModelTemplate 中优先合并（那是中转站
 * 自己的实报值，属于第一手信息）；目录落后于 pi 的问题交给「模型目录更新」功能解决，
 * 不靠读取解析后视图兜。
 */
export function resolveModelSpecFromCatalogs(input: ModelCapabilityLookupInput, index: PiAiCatalogIndex): ModelSpec | null {
	const match = findModelCapabilityMatch(input, piAiCandidates(index));
	return match ? modelCapabilityMatchToSpec(match) : null;
}
