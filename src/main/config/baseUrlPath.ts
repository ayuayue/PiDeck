/**
 * Provider baseUrl 路径规则：
 * - 桌面端「获取模型 / 测试连接」会为 OpenAI 兼容协议自动尝试补齐 /v1
 * - pi 会话运行时会**原样**使用 models.json 里的 baseUrl，不会再补版本路径
 * 因此检测通过但根路径配置可能导致会话 404。
 *
 * 策略：检测若实际走通版本路径，则建议（并可由 UI 自动）把 baseUrl 写成带版本的地址。
 */

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
 */
export function needsSessionBaseUrlVersionHint(
	configuredBaseUrl: string,
	effectiveRequestUrl?: string,
): boolean {
	if (!configuredBaseUrl.trim()) return false;
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
export function suggestNormalizedBaseUrl(
	configuredBaseUrl: string,
	effectiveRequestUrl?: string,
	apiType?: string,
): string | null {
	if (!needsSessionBaseUrlVersionHint(configuredBaseUrl, effectiveRequestUrl)) {
		return null;
	}

	const fromRequest = effectiveRequestUrl
		? extractVersionedBaseFromRequestUrl(effectiveRequestUrl)
		: null;
	if (fromRequest) {
		const current = configuredBaseUrl.replace(/\/+$/, "");
		return fromRequest === current ? null : fromRequest;
	}

	const u = configuredBaseUrl.replace(/\/+$/, "");
	const api = (apiType ?? "").toLowerCase();
	// Google 检测补的是 v1beta；其余 OpenAI/Anthropic 兼容补 /v1
	if (api === "google-generative-ai" || api === "google") {
		return `${u}/v1beta`;
	}
	return ensureOpenAiVersionPath(configuredBaseUrl);
}
