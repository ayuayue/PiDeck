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

import { enUS } from "./i18n/rendererCopy.en-US";
import { zhCN } from "./i18n/rendererCopy.zh-CN";
import { zhTW } from "./i18n/rendererCopy.zh-TW";
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

const dictionaries: Record<SupportedLocale, Record<TranslationKey, string>> = {
	"zh-CN": zhCN,
	"zh-TW": zhTW,
	"en-US": enUS,
	pseudo: makePseudoDictionary(enUS),
};

let currentLocale: SupportedLocale = resolveLocale("system");

export function setI18nLocale(locale: SupportedLocale) {
	currentLocale = locale;
}

/** 返回当前生效 locale（pseudo 按 en-US 处理），供第三方库（如日期组件 locale）取用。 */
export function getI18nLocale(): SupportedLocale {
	return currentLocale;
}

export function t(key: TranslationKey, params?: Params) {
	const dictionary = dictionaries[currentLocale] ?? dictionaries["en-US"];
	let text = dictionary[key] ?? dictionaries["en-US"][key] ?? key;
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
