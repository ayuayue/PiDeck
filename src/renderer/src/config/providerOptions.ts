/**
 * 默认供应商下拉的候选聚合（纯函数，可单测）。
 *
 * 来源必须覆盖三处：模型配置（models.json providers）、认证条目（auth keys）、
 * 自动发现（auth-only 供应商通过端点探测，discoveredModels）。
 * 漏掉 discovered 会导致这类供应商在默认供应商下拉里「无匹配选项」、
 * 无法切换，且默认模型的联动过滤随之失效（模型切换列表三源齐全，两边不一致）。
 * 另外固定注入内置 TokenDance（幂等：不管三源里有没有，都出现在候选最前）——
 * 这是 PiDeck 内置供应商入口，用户不需要（也无法）在 pi 配置里手动添加它。
 */
import type { AuthFile, ModelsFile } from "./configTypes";

/** 内置 TokenDance 供应商名（与 providerHeaders.ts 的 KNOWN_PROVIDER_ENDPOINTS 键一致）。 */
export const BUILTIN_TOKENDANCE_PROVIDER = "tokendance";

export function collectProviderOptions(
	modelsData?: ModelsFile,
	authData?: AuthFile,
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>,
): Array<{ value: string }> {
	// 内置供应商最先加入集合 → 迭代序在前，天然置顶；重复加入是幂等的。
	const providerSet = new Set<string>([BUILTIN_TOKENDANCE_PROVIDER]);
	if (modelsData) {
		for (const name of Object.keys(modelsData.providers)) {
			providerSet.add(name);
		}
	}
	if (authData) {
		for (const name of Object.keys(authData)) {
			providerSet.add(name);
		}
	}
	if (discoveredModels) {
		for (const name of Object.keys(discoveredModels)) {
			providerSet.add(name);
		}
	}
	return [...providerSet].map((name) => ({ value: name }));
}
