/**
 * 逐模型 compat（models.json 的 `models[].compat`）的配置页模型。
 *
 * 背景：pi 用 compat 描述「协议整体没错、但这个模型/供应商有差异」的布尔开关。
 * Claude Opus 4.7+ / Sonnet 5+ / Fable 5 这一代必须按自适应思考协议发送
 * （`thinking:{type:"adaptive"}` + `output_config.effort`），老写法
 * `thinking:{type:"enabled",budget_tokens}` 会被上游直接 400；pi 默认按模型 ID 判定，
 * 经中转站（自定义 provider 名）时判不出来，只能逐模型写 compat。
 * 以前这些键只能手改 models.json，所以这里给出可编辑清单 + 官方目录建议。
 */

import type { TranslationKey } from "../i18n";
import type { ProviderCompat } from "./configTypes";

export type ModelCompatField = {
	/** models.json 里的 compat 键名（面板原样展示，方便对照配置文件）。 */
	key: string;
	labelKey: TranslationKey;
	hintKey: TranslationKey;
};

/**
 * 面板管理的键（顺序 = UI 顺序）。
 *
 * 只收布尔键：目录里的字符串枚举（thinkingFormat / maxTokensField）与对象
 * （openRouterRouting / allowedFallbackModels）需要结构化编辑，不在这里表达；
 * 「应用目录建议」也只在键集合里取交集，保证写进去的每一项都能在面板上改回来。
 */
export const MODEL_COMPAT_FIELDS: readonly ModelCompatField[] = [
	{ key: "forceAdaptiveThinking", labelKey: "config.modelCompatAdaptiveThinking", hintKey: "config.modelCompatAdaptiveThinkingDesc" },
	{ key: "supportsTemperature", labelKey: "config.modelCompatTemperature", hintKey: "config.modelCompatTemperatureDesc" },
	{ key: "supportsReasoningEffort", labelKey: "config.reasoningEffort", hintKey: "config.reasoningEffortDesc" },
	{ key: "supportsDeveloperRole", labelKey: "config.developerRole", hintKey: "config.developerRoleDesc" },
	{ key: "requiresReasoningContentOnAssistantMessages", labelKey: "config.reasoningContentReplay", hintKey: "config.reasoningContentReplayDesc" },
	{ key: "supportsStrictMode", labelKey: "config.strictToolSampling", hintKey: "config.strictToolSamplingDesc" },
	{ key: "supportsStore", labelKey: "config.modelCompatStore", hintKey: "config.modelCompatStoreDesc" },
];

const MANAGED_KEYS = new Set(MODEL_COMPAT_FIELDS.map((field) => field.key));

/** 目录建议：官方目录对该模型声明的 compat 布尔键（已按可编辑键过滤）+ 命中的标准模型 ID。 */
export type ModelCompatSuggestion = {
	matchedId?: string;
	flags: Record<string, boolean>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 任意 compat 记录 → 只保留布尔键（含面板不管理的键，用于行内展示）。 */
export function readCompatBooleans(compat: unknown): Record<string, boolean> {
	if (!isRecord(compat)) return {};
	const flags: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(compat)) {
		if (typeof value === "boolean") flags[key] = value;
	}
	return flags;
}

/** 目录建议用：只取面板能编辑、能撤销的键。 */
export function pickManagedCompatFlags(compat: unknown): Record<string, boolean> {
	const flags = readCompatBooleans(compat);
	const picked: Record<string, boolean> = {};
	for (const key of Object.keys(flags)) {
		if (MANAGED_KEYS.has(key)) picked[key] = flags[key];
	}
	return picked;
}

/** 三态写值：undefined = 不做表态（删除键，跟随 Pi 默认），true/false = 显式落盘。 */
export function setModelCompatFlag(compat: ProviderCompat | undefined, key: string, value: boolean | undefined): ProviderCompat | undefined {
	const next: ProviderCompat = { ...(isRecord(compat) ? compat : {}) };
	if (value === undefined) delete next[key];
	else next[key] = value;
	return Object.keys(next).length > 0 ? next : undefined;
}

export type ModelCompatSuggestionDiff = {
	key: string;
	suggested: boolean;
	current?: boolean;
};

/** 目录建议与当前值的差异（未表态的键也算差异，用户才知道该开什么）。 */
export function diffModelCompatSuggestion(compat: ProviderCompat | undefined, flags: Record<string, boolean>): ModelCompatSuggestionDiff[] {
	const current = readCompatBooleans(compat);
	const diff: ModelCompatSuggestionDiff[] = [];
	for (const field of MODEL_COMPAT_FIELDS) {
		const suggested = flags[field.key];
		if (suggested === undefined || current[field.key] === suggested) continue;
		diff.push({ key: field.key, suggested, ...(current[field.key] !== undefined ? { current: current[field.key] } : {}) });
	}
	return diff;
}

/** 应用目录建议：只覆盖建议里有的管理键，其余 compat 键原样保留。 */
export function applyModelCompatSuggestion(compat: ProviderCompat | undefined, flags: Record<string, boolean>): ProviderCompat | undefined {
	let next: ProviderCompat | undefined = compat;
	for (const field of MODEL_COMPAT_FIELDS) {
		const suggested = flags[field.key];
		if (suggested === undefined) continue;
		next = setModelCompatFlag(next, field.key, suggested);
	}
	return next;
}

/** 是否存在任何 compat 配置（含面板不管理的非布尔键；行内图标据此高亮）。 */
export function hasModelCompat(compat: unknown): boolean {
	return isRecord(compat) && Object.keys(compat).length > 0;
}

/** 行内 tooltip 摘要：`key=true/false` 全量列出（含手写的非管理键），方便对照 models.json。 */
export function summarizeModelCompat(compat: unknown): string {
	const flags = readCompatBooleans(compat);
	return Object.entries(flags)
		.map(([key, value]) => `${key}=${value}`)
		.join(" · ");
}
