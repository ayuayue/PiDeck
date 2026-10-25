import type { AppLanguageMode, I18nDescriptor, I18nParams } from "../../shared/types";
import { isTraditionalChineseLanguageTag } from "../../shared/types";

export type SupportedLocale = "zh-CN" | "zh-TW" | "en-US" | "pseudo";

function normalizeSystemLanguage(language: string | undefined): string {
	return (language ?? "").trim().replace(/_/g, "-").toLowerCase();
}

/**
 * Resolve the app locale from a user choice and one ordered system-language hint.
 * Callers intentionally pass Electron's preferred OS language first, then browser hints;
 * keeping this pure makes the precedence testable and preserves explicit user choices.
 */
export function resolveLocale(mode: AppLanguageMode, systemLanguage = typeof navigator === "undefined" ? "en-US" : (navigator.languages?.[0] ?? navigator.language)): SupportedLocale {
	if (mode === "zh-CN" || mode === "zh-TW" || mode === "en-US" || mode === "pseudo") return mode;
	const normalized = normalizeSystemLanguage(systemLanguage);
	if (normalized !== "zh" && !normalized.startsWith("zh-")) return "en-US";
	return isTraditionalChineseLanguageTag(normalized) ? "zh-TW" : "zh-CN";
}

import { zhCN } from "./i18n/rendererCopy.zh-CN";
import type { TranslationKey } from "./i18n/rendererCopy.zh-CN";

export type { TranslationKey } from "./i18n/rendererCopy.zh-CN";

type Params = I18nParams;

function makePseudoDictionary(source: Record<TranslationKey, string>): Record<TranslationKey, string> {
	const entries = Object.entries(source).map(([key, value]) => {
		const tail = value.length > 8 ? ` ${value.slice(0, Math.ceil(value.length * 0.35))}` : "";
		return [key, `[!! ${value}${tail} !!]`];
	});
	return Object.fromEntries(entries) as Record<TranslationKey, string>;
}

type Dictionary = Record<TranslationKey, string>;

/**
 * 词典按需加载（体积优化，2026-10）。
 *
 * 三份词典各约 430KB；原先全部静态 import 会被 rollup 提进首屏静态 chunk（实测该 chunk
 * 1.42MB，其中约 1.31MB 是词典）。现在 zh-CN 常驻（同时是所有 key 的类型基准与缺失回退），
 * en-US / zh-TW 改成 `ensureI18nLocale()` 的 `import()`：首屏只加载当前 locale 一份，
 * 切语言时再加载另一份；两份都只在首次用到时进内存。
 *
 * 纪律：`setI18nLocale` 仍是同步的（大量 `t()` 调用点不能变成 async），但只有在词典
 * 已注册后调用才生效——启动入口（main.tsx / floater）必须先 await ensureI18nLocale。
 */
const dictionaries: Partial<Record<SupportedLocale, Dictionary>> = { "zh-CN": zhCN };
const pendingLoads = new Map<SupportedLocale, Promise<void>>();

const dictionaryLoaders: Record<SupportedLocale, () => Promise<Dictionary>> = {
	"zh-CN": async () => zhCN,
	"en-US": async () => (await import("./i18n/rendererCopy.en-US")).enUS,
	"zh-TW": async () => (await import("./i18n/rendererCopy.zh-TW")).zhTW,
	// pseudo 是调试用「伪本地化」：直接由 en-US 派生，不单独维护词典。
	pseudo: async () => makePseudoDictionary((await import("./i18n/rendererCopy.en-US")).enUS),
};

/** 该 locale 的词典是否已注册（调用方可据此决定「同步生效」还是「加载后再刷新」）。 */
export function isI18nLocaleLoaded(locale: SupportedLocale): boolean {
	return Boolean(dictionaries[locale]);
}

/** 动态加载并注册 locale 词典；同一 locale 并发调用只加载一次。 */
export function ensureI18nLocale(locale: SupportedLocale): Promise<void> {
	if (dictionaries[locale]) return Promise.resolve();
	const existing = pendingLoads.get(locale);
	if (existing) return existing;
	const load = dictionaryLoaders[locale]()
		.then((dictionary) => {
			dictionaries[locale] = dictionary;
		})
		.finally(() => {
			pendingLoads.delete(locale);
		});
	pendingLoads.set(locale, load);
	return load;
}

let currentLocale: SupportedLocale = "zh-CN";

export function setI18nLocale(locale: SupportedLocale) {
	currentLocale = locale;
}

/** 返回当前生效 locale（pseudo 按 en-US 处理），供第三方库（如日期组件 locale）取用。 */
export function getI18nLocale(): SupportedLocale {
	return currentLocale;
}

export function t(key: TranslationKey, params?: Params) {
	// 当前 locale 的词典未注册（ensure 还没完成）时回退 zh-CN：这是常驻基准，
	// 宁可短暂显示中文，也不要显示 key 名或 crash。
	const dictionary = dictionaries[currentLocale] ?? zhCN;
	let text = dictionary[key] ?? zhCN[key] ?? key;
	if (!params) return text;
	return text.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = params[name];
		return value == null ? match : String(value);
	});
}

export function formatI18nDateTime(value: Date | number | string): string {
	const locale = currentLocale === "pseudo" ? "en-US" : currentLocale;
	return new Date(value).toLocaleString(locale);
}

export function translateI18nDescriptor(descriptor: I18nDescriptor | null | undefined, fallback: string): string {
	const key = descriptor?.i18nKey;
	if (!key || !Object.prototype.hasOwnProperty.call(zhCN, key)) return fallback;
	return t(key as TranslationKey, descriptor.i18nParams);
}
