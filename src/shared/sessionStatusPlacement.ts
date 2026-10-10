/**
 * 会话状态（待办 / 修改文件 / 子代理）的显示位置（设置项 sessionStatusPlacement）。
 *
 * 纯函数无依赖：主进程 SettingsStore 用 parse 做磁盘值与写入值校验，
 * 渲染层 App 用 placementShowsSidebarPanel 决定右侧边栏下半区的装配。
 */

/**
 * 二选一，同一时刻只在一处显示：
 * - sidebar：右侧边栏下半区；面板可见地展示某会话时，该会话输入框上方的同类折叠条让位
 *   （抽屉关闭/面板收起时折叠条自动恢复，信息不会无处可看）；
 * - composer：输入框上方（不挂下半区，右侧边栏保持改造前的单区抽屉）。
 */
export type SessionStatusPlacement = "sidebar" | "composer";

export const DEFAULT_SESSION_STATUS_PLACEMENT: SessionStatusPlacement = "sidebar";

/** 磁盘 JSON 无类型，旧数据或坏值（含已移除的 "both"）一律回落默认，不抛错。 */
export function parseSessionStatusPlacement(value: unknown): SessionStatusPlacement {
	return value === "sidebar" || value === "composer" ? value : DEFAULT_SESSION_STATUS_PLACEMENT;
}

/** 右侧边栏是否挂「会话状态」下半区。 */
export function placementShowsSidebarPanel(placement: SessionStatusPlacement): boolean {
	return placement === "sidebar";
}
