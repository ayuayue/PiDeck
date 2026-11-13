import type { ModelsFile } from "../configTypes";
import type { ProviderModelIdIndex } from "../../../../shared/types/modelSpecs";

/**
 * provider → 该供应商当前模型 id 集合（配置写盘前清理孤儿键用）。
 * 只包含 models.json 里的供应商：不在表里的 provider 一律不动——pi 内置 provider
 * （没写进用户 models.json 的 anthropic 等）的档位与隐藏设置是合法的。
 */
export function modelIdIndex(providers: ModelsFile["providers"]): ProviderModelIdIndex {
	return new Map(Object.entries(providers).map(([name, provider]) => [name, new Set(provider.models.map((model) => model.id).filter(Boolean))] as const));
}
