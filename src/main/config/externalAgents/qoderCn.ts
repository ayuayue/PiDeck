/**
 * Qoder CN 配置发现：~/.qoder-cn/settings.json
 * 结构 {providers: {<id>: {apiKey, baseUrl, displayName, protocol: "openai"|"anthropic", models: [{model, displayName, ...}]}}, model: {name: "<provider>/<model>"}}
 * 只取自定义 providers（官方登录态走 .auth/ 下的凭据，不在本文件，无法只读导出）。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, parseJson, readSmallFile, limitModelIds } from "./shared";

export type QoderCnParsedProvider = { id: string; name?: string; baseUrl?: string; apiKey?: string; protocol?: string; modelIds: string[] };

export function parseQoderCnSettings(text: string): { providers: QoderCnParsedProvider[] } {
	const parsed = parseJson(text);
	const table = parsed ? asRecord(parsed["providers"]) : undefined;
	if (!table) return { providers: [] };
	const out: QoderCnParsedProvider[] = [];
	for (const [id, raw] of Object.entries(table)) {
		const item = asRecord(raw);
		if (!item) continue;
		const models = Array.isArray(item["models"]) ? item["models"] : [];
		const modelIds: string[] = [];
		for (const entry of models) {
			const model = asRecord(entry);
			const modelId = model ? (asString(model["model"]) ?? asString(model["id"])) : undefined;
			if (modelId) modelIds.push(modelId);
		}
		out.push({
			id,
			name: asString(item["displayName"]),
			baseUrl: asString(item["baseUrl"]),
			apiKey: asString(item["apiKey"]),
			protocol: asString(item["protocol"]),
			modelIds,
		});
	}
	return { providers: out };
}

export async function discoverQoderCn(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const text = await readSmallFile(join(home, ".qoder-cn", "settings.json"));
	if (!text) return { found: false, providers: [] };
	const providers: ExternalAgentProviderFound[] = [];
	for (const provider of parseQoderCnSettings(text).providers) {
		if (!provider.baseUrl && !provider.apiKey) continue;
		providers.push({
			id: `qoder-cn:${provider.id}`,
			agent: "qoder-cn",
			providerName: uniqueName(provider.name ?? provider.id, "qoder"),
			apiType: provider.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
			baseUrl: provider.baseUrl,
			apiKeyMasked: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? maskKey(provider.apiKey) : undefined,
			modelIds: limitModelIds(provider.modelIds),
			note: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? undefined : "no-key",
		});
	}
	return { found: providers.length > 0, providers };
}

export async function resolveQoderCnKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const text = await readSmallFile(join(home, ".qoder-cn", "settings.json"));
	if (!text) return { ok: false, error: "config not found" };
	const provider = parseQoderCnSettings(text).providers.find((p) => p.id === detail);
	if (!provider?.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: provider.apiKey };
}
