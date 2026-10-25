/**
 * Codex 配置发现：
 * - ~/.codex/config.toml → model_provider / model_providers.<id>.{name, base_url, env_key} / openai_base_url
 * - ~/.codex/auth.json → OPENAI_API_KEY（apikey 模式）或 OAuth tokens（chatgpt 订阅，只提示）。
 */
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, parseJson, readSmallFile, MAX_AGENT_CONFIG_BYTES } from "./shared";

type CodexProviderToml = {
	name?: string;
	base_url?: string;
	env_key?: string;
	wire_api?: string;
};

export type CodexParsedProvider = { id: string; name?: string; baseUrl?: string; wireApi?: string };

export function parseCodexConfig(text: string): { providers: CodexParsedProvider[]; activeProviderId?: string; defaultModel?: string } {
	if (text.length > MAX_AGENT_CONFIG_BYTES) return { providers: [] };
	try {
		const parsed = parseToml(text) as Record<string, unknown>;
		const providers: CodexParsedProvider[] = [];
		const table = asRecord(parsed["model_providers"]);
		if (table) {
			for (const [id, raw] of Object.entries(table)) {
				const item = asRecord(raw);
				if (!item) continue;
				providers.push({ id, name: asString(item["name"]), baseUrl: asString(item["base_url"]), wireApi: asString(item["wire_api"]) });
			}
		}
		// 顶层 openai_base_url：第三方网关常直接改这个而不建 model_providers 段。
		const openaiBaseUrl = asString(parsed["openai_base_url"]);
		if (openaiBaseUrl) providers.push({ id: "openai", name: "openai", baseUrl: openaiBaseUrl, wireApi: "responses" });
		return {
			providers,
			activeProviderId: asString(parsed["model_provider"]),
			defaultModel: asString(parsed["model"]),
		};
	} catch {
		return { providers: [] };
	}
}

export function parseCodexAuth(text: string): { apiKey?: string; oauth?: boolean } {
	const parsed = parseJson(text);
	if (!parsed) return {};
	const mode = parsed["auth_mode"] ?? parsed["OPENAI_AUTH_MODE"];
	const apiKey = asString(parsed["OPENAI_API_KEY"]);
	// chatgpt 模式：文件里是 OAuth token（access/refresh），不能当 API key 导入。
	const oauth = typeof mode === "string" ? mode.includes("chatgpt") : apiKey === undefined && parsed["tokens"] != null;
	return { apiKey, oauth };
}

export async function discoverCodex(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	let found = false;
	const providers: ExternalAgentProviderFound[] = [];
	const configText = await readSmallFile(join(home, ".codex", "config.toml"));
	const authText = await readSmallFile(join(home, ".codex", "auth.json"));
	if (configText || authText) {
		const config = configText ? parseCodexConfig(configText) : { providers: [] as CodexParsedProvider[], activeProviderId: undefined, defaultModel: undefined };
		const auth = authText ? parseCodexAuth(authText) : {};
		// Codex 网关型配置：model_provider 指向 magpie 之类的本地网关（占位 key），提示用户但标记 no-key。
		for (const provider of config.providers) {
			found = true;
			const wireApi = provider.wireApi === "chat" ? "openai-completions" : "openai-codex-responses";
			providers.push({
				id: `codex:${provider.id}`,
				agent: "codex",
				providerName: uniqueName(provider.name ?? provider.id, "codex"),
				apiType: wireApi,
				baseUrl: provider.baseUrl,
				apiKeyMasked: auth.apiKey && !isPlaceholderKey(auth.apiKey) ? maskKey(auth.apiKey) : undefined,
				modelIds: provider.id === config.activeProviderId && config.defaultModel ? [config.defaultModel] : [],
				note: auth.oauth ? "subscription:chatgpt" : auth.apiKey ? undefined : "no-key",
			});
		}
		if (!config.providers.length && auth.oauth) {
			// 没有自定义 provider，只有 ChatGPT 订阅登录。
			found = true;
			providers.push({ id: "codex:oauth", agent: "codex", providerName: uniqueName("codex-subscription", "codex"), apiType: "openai-codex-responses", modelIds: [], note: "subscription:chatgpt" });
		}
	}
	return { found, providers };
}

export async function resolveCodexKey(home: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const authText = await readSmallFile(join(home, ".codex", "auth.json"));
	if (!authText) return { ok: false, error: "config not found" };
	const auth = parseCodexAuth(authText);
	if (!auth.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: auth.apiKey };
}
