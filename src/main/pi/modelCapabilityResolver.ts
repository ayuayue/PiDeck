import type { ModelSpec } from "../../shared/types/modelSpecs";
import type { AvailableModel } from "../../shared/types/agent";
import {
  findModelCapabilityMatch,
  modelCapabilityMatchToSpec,
  type ModelCapabilityCandidate,
  type ModelCapabilityLookupInput,
} from "./modelCapabilityMatch";
import {
  getPiAiCatalogEntries,
  type PiAiCatalogIndex,
} from "./piAiBuiltinCatalog";

function asInput(values: readonly string[] | undefined): Array<"text" | "image"> | undefined {
  if (!values) return undefined;
  const input = values.filter((value): value is "text" | "image" => value === "text" || value === "image");
  return input.length > 0 ? input : undefined;
}

function piAiCandidates(index: PiAiCatalogIndex): ModelCapabilityCandidate[] {
  return getPiAiCatalogEntries(index).flatMap((entry) => {
    const provider = entry.provider?.trim();
    if (!provider || !entry.id.trim()) return [];
    return [{
      source: "pi-ai" as const,
      provider,
      id: entry.id,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
      ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
      ...(asInput(entry.input) ? { input: asInput(entry.input) } : {}),
      ...(entry.thinkingLevelMap ? { thinkingLevelMap: { ...entry.thinkingLevelMap } } : {}),
    }];
  });
}

/**
 * 运行中 pi 的模型列表 → 候选（source: pi-runtime）。
 * 数据来自 pi --list-models（含内置目录 + auth.json/models.json 覆盖后的解析值），
 * 即「用户正在跑的 pi 实际会用的容量」，比 bundled 快照新。
 * pi 表格没有 thinkingLevelMap，该字段仍由 bundled catalog 补足（见 piAiCandidates）。
 */
function piRuntimeCandidates(
  runtimeModels: readonly AvailableModel[],
  bundledByKey: Map<string, ModelCapabilityCandidate>,
): ModelCapabilityCandidate[] {
  return runtimeModels.flatMap((model) => {
    const provider = model.provider?.trim();
    const id = model.id?.trim();
    if (!provider || !id) return [];
    const fallbackName = `${provider}/${id}`;
    const candidate: ModelCapabilityCandidate = {
      source: "pi-runtime" as const,
      provider,
      id,
      // name 与解析器拼的默认名一致时省略，避免污染别名匹配
      ...(model.name && model.name !== fallbackName ? { name: model.name } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      // images 列 yes 是图片能力的正向信号；no 可能是旧 pi 不报该列，不据此推断纯文本
      ...(asInput(model.input) ? { input: asInput(model.input) } : {}),
      ...(asInput(model.input) === undefined && model.images === true
        ? { input: ["text", "image"] as const }
        : {}),
    };
    // CLI 回退到 models.json 时条目可能缺容量（用户没填）；同 provider+id 的
    // bundled 条目已知则补空，避免 choosePreferred 因 source 优先丢掉已知容量。
    const bundled = bundledByKey.get(`${provider}\0${id}`);
    if (bundled) {
      if (candidate.contextWindow === undefined && bundled.contextWindow !== undefined) {
        candidate.contextWindow = bundled.contextWindow;
      }
      if (candidate.maxTokens === undefined && bundled.maxTokens !== undefined) {
        candidate.maxTokens = bundled.maxTokens;
      }
      if (candidate.reasoning === undefined && bundled.reasoning !== undefined) {
        candidate.reasoning = bundled.reasoning;
      }
      if (!candidate.input && bundled.input) candidate.input = [...bundled.input];
    }
    return [candidate];
  });
}

/**
 * 配置阶段的自适应模板解析：运行中 pi 模型列表优先，PiDeck 自带 bundled catalog 兜底。
 * 不读 capability cache（那是输入框/思考强度的运行时快照，属于另一个消费面）。
 *
 * 修复「bundled 快照落后于运行中 pi」导致的匹配不到留空：当外部 Pi 已收录的新模型
 * 尚未进入 PiDeck bundled catalog 时，旧逻辑会匹配失败、字段留空，Pi 回退 128k
 * 静默降级。现在先按运行中 pi 实报（pi-runtime，sourcePriority 更高）
 * 匹配，bundled catalog 只负责补 thinkingLevelMap 等 pi 表格不带的字段。
 * endpoint /models 实报字段仍由渲染层在 mergeAdaptiveModelTemplate 中优先合并。
 */
export function resolveModelSpecFromCatalogs(
  input: ModelCapabilityLookupInput,
  index: PiAiCatalogIndex,
  runtimeModels?: readonly AvailableModel[],
): ModelSpec | null {
  const bundled = piAiCandidates(index);
  // 按 provider+id 建索引，供运行中 pi 条目补空（见 piRuntimeCandidates）
  const bundledByKey = new Map<string, ModelCapabilityCandidate>();
  for (const candidate of bundled) bundledByKey.set(`${candidate.provider}\0${candidate.id}`, candidate);
  const candidates = [
    ...(runtimeModels ? piRuntimeCandidates(runtimeModels, bundledByKey) : []),
    ...bundled,
  ];
  const match = findModelCapabilityMatch(input, candidates);
  return match ? modelCapabilityMatchToSpec(match) : null;
}

/**
 * 配置阶段的自适应模板解析（仅 bundled pi-ai catalog，测试/兜底路径）。
 * 生产走 resolveModelSpecFromCatalogs；此函数保留 bundled-only 语义供单测与
 * 无运行中 pi 信息（未安装/解析失败）时回退。
 */
export function resolveModelSpecFromPiCatalogs(
  input: ModelCapabilityLookupInput,
  index: PiAiCatalogIndex,
): ModelSpec | null {
  return resolveModelSpecFromCatalogs(input, index);
}
