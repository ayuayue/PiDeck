/**
 * GUI 扩展桥 —— 渲染层回灌交互事件的 hook（§8.3）。
 *
 * 渲染层**只上报，不改状态**：点击/输入把事件经 IPC 送回主进程，
 * 主进程排入桥队列，pi 侧桥在下次轮询时取走并在扩展里触发回调，
 * 扩展改完状态后推新树回来 —— 渲染层自然重渲。
 *
 * 身份校验：事件带 `sessionId + agentId + runtimeGeneration`，
 * 主进程据此拒绝旧 runtime 的迟到事件（AGENTS.md 硬性要求）。
 */

import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { sessionRuntimeByIdAtom } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";
import type { BridgeEventInput } from "../../../shared/types/bridge";
import type { BridgeNodeEvent } from "../components/bridge/renderBridgeNode";

/**
 * 返回一个事件上报回调。
 *
 * `sessionId` 对应的 runtime 未就绪（detached / 无 agentId）时返回 no-op ——
 * 桥此时也不会推内容，上报没有意义。
 */
export function useBridgeEventSink(sessionId: string | undefined): (nodeId: string, event: BridgeNodeEvent) => void {
	const runtime = useAtomValue(sessionRuntimeByIdAtom);
	const binding = sessionId ? runtime[sessionId] : undefined;
	const agentId = binding?.agentId;
	const runtimeGeneration = binding?.runtimeGeneration;

	return useCallback(
		(nodeId: string, event: BridgeNodeEvent) => {
			if (!sessionId || !agentId || typeof runtimeGeneration !== "number") return;
			const input: BridgeEventInput = {
				sessionId,
				agentId,
				runtimeGeneration,
				event: { ...event, nodeId } as BridgeEventInput["event"],
			};
			// fire-and-forget：上报失败（旧 runtime / 桥未连）不影响 UI。
			// 走 desktopApi 这个规范入口（PR 评审 §3）：浏览器/预览态由 browserApi / previewApi
			// 的 sendBridgeEvent stub 应答，而不是直接摸 window.piDesktop（绕开入口会让 stub 失效）。
			try {
				void desktopApi.sessions.sendBridgeEvent(input).catch(() => undefined);
			} catch {
				// preload 缺失的配置错误态：desktopApi 是抛错 Proxy，点击不该把异常抛到 React 里
			}
		},
		[agentId, runtimeGeneration, sessionId],
	);
}
