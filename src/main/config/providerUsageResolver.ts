/**
 * Provider 名称 → 用量查询端点配置的解析（主进程，纯函数可单测）。
 *
 * 会话运行时 provider 名可能是两种来源：
 * - pi 侧：models.json 的 provider key（如 "oc"，含 baseUrl/apiKey/api/models）；
 * - DSH 侧：网关/route 名（如 "opencode-go"）。DSH 端点以 settings.yaml 的
 *   profile 优先（见 ConfigManager.resolveUsageEndpoint 的 dsh 分支），本解析是
 *   其兜底——pi 精确命中后回退 pi-ai catalog 默认端点。
 *
 * 同一网关可能同时存在两套名字（models.json 的 "oc" 与 catalog 的
 * "opencode-go"），因此解析顺序固定为：先 models.json 精确命中，再无 catalog
 * 兜底。apiKey 只用于主进程发请求，绝不回传渲染层（fetchProviderUsage 内部
 * 对响应做脱敏）。
 * TokenDance 等外部供应商由用户确认写入 models.json 后走第一段命中，无需特判。
 */
import type { PiAuthFile, PiModelsFile, PiProviderConfig } from "./ConfigManager";
import { resolvePiApiKey } from "./providerMigration";

/** 从 PiProviderConfig 的安全抽出 headers（index signature 实为 unknown，需收窄为对象）。 */
export function safeProviderHeaders(config: PiProviderConfig | undefined): Record<string, string> | undefined {
	const h = config && typeof config === "object" && config.headers;
	if (!h || typeof h !== "object" || Array.isArray(h)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
		if (typeof v === "string") out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export type ResolvedProviderEndpoint = {
	/** 解析输入的 provider 名原样带回（供上层展示/日志）。 */
	provider: string;
	baseUrl?: string;
	apiKey?: string;
	apiType?: string;
	headers?: Record<string, string>;
	/** 解析是否命中（models.json 或 catalog）。 */
	matched: boolean;
};

/** 解析所需的外部读取能力，注入以便单测（不直接依赖 ConfigManager 实例）。 */
export type ProviderEndpointLookup = {
	getModelsConfig: () => Promise<{ parsed: PiModelsFile | undefined }>;
	getAuthConfig: () => Promise<{ parsed: PiAuthFile | undefined }>;
	/** catalog 兜底适配器：返回一个可选的基础配置（来自 pi-ai 目录首个条目）。 */
	catalogProvider: (provider: string) => PiProviderConfig | undefined;
};

/**
 * 按 provider 名解析用量查询端点。
 * 顺序：models.json 精确 key（含内联/apiAuth key）→ pi-ai catalog 兜底。
 * 返回 matched=false 表示未命中，上层据此给出「暂不支持」文案。
 */
export async function resolveProviderUsageEndpoint(
	lookup: ProviderEndpointLookup,
	provider: string,
): Promise<ResolvedProviderEndpoint> {
	const name = provider?.trim() ?? "";
	if (!name) return { provider: name, matched: false };

	const [modelsRes, authRes] = await Promise.all([
		lookup.getModelsConfig(),
		lookup.getAuthConfig(),
	]);
	const providers = modelsRes.parsed?.providers ?? {};
	const auth = authRes.parsed ?? {};

	// 1) models.json 精确命中（pi 侧 provider，含内联 key 或 auth[key]）。
	const providerConfig = providers[name];
	if (providerConfig) {
		const apiKey = resolvePiApiKey(providerConfig, auth[name]);
		return {
			provider: name,
			baseUrl: providerConfig.baseUrl,
			apiKey,
			apiType: providerConfig.api ?? "openai-completions",
			headers: safeProviderHeaders(providerConfig),
			matched: !!providerConfig.baseUrl,
		};
	}

	// 2) catalog 兜底（DSH 的 route 名如 "opencode-go"，走内置目录默认端点）。
	const catalog = lookup.catalogProvider(name);
	if (catalog) {
		const apiKey = resolvePiApiKey(catalog, auth[name]);
		return {
			provider: name,
			baseUrl: catalog.baseUrl,
			apiKey,
			apiType: catalog.api ?? "openai-completions",
			headers: safeProviderHeaders(catalog),
			matched: !!catalog.baseUrl,
		};
	}

	return { provider: name, matched: false };
}