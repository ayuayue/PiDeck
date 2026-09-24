import { useEffect, useRef } from "react";
import type { AvailableModel, SessionRuntimeModelSelection, SessionRuntimeTarget } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import type { ModelPending } from "../utils/modelPendingDisplay";
import { SessionCommandFailure, requireSessionCommand, toSessionRuntimeTarget } from "../utils/sessionCommands";

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
	const applyingRef = useRef(false);
	// 套模型若需重启，只弹一次；取消后也不要跟着 runtime 刷新再弹。
	const blockedRef = useRef(false);
	const callbacksRef = useRef(input);
	callbacksRef.current = input;

	useEffect(() => {
		blockedRef.current = false;
	}, [input.modelPending, input.sessionId]);

	const inFlight = input.runtime?.status === "running" || Boolean(input.runtime?.state?.isStreaming);
	const agentId = input.runtime?.agentId;
	const runtimeGeneration = input.runtime?.runtimeGeneration;

	useEffect(() => {
		const current = callbacksRef.current;
		if (!current.modelPending || applyingRef.current || blockedRef.current) return;
		if (inFlight) return;
		const handle = toSessionRuntimeTarget(current.sessionId, current.runtime);
		if (!handle) {
			current.clearPending();
			return;
		}
		const pending = current.modelPending;
		applyingRef.current = true;
		let cancelled = false;
		void (async () => {
			try {
				// 运行时 readback 是最终值；不要用排队时的模型快照覆盖实际模型名/档位。
				const applied = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(handle, pending.to.provider, pending.to.modelId, pending.to.modelName));
				if (cancelled) return;
				current.applySelectedModel(applied.value);
				current.clearPending();
			} catch (error) {
				if (cancelled) return;
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
	}, [input.modelPending, input.sessionId, inFlight, agentId, runtimeGeneration]);
}
