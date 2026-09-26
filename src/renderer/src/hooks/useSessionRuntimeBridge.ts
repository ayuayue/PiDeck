import { useEffect, useRef } from "react";
import { useStore } from "jotai";
import type { AgentRuntimeState } from "../../../shared/types";
import { applySessionRuntimeEventAtom, openSettingsAtom, replaceSessionRuntimesAtom, sessionRuntimeByIdAtom } from "../atoms";
import { agentExitedAtom } from "../atoms/runtime-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";
import { showNotice } from "../utils/notice";
import type { NoticeActions, NoticeKind } from "../utils/notice";

type RuntimeBridgeCallbacks = {
	onRuntimeCapabilityChanged?: (input: { sessionId: string; agentId: string; previous?: AgentRuntimeState; current: AgentRuntimeState; patch: AgentRuntimeState }) => void;
};

export function useSessionRuntimeBridge(callbacks: RuntimeBridgeCallbacks = {}): void {
	const store = useStore();
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;

	useEffect(() => {
		let disposed = false;
		void desktopApi.sessions
			.listRuntimes()
			.then((runtimes) => {
				if (!disposed) store.set(replaceSessionRuntimesAtom, runtimes);
			})
			.catch(() => undefined);

		const offRuntimeEvents = desktopApi.sessions.onRuntimeEvent((event) => {
			// agents:state 是全量 AgentTab[] 推送：对已退出（closed）的 agent 释放
			// agentId 维度 atomFamily 缓存（agentId 每次新 UUID，只增不清是慢泄漏）。
			if (event.sourceChannel === "agents:state" && Array.isArray(event.payload)) {
				for (const tab of event.payload as Array<{ id?: string; status?: string }>) {
					if (typeof tab.id === "string" && tab.status === "closed") {
						store.set(agentExitedAtom, tab.id);
					}
				}
			}
			// 主进程瞬时状态反馈（如 abort 已请求停止）走 toast，不进会话时间线：
			// 系统卡片太抢眼，且插在 assistant 中间会打断 agent-run 分组。
			if (event.sourceChannel === "agents:notice" && event.payload && typeof event.payload === "object") {
				const notice = event.payload as {
					message?: string;
					i18nKey?: string;
					kind?: NoticeKind;
					duration?: number;
					/** 主进程只能给符号化动作 id（它不掌握 UI 导航），在这里解析成实际跳转。 */
					action?: string;
				};
				const text = notice.i18nKey ? t(notice.i18nKey as TranslationKey) : notice.message;
				if (text) {
					// 异常（error）常驻不自动消失；其余时长由设置项 toastDurationMs 全局决定，
					// 主进程带的 duration 不再单独尊重。
					const kind = notice.kind ?? "info";
					// 「禁用扩展启动」提示带动作：一键打开 设置 → 开发设置 并滚到启动参数，
					// 否则用户只能自己去找该开关（能力静默缺失就是这么来的）。
					const actions: NoticeActions | undefined =
						notice.action === "openDevExtensionsSettings"
							? {
									action: {
										label: t("notice.openDevExtensionsSettings"),
										onClick: () => store.set(openSettingsAtom, { tab: "dev", section: "dev-pi-rpc" }),
									},
								}
							: undefined;
					showNotice(
						text,
						kind === "error" ? Number.POSITIVE_INFINITY : undefined,
						kind,
						undefined,
						actions,
						// 以 i18nKey 作稳定 id：同一条提示重复推送时顶掉上一条，不堆一排
						notice.i18nKey,
					);
				}
				return;
			}
			const previousRuntime = store.get(sessionRuntimeByIdAtom)[event.sessionId];
			store.set(applySessionRuntimeEventAtom, event);
			if (event.sourceChannel !== "agents:runtime-state") return;
			const currentRuntime = store.get(sessionRuntimeByIdAtom)[event.sessionId];
			if (currentRuntime?.agentId !== event.agentId || currentRuntime.runtimeGeneration !== event.runtimeGeneration || !currentRuntime.state || !event.payload || typeof event.payload !== "object") {
				return;
			}
			const patch = (event.payload as { state?: AgentRuntimeState }).state;
			if (!patch) return;
			callbacksRef.current.onRuntimeCapabilityChanged?.({
				sessionId: event.sessionId,
				agentId: event.agentId,
				previous: previousRuntime?.agentId === event.agentId && previousRuntime.runtimeGeneration === event.runtimeGeneration ? previousRuntime.state : undefined,
				current: currentRuntime.state,
				patch,
			});
		});
		return () => {
			disposed = true;
			offRuntimeEvents();
		};
	}, [store]);
}
