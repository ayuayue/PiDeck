/**
 * 「快捷消息」浮层由哪一栏响应全局快捷键 —— 纯判定，便于单测。
 *
 * 背景：快捷键是主进程 before-input-event 的全局广播（appShortcutTriggered），
 * 分屏时每个会话栏都挂一份订阅，若不加判定就会按一次同时弹出多个浮层。
 *
 * 两种「属于本栏」的情形：
 * - 本栏就是聚焦会话（分屏下点过哪一栏、或当前打开的会话）；
 * - 当前没有会话被聚焦（项目空态/引导页），此时页面上只存在引导页那一个输入框，
 *   快捷键当然归它——否则按钮看得见、快捷键却静默失效，是最难排查的一类不一致。
 */
export function ownsQuickMessageShortcut(input: { focusedSessionId: string | undefined; sessionId: string; guideSessionId: string }): boolean {
	if (input.focusedSessionId === input.sessionId) return true;
	return input.focusedSessionId === undefined && input.sessionId === input.guideSessionId;
}
