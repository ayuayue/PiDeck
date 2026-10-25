/**
 * Crush (charmbracelet) 配置发现：
 * - ~/.local/share/crush/crush.json（TUI 动态写入，优先）与 ~/.config/crush/crush.json（静态）。
 *   providers[].{id, name, base_url, api_key}（官方 internal/config/config.go ProviderConfig）。
 * 两个文件按 provider id 合并，动态文件优先。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, asStringRecord, isPlaceholderKey, maskKey, parseJson, readSmallFile } from "./shared";

export type CrushParsedProvider = { id: string; name?: string; baseUrl?: string; apiKey?: string };

export function parseCrushConfig(text: string): { providers: CrushParsedProvider[]; defaultModel?: string } {
	const parsed = parseJson(text);
	if (!parsed) return { providers: [] };
	const out: CrushParsedProvider[] = [];
	if (Array.isArray(parsed["providers"])) {
		for (const raw of parsed["providers"] as unknown[]) {
			const item = asRecord(raw);
			if (!item) continue;
			const id = asString(item["id"]);
			if (!id) continue;
			out.push({
				id,
				name: asString(item["name"]),
				baseUrl: asString(item["base_url"]),
				// api_key 字段部分版本才有；更多场景 key 在环境变量里（envKey 字段），env 里拿不到就标 no-key。
				apiKey: asString(item["api_key"]) ?? asString(item["apiKey"]),
			});
		}
	}
	// 顶层 env（旧版）可能带 *_API_KEY。
	const env = asStringRecord(parsed["env"]) ?? {};
	for (const provider of out) {
		if (provider.apiKey) continue;
		const envKey = `${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		if (env[envKey]) provider.apiKey = env[envKey];
	}
	const defaultModel = asString(parsed["model"]);
	return { providers: out, defaultModel };
}

export async function discoverCrush(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const dynamicText = await readSmallFile(join(home, ".local", "share", "crush", "crush.json"));
	const staticText = await readSmallFile(join(home, ".config", "crush", "crush.json"));
	if (!dynamicText && !staticText) return { found: false, providers: [] };
	const dynamic = dynamicText ? parseCrushConfig(dynamicText) : { providers: [] as CrushParsedProvider[], defaultModel: undefined };
	const staticConf = staticText ? parseCrushConfig(staticText) : { providers: [] as CrushParsedProvider[], defaultModel: undefined };
	// 按 id 合并：动态文件的字段优先，缺的从静态文件补。
	const merged = new Map<string, CrushParsedProvider>();
	for (const entry of [...staticConf.providers, ...dynamic.providers]) {
		const existing = merged.get(entry.id);
		merged.set(entry.id, { ...existing, ...entry, name: entry.name ?? existing?.name, baseUrl: entry.baseUrl ?? existing?.baseUrl, apiKey: entry.apiKey ?? existing?.apiKey });
	}
	const providers: ExternalAgentProviderFound[] = [];
	for (const entry of merged.values()) {
		if (!entry.baseUrl && !entry.apiKey) continue;
		providers.push({
			id: `crush:${entry.id}`,
			agent: "crush",
			providerName: uniqueName(entry.name ?? entry.id, "crush"),
			apiType: entry.id.startsWith("anthropic") ? "anthropic-messages" : entry.id.startsWith("gemini") || entry.id.startsWith("google") ? "google-generative-ai" : "openai-completions",
			baseUrl: entry.baseUrl,
			apiKeyMasked: entry.apiKey && !isPlaceholderKey(entry.apiKey) ? maskKey(entry.apiKey) : undefined,
			modelIds: [],
			note: entry.apiKey ? undefined : "no-key",
		});
	}
	return { found: providers.length > 0, providers };
}

export async function resolveCrushKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const dynamicText = await readSmallFile(join(home, ".local", "share", "crush", "crush.json"));
	const staticText = await readSmallFile(join(home, ".config", "crush", "crush.json"));
	const dynamic = dynamicText ? parseCrushConfig(dynamicText).providers : [];
	const staticProviders = staticText ? parseCrushConfig(staticText).providers : [];
	const entry = [...dynamic, ...staticProviders].find((p) => p.id === detail);
	if (!entry?.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: entry.apiKey };
}
