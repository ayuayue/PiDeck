import { t, type TranslationKey } from "../i18n";

// User-Agent 预设清单已迁到 ./userAgentPresets（纯函数 + 分组元数据，可单测）：
// 这里保留 providerHeaders 的职责——headers 对象的规范读取/写入与 API 类型映射。

export { getUserAgentOptions, USER_AGENT_UNSET, USER_AGENT_PRESETS } from "./userAgentPresets";

export function getProviderHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(([key, headerValue]) => key.trim().length > 0 && typeof headerValue === "string");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function getHeaderValue(headers: unknown, targetKey: string) {
	const normalized = getProviderHeaders(headers);
	if (!normalized) return "";
	const entry = Object.entries(normalized).find(([key]) => key.toLowerCase() === targetKey.toLowerCase());
	return entry?.[1] ?? "";
}

/**
 * provider.modelOverrides[modelId] 的逐模型 User-Agent 读写（纯函数，可单测）。
 *
 * 结构已按 pi 源码核实（v0.85.1）：
 * - `core/model-config.d.ts` 中 modelOverrides 是 `{ [modelId]: { headers?: Record<string,string>, … } }`，
 *   headers 是合法的 TypeBox 字段，不是会被校验拒绝的自定义字段。
 * - `core/provider-composer.js` 的 rawModelHeaders 把 `modelOverrides[id].headers` 展开在
 *   **最后**：优先级高于 provider.headers，因此这里写的 UA 会覆盖供应商级 UA。
 * 留空语义 = 删除该键，让模型继承 provider 级 UA（而不是写空串去覆盖它）。
 */
export function setHeaderValue(headers: unknown, targetKey: string, value: string): Record<string, string> | undefined {
	const normalized = { ...(getProviderHeaders(headers) ?? {}) };
	for (const key of Object.keys(normalized)) {
		if (key.toLowerCase() === targetKey.toLowerCase()) delete normalized[key];
	}
	if (value.trim()) normalized[targetKey] = value.trim();
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function getModelUserAgentOverride(modelOverrides: unknown, modelId: string): string {
	const headers = getOverrideHeaders(modelOverrides, modelId);
	return headers ? getHeaderValue(headers, "User-Agent") : "";
}

/**
 * 写入逐模型 UA，返回新的 modelOverrides 对象（不改动入参）。
 * 值清空 → 移除该模型的 UA 键；若该模型只剩空壳则一并删掉，避免留下
 * `{ m1: {} }` 这种让 pi 白跑一层覆盖的空对象。
 */
export function setModelUserAgentOverride(modelOverrides: unknown, modelId: string, value: string): Record<string, Record<string, unknown>> | undefined {
	const id = modelId.trim();
	if (!id) return asOverridesRecord(modelOverrides);
	const base = asOverridesRecord(modelOverrides) ?? {};
	const current = isPlainObject(base[id]) ? { ...base[id] } : {};
	const nextHeaders = setHeaderValue(current.headers, "User-Agent", value);
	const next = { ...base };
	if (nextHeaders) {
		current.headers = nextHeaders;
		next[id] = current;
	} else {
		// 只删 UA 键：模型可能还有 maxTokens 等其它覆盖字段，不能整块丢掉。
		delete current.headers;
		if (Object.keys(current).length > 0) next[id] = current;
		else delete next[id];
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

function getOverrideHeaders(modelOverrides: unknown, modelId: string): Record<string, string> | undefined {
	const overrides = asOverridesRecord(modelOverrides);
	const entry = overrides?.[modelId];
	return isPlainObject(entry) ? getProviderHeaders(entry.headers) : undefined;
}

function asOverridesRecord(value: unknown): Record<string, Record<string, unknown>> | undefined {
	if (!isPlainObject(value)) return undefined;
	// 逐项收窄：value 是 unknown，整体断言会绕过类型检查（项目禁止 as 强转）。
	const entries = Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1]));
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// pi provider 的 api 字段必须使用官方 registry 名称；openai-completions 实际对应 Chat Completions。
// 不再把历史别名 openai-chat-completions 作为预设暴露，避免测试通过但 pi 会话启动失败。
// 列表对齐 pi 1.0.4 pi-ai 的 BUILTIN_APIS（不含 image/classifier 专用协议：那些不是聊天协议，
// 混进下拉会让用户给聊天 provider 选到不能聊天的协议）。
export const PROVIDER_API_OPTIONS = ["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages", "google-generative-ai", "google-vertex", "mistral-conversations", "bedrock-converse-stream", "pi-messages"];

/**
 * DSH（llm-pi-ai 适配器）只注册了三种协议（见 dsh 设置 schema 的 llm-pi-ai.api 联合：
 * openai-completions / openai-responses / anthropic-messages）。它的表单与 pi 共用
 * ApiTypeInput，所以必须单独给一份可选集，否则用户会选到 DSH 写不进配置的值。
 */
export const DSH_PROVIDER_API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages"];

export const API_TYPE_LABELS: Record<string, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"openai-codex-responses": "OpenAI Codex Responses",
	"azure-openai-responses": "Azure OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
	"google-vertex": "Google Vertex AI",
	"mistral-conversations": "Mistral Conversations",
	"bedrock-converse-stream": "Amazon Bedrock Converse",
	"pi-messages": "Pi Messages",
};

const API_TYPE_DESCRIPTION_KEYS: Record<string, TranslationKey> = {
	"openai-completions": "config.apiTypeDescription.openaiCompletions",
	"openai-responses": "config.apiTypeDescription.openaiResponses",
	"openai-codex-responses": "config.apiTypeDescription.openaiCodexResponses",
	"azure-openai-responses": "config.apiTypeDescription.azureOpenaiResponses",
	"anthropic-messages": "config.apiTypeDescription.anthropicMessages",
	"google-generative-ai": "config.apiTypeDescription.googleGenerativeAi",
	"google-vertex": "config.apiTypeDescription.googleVertex",
	"mistral-conversations": "config.apiTypeDescription.mistralConversations",
	"bedrock-converse-stream": "config.apiTypeDescription.bedrockConverseStream",
	"pi-messages": "config.apiTypeDescription.piMessages",
};

export function getApiTypeDescription(apiType: string): string {
	const key = API_TYPE_DESCRIPTION_KEYS[apiType];
	return key ? t(key) : "";
}

/**
 * 主流供应商 → API 端点映射。
 * 用于在 settings 中自动发现 auth-only 供应商的模型列表，无需用户手动在 models.json 中配置。
 */
export const KNOWN_PROVIDER_ENDPOINTS: Record<string, { baseUrl: string; apiType: string }> = {
	openai: { baseUrl: "https://api.openai.com/v1", apiType: "openai-completions" },
	anthropic: { baseUrl: "https://api.anthropic.com/v1", apiType: "anthropic-messages" },
	google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiType: "google-generative-ai" },
	deepseek: { baseUrl: "https://api.deepseek.com/v1", apiType: "openai-completions" },
	mistral: { baseUrl: "https://api.mistral.ai/v1", apiType: "mistral-conversations" },
	nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", apiType: "openai-completions" },
	xai: { baseUrl: "https://api.x.ai/v1", apiType: "openai-completions" },
	groq: { baseUrl: "https://api.groq.com/openai/v1", apiType: "openai-completions" },
	cerebras: { baseUrl: "https://api.cerebras.ai/v1", apiType: "openai-completions" },
	openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiType: "openai-completions" },
	together: { baseUrl: "https://api.together.xyz/v1", apiType: "openai-completions" },
	fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiType: "openai-completions" },
	huggingface: { baseUrl: "https://api-inference.huggingface.co/v1", apiType: "openai-completions" },
	opencode: { baseUrl: "https://opencode.ai/zen/v1", apiType: "openai-completions" },
	"opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", apiType: "openai-completions" },
	minimax: { baseUrl: "https://api.minimax.io/v1", apiType: "openai-completions" },
	"minimax-cn": { baseUrl: "https://api.minimaxi.com/v1", apiType: "openai-completions" },
	// TokenDance（词元跳动）：多模型/多供应商网关，OpenAI 兼容 base URL；模型拉取
	// 走其公开 /gateway/v1/models（无需鉴权），余额查询由 providerUsageProbe 专属候选覆盖。
	tokendance: { baseUrl: "https://tokendance.space/gateway/v1", apiType: "openai-completions" },
};
