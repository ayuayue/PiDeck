/**
 * Provider baseUrl 路径规则：
 * - 桌面端「获取模型 / 测试连接」会为 OpenAI 兼容协议自动尝试补齐 /v1
 * - pi 会话运行时会**原样**使用 models.json 里的 baseUrl，不会再补版本路径
 * 因此检测通过但根路径配置可能导致会话 404。
 *
 * 策略：检测若实际走通版本路径，则建议（并可由 UI 自动）把 baseUrl 写成带版本的地址。
 *
 * 注意「探测端点」与「会话端点」的版本段归属**不一定相同**：探测统一打 /v1/models（猜测 +
 * 回退），而会话侧由各家 SDK 自己拼路径。因此自动改写前必须先按 apiType 判断会话侧到底吃不吃
 * 版本段（见 sessionBaseUrlVersionPolicy），否则会把用户的可用配置改成 404（issue #337）。
 */

/**
 * 会话端点 baseUrl 里该不该带版本段（依据 pi-ai 各协议适配器的实测拼法）：
 *  - `openai`：OpenAI SDK 在 baseUrl 后接 `/chat/completions`、`/responses`，registry 里
 *    openai 系 baseUrl 带 /v1（https://api.openai.com/v1）→ 需要补。
 *  - `google`：pi 把 baseUrl 直接交给 Google SDK 且 `apiVersion = ""`（源码注释
 *    "baseUrl already includes version path"），registry 里也是 .../v1beta → 需要补。
 *  - `none`：会话侧自己拼版本段的协议 → **绝不能补**：
 *    anthropic-messages 走 Anthropic SDK，会把 `/v1/messages` 接到 baseURL 后
 *    （baseUrl 带 /v1 就变成 `.../v1/v1/messages`）；mistral-conversations 自拼
 *    `v1/chat/completions`（registry baseUrl 是 https://api.mistral.ai）；openai-codex-responses
 *    自拼 `/codex/responses`；pi-messages 直接用 `<baseUrl>/messages`。
 * 未知（自定义）api id 也归 `none`：语义不可判断时保持用户填写的值不变。
 * 空 api 按 `openai` 处理：探测侧的 normalizeApiType 就是这么兜底的，pi 对未声明 api 的
 * 自定义 provider 也回落到 OpenAI 形状，保持与原行为一致。
 */
function sessionBaseUrlVersionPolicy(apiType?: string): "openai" | "google" | "none" {
	const api = (apiType ?? "").trim().toLowerCase();
	if (!api) return "openai";
	switch (api) {
		case "openai-completions":
		case "openai-chat-completions":
		case "openai-responses":
			return "openai";
		case "google-generative-ai":
		case "google":
			return "google";
		default:
			return "none";
	}
}

/** baseUrl 是否已带 API 版本段（/v1、/v1beta、/api 等）。 */
export function hasApiVersionPath(baseUrl: string): boolean {
	const u = baseUrl.replace(/\/+$/, "");
	return /\/v\d+(alpha|beta)?$|\/api$/.test(u);
}

/**
 * OpenAI 兼容协议：若未写版本路径则补 `/v1`。
 * 与 ConfigManager.ensureVersionPath 行为一致，抽出来便于单测与提示文案。
 */
export function ensureOpenAiVersionPath(baseUrl: string): string {
	const u = baseUrl.replace(/\/+$/, "");
	return hasApiVersionPath(u) ? u : `${u}/v1`;
}

/**
 * 去掉 baseUrl 末尾的 API 版本段（/v1、/v1beta、/api），用于计算与 OpenAI 兼容端点
 * 不同根的「管理面」基址（如 New API 的 /api/user/self 挂在站点根，不在 /v1 之下）。
 * 只剥末尾版本段，子路径前缀保留：
 *   https://host/v1       → https://host
 *   https://host/proxy/v1 → https://host/proxy
 *   https://host（无版本段）→ 原样
 * 判定正则与 hasApiVersionPath 保持一致，避免「剥了又补」来回跳。
 */
export function stripOpenAiVersionPath(baseUrl: string): string {
	const u = baseUrl.replace(/\/+$/, "");
	return u.replace(/(\/v\d+(?:alpha|beta)?|\/api)$/i, "");
}

/**
 * 从检测实际请求 URL 反推「应写入 models.json 的 baseUrl」。
 * 例：https://host/v1/chat/completions → https://host/v1
 *     https://host/proxy/v1/models → https://host/proxy/v1
 *     https://host/v1beta/models/xxx:generateContent → https://host/v1beta
 */
export function extractVersionedBaseFromRequestUrl(requestUrl: string): string | null {
	try {
		const u = new URL(requestUrl);
		const match = u.pathname.match(/^(.*?)(\/v\d+(?:alpha|beta)?|\/api)(?=\/|$)/i);
		if (!match) return null;
		const prefix = match[1] ?? "";
		const version = match[2] ?? "";
		return `${u.origin}${prefix}${version}`;
	} catch {
		const match = requestUrl.match(/^(https?:\/\/[^?#]+?)(\/v\d+(?:alpha|beta)?|\/api)(?=\/|$)/i);
		if (!match) return null;
		return `${match[1]}${match[2]}`;
	}
}

/**
 * 检测侧若对用户配置做了版本路径补齐，会话侧仍用原始 baseUrl。
 * 返回 true 时 UI 应自动改写 baseUrl（或至少提示）。
 * 会话侧不吃版本段的 api 直接返回 false：那种情况下「补版本」本身就是错的提示。
 */
export function needsSessionBaseUrlVersionHint(configuredBaseUrl: string, effectiveRequestUrl?: string, apiType?: string): boolean {
	if (!configuredBaseUrl.trim()) return false;
	if (sessionBaseUrlVersionPolicy(apiType) === "none") return false;
	// 用户已经写了版本路径 → 无需改写
	if (hasApiVersionPath(configuredBaseUrl)) return false;
	// 没有实际请求 URL 时，只要配置是根路径就标记（保存前预警）
	if (!effectiveRequestUrl) return true;
	// 仅当实际请求用到了版本路径时才改写，避免「根路径 /models 也通了」时误加 /v1
	return extractVersionedBaseFromRequestUrl(effectiveRequestUrl) != null;
}

/**
 * 在检测成功且走了版本路径时，给出应写入配置的 baseUrl。
 * 返回 null 表示无需改动。
 */
export function suggestNormalizedBaseUrl(configuredBaseUrl: string, effectiveRequestUrl?: string, apiType?: string): string | null {
	const policy = sessionBaseUrlVersionPolicy(apiType);
	// issue #337：anthropic-messages 的探测主候选固定是 `<base>/v1/models`（见
	// ConfigManager.buildModelsRequest），探测走通 /v1 并不意味着会话端点也要 /v1 ——
	// Anthropic SDK 自己拼 /v1/messages，补上就是所有会话 404。会话侧不吃版本段的协议
	// 一律不改写用户填写的 baseUrl。
	if (policy === "none") return null;
	if (!needsSessionBaseUrlVersionHint(configuredBaseUrl, effectiveRequestUrl, apiType)) {
		return null;
	}

	const fromRequest = effectiveRequestUrl ? extractVersionedBaseFromRequestUrl(effectiveRequestUrl) : null;
	if (fromRequest) {
		const current = configuredBaseUrl.replace(/\/+$/, "");
		return fromRequest === current ? null : fromRequest;
	}

	const u = configuredBaseUrl.replace(/\/+$/, "");
	// Google 检测补的是 v1beta；OpenAI 系补 /v1
	if (policy === "google") {
		return `${u}/v1beta`;
	}
	return ensureOpenAiVersionPath(configuredBaseUrl);
}
