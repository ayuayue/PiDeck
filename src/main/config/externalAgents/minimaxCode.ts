/**
 * MiniMax Code 配置发现：~/.minimax/config.yaml
 * 结构 {provider: {<id>: {name, npm, options: {apiKey, baseURL}, models: {<modelId>: {...}}, model_order: [...]}}}
 * 顶层 defaultModel 形如 "<providerId>/<modelId>"。YAML 用项目已有依赖 js-yaml 解析（同 dsh 各 profile 模块）。
 */
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, readSmallFile, limitModelIds } from "./shared";

export type MinimaxParsedProvider = { id: string; name?: string; baseUrl?: string; apiKey?: string; modelIds: string[] };

export function parseMinimaxConfig(text: string): { providers: MinimaxParsedProvider[] } {
	let parsed: unknown;
	try {
		parsed = loadYaml(text);
	} catch {
		return { providers: [] };
	}
	const root = asRecord(parsed);
	const table = root ? asRecord(root["provider"]) : undefined;
	if (!root || !table) return { providers: [] };
	const out: MinimaxParsedProvider[] = [];
	for (const [id, raw] of Object.entries(table)) {
		const item = asRecord(raw);
		if (!item) continue;
		const options = asRecord(item["options"]);
		const models = asRecord(item["models"]);
		const order = Array.isArray(item["model_order"]) ? item["model_order"].filter((v): v is string => typeof v === "string") : [];
		const modelIds = order.length > 0 ? order : models ? Object.keys(models) : [];
		out.push({
			id,
			name: asString(item["name"]),
			baseUrl: options ? (asString(options["baseURL"]) ?? asString(options["baseUrl"])) : undefined,
			apiKey: options ? asString(options["apiKey"]) : undefined,
			modelIds,
		});
	}
	void root["defaultModel"];
	return { providers: out };
}

export async function discoverMinimaxCode(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const text = await readSmallFile(join(home, ".minimax", "config.yaml"));
	if (!text) return { found: false, providers: [] };
	const providers: ExternalAgentProviderFound[] = [];
	for (const provider of parseMinimaxConfig(text).providers) {
		if (!provider.baseUrl && !provider.apiKey) continue;
		providers.push({
			id: `minimax-code:${provider.id}`,
			agent: "minimax-code",
			providerName: uniqueName(provider.name ?? `minimax-${provider.id}`, "minimax"),
			apiType: "openai-completions",
			baseUrl: provider.baseUrl,
			apiKeyMasked: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? maskKey(provider.apiKey) : undefined,
			modelIds: limitModelIds(provider.modelIds),
			note: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? undefined : "no-key",
		});
	}
	return { found: providers.length > 0, providers };
}

export async function resolveMinimaxKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const text = await readSmallFile(join(home, ".minimax", "config.yaml"));
	if (!text) return { ok: false, error: "config not found" };
	const provider = parseMinimaxConfig(text).providers.find((p) => p.id === detail);
	if (!provider?.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: provider.apiKey };
}
