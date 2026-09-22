import type { PiAuthMethod, PiAuthProviderOption } from "../../../shared/types/piAuth";

/**
 * 「登录供应商」弹框的纯逻辑：搜索过滤、行状态、失败原因归类。
 *
 * 为什么单独成模块：这些规则要能脱离 React 单测（AGENTS.md「纯策略可单测」），
 * 组件只负责把结果画出来，不再在 JSX 里内联判断。
 */

/** 一行的展示状态：是否已登录、当前可点的登录方式。 */
export type AuthProviderRowState = {
	/** pi 的 `auth.json` 里已有可用凭据（oauth 或 api_key）。 */
	loggedIn: boolean;
	/** 可交互的登录方式；顺序固定 oauth → api_key，保证同屏按钮顺序稳定。 */
	methods: PiAuthMethod[];
};

export function describeAuthProviderRow(provider: PiAuthProviderOption): AuthProviderRowState {
	const methods: PiAuthMethod[] = [];
	if (provider.oauth) methods.push("oauth");
	// canLogin=false 表示 pi 没有交互式录入实现（只能用环境变量/AWS 凭据文件），
	// 给它按钮等于点进去必然失败，所以不算「可点的登录方式」。
	if (provider.apiKey?.canLogin) methods.push("api_key");
	return { loggedIn: provider.credential !== undefined, methods };
}

/** 搜索命中的文本：id、名称、两种登录方式的标签（都是 pi 给的原文，不额外翻译）。 */
function authProviderSearchText(provider: PiAuthProviderOption): string {
	return [provider.id, provider.name, provider.oauth?.label, provider.apiKey?.name]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join(" ")
		.toLowerCase();
}

/**
 * 按关键词过滤供应商：大小写不敏感，匹配 id / 名称 / 登录方式标签。
 * 空关键词返回原顺序副本（pi 侧已按名称排好序，宿主不再重排，避免两处排序漂移）。
 */
export function filterAuthProviders(providers: readonly PiAuthProviderOption[], query: string): PiAuthProviderOption[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...providers];
	return providers.filter((provider) => authProviderSearchText(provider).includes(needle));
}

/** 登录失败的可操作建议类型；`none` 表示只能展示 pi 的原文。 */
export type AuthFailureHintKind = "region" | "network" | "code-expired" | "none";

/**
 * 地区限制：OpenAI 一类供应商的 token 交换会返回
 * `unsupported_country_region_territory` / "Country, region, or territory not supported"。
 * 这类失败用户自己看不出原因，必须单独给出「换网络/开代理」的提示。
 */
const REGION_PATTERN = /unsupported_country|country,?\s*region,?\s*or\s*territory\s+not\s+supported|not\s+available\s+in\s+your\s+region/i;
/** 网络不可达（DNS/连接/超时）；undici 的各类失败文本一并覆盖。 */
const NETWORK_PATTERN = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|fetch failed|socket hang up|network error|premature close/i;
/** 授权码失效：回调早于/晚于浏览器流程，或同一码被用过。 */
const CODE_PATTERN = /invalid_grant|invalid[_ ]code|code (?:has )?expired|expired/i;

/**
 * 把 pi 的错误原文归类成一条可操作建议。
 *
 * 判据是文本匹配而不是 errorKind：pi 把所有登录失败都归到 `login-failed`，
 * 真正的差异只体现在 message 里；顺序先判最具体的地区限制，再判网络与授权码。
 */
export function classifyAuthFailure(message: string | undefined): AuthFailureHintKind {
	if (!message) return "none";
	if (REGION_PATTERN.test(message)) return "region";
	if (NETWORK_PATTERN.test(message)) return "network";
	if (CODE_PATTERN.test(message)) return "code-expired";
	return "none";
}
