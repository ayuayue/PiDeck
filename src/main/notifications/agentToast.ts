/**
 * Agent 会话桌面通知（Windows toast）的统一出口：品牌字标 + 点击深链跳回会话。
 *
 * 为什么要收口：pi / DSH / ACP 三条后端都要发「会话完成」与「Ask 提问」通知，
 * toast XML、logo、点击跳转与失败日志只要各写一份就会漂移（历史上已经出现过
 * 「logo 外一层边框」「点击不跳会话」两次事故，见 notificationToast.ts 注释）。
 *
 * 门控顺序（三条后端一致）：对应开关 → 仅失焦提醒 → 系统支持。
 * pi 在 AgentManager 内部保留自己的门控与文案（行为不变），只复用这里的构造；
 * DSH/ACP 直接走 notifySessionFinished / notifyAskPending。
 */
import { Notification, type BrowserWindow } from "electron";
import type { AppSettings } from "../../shared/types";
import { APP_DISPLAY_NAME } from "../utils/appBrand";
import { isMainWindowFocused, shouldAlertNow } from "./alertFocusGate";
import { buildToastXml, notificationLaunchUrl } from "./notificationToast";
import { clampNotificationBody, clampNotificationTitle } from "./notificationText";

/** 通知标题截断复用于 pi 的 AgentManager（避免它再开一条 import 行）。 */
export { clampNotificationTitle } from "./notificationText";

export type AgentNotificationKind = "done" | "ask";

export type AgentToastCopyKey = "mainNotification.sessionDone" | "mainNotification.askQuestion" | "mainNotification.askPending";

export type AgentToastDeps = {
	/** 宿主未就绪时返回 null（通知静默跳过）。 */
	settings: () => AppSettings | null;
	getWindow: () => BrowserWindow | null;
	logoUri: () => string | null;
	translate: (key: AgentToastCopyKey, params?: Record<string, string | number>) => string;
	/** 点击通知后：聚焦窗口并切到会话（sessionId 缺省只聚焦）。 */
	activate: (sessionId?: string) => void;
	logger?: { warn: (scope: string, message: string, detail?: unknown) => void };
	/** 时钟注入（单测用）；缺省 Date.now。 */
	now?: () => number;
};

/**
 * 完成通知的最小间隔。
 *
 * 一个回合结束时，多个 ACP/DSH 会话可能在同一秒内陆续完成；每次 toast 都会在
 * Windows UI 线程上走一次 WinRT `show()`（上游已知可能卡在 COM 上）。同一秒内的
 * 第二、三条完成通知对用户没有增量信息（时间线/宠物气泡仍逐条展示），合并掉
 * 可以显著减少主进程被 toast 阻塞的次数。Ask 通知需要用户操作，不参与节流。
 */
const DONE_TOAST_MIN_INTERVAL_MS = 1000;
let lastDoneToastAt = 0;

/** 门控：对应开关 → 仅失焦提醒 → 系统支持。 */
export function agentToastGate(deps: AgentToastDeps, kind: AgentNotificationKind): boolean {
	const settings = deps.settings();
	if (!settings) return false;
	if (kind === "done" ? !settings.enableNotifications : !settings.askNotificationEnabled) return false;
	if (!shouldAlertNow(settings.alertOnlyWhenUnfocused, isMainWindowFocused(deps.getWindow()))) return false;
	return Notification.isSupported();
}

/** 构造并弹出 toast；失败静默——通知不得影响会话主流程。 */
export function showAgentToast(deps: AgentToastDeps, input: { agentId: string; kind: AgentNotificationKind; body: string; sessionId?: string }): void {
	if (input.kind === "done") {
		const now = deps.now?.() ?? Date.now();
		if (now - lastDoneToastAt < DONE_TOAST_MIN_INTERVAL_MS) return;
		lastDoneToastAt = now;
	}
	try {
		const appName = APP_DISPLAY_NAME;
		// 正文兜底再截一次：调用方可能把整段会话标题/错误原文塞进来，超大 toast 会让
		// Windows Shell 处理明显变慢（主进程 Notification.show() 期间窗口卡顿）。
		const body = clampNotificationBody(input.body);
		const notification = new Notification({
			title: appName,
			body,
			silent: false,
			// 自定义 toast XML：launch 携带 sessionId，点击后经 pideck:// 协议唤起应用并跳转对应会话
			toastXml: buildToastXml({ title: appName, body, launch: notificationLaunchUrl(input.sessionId), logoUri: deps.logoUri() }),
		});
		notification.on("click", () => deps.activate(input.sessionId));
		notification.on("failed", (_event, error) => {
			// Windows 拒绝显示 toast 时触发（show() 本身不抛异常），记 warn 便于排查
			void deps.logger?.warn("agent", input.kind === "done" ? "Session notification failed to show" : "Ask notification failed to show", { agentId: input.agentId, error: String(error) });
		});
		notification.show();
	} catch {
		// 通知失败不影响主流程，静默处理
	}
}

/** 会话完成通知（ACP/DSH 用；pi 在 AgentManager 内保留自己的门控后复用 showAgentToast）。 */
export function notifySessionFinished(deps: AgentToastDeps, input: { agentId: string; title: string; sessionId?: string }): void {
	if (!agentToastGate(deps, "done")) return;
	const title = clampNotificationTitle(input.title || APP_DISPLAY_NAME);
	showAgentToast(deps, { agentId: input.agentId, kind: "done", body: deps.translate("mainNotification.sessionDone", { title }), ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
}

/**
 * Ask 提问通知（ACP/DSH 用）。返回是否真的弹出：调用方据此维护「每轮只提醒一次」，
 * 开关关着时不占用去重位（用户中途打开开关仍能收到当前提问）。
 */
export function notifyAskPending(deps: AgentToastDeps, input: { agentId: string; sessionId: string; sessionTitle: string; question: string }): boolean {
	if (!agentToastGate(deps, "ask")) return false;
	const title = clampNotificationTitle(input.sessionTitle || APP_DISPLAY_NAME);
	const questionText = input.question.length > 60 ? `${input.question.slice(0, 60)}…` : input.question;
	const body = questionText ? deps.translate("mainNotification.askQuestion", { title, question: questionText }) : deps.translate("mainNotification.askPending", { title });
	showAgentToast(deps, { agentId: input.agentId, kind: "ask", body, sessionId: input.sessionId });
	return true;
}
