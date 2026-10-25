/**
 * Provider User-Agent 预设与取值解析（纯函数，可单测）。
 *
 * 背景（用户报告 + 实测结论）：
 * 部分第三方网关按 UA 做白名单/风控，官方 CLI 的 UA 才能过；另外 pi 的
 * `openai-codex-responses` 实现会用 `headers.set("User-Agent", getPiUserAgent())`
 * 无条件覆盖用户配置，导致「配了 UA 也无效」。因此配置侧必须提供足够覆盖面
 * 的预设，并让用户能直接手写任意 UA。
 *
 * 预设取值来源：cc-switch 的 `src/config/userAgentPresets.ts`（对 Kimi Coding Plan
 * UA 白名单做 curl 实测得出：`claude-cli/*`、`claude-code/*`、`Kilo-Code/*` 放行），
 * 再补上各官方 SDK / 客户端的真实默认 UA，覆盖「模拟 SDK」这一常见诉求。
 */

import { t, type TranslationKey } from "../i18n";

/** 存储层的「未配置」哨兵值：写入 headers 时视为不设置 User-Agent。 */
export const USER_AGENT_UNSET = "";

export type UserAgentPreset = {
	/** 写入 headers 的 User-Agent 值。 */
	value: string;
	/** i18n key（可选）；缺省时直接展示 value。 */
	labelKey?: TranslationKey;
	/** 直接展示的标签（可选，优先级低于 labelKey）；预设本身是英文协议串时无需给。 */
	label?: string;
	/** 归组标题的 i18n key，用于在下拉里分段展示。 */
	groupKey?: TranslationKey;
};

/**
 * 预设清单（顺序即下拉展示顺序）。
 *
 * 取值来源：cc-switch 的 `src/config/userAgentPresets.ts` 实测结果（对按 UA 做
 * 白名单/风控的网关：`claude-cli/*`、`claude-code/*`、`Kilo-Code/*` 放行），
 * 再加上各官方 SDK / 客户端的真实默认 UA，覆盖「模拟官方客户端 / 模拟 SDK」两类诉求。
 * 官方 CLI 放最前：用户报告里能过 anyrouter / agentrouter 这类站的就是 claude-cli。
 */
export const USER_AGENT_PRESETS: readonly UserAgentPreset[] = [
	// ── 官方 CLI / 客户端（按 UA 白名单的网关优先命中这一组）──
	{ value: "claude-cli/2.1.161 (external, cli)", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "claude-cli/2.1.161", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "claude-cli/1.0.60 (external, cli)", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "claude-code/1.0.0", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "claude-code/0.1.0", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "codex-cli/1.0.0", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "Kilo-Code/1.0", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "cursor-agent/1.0", groupKey: "config.userAgentGroupOfficialCli" },
	{ value: "pi-coding-agent", groupKey: "config.userAgentGroupOfficialCli" },
	// ── 官方 SDK 默认值（网关按 SDK 特征放行时用这一组）──
	{ value: "OpenAI/JS 6.26.0", groupKey: "config.userAgentGroupSdk" },
	{ value: "anthropic-sdk-typescript/0.27.3", groupKey: "config.userAgentGroupSdk" },
	{ value: "openai-node/4.0.0", groupKey: "config.userAgentGroupSdk" },
	{ value: "GoogleGenerativeAI/1.0.0", groupKey: "config.userAgentGroupSdk" },
	{ value: "Mistral/1.0.0", groupKey: "config.userAgentGroupSdk" },
	// ── 通用 HTTP 客户端 / 浏览器 ──
	{ value: "python-requests/2.31.0", groupKey: "config.userAgentGroupHttpClient" },
	{ value: "axios/1.6.0", groupKey: "config.userAgentGroupHttpClient" },
	{ value: "Go-http-client/1.1", groupKey: "config.userAgentGroupHttpClient" },
	{ value: "curl/8.5.0", groupKey: "config.userAgentGroupHttpClient" },
	// 真实 Chrome UA：少数网关按浏览器特征放行，保留完整格式（仅 UA 头部，不改其他指纹）。
	{
		value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		labelKey: "config.userAgentBrowser",
		groupKey: "config.userAgentGroupHttpClient",
	},
];

/**
 * 组合框选项：首项是「不写入」（等同运行时默认），其后是全部预设，并带上译好的分组标题。
 *
 * 之所以把「不写入」做成下拉里的一个正式选项而不是额外按钮：组合框是单控件，
 * 用户要能像选预设一样把 UA 清空回默认；否则清空只能靠手删输入框内容，
 * 而实际上删空与「选不写入」是同一个落盘结果（headers 里不写 User-Agent）。
 */
export function getUserAgentOptions(): Array<{ value: string; label: string; group?: string }> {
	const presetOptions = USER_AGENT_PRESETS.map((preset) => ({
		value: preset.value,
		// 预设本身是英文协议串，不需要翻译；只有浏览器 UA 这类需要人话说明才带 labelKey。
		label: preset.labelKey ? t(preset.labelKey) : (preset.label ?? preset.value),
		// 分组标题在这里就翻好并写入 group：组合框是按字符串分段展示的，
		// 传 i18n key 进去还得在渲染层再翻一次，多一层耦合。
		...(preset.groupKey ? { group: t(preset.groupKey) } : {}),
	}));
	return [{ value: USER_AGENT_UNSET, label: t("config.userAgentRuntimeDefault") }, ...presetOptions];
}

/**
 * 展示值（组合框直接用 value 作为选中值，不再有「自定义」哨兵项）。
 *
 * 旧实现用 `__custom__` 哨兵把「下拉选项」和「手写值」拆成两个控件，结果两边
 * 会互相覆盖，用户报告「下拉还有一个输入框，应该只有一个」。单控件的关键是不再
 * 需要哨兵：任意手写值都是合法选中值，选中后直接当 value 用。
 */
export function resolveUserAgentSelection(value: string): string {
	return value.trim();
}

/**
 * 校验自定义 User-Agent 是否可作为请求头写入。
 *
 * 与 cc-switch 的 `parse_custom_user_agent` 同口径：含控制字符（换行符等）会被
 * 静默忽略——请求头注入风险，且静默忽略会让用户以为「配了却不生效」，所以这里
 * 显式拦下并给 UI 提示。空值与首尾空白由调用方 trim 处理。
 */
export function isValidUserAgent(value: string): boolean {
	// eslint-disable-next-line no-control-regex
	return !/[\x00-\x1f\x7f]/.test(value);
}

/** 会无条件覆盖用户 User-Agent 的 provider api 类型。 */
const UA_OVERRIDING_API_TYPES = new Set(["openai-codex-responses"]);

/**
 * 该 api 类型下，用户配置的 User-Agent 是否会被 pi 冲掉。
 *
 * pi 的 `openai-codex-responses` 实现在发请求前执行 `headers.set("User-Agent", getPiUserAgent())`，
 * 无条件覆盖 models.json 里 provider.headers 的 User-Agent。结果是「配了 UA 也无效」——
 * 用户会以为是中转站不认这个 UA，实际是 pi 根本没把它发出去。
 * 这类 api 类型必须在表单里显式提示，并引导改用不覆盖 UA 的 openai-responses。
 *
 * 这里只返回布尔、不拼文案：文案走 i18n，判定逻辑保持可单测。
 */
export function isUserAgentOverriddenByApiType(apiType: string | undefined): boolean {
	const normalized = apiType?.trim().toLowerCase();
	return normalized ? UA_OVERRIDING_API_TYPES.has(normalized) : false;
}
