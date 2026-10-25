/**
 * Gemini CLI 配置发现：~/.gemini/settings.json → apiKey（少数用户直存）或 auth.selectedType（OAuth 只提示）。
 * GEMINI_API_KEY 一般在 env 而非文件；官方登录是 OAuth（不导出）。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, isPlaceholderKey, maskKey, parseJson, readSmallFile } from "./shared";

export function parseGeminiSettings(text: string): { apiKey?: string; authType?: string } {
	const parsed = parseJson(text);
	if (!parsed) return {};
	const apiKey = asString(parsed["apiKey"]);
	const auth = asRecord(parsed["auth"]);
	const authType = auth ? asString(auth["selectedType"]) : undefined;
	return { apiKey, authType };
}

export async function discoverGeminiCli(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	const configText = await readSmallFile(join(home, ".gemini", "settings.json"));
	if (!configText) return { found: false, providers: [] };
	const parsed = parseGeminiSettings(configText);
	// 只有文件里明确存了 apiKey 才给可导入候选；OAuth 登录只提示。
	if (parsed.apiKey && !isPlaceholderKey(parsed.apiKey)) {
		return { found: true, providers: [{ id: "gemini-cli:api-key", agent: "gemini-cli", providerName: uniqueName("gemini", "gemini"), apiType: "google-generative-ai", apiKeyMasked: maskKey(parsed.apiKey), modelIds: [] }] };
	}
	return { found: true, providers: [{ id: "gemini-cli:oauth", agent: "gemini-cli", providerName: uniqueName("gemini-subscription", "gemini"), apiType: "google-generative-ai", modelIds: [], note: parsed.authType ? `subscription:${parsed.authType}` : "subscription" }] };
}

export async function resolveGeminiKey(home: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	const configText = await readSmallFile(join(home, ".gemini", "settings.json"));
	if (!configText) return { ok: false, error: "config not found" };
	const parsed = parseGeminiSettings(configText);
	if (!parsed.apiKey) return { ok: false, error: "no api key" };
	return { ok: true, apiKey: parsed.apiKey };
}
