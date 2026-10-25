import { useStore } from "jotai";
import { useEffect, useRef } from "react";
import type { AvailableModel, SessionRuntimeModelSelection, SessionRuntimeTarget } from "../../../shared/types";
import { modelPendingByIdAtom, sessionRuntimeByIdAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import type { ModelPending } from "../utils/modelPendingDisplay";
import { SessionCommandFailure, isLiveRuntimeStatus, requireSessionCommand, toSessionRuntimeTarget } from "../utils/sessionCommands";

type RuntimeLike =
	| {
			agentId?: string;
			runtimeGeneration?: number;
			status?: string;
			state?: { isStreaming?: boolean };
	  }
	| undefined;

/**
 * 当后端明确拒绝运行中模型切换时，把待选模型在 runtime 空闲后重新提交；
 * 支持 live selection 的后端不会进入这条 fallback 路径。
 */
export function usePendingModelApply(input: { sessionId: string; runtime: RuntimeLike; modelPending: ModelPending | undefined; applySelectedModel: (model: SessionRuntimeModelSelection) => void; clearPending: () => void; offerRestart: (handle: SessionRuntimeTarget, model: AvailableModel) => void }) {
	const store = useStore();
	const applyingRef = useRef(false);
	// 同一选择/绑定若需重启，只弹一次；取消不重弹，但不能阻挡替换后的进程。
	const blockedRef = useRef(false);
	const callbacksRef = useRef(input);
	callbacksRef.current = input;
	const status = input.runtime?.status;
	const isStreaming = Boolean(input.runtime?.state?.isStreaming);
	const agentId = input.runtime?.agentId;
	const runtimeGeneration = input.runtime?.runtimeGeneration;

	useEffect(() => {
		blockedRef.current = false;
	}, [input.modelPending, input.sessionId, agentId, runtimeGeneration]);

	useEffect(() => {
		const current = callbacksRef.current;
		if (!current.modelPending || applyingRef.current) return;
		const pending = current.modelPending;
		const handle = toSessionRuntimeTarget(current.sessionId, current.runtime);
		// atom 已换绑/换意图但 React 尚未重绘时，effect cleanup 还来不及淘汰旧请求。
		const ownsSelection = () => {
			const latest = toSessionRuntimeTarget(current.sessionId, store.get(sessionRuntimeByIdAtom)[current.sessionId]);
			return callbacksRef.current.sessionId === current.sessionId && store.get(modelPendingByIdAtom)[current.sessionId] === pending && latest?.agentId === handle?.agentId && latest?.runtimeGeneration === handle?.runtimeGeneration;
		};
		if (!ownsSelection()) return;
		const runtime = store.get(sessionRuntimeByIdAtom)[current.sessionId];
		if (!handle || !isLiveRuntimeStatus(runtime?.status)) {
			// 终态只清展示标记；busy 路径已保存的下次启动偏好仍保留。
			current.clearPending();
			return;
		}
		// starting 有绑定但尚未握手；只在真正 idle、无流式输出时重试。
		if (blockedRef.current || runtime?.status !== "idle" || runtime.state?.isStreaming) return;
		applyingRef.current = true;
		let cancelled = false;
		const isCurrent = () => !cancelled && ownsSelection() && isLiveRuntimeStatus(store.get(sessionRuntimeByIdAtom)[current.sessionId]?.status);
		void (async () => {
			try {
				// 运行时 readback 是最终值；不要用排队时的模型快照覆盖实际模型名/档位。
				const applied = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(handle, pending.to.provider, pending.to.modelId, pending.to.modelName));
				if (!isCurrent()) return;
				current.applySelectedModel(applied.value);
				current.clearPending();
			} catch (error) {
				if (!isCurrent()) return;
				if (error instanceof SessionCommandFailure && error.needsRestart) {
					blockedRef.current = true;
					current.offerRestart(handle, {
						provider: pending.to.provider,
						id: pending.to.modelId,
						name: pending.to.modelName,
					});
					return;
				}
				if (error instanceof SessionCommandFailure && (error.code === "SESSION_RUNTIME_UNAVAILABLE" || error.code === "SESSION_RUNTIME_CHANGED")) {
					current.clearPending();
					return;
				}
				showNotice(error instanceof Error ? error.message : String(error), 4000);
			} finally {
				if (!cancelled) applyingRef.current = false;
			}
		})();
		return () => {
			cancelled = true;
			applyingRef.current = false;
		};
	}, [input.modelPending, input.sessionId, status, isStreaming, agentId, runtimeGeneration, store]);
}
