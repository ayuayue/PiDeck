/**
 * Kimi Code CLI 配置发现（moonshotai）：
 * - ~/.kimi/config.toml（kimi-cli 旧版）与 ~/.kimi-code/config.toml（kimi.com/code 新版），两处都扫。
 *   [providers.<id>] {name?, api_key | api_key_env, base_url?}；顶层 platform/kimi 决定默认供应商。
 */
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, readSmallFile, MAX_AGENT_CONFIG_BYTES } from "./shared";

export type KimiParsedProvider = { id: string; name?: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string };

export function parseKimiConfig(text: string): { providers: KimiParsedProvider[]; platform?: string; defaultModel?: string } {
	if (text.length > MAX_AGENT_CONFIG_BYTES) return { providers: [] };
	try {
		const parsed = parseToml(text) as Record<string, unknown>;
		const providers: KimiParsedProvider[] = [];
		const table = asRecord(parsed["providers"]);
		if (table) {
			for (const [id, raw] of Object.entries(table)) {
				const item = asRecord(raw);
				if (!item) continue;
				providers.push({
					id,
					name: asString(item["name"]),
					baseUrl: asString(item["base_url"]) ?? asString(item["baseURL"]),
					apiKey: asString(item["api_key"]) ?? asString(item["apiKey"]),
					apiKeyEnv: asString(item["api_key_env"]) ?? asString(item["apiKeyEnv"]),
				});
			}
		}
		return { providers, platform: asString(parsed["platform"]) ?? asString(parsed["kimi"]), defaultModel: asString(parsed["model"]) };
	} catch {
		return { providers: [] };
	}
}

export async function discoverKimiCode(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	// 两处路径都扫：~/.kimi/config.toml（kimi-cli）与 ~/.kimi-code/config.toml（kimi.com/code 新版）。
	const candidates = [
		{ dir: ".kimi", prefix: "kimi" },
		{ dir: ".kimi-code", prefix: "kimi-code" },
	];
	const providers: ExternalAgentProviderFound[] = [];
	for (const candidate of candidates) {
		const text = await readSmallFile(join(home, candidate.dir, "config.toml"));
		if (!text) continue;
		const parsed = parseKimiConfig(text);
		for (const provider of parsed.providers) {
			if (!provider.baseUrl && !provider.apiKey) continue;
			providers.push({
				id: `${candidate.prefix}:${provider.id}`,
				agent: "kimi-code",
				providerName: uniqueName(provider.name ?? `kimi-${provider.id}`, "kimi"),
				apiType: provider.id === "anthropic" ? "anthropic-messages" : "openai-completions",
				baseUrl: provider.baseUrl,
				apiKeyMasked: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? maskKey(provider.apiKey) : undefined,
				modelIds: parsed.defaultModel ? [parsed.defaultModel] : [],
				note: provider.apiKey ? undefined : "no-key",
			});
		}
	}
	return { found: providers.length > 0, providers };
}

export async function resolveKimiKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const [prefix, providerId] = detail.split(":");
	const dir = prefix === "kimi-code" ? ".kimi-code" : ".kimi";
	const text = await readSmallFile(join(home, dir, "config.toml"));
	if (!text) return { ok: false, error: "config not found" };
	const parsed = parseKimiConfig(text);
	const provider = parsed.providers.find((p) => p.id === providerId);
	if (!provider?.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: provider.apiKey };
}
