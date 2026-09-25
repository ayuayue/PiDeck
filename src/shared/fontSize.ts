import type { AppFontSizeMode } from "./types/settings";

/**
 * 字号档位（4 档）：紧凑 / 中 / 大 / 特大。
 *
 * 为什么从 5 档收敛到 4 档：旧的 5 档是 14 / 15 / 16 / 18 / 20，**前 3 档只差 1px**，
 * 肉眼分不出来——用户看到的是 3 个"选哪个都一样"的选项，等于 5 档里只有 3 档有效。
 * 现在改成**等距 2px** 的 14 / 16 / 18 / 20：4 档全部可辨，而且中档 16 与
 * Tailwind（text-base）/ Material（body-large）的正文标准一致。
 *
 * 三轨（界面 / 会话正文 / 输入框）共用同一组档位名，各自在 foundation.css 里有对应块。
 */
export const APP_FONT_SIZE_MODES: readonly AppFontSizeMode[] = ["compact", "medium", "large", "xlarge"];

/** 出厂默认档位：中 */
export const DEFAULT_APP_FONT_SIZE_MODE: AppFontSizeMode = "medium";

/**
 * 字号档位归一化：任何不在当前档位表里的值一律落到中档。
 *
 * 用途是旧数据与脏值兜底——升级前存着已删除的 "default" 档，刻意**不做迁移框架**：
 * 旧用户升级后自动等于「中」，不需要读写迁移，也不会因为读到未知值让 UI 下拉变空白。
 */
export function normalizeFontSizeMode(value: unknown, fallback: AppFontSizeMode = DEFAULT_APP_FONT_SIZE_MODE): AppFontSizeMode {
	if (typeof value !== "string") return fallback;
	return APP_FONT_SIZE_MODES.find((mode) => mode === value) ?? fallback;
}

/** 可空档位（null = 跟随全局字号，必须保持 null）；非空值同样归一化 */
export function normalizeOptionalFontSizeMode(value: unknown, fallback: AppFontSizeMode = DEFAULT_APP_FONT_SIZE_MODE): AppFontSizeMode | null {
	if (value === null || value === undefined) return null;
	return normalizeFontSizeMode(value, fallback);
}
