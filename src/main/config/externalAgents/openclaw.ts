/**
 * OpenClaw 配置发现：~/.openclaw/openclaw.json → models.providers.<id>
 * {api, apiKey, baseUrl, models: [{id, name}]}；api 取值与 pi 的 PROVIDER_API_OPTIONS 基本同构，直接沿用。
 * 顶层 agents.defaults.model.primary 形如 "<provider>/<model>"，只作建议展示。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, parseJson, readSmallFile, limitModelIds } from "./shared";

export type OpenClawParsedProvider = { id: string; name?: string; baseUrl?: string; apiKey?: string; api?: string; modelIds: string[] };

export function parseOpenClawConfig(text: string): { providers: OpenClawParsedProvider[] } {
	const parsed = parseJson(text);
	const models = parsed ? asRecord(parsed["models"]) : undefined;
	const table = models ? asRecord(models["providers"]) : undefined;
	if (!table) return { providers: [] };
	const out: OpenClawParsedProvider[] = [];
	for (const [id, raw] of Object.entries(table)) {
		const item = asRecord(raw);
		if (!item) continue;
		const models = Array.isArray(item["models"]) ? item["models"] : [];
		const modelIds: string[] = [];
		for (const entry of models) {
			const model = asRecord(entry);
			const modelId = model ? asString(model["id"]) : undefined;
			if (modelId) modelIds.push(modelId);
		}
		out.push({
			id,
			baseUrl: asString(item["baseUrl"]),
			apiKey: asString(item["apiKey"]),
			api: asString(item["api"]),
			modelIds,
		});
	}
	return { providers: out };
}

export async function discoverOpenClaw(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const text = await readSmallFile(join(home, ".openclaw", "openclaw.json"));
	if (!text) return { found: false, providers: [] };
	const providers: ExternalAgentProviderFound[] = [];
	for (const provider of parseOpenClawConfig(text).providers) {
		if (!provider.baseUrl && !provider.apiKey) continue;
		providers.push({
			id: `openclaw:${provider.id}`,
			agent: "openclaw",
			providerName: uniqueName(provider.id, "openclaw"),
			// 对方 api 字段就是 pi 的协议名（openai-completions / anthropic-messages / ...），非法值回落 openai-completions。
			apiType: provider.api && /^[a-z-]+$/.test(provider.api) ? provider.api : "openai-completions",
			baseUrl: provider.baseUrl,
			apiKeyMasked: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? maskKey(provider.apiKey) : undefined,
			modelIds: limitModelIds(provider.modelIds),
			note: provider.apiKey && !isPlaceholderKey(provider.apiKey) ? undefined : "no-key",
		});
	}
	return { found: providers.length > 0, providers };
}

export async function resolveOpenClawKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const text = await readSmallFile(join(home, ".openclaw", "openclaw.json"));
	if (!text) return { ok: false, error: "config not found" };
	const provider = parseOpenClawConfig(text).providers.find((p) => p.id === detail);
	if (!provider?.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: provider.apiKey };
}
