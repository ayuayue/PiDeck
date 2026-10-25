/**
 * ZCode 配置发现：~/.zcode/v2/config.json
 * 结构 {provider: {<id>: {name, kind: "anthropic"|"openai", enabled, source: "custom"|"builtin", options: {apiKey, baseURL}, models: {...}}}}
 * 只取 source=custom 的供应商：builtin:* 是对方内置的官方端点（多为 OAuth/套餐登录），不是用户自己的配置。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, parseJson, readSmallFile, limitModelIds } from "./shared";

export type ZcodeParsedProvider = { id: string; name?: string; baseUrl?: string; apiKey?: string; kind?: string; enabled?: boolean; source?: string; modelIds: string[] };

export function parseZcodeConfig(text: string): { providers: ZcodeParsedProvider[] } {
	const parsed = parseJson(text);
	const table = parsed ? asRecord(parsed["provider"]) : undefined;
	if (!table) return { providers: [] };
	const out: ZcodeParsedProvider[] = [];
	for (const [id, raw] of Object.entries(table)) {
		const item = asRecord(raw);
		if (!item) continue;
		const options = asRecord(item["options"]);
		const models = asRecord(item["models"]);
		out.push({
			id,
			name: asString(item["name"]),
			baseUrl: options ? (asString(options["baseURL"]) ?? asString(options["baseUrl"])) : undefined,
			apiKey: options ? asString(options["apiKey"]) : undefined,
			kind: asString(item["kind"]),
			enabled: item["enabled"] !== false,
			source: asString(item["source"]),
			modelIds: models ? Object.keys(models) : [],
		});
	}
	return { providers: out };
}

export async function discoverZcode(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const text = await readSmallFile(join(home, ".zcode", "v2", "config.json"));
	if (!text) return { found: false, providers: [] };
	const providers: ExternalAgentProviderFound[] = [];
	for (const provider of parseZcodeConfig(text).providers) {
		// builtin:* 是对方内置的官方端点（OAuth/套餐），导入到 pi 没有可用 key；custom 才是用户自建配置。
		if (provider.source === "builtin" || provider.id.startsWith("builtin:")) continue;
		if (!provider.baseUrl && !provider.apiKey) continue;
		providers.push({
			id: `zcode:${provider.id}`,
			agent: "zcode",
			providerName: uniqueName(provider.name ?? provider.id, "zcode"),
			apiType: provider.kind === "openai" ? "openai-completions" : "anthropic-messages",
			baseUrl: provider.baseUrl,
			apiKeyMasked: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? maskKey(provider.apiKey) : undefined,
			modelIds: limitModelIds(provider.modelIds),
			note: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? undefined : "no-key",
		});
	}
	return { found: providers.length > 0, providers };
}

export async function resolveZcodeKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const text = await readSmallFile(join(home, ".zcode", "v2", "config.json"));
	if (!text) return { ok: false, error: "config not found" };
	const provider = parseZcodeConfig(text).providers.find((p) => p.id === detail);
	if (!provider?.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: provider.apiKey };
}
