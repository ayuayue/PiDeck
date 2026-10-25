/**
 * Goose (Block) 配置发现：
 * - config.yaml：Win 在 %APPDATA%\Block\goose\config\config.yaml，Unix ~/.config/goose/config.yaml。
 *   新结构 {active_provider, providers: {<id>: {enabled, model, configured}}}；旧结构平铺 GOOSE_PROVIDER/GOOSE_MODEL。
 * - 自定义供应商：config 目录下 custom_providers/<id>.json（DeclarativeProviderConfig：name/display_name/base_url/api_key_env/models/engine）。
 * - key 在 secrets.yaml（keyring 禁用时的文件兜底，同 config 目录）按 <ID>_API_KEY 存。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, asStringRecord, isPlaceholderKey, maskKey, parseJson, readSmallFile } from "./shared";

/** goose 的 config 目录：Windows %APPDATA%\Block\goose\config，Unix ~/.config/goose。 */
export function gooseConfigDir(home: string, platform: string): string {
	return platform === "win32" ? join(home, "AppData", "Roaming", "Block", "goose", "config") : join(home, ".config", "goose");
}

export type GooseCustomProvider = { id: string; displayName?: string; baseUrl?: string; engine?: string; apiKeyEnv?: string; modelIds: string[] };

/** custom_providers/<id>.json：{name, display_name, base_url, api_key_env, engine, models:[{name/id}]}。 */
export function parseGooseCustomProvider(id: string, text: string): GooseCustomProvider | undefined {
	const parsed = parseJson(text);
	if (!parsed) return undefined;
	const baseUrl = asString(parsed["base_url"]);
	if (!baseUrl) return undefined;
	const modelIds: string[] = [];
	if (Array.isArray(parsed["models"])) {
		for (const raw of parsed["models"] as unknown[]) {
			const item = asRecord(raw);
			if (!item) continue;
			const name = asString(item["name"]) ?? asString(item["id"]);
			if (name) modelIds.push(name);
		}
	}
	return {
		id,
		displayName: asString(parsed["display_name"]) ?? asString(parsed["name"]),
		baseUrl,
		engine: asString(parsed["engine"]),
		apiKeyEnv: asString(parsed["api_key_env"]),
		modelIds,
	};
}

/** 简易 YAML 顶层 key:value 读取：goose 的 config.yaml/secrets.yaml 都是平铺标量表，够用且零依赖。 */
export function parseFlatYaml(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim());
		if (!m) continue;
		const value = m[2].trim();
		if (value && !value.startsWith("#")) out[m[1]] = stripYamlQuotes(value);
	}
	return out;
}

function stripYamlQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
	return value;
}

export async function discoverGoose(home: string, platform: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const configDir = gooseConfigDir(home, platform);
	const configText = await readSmallFile(join(configDir, "config.yaml"));
	const secretsText = await readSmallFile(join(configDir, "secrets.yaml"));
	if (!configText && !secretsText) return { found: false, providers: [] };
	const secrets = secretsText ? parseFlatYaml(secretsText) : {};
	const providers: ExternalAgentProviderFound[] = [];

	// 新版 config.yaml 的嵌套 providers 表 + active_provider；旧版是平铺 GOOSE_PROVIDER/GOOSE_MODEL。
	const configJson = configText ? parseJson(configText) : undefined;
	const activeProvider = configJson ? asString(configJson["active_provider"]) : undefined;
	const defaultModel = configText ? parseFlatYaml(configText)["GOOSE_MODEL"] : undefined;

	// 自定义供应商（goose configure 的 custom_providers/<id>.json）。
	const { readdir } = await import("node:fs/promises");
	try {
		for (const file of await readdir(join(configDir, "custom_providers"))) {
			if (!file.endsWith(".json")) continue;
			const text = await readSmallFile(join(configDir, "custom_providers", file));
			if (!text) continue;
			const provider = parseGooseCustomProvider(file.replace(/\.json$/, ""), text);
			if (!provider) continue;
			const key = provider.apiKeyEnv ? secrets[provider.apiKeyEnv] : undefined;
			providers.push({
				id: `goose:${provider.id}`,
				agent: "goose",
				providerName: uniqueName(provider.displayName ?? provider.id, "goose"),
				apiType: provider.engine === "anthropic" ? "anthropic-messages" : "openai-completions",
				baseUrl: provider.baseUrl,
				apiKeyMasked: key && !isPlaceholderKey(key) ? maskKey(key) : undefined,
				modelIds: provider.id === activeProvider && defaultModel ? [defaultModel] : provider.modelIds,
				note: key ? undefined : "no-key",
			});
		}
	} catch {
		// 目录不存在：没有自定义供应商，忽略。
	}

	// 内置 provider（openai/anthropic/…）：只有 secrets.yaml 里有对应 key 才给候选（没有 baseUrl 的用官方默认端点）。
	const env = configText ? parseFlatYaml(configText) : {};
	const builtinIds = new Set(["openai", "anthropic", "google", "groq", "openrouter", "deepseek", "ollama", "databricks", "mistral", "bedrock", "azure"]);
	for (const [secretName, key] of Object.entries(secrets)) {
		const id = secretName.replace(/_API_KEY$/, "").toLowerCase();
		if (!builtinIds.has(id)) continue;
		if (isPlaceholderKey(key)) continue;
		providers.push({
			id: `goose:${id}`,
			agent: "goose",
			providerName: uniqueName(id, "goose"),
			apiType: id === "anthropic" ? "anthropic-messages" : id === "google" ? "google-generative-ai" : "openai-completions",
			apiKeyMasked: maskKey(key),
			modelIds: id === activeProvider && defaultModel ? [defaultModel] : [],
			baseUrl: env[`${id.toUpperCase()}_BASE_URL`] || env["GOOSE_BASE_URL"],
		});
	}
	return { found: providers.length > 0, providers };
}

export async function resolveGooseKey(home: string, platform: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const configDir = gooseConfigDir(home, platform);
	// 优先按 custom provider 的 api_key_env 找，再退回 <ID>_API_KEY 约定。
	const customText = await readSmallFile(join(configDir, "custom_providers", `${detail}.json`));
	if (customText) {
		const provider = parseGooseCustomProvider(detail, customText);
		if (provider?.apiKeyEnv) {
			const secretsText = await readSmallFile(join(configDir, "secrets.yaml"));
			const secrets = secretsText ? parseFlatYaml(secretsText) : {};
			if (secrets[provider.apiKeyEnv]) return { ok: true, apiKey: secrets[provider.apiKeyEnv] };
		}
	}
	const secretsText = await readSmallFile(join(configDir, "secrets.yaml"));
	const secrets = secretsText ? parseFlatYaml(secretsText) : {};
	const key = secrets[`${detail.toUpperCase()}_API_KEY`];
	if (!key) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: key };
}
