import { useEffect } from "react";
import { useStore } from "jotai";
import { currentSessionIdAtom } from "../atoms";
import { sessionSendStateByIdAtom } from "../atoms/composer-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { toSessionRuntimeTarget } from "../utils/sessionCommands";
import { isSessionRuntimeBusy } from "./useSessionTimelineController";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";

/** 确认弹窗最小切片（与 useSessionRunControl 的 RunControlConfirmOverlay 同构） */
interface CloseTabConfirmOverlay {
	showConfirm: (options: { title: string; message: string; danger?: boolean; confirmLabel?: string; onConfirm: () => void }) => void;
	clearConfirm: () => void;
}

export interface CloseSessionTabShortcutDeps {
	/** 关闭会话 Tab（chrome 域，不含停止语义）：关闭后焦点/分屏邻居由 closeTab 内部处理 */
	closeTab: (sessionId: string) => void;
	/** 停止当前回答（运行控制域 abortAgent）：失败 toast 与流式态清理已由其内部兜底，不抛异常 */
	abortAgent: (agentId: string) => Promise<void>;
	overlays: CloseTabConfirmOverlay;
}

/**
 * Cmd/Ctrl+W 关闭当前会话标签页（Chrome 关标签页惯例）。
 *
 * 主进程 before-input-event 命中（键位可在设置页自定义）后广播 appShortcutTriggered，
 * 这里消费：AI 回答进行中先弹确认框——确认 = 停止当前回答并关闭 Tab，取消 = 原样保持；
 * 空闲会话直接关闭。关闭 Tab 不杀 Agent 进程，所以「回答中」必须先 abort 再关，
 * 否则 Agent 会在后台继续烧 token；会话记录与历史始终保留，重新打开即可恢复。
 */
export function useCloseSessionTabShortcut({ closeTab, abortAgent, overlays }: CloseSessionTabShortcutDeps) {
	const store = useStore();

	useEffect(
		() =>
			desktopApi.app.onShortcutTriggered((id) => {
				if (id !== "closeSessionTab") return;
				const sessionId = store.get(currentSessionIdAtom);
				if (!sessionId) return;

				const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
				const sendStatus = store.get(sessionSendStateByIdAtom)[sessionId]?.status;
				// 「AI 对话进行中」与时间线 isBusy 同口径：发送激活中/发送 IPC 在途/runtime 流式或执行工具。
				// 终态（idle/error/closed）由 isSessionRuntimeBusy 权威早退，不受迟到 runtime-state 事件影响。
				const busy = sendStatus === "activating" || sendStatus === "sending" || isSessionRuntimeBusy(runtime?.status, runtime?.state);
				if (!busy) {
					closeTab(sessionId);
					return;
				}
				overlays.showConfirm({
					title: t("tabs.closeRunningTitle"),
					message: t("tabs.closeRunningBody"),
					confirmLabel: t("tabs.closeRunningConfirm"),
					danger: true,
					onConfirm: () => {
						overlays.clearConfirm();
						// 先停后关：abort 按 agentId 寻址（target 在 Tab 关闭后依然有效），无需等 IPC 返回；
						// 尚无绑定的激活早期没有可停的回合，直接关即可。
						const target = toSessionRuntimeTarget(sessionId, runtime);
						if (target) void abortAgent(target.agentId);
						closeTab(sessionId);
					},
				});
			}),
		[store, closeTab, abortAgent, overlays],
	);
}
