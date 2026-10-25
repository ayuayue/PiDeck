/**
 * 「按模型/供应商走代理」名单是否已启用（纯函数，主进程策略与渲染层设置页共用）。
 *
 * 为什么放在 shared：名单一旦非空，pi 代理策略就完全由名单决定（名单内强制走代理、
 * 名单外强制直连），主开关「启用 Pi agent 代理」不再参与任何决策——见
 * src/main/sessions/sessionProxyPolicy.ts 的 resolveListedProxyMode / resolveDshHostProxyMode。
 * 设置页据此把主开关置灰并给出提示；两处若各写一份判断，策略调整时提示会静默失真。
 *
 * 供应商名单（piProxyProviders）是旧版字段，UI 入口已移除，但升级前已配置的数据仍需
 * 参与判断（与 resolveListedProxyMode 的兼容读取一致）。
 */
export function hasPiProxyListFilter(piProxyProviders: ReadonlyArray<string> | undefined, piProxyModels: ReadonlyArray<string> | undefined): boolean {
	return (piProxyProviders?.length ?? 0) > 0 || (piProxyModels?.length ?? 0) > 0;
}

/** models.json 里配置的供应商摘要：名称 + 模型条目数。模型条目数决定「pi 为什么没列出它」的归类。 */
export type ConfiguredProviderSummary = { name: string; modelCount: number };

/**
 * 从 models.json 解析结果里读出供应商摘要（纯函数）。
 * 只认 `providers[name].models` 数组，判据与 src/main/pi/modelListCache.ts 的 modelsFromPiConfig 一致——
 * 两处对「这个供应商有没有模型」结论不同，就会把用户指向错误的修复动作。
 */
export function configuredProviderSummariesFromModelsConfig(modelsFile: unknown): ConfiguredProviderSummary[] {
	if (!modelsFile || typeof modelsFile !== "object" || Array.isArray(modelsFile)) return [];
	const providers = (modelsFile as { providers?: unknown }).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
	const summaries: ConfiguredProviderSummary[] = [];
	for (const [name, config] of Object.entries(providers)) {
		if (!name) continue;
		const models = config && typeof config === "object" && !Array.isArray(config) ? (config as { models?: unknown }).models : undefined;
		summaries.push({ name, modelCount: Array.isArray(models) ? models.length : 0 });
	}
	return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把「models.json 里有、pi 的报告里没有」的供应商按原因分组（纯函数）。
 *
 * 为什么必须分开：pi 只列出凭据可解析的供应商（pi docs/models.md「The picker shows models whose
 * providers have usable authentication」），而 PiDeck 允许保存不带 API Key 的供应商（走 /login 或
 * 环境变量的场景也合法）。于是出现「设置页有 / 会话模型选择器与代理名单没有」（issue #356）。
 * 两种原因的可操作动作完全不同——补凭据 vs 补模型——混成一句提示就会把人引向错误的修复。
 */
export function splitUnlistedProviders(configured: ReadonlyArray<ConfiguredProviderSummary>, reported: ReadonlyArray<string>): { withModels: string[]; withoutModels: string[] } {
	const reportedSet = new Set(reported);
	const withModels: string[] = [];
	const withoutModels: string[] = [];
	for (const provider of configured) {
		if (!provider.name || reportedSet.has(provider.name)) continue;
		if (provider.modelCount > 0) withModels.push(provider.name);
		else withoutModels.push(provider.name);
	}
	const byName = (a: string, b: string) => a.localeCompare(b);
	return { withModels: withModels.sort(byName), withoutModels: withoutModels.sort(byName) };
}
