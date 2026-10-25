import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { sessionRecordsAtom, sessionRuntimeUiByIdAtom } from "../atoms/session-atoms";
import { t } from "../i18n";
import { dismissNotice, showNotice, type NoticeId } from "../utils/notice";
import { collectPendingBackgroundAsks, describeBackgroundAsk, forgetBackgroundAsk, getRememberedBackgroundAskKeys, rememberBackgroundAsk } from "../utils/runtimeNotification";

/** Ask 提醒的 Toast 句柄跨组件生命周期存在，放模块级而非 hook 实例 ref。 */
const backgroundAskNoticeIdMap = new Map<string, NoticeId>();

export interface UseBackgroundAskPatrolOptions {
	/** Ask 提醒「前往会话」动作：跳转到等待回答的会话（渲染层提供，不依赖主进程）。 */
	onFocusSession?: (sessionId: string) => void;
}

/**
 * 后台 Ask 巡检（M7）：全应用只在 App.tsx 挂载一份。
 * 此前寄生在每栏的 useSessionRuntimeController 里，任一会话的 UI request/revision
 * 变化都会戳醒所有分屏栏的 Injector——违反「多实例必须按 session 订阅」。
 * 巡检天然跨会话，按架构规则收敛到单一全局挂载点。
 */
export function useBackgroundAskPatrol(options: UseBackgroundAskPatrolOptions): void {
	const { onFocusSession } = options;
	const sessionRuntimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
	const sessionRecords = useAtomValue(sessionRecordsAtom);

	useEffect(() => {
		const activeKeys = new Set<string>();
		for (const ask of collectPendingBackgroundAsks(sessionRuntimeUiById)) {
			activeKeys.add(ask.key);
			if (!rememberBackgroundAsk(ask.key)) continue;
			const display = describeBackgroundAsk({
				sessionName: sessionRecords[ask.sessionId]?.title,
				requestTitle: ask.requestTitle,
				defaultSessionName: t("ask.defaultTitle"),
			});
			const message = display.question ? t("ask.backgroundPendingDetail", { title: display.sessionName, question: display.question }) : t("ask.backgroundPending", { title: display.sessionName });
			// question 档（问号气泡图标 + ask 身份色）：Ask 是「等你回答」而不是异常，
			// 用 warning 黄三角会让用户误以为会话出错（回归守卫：tests/sonnerToasterMount.test.mjs）。
			const noticeId = showNotice(message, Number.POSITIVE_INFINITY, "question", undefined, {
				action: onFocusSession ? { label: t("ask.jumpToSession"), onClick: () => onFocusSession(ask.sessionId) } : undefined,
			});
			if (noticeId !== undefined) backgroundAskNoticeIdMap.set(ask.key, noticeId);
		}

		// 仅当 Ask 不再 pending（已回答/取消）时撤掉对应浮层；通知 key 保留到 Ask
		// 真正完成，避免来回切换反复弹出。
		for (const [key, noticeId] of backgroundAskNoticeIdMap) {
			if (activeKeys.has(key)) continue;
			dismissNotice(noticeId);
			backgroundAskNoticeIdMap.delete(key);
		}
		// 只有请求已经回答/取消，才回收去重 key；切换焦点不算 Ask 生命周期结束。
		for (const key of getRememberedBackgroundAskKeys()) {
			if (!activeKeys.has(key)) forgetBackgroundAsk(key);
		}
	}, [sessionRecords, sessionRuntimeUiById, onFocusSession]);
}
