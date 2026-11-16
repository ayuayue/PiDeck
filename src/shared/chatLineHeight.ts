import type { AppSettings } from "./types/settings";

/** 会话正文行距档位（#547）：类型唯一来源是 AppSettings.chatLineHeight。 */
export type ChatLineHeightMode = AppSettings["chatLineHeight"];

/**
 * 会话正文行距（#547）：三档，全局一份。
 *
 * 为什么是档位而不是滑条：行距是排版尺度，不是一个连续可调的量；三档
 * （基线 / 舒展 / 宽松）已覆盖「紧凑看不清」到「大字号下要透气」的诉求，
 * 且每档都能在 CSS 里固定成可断言的倍率。
 *
 * 基线档刻意等于当前出厂值（1.6），所以默认设置不改变既有外观；可选档位只上调，
 * 因为反馈的方向是「偏紧」。代码块与表格不跟随（按作者口径，那两块当前观感没问题）。
 */
export const CHAT_LINE_HEIGHT_MODES: readonly ChatLineHeightMode[] = ["default", "relaxed", "loose"];

/** 出厂默认档：与 CSS token 基线一致 */
export const DEFAULT_CHAT_LINE_HEIGHT_MODE: ChatLineHeightMode = "default";

/**
 * 档位归一化：不在档位表里的历史值/脏值一律落到基线档。
 * 与字号档位同一策略——不写迁移框架，读到未知值也不会让下拉变空白。
 */
export function normalizeChatLineHeightMode(value: unknown, fallback: ChatLineHeightMode = DEFAULT_CHAT_LINE_HEIGHT_MODE): ChatLineHeightMode {
	if (typeof value !== "string") return fallback;
	return CHAT_LINE_HEIGHT_MODES.find((mode) => mode === value) ?? fallback;
}
