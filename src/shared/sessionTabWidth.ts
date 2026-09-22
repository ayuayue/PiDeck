/**
 * 会话 Tab 最大宽度（sessionTabMaxWidth）纯策略：
 * - 默认值 104px = 旧代码硬编码 max-w-[104px]（无徽标 Tab 的出厂观感，迁移零回归）；
 * - 下限 80px：再窄时标题只剩 2-3 字符 + 关闭按钮，截断无阅读价值；
 * - 上限 400px：超过后单 Tab 独占半条栏，可容纳的 Tab 数失去意义；
 * - 有前置徽标（Pin/DSH/plan chip）的 Tab 放宽 +28px：旧代码 132px 与 104px 的差值，
 *   保证徽标挤占后标题仍有可读空间。
 *
 * 纯函数放在 shared：SettingsStore（主进程归一化）与 AppearanceTab（UI 夹取）
 * 共用同一份边界，避免两端各写一套 min/max 漂移。
 */

/** 出厂默认：与旧硬编码 max-w-[104px] 一致 */
export const SESSION_TAB_MAX_WIDTH_DEFAULT = 104;

/** 合理区间下限（px）：低于此值标题截断后基本不可读 */
export const SESSION_TAB_MAX_WIDTH_MIN = 80;

/** 合理区间上限（px）：超过后单 Tab 独占半条栏 */
export const SESSION_TAB_MAX_WIDTH_MAX = 400;

/**
 * 有前置徽标（Pin 图标 / DSH·生图徽标 / plan chip）时在上限基础上放宽的像素：
 * 沿用旧代码 132px - 104px 的差值，保证徽标 + 标题共存。
 */
export const SESSION_TAB_BADGE_EXTRA_WIDTH = 28;

/** 把任意来源（settings.json 磁盘值 / UI 输入）的宽度收敛到合法区间；非有限数值回落默认。 */
export function clampSessionTabMaxWidth(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return SESSION_TAB_MAX_WIDTH_DEFAULT;
	return Math.min(SESSION_TAB_MAX_WIDTH_MAX, Math.max(SESSION_TAB_MAX_WIDTH_MIN, Math.round(value)));
}
