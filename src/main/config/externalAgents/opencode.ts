/**
 * OpenCode 配置发现：
 * - ~/.opencode/opencode.json（旧版 config.json）→ provider.<id>.{name, options:{baseURL, apiKey}, models}
 * - ~/.local/share/opencode/auth.json → opencode auth login 存的凭据：{<providerId>: {type:"api", key} | {type:"oauth",...}}
 *   两处互补：auth.json 有 key、config 有 baseUrl/models，按 provider id 合并。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, parseJson, readSmallFile, limitModelIds } from "./shared";

export type OpenCodeParsedProvider = { id: string; name?: string; baseUrl?: string; apiKey?: string; modelIds: string[] };

export function parseOpenCodeConfig(text: string): { providers: OpenCodeParsedProvider[]; defaultModel?: string } {
	const parsed = parseJson(text);
	if (!parsed) return { providers: [] };
	const out: OpenCodeParsedProvider[] = [];
	const providerTable = asRecord(parsed["provider"]);
	if (providerTable) {
		for (const [id, raw] of Object.entries(providerTable)) {
			const item = asRecord(raw);
			if (!item) continue;
			const options = asRecord(item["options"]);
			const models: string[] = [];
			const modelsTable = asRecord(item["models"]);
			if (modelsTable) for (const modelId of Object.keys(modelsTable)) models.push(modelId);
			out.push({
				id,
				name: asString(item["name"]),
				baseUrl: options ? asString(options["baseURL"]) : undefined,
				apiKey: options ? asString(options["apiKey"]) : undefined,
				modelIds: models,
			});
		}
	}
	return { providers: out, defaultModel: asString(parsed["model"]) };
}

/** auth.json：api 类型的 key 可导；oauth 类型只提示。返回 providerId → 凭据。 */
export function parseOpenCodeAuth(text: string): { apiKeys: Record<string, string>; oauthIds: string[] } {
	const parsed = parseJson(text);
	if (!parsed) return { apiKeys: {}, oauthIds: [] };
	const apiKeys: Record<string, string> = {};
	const oauthIds: string[] = [];
	for (const [id, raw] of Object.entries(parsed)) {
		const item = asRecord(raw);
		if (!item) continue;
		const key = asString(item["key"]);
		if (item["type"] !== "oauth" && key && !isPlaceholderKey(key)) apiKeys[id] = key;
		else if (item["type"] === "oauth") oauthIds.push(id);
	}
	return { apiKeys, oauthIds };
}

export async function readOpenCodeSources(home: string): Promise<{ config?: ReturnType<typeof parseOpenCodeConfig>; auth?: ReturnType<typeof parseOpenCodeAuth> }> {
	// opencode 的新配置文件名是 opencode.json，旧版 config.json 兼容读；auth.json 三平台固定在 ~/.local/share/opencode/。
	const configText = (await readSmallFile(join(home, ".opencode", "opencode.json"))) ?? (await readSmallFile(join(home, ".opencode", "config.json")));
	const authText = await readSmallFile(join(home, ".local", "share", "opencode", "auth.json"));
	return {
		config: configText ? parseOpenCodeConfig(configText) : undefined,
		auth: authText ? parseOpenCodeAuth(authText) : undefined,
	};
}

export async function discoverOpenCode(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const { config, auth } = await readOpenCodeSources(home);
	if (!config && !auth) return { found: false, providers: [] };
	const providers: ExternalAgentProviderFound[] = [];
	const configById = new Map((config?.providers ?? []).map((p) => [p.id, p]));
	// auth.json 里的 key 优先（显式 login 的结果），config 里的 apiKey 兜底。
	for (const [id, key] of Object.entries(auth?.apiKeys ?? {})) {
		const entry = configById.get(id);
		providers.push({
			id: `opencode:${id}`,
			agent: "opencode",
			providerName: uniqueName(entry?.name ?? id, "opencode"),
			// opencode 的 provider id 里通常含协议暗示（openai/* → completions，anthropic/* → messages）。
			apiType: id.startsWith("anthropic") ? "anthropic-messages" : "openai-completions",
			baseUrl: entry?.baseUrl,
			apiKeyMasked: maskKey(key),
			modelIds: entry?.modelIds ?? [],
		});
		configById.delete(id);
	}
	// config 里有 key/baseUrl 但 auth.json 没有的（老式内联配置）。
	for (const entry of configById.values()) {
		if (!entry.baseUrl && !entry.apiKey) continue;
		providers.push({
			id: `opencode:${entry.id}`,
			agent: "opencode",
			providerName: uniqueName(entry.name ?? entry.id, "opencode"),
			apiType: entry.id.startsWith("anthropic") ? "anthropic-messages" : "openai-completions",
			baseUrl: entry.baseUrl,
			apiKeyMasked: entry.apiKey && !isPlaceholderKey(entry.apiKey) ? maskKey(entry.apiKey) : undefined,
			modelIds: limitModelIds(entry.modelIds),
			note: entry.apiKey ? undefined : "no-key",
		});
	}
	// 纯 OAuth 登录（如 github-copilot）只提示。
	for (const id of auth?.oauthIds ?? []) {
		if (auth?.apiKeys[id]) continue;
		providers.push({ id: `opencode:${id}`, agent: "opencode", providerName: uniqueName(`${id}-subscription`, "opencode"), apiType: "openai-completions", modelIds: [], note: "subscription:oauth" });
	}
	return { found: providers.length > 0, providers };
}

export async function resolveOpenCodeKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const { config, auth } = await readOpenCodeSources(home);
	const key = auth?.apiKeys[detail] ?? config?.providers.find((p) => p.id === detail)?.apiKey;
	if (!key) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: key };
}
