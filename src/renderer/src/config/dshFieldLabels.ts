import { t, type TranslationKey } from "../i18n";

/**
 * DSH schema 字段的可读文案。
 * schemastery 通常不带 title，自定义设置里若只用 path 末段或空 path，
 * 会显示 raw key / "(root)"，用户不知道密钥和 Base URL 该怎么填。
 */
const FIELD_COPY: Record<
	string,
	{
		/** 可读标签；缺省时回退 schema 原始字段名（与 provider/model 等英文原名对齐）。 */
		label?: TranslationKey;
		hint?: TranslationKey;
		placeholder?: TranslationKey;
	}
> = {
	baseURL: {
		label: "config.dsh.field.baseURL",
		hint: "config.dsh.field.baseURLHint",
		placeholder: "config.dsh.field.baseURLPlaceholder",
	},
	baseUrl: {
		label: "config.dsh.field.baseURL",
		hint: "config.dsh.field.baseURLHint",
		placeholder: "config.dsh.field.baseURLPlaceholder",
	},
	api: {
		label: "config.dsh.field.api",
		hint: "config.dsh.field.apiHint",
	},
	apiKeyEnv: {
		label: "config.dsh.field.apiKeyEnv",
		hint: "config.dsh.field.apiKeyEnvHint",
		placeholder: "config.dsh.field.apiKeyEnvPlaceholder",
	},
	displayName: {
		label: "config.dsh.field.displayName",
		hint: "config.dsh.field.displayNameHint",
		placeholder: "config.dsh.field.displayNamePlaceholder",
	},
	headers: {
		label: "config.dsh.field.headers",
		hint: "config.dsh.field.headersHint",
	},
	retryPolicy: {
		label: "config.dsh.field.retryPolicy",
		hint: "config.dsh.field.maxRetriesHint",
	},
	maxRetries: {
		label: "config.dsh.field.maxRetries",
		hint: "config.dsh.field.maxRetriesHint",
	},
	reasoningEffort: {
		// label 保持英文（与 provider/model 等 schema 原名一致），只补档位说明
		label: "config.dsh.field.reasoningEffort",
		hint: "config.dsh.field.reasoningEffortHint",
	},
};

export type DshFieldCopy = {
	label: string;
	hint?: string;
	placeholder?: string;
};

/** 把 schema 字段名翻成界面文案；未知字段回退字段名，空名不显示 (root)。 */
export function dshFieldCopy(name: string): DshFieldCopy {
	const known = FIELD_COPY[name];
	if (known) {
		return {
			label: known.label ? t(known.label) : name,
			hint: known.hint ? t(known.hint) : undefined,
			placeholder: known.placeholder ? t(known.placeholder) : undefined,
		};
	}
	return { label: name };
}

/**
 * 自定义设置里应隐藏的字段：密钥已在卡片上方单独编辑，
 * apiKeyEnv 只是凭证槽位名，放在表单里容易被当成「把密钥填这里」。
 * compat 对象整块隐藏：其字段（supportsStore / requiresThinkingAsText 等）由
 * pi-ai 目录元数据自动决定，用户一般不改；要改走「源文件」tab 手写 settings.yaml。
 */
export function isDshCustomSettingsHiddenField(name: string, meta?: Record<string, unknown>): boolean {
	// retryPolicy is intentionally kept in settings.yaml: dsh-web's curated
	// provider cards only expose a key, Base URL and the model catalog.
	if (name === "models" || name === "apiKeyEnv" || name === "retryPolicy" || name === "compat") return true;
	return meta?.role === "secret" || meta?.role === "credential-ref";
}

/**
 * Direct DeepSeek is a composition-owned adapter, not a generic pi-ai route.
 * Keep its card aligned with dsh-web: only endpoint override belongs in the
 * curated fold; thinking/retry/transport defaults stay in the raw settings file.
 */
const DSH_DEEPSEEK_PROFILE_VISIBLE_FIELDS = new Set(["baseURL", "baseUrl"]);

export function isDshDeepseekProfileVisibleField(name: string): boolean {
	return DSH_DEEPSEEK_PROFILE_VISIBLE_FIELDS.has(name);
}

/**
 * `declared` is an adapter answer, not an "active" flag: true means pi-ai has
 * no shipped catalog route for this id. Directory failures are handled like a
 * custom route so a user can still finish editing a newly-added provider.
 */
export function isDshPiAiCustomRoute(entry: { declared?: boolean } | undefined): boolean {
	return !entry || entry.declared === true;
}

/**
 * llm-pi-ai provider profile 折叠区白名单：只显示这些字段（其余全隐藏）。
 *
 * 对齐 dsh-web 的 ProviderEditor：主字段只有 API 密钥，自定义设置折叠区只放
 * per-family extras，对 pi-ai 家族而言就是 baseURL / api / displayName。
 *
 * schema 里其他顶层字段（defaultContextWindow / defaultMaxTokens / defaultInput /
 * headers / reasoning / thinkingBudgets / cacheRetention / transport / *Ms / retryPolicy
 * 等）由 host 默认值或 settings.yaml 兜底，普通用户不动；要改走「源文件」tab。
 *
 * 黑名单会随 schema 升级静默漏出新字段；白名单是面向 future-proof 的正确选择。
 */
export const DSH_PI_AI_PROFILE_VISIBLE_FIELDS = new Set([
	"baseURL", // dsh-llm-pi-ai schema 标准写法
	"baseUrl", // 旧/别名写法（dshFieldLabels 已把 label 映射为 baseURL）
	"api", // 接口协议（openai-completions / anthropic-messages / …）
	"displayName", // 侧栏/配置页展示名
]);

export function isDshPiAiProfileVisibleField(name: string): boolean {
	return DSH_PI_AI_PROFILE_VISIBLE_FIELDS.has(name);
}
