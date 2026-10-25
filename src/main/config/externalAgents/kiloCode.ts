/**
 * Kilo Code（VS Code 插件，Roo 系）配置发现：~/.kilocode/secrets.json
 * 结构 {"<extId>.kilo-code": {roo_cline_config_api_config: "<JSON字符串>"}}，内嵌
 * {apiConfigs: {<name>: {apiProvider, openAiBaseUrl, openAiModelId, ...}}, currentApiConfigName}。
 * 这是「JSON 套 JSON」的两层结构；key 在内层 openAiApiKey / glinerApiKey 等按 provider 分字段。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, hostNameFromUrl, isPlaceholderKey, maskKey, parseJson, readSmallFile } from "./shared";

/** secrets.json 里每个键的值可能是字符串化的 JSON（Kilo/Roo 存法），也可能是原生对象。 */
export function parseKiloSecrets(text: string): { apiConfigs: Record<string, Record<string, string>>; currentName?: string } {
	const parsed = parseJson(text);
	if (!parsed) return { apiConfigs: {} };
	const apiConfigs: Record<string, Record<string, string>> = {};
	let currentName: string | undefined;
	for (const rawOuter of Object.values(parsed)) {
		// secrets.json 的两层结构：外层 {extId: {roo_cline_config_api_config: "<JSON字符串>"}}。
		// 内层字段值可能是字符串化的 JSON，也可能是原生对象，统一先试字符串解析再当对象读。
		const outer = asRecord(rawOuter);
		const entriesToScan: Array<Record<string, unknown>> = [];
		if (outer) {
			for (const value of Object.values(outer)) {
				if (typeof value === "string") {
					const inner = parseJson(value);
					if (inner) entriesToScan.push(inner);
				} else {
					const rec = asRecord(value);
					if (rec) entriesToScan.push(rec);
				}
			}
		} else if (typeof rawOuter === "string") {
			const inner = parseJson(rawOuter);
			if (inner) entriesToScan.push(inner);
		}
		for (const entry of entriesToScan) {
			currentName = currentName ?? asString(entry["currentApiConfigName"]);
			const configs = asRecord(entry["apiConfigs"]);
			if (!configs) continue;
			for (const [name, configRaw] of Object.entries(configs)) {
				const config = asRecord(configRaw);
				if (!config) continue;
				const flat: Record<string, string> = {};
				for (const [k, v] of Object.entries(config)) if (typeof v === "string" && v.length > 0) flat[k] = v;
				apiConfigs[name] = flat;
			}
		}
	}
	return { apiConfigs, currentName };
}

/** Kilo 的 key 字段按 apiProvider 变化：openAi→openAiApiKey、anthropic→apiKey 等，逐个尝试。 */
function extractKey(config: Record<string, string>): string | undefined {
	for (const field of ["openAiApiKey", "apiKey", "glinerApiKey", "openRouterApiKey", "deepSeekApiKey", "mistralApiKey", "groqApiKey", "geminiApiKey"]) {
		const value = config[field];
		if (value && !isPlaceholderKey(value)) return value;
	}
	return undefined;
}

export async function discoverKiloCode(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const secretsText = await readSmallFile(join(home, ".kilocode", "secrets.json"));
	if (!secretsText) return { found: false, providers: [] };
	const { apiConfigs, currentName } = parseKiloSecrets(secretsText);
	const providers: ExternalAgentProviderFound[] = [];
	for (const [name, config] of Object.entries(apiConfigs)) {
		const baseUrl = config["openAiBaseUrl"] ?? config["apiBaseUrl"] ?? config["baseUrl"];
		const key = extractKey(config);
		if (!baseUrl && !key) continue;
		const apiProvider = config["apiProvider"] ?? "";
		providers.push({
			id: `kilo-code:${name}`,
			agent: "kilo-code",
			providerName: uniqueName(baseUrl ? hostNameFromUrl(baseUrl, "kilo") : name, "kilo"),
			apiType: apiProvider.includes("anthropic") ? "anthropic-messages" : apiProvider.includes("gemini") || apiProvider.includes("google") ? "google-generative-ai" : "openai-completions",
			baseUrl,
			apiKeyMasked: key ? maskKey(key) : undefined,
			modelIds: config["openAiModelId"] ? [config["openAiModelId"]] : [],
			note: key ? undefined : "no-key",
		});
		// 只有激活项才带模型建议（其余 config 的 modelId 是历史残留）。
		if (name !== currentName) providers[providers.length - 1].modelIds = [];
	}
	return { found: providers.length > 0, providers };
}

export async function resolveKiloKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const secretsText = await readSmallFile(join(home, ".kilocode", "secrets.json"));
	if (!secretsText) return { ok: false, error: "config not found" };
	const { apiConfigs } = parseKiloSecrets(secretsText);
	const key = extractKey(apiConfigs[detail] ?? {});
	if (!key) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: key };
}
