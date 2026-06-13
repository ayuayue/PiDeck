import { t } from "../i18n";

export function getUserAgentOptions() {
	return [
		{ value: "", label: t("config.userAgentRuntimeDefault") },
		{ value: "OpenAI/JS 6.26.0", label: "OpenAI/JS 6.26.0" },
		{ value: "Mozilla/5.0", label: "Mozilla/5.0" },
		{ value: "pi-coding-agent", label: "pi-coding-agent" },
	];
}
export const CUSTOM_USER_AGENT_VALUE = "__custom__";

export function getProviderHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		([key, headerValue]) =>
			key.trim().length > 0 && typeof headerValue === "string",
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function getHeaderValue(headers: unknown, targetKey: string) {
	const normalized = getProviderHeaders(headers);
	if (!normalized) return "";
	const entry = Object.entries(normalized).find(
		([key]) => key.toLowerCase() === targetKey.toLowerCase(),
	);
	return entry?.[1] ?? "";
}

export function setHeaderValue(
	headers: unknown,
	targetKey: string,
	value: string,
): Record<string, string> | undefined {
	const normalized = { ...(getProviderHeaders(headers) ?? {}) };
	for (const key of Object.keys(normalized)) {
		if (key.toLowerCase() === targetKey.toLowerCase()) delete normalized[key];
	}
	if (value.trim()) normalized[targetKey] = value.trim();
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// pi provider 的 api 字段必须使用官方 registry 名称；openai-completions 实际对应 Chat Completions。
// 不再把历史别名 openai-chat-completions 作为预设暴露，避免测试通过但 pi 会话启动失败。
export const PROVIDER_API_OPTIONS = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
];
