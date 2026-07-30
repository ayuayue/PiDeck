import { t } from "../i18n";

export function getUserAgentOptions() {
	return [
		{ value: "", label: t("config.userAgentRuntimeDefault") },
		{ value: "claude-cli/2.1.161 (external, cli)", label: "claude-cli/2.1.161 (external, cli)" },
		{ value: "claude-cli/2.1.161", label: "claude-cli/2.1.161" },
		{ value: "claude-code/1.0.0", label: "claude-code/1.0.0" },
		{ value: "claude-code/0.1.0", label: "claude-code/0.1.0" },
		{ value: "Kilo-Code/1.0", label: "Kilo-Code/1.0" },
		{ value: "OpenAI/JS 6.26.0", label: "OpenAI/JS 6.26.0" },
		{ value: "anthropic-sdk-typescript/0.27.3", label: "Anthropic SDK (anthropic-sdk-typescript/0.27.3)" },
		{ value: "Mozilla/5.0", label: "Mozilla/5.0 (浏览器)" },
		{ value: "pi-coding-agent", label: "pi-coding-agent" },
		{ value: "python-requests/2.31.0", label: "Python Requests" },
		{ value: "axios/1.6.0", label: "Axios" },
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

export const API_TYPE_LABELS: Record<string, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"openai-codex-responses": "OpenAI Codex Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
	"mistral-conversations": "Mistral Conversations",
};

export const API_TYPE_DESCRIPTIONS: Record<string, string> = {
	"openai-completions": "OpenAI Chat Completions API — 兼容性最广，适用于大多数第三方服务和本地模型",
	"openai-responses": "OpenAI Responses API — 新版 API，支持更多功能",
	"openai-codex-responses": "OpenAI Codex Responses — 用于 ChatGPT Plus/Pro 订阅。如遇问题可尝试 openai-responses + 自定义 User-Agent",
	"anthropic-messages": "Anthropic Messages API — Claude 系列模型专用",
	"google-generative-ai": "Google Generative AI API — Gemini 系列模型",
	"mistral-conversations": "Mistral Conversations API — Mistral 模型原生接口",
};
export const API_TYPE_DESCRIPTIONS_EN: Record<string, string> = {
	"openai-completions": "OpenAI Chat Completions API — Most compatible, works with most third-party services and local models",
	"openai-responses": "OpenAI Responses API — Newer API with more features",
	"openai-codex-responses": "OpenAI Codex Responses — For ChatGPT Plus/Pro. Try openai-responses + custom User-Agent if issues occur",
	"anthropic-messages": "Anthropic Messages API — For Claude models",
	"google-generative-ai": "Google Generative AI API — For Gemini models",
	"mistral-conversations": "Mistral Conversations API — Native Mistral interface",
};

/**
 * 主流供应商 → API 端点映射。
 * 用于在 settings 中自动发现 auth-only 供应商的模型列表，无需用户手动在 models.json 中配置。
 */
export const KNOWN_PROVIDER_ENDPOINTS: Record<
	string,
	{ baseUrl: string; apiType: string }
> = {
	"openai": { baseUrl: "https://api.openai.com/v1", apiType: "openai-completions" },
	"anthropic": { baseUrl: "https://api.anthropic.com/v1", apiType: "anthropic-messages" },
	"google": { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiType: "google-generative-ai" },
	"deepseek": { baseUrl: "https://api.deepseek.com/v1", apiType: "openai-completions" },
	"mistral": { baseUrl: "https://api.mistral.ai/v1", apiType: "mistral-conversations" },
	"nvidia": { baseUrl: "https://integrate.api.nvidia.com/v1", apiType: "openai-completions" },
	"xai": { baseUrl: "https://api.x.ai/v1", apiType: "openai-completions" },
	"groq": { baseUrl: "https://api.groq.com/openai/v1", apiType: "openai-completions" },
	"cerebras": { baseUrl: "https://api.cerebras.ai/v1", apiType: "openai-completions" },
	"openrouter": { baseUrl: "https://openrouter.ai/api/v1", apiType: "openai-completions" },
	"together": { baseUrl: "https://api.together.xyz/v1", apiType: "openai-completions" },
	"fireworks": { baseUrl: "https://api.fireworks.ai/inference/v1", apiType: "openai-completions" },
	"huggingface": { baseUrl: "https://api-inference.huggingface.co/v1", apiType: "openai-completions" },
	"opencode": { baseUrl: "https://opencode.ai/zen/v1", apiType: "openai-completions" },
	"opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", apiType: "openai-completions" },
	"minimax": { baseUrl: "https://api.minimax.io/v1", apiType: "openai-completions" },
	"minimax-cn": { baseUrl: "https://api.minimaxi.com/v1", apiType: "openai-completions" },
};
