/**
 * Qwen Code 配置发现：~/.qwen/settings.json
 * 结构 {modelProviders: {<family>: [{id,name,baseUrl,envKey}]}, env: {<envKey>: "sk-..."}}。
 * provider 的 key 在顶层 env 表里按 envKey 关联（官方文档 users/configuration/auth.md）。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, asStringRecord, hostNameFromUrl, isPlaceholderKey, maskKey, parseJson, readSmallFile } from "./shared";

export type QwenParsedProvider = { id: string; name?: string; baseUrl?: string; envKey?: string };

export function parseQwenSettings(text: string): { providers: QwenParsedProvider[]; env: Record<string, string>; authType?: string } {
	const parsed = parseJson(text);
	if (!parsed) return { providers: [], env: {} };
	const env = asStringRecord(parsed["env"]) ?? {};
	const providers: QwenParsedProvider[] = [];
	// modelProviders 是分组结构：{openai: [provider...], anthropic: [...]}。
	const groups = asRecord(parsed["modelProviders"]);
	if (groups) {
		for (const [group, raw] of Object.entries(groups)) {
			if (!Array.isArray(raw)) continue;
			for (const entry of raw) {
				const item = asRecord(entry);
				if (!item) continue;
				const id = asString(item["id"]);
				if (!id) continue;
				providers.push({
					id: `${group}/${id}`,
					name: asString(item["name"]) ?? id,
					baseUrl: asString(item["baseUrl"]),
					envKey: asString(item["envKey"]),
				});
			}
		}
	}
	const auth = asRecord(parsed["auth"]) ?? asRecord(asRecord(parsed["security"])?.["auth"]);
	const authType = auth ? asString(auth["selectedType"]) : undefined;
	return { providers, env, authType };
}

export async function discoverQwenCode(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const configText = await readSmallFile(join(home, ".qwen", "settings.json"));
	if (!configText) return { found: false, providers: [] };
	const parsed = parseQwenSettings(configText);
	const providers: ExternalAgentProviderFound[] = [];
	for (const provider of parsed.providers) {
		if (!provider.baseUrl && !provider.envKey) continue;
		const key = provider.envKey ? parsed.env[provider.envKey] : undefined;
		providers.push({
			id: `qwen-code:${provider.id}`,
			agent: "qwen-code",
			providerName: uniqueName(provider.name ?? provider.id, "qwen"),
			apiType: provider.id.startsWith("anthropic") ? "anthropic-messages" : "openai-completions",
			baseUrl: provider.baseUrl,
			apiKeyMasked: key && !isPlaceholderKey(key) ? maskKey(key) : undefined,
			modelIds: [],
			note: key && !isPlaceholderKey(key) ? undefined : "no-key",
		});
	}
	// 无自定义 provider 且是 OAuth 登录（qwen-oauth / oauth-cloud）时只提示。
	if (!providers.length && parsed.authType?.includes("oauth")) {
		return { found: true, providers: [{ id: "qwen-code:oauth", agent: "qwen-code", providerName: uniqueName("qwen-subscription", "qwen"), apiType: "openai-completions", modelIds: [], note: `subscription:${parsed.authType}` }] };
	}
	return { found: providers.length > 0, providers };
}

export async function resolveQwenKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const configText = await readSmallFile(join(home, ".qwen", "settings.json"));
	if (!configText) return { ok: false, error: "config not found" };
	const parsed = parseQwenSettings(configText);
	const provider = parsed.providers.find((p) => p.id === detail);
	if (!provider?.envKey) return { ok: false, error: "no api key" };
	const key = parsed.env[provider.envKey];
	if (!key) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: key };
}
