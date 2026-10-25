/**
 * Claude Code 配置发现：
 * - ~/.claude/settings.json → env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
 * - ~/.claude.json → OAuth 订阅登录态（oauthAccount），只提示不导 token。
 */
import { join } from "node:path";
import type { ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";
import { asRecord, asString, asStringRecord, hostNameFromUrl, isPlaceholderKey, maskKey, parseJson, readSmallFile } from "./shared";

type ClaudeSettingsShape = {
	env?: Record<string, string>;
};

export function parseClaudeSettings(text: string): { baseUrl?: string; token?: string; modelIds: string[] } {
	const parsed = parseJson(text) as ClaudeSettingsShape | undefined;
	if (!parsed) return { modelIds: [] };
	const env = asStringRecord(parsed.env) ?? {};
	const baseUrl = env["ANTHROPIC_BASE_URL"];
	const token = env["ANTHROPIC_AUTH_TOKEN"] ?? env["ANTHROPIC_API_KEY"];
	// env 里 ANTHROPIC_MODEL / *_DEFAULT_*_MODEL 是模型指定；只取主模型作建议。
	const modelIds = [env["ANTHROPIC_MODEL"], env["ANTHROPIC_DEFAULT_SONNET_MODEL"]].filter((v): v is string => Boolean(v));
	return { baseUrl, token, modelIds };
}

export function parseClaudeOAuthAccount(text: string): { email?: string; accountUuid?: string } | undefined {
	const parsed = parseJson(text);
	if (!parsed) return undefined;
	// ~/.claude.json 里的 oauthAccount：订阅登录的证据（只取展示字段，token 不导出）。
	const oauth = asRecord(parsed["oauthAccount"]);
	if (!oauth) return undefined;
	const email = asString(oauth["emailAddress"]);
	const accountUuid = asString(oauth["accountUuid"]);
	return email || accountUuid ? { email, accountUuid } : undefined;
}

export async function discoverClaudeCode(home: string, uniqueName: (raw: string, fallback: string) => string): Promise<{ found: boolean; providers: ExternalAgentProviderFound[] }> {
	let found = false;
	const providers: ExternalAgentProviderFound[] = [];
	const settingsText = await readSmallFile(join(home, ".claude", "settings.json"));
	if (settingsText) {
		const parsed = parseClaudeSettings(settingsText);
		if (parsed.baseUrl || parsed.token) {
			found = true;
			// token 为占位值（本机网关）或缺失时仍可作为「无 key 端点」候选导入。
			providers.push({
				id: "claude-code:anthropic",
				agent: "claude-code",
				providerName: uniqueName(parsed.baseUrl ? hostNameFromUrl(parsed.baseUrl, "claude") : "claude-code", "claude"),
				apiType: "anthropic-messages",
				baseUrl: parsed.baseUrl,
				apiKeyMasked: parsed.token && !isPlaceholderKey(parsed.token) ? maskKey(parsed.token) : undefined,
				modelIds: parsed.modelIds,
				// 有 token 但被判定为占位值（本机网关）时同样标 no-key，UI 才能提示「导入后需自行填写」。
				note: parsed.token && !isPlaceholderKey(parsed.token) ? undefined : "no-key",
			});
		}
	}
	const claudeJsonText = await readSmallFile(join(home, ".claude.json"));
	if (claudeJsonText) {
		const oauth = parseClaudeOAuthAccount(claudeJsonText);
		if (oauth) {
			found = true;
			providers.push({
				id: "claude-code:oauth",
				agent: "claude-code",
				providerName: uniqueName("claude-subscription", "claude"),
				apiType: "anthropic-messages",
				modelIds: [],
				note: oauth.email ? `subscription:${oauth.email}` : "subscription",
			});
		}
	}
	return { found, providers };
}

/** 导入确认后取真实 key：OAuth 订阅没有可导出的 API key。 */
export async function resolveClaudeKey(home: string, detail: string): Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }> {
	if (detail === "anthropic") {
		const settingsText = await readSmallFile(join(home, ".claude", "settings.json"));
		if (!settingsText) return { ok: false, error: "config not found" };
		const parsed = parseClaudeSettings(settingsText);
		const key = parsed.token;
		if (!key) return { ok: false, error: "no api key" };
		return { ok: true, apiKey: key };
	}
	return { ok: false, error: "subscription login has no api key" };
}
