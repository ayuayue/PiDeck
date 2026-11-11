/**
 * 「给项目点个 Star」提醒的调度 hook（全局唯一挂载点：App.tsx，与 useAnnouncementNotifier 同层）。
 *
 * 为什么用全局 toast 而不是自绘浮层：右上角提醒在这个应用里已是既成语义（公告/架构错包/
 * Agent 数量告警都走 showNotice 的右上角卡片），复用同一套卡片能白拿按钮样式、复制/关闭、
 * 堆叠与「通知历史」入口，也不必再实现一套定位/层级/无障碍。
 *
 * 打扰边界（判定全在 utils/starReminderPolicy.ts，可单测）：
 * - 首次记录满一天 + 本次运行满 15 分钟才开口；一天最多一次；模态框打开/窗口不在前台时顺延。
 * - 点「不再提醒」= 本机永久静默；点「去点 Star」也算已完成（我们无法也不应验证用户是否真点了
 *   Star —— 那需要账号授权，绝不代做），同样不再打扰。
 * - 卡片是粘性 toast，但 60 秒后自动收起：用户没理它就自己消失，第二天再说，不常驻像广告。
 *
 * 记账先落盘再弹：即使弹完立刻崩溃/退出，也不会因为「还没记上」而在同一天重播。
 * localStorage 读写全部 try/catch：受限环境写不进去最坏多提醒一次，绝不能因此打断启动。
 */
import { useEffect } from "react";
import { gitHubReleasesBase } from "../../../shared/updateSources";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { dismissNotice, showNotice } from "../utils/notice";
import { nextStarReminderCheckDelayMs, parseStarReminderState, shouldPromptStarReminder, STAR_REMINDER_STORAGE_KEY, type StarReminderState } from "../utils/starReminderPolicy";

/** 单次提醒的展示时长（ms）：到点自动收起（不依赖设置里的全局 toast 时长，这条需要够读完）。 */
const STAR_REMINDER_AUTO_DISMISS_MS = 60_000;

/** Star 目标地址 = 仓库主页（Star 按钮在页面右上角）；owner/repo 取 shared 里更新源的同源常量。 */
const STAR_REMINDER_URL = gitHubReleasesBase();

function readStarReminderState(now: number): StarReminderState {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(STAR_REMINDER_STORAGE_KEY);
	} catch {
		// 受限环境（localStorage 被禁）：按首次使用处理，写回也会失败，最坏下次再来一次
	}
	return parseStarReminderState(raw, now);
}

function writeStarReminderState(state: StarReminderState): void {
	try {
		localStorage.setItem(STAR_REMINDER_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// 写不进去就罢了：这条提示不值得为它打断用户
	}
}

/** 当前是否处于「不该打扰」：任意模态框打开（toast 会压在弹窗上）或窗口不在前台。 */
function isBlockedForStarReminder(): boolean {
	const modalOpen = document.querySelector('[role="dialog"]') != null;
	const windowInactive = typeof document.hasFocus === "function" ? !document.hasFocus() : false;
	return modalOpen || windowInactive;
}

export function useStarReminder(): void {
	useEffect(() => {
		// performance.now() 是单调时钟：系统时间被改/校时时「本次运行了多久」不受影响
		const bootAt = performance.now();
		const bootNow = Date.now();
		let state = readStarReminderState(bootNow);
		// 首启即落盘 firstSeenAt：它是「用了一段时间」的计时起点，必须在第一次运行时固定下来
		writeStarReminderState(state);
		if (state.dismissed) return;

		let timer: number | undefined;
		let autoDismissTimer: number | undefined;
		let disposed = false;

		const stopPolling = () => {
			if (timer !== undefined) window.clearTimeout(timer);
			timer = undefined;
		};

		const schedule = () => {
			const delay = nextStarReminderCheckDelayMs(performance.now() - bootAt);
			timer = window.setTimeout(tick, delay);
		};

		const markHandled = () => {
			state = { ...state, dismissed: true };
			writeStarReminderState(state);
			stopPolling();
		};

		const tick = () => {
			if (disposed) return;
			const now = Date.now();
			const uptimeMs = performance.now() - bootAt;
			if (!shouldPromptStarReminder({ state, now, uptimeMs, blocked: isBlockedForStarReminder() })) {
				schedule();
				return;
			}
			// 先记账再弹（见文件头注释），本次运行不再复查——24h 内不可能再满足间隔条件
			state = { ...state, lastShownAt: now };
			writeStarReminderState(state);
			const noticeId = showNotice(t("starReminder.desc"), Number.POSITIVE_INFINITY, "info", t("starReminder.title"), {
				action: {
					label: t("starReminder.action"),
					onClick: () => {
						markHandled();
						void desktopApi.app.openExternal(STAR_REMINDER_URL, true).catch(() => undefined);
					},
				},
				cancel: {
					label: t("starReminder.dismiss"),
					onClick: () => {
						markHandled();
					},
				},
			});
			autoDismissTimer = window.setTimeout(() => dismissNotice(noticeId), STAR_REMINDER_AUTO_DISMISS_MS);
		};

		schedule();
		return () => {
			disposed = true;
			stopPolling();
			if (autoDismissTimer !== undefined) window.clearTimeout(autoDismissTimer);
		};
	}, []);
}
