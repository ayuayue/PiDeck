import type { WebContents } from "electron";
import { agentEventTags, ipcChannels } from "../../shared/ipc";
import type { SessionRuntimeEvent } from "../../shared/types";

/**
 * 主进程 → 发起窗口的一条 toast（#539）。
 *
 * 为什么走 agents:notice：这是「操作成功，但有一小部分文件没处理掉」的瞬时反馈，与 runtime
 * 无关（归档/删除后 runtime 已解绑，没有会话能承载系统消息）。渲染层
 * useSessionRuntimeBridge 对 sourceChannel=agents:notice 的载荷直接弹 toast、不查 runtime。
 *
 * 为什么用发起请求的 sender 而不是广播：多窗口下只有操作者该看到这条提示。
 */
export function sendAgentsNotice(sender: WebContents, notice: { sessionId?: string; i18nKey: string; i18nParams?: Record<string, string | number>; message: string }): void {
	if (sender.isDestroyed()) return;
	const event: SessionRuntimeEvent = {
		kind: "event",
		sessionId: notice.sessionId ?? "",
		agentId: "system",
		runtimeGeneration: 0,
		sourceChannel: agentEventTags.agentsNotice,
		payload: { i18nKey: notice.i18nKey, i18nParams: notice.i18nParams, kind: "warning", duration: 8_000, message: notice.message },
	};
	sender.send(ipcChannels.sessionsRuntimeEvent, event);
}
