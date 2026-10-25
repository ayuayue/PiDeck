import { useEffect, useRef } from "react";
import { useStore } from "jotai";
import type { AgentRuntimeState } from "../../../shared/types";
import { applySessionRuntimeEventAtom, openSettingsAtom, replaceSessionRuntimesAtom, sessionRuntimeByIdAtom, setSessionDraftAtom } from "../atoms";
import { agentExitedAtom } from "../atoms/runtime-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";
import { showNotice } from "../utils/notice";
import type { NoticeActions, NoticeKind } from "../utils/notice";

type RuntimeBridgeCallbacks = {
	onRuntimeCapabilityChanged?: (input: { sessionId: string; agentId: string; previous?: AgentRuntimeState; current: AgentRuntimeState; patch: AgentRuntimeState }) => void;
	/**
	 * 「停止响应较慢」提示上的恢复入口：由 App 装配到带确认的重启通道。
	 * 桥自己不直接调 restartRuntime——终止进程是破坏性动作，必须过确认框。
	 */
	onRestartSessionRuntime?: (sessionId: string) => void;
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
			// 停止按钮撤回的排队消息（main AgentManager.clearQueueBeforeAbort → agents:queue-cleared）：
			// 用户点停止后排队中的 steer/followUp 不会执行，文本写回输入框（CLI Esc 同款语义）。
			// append 而非 replace：不清空用户正在写的内容。
			if (event.sourceChannel === "agents:queue-cleared" && event.payload && typeof event.payload === "object") {
				const payload = event.payload as { steering?: unknown; followUp?: unknown };
				const texts = [...(Array.isArray(payload.steering) ? payload.steering : []), ...(Array.isArray(payload.followUp) ? payload.followUp : [])].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
				if (texts.length > 0) {
					const joined = texts.join("\n\n");
					store.set(setSessionDraftAtom, { sessionId: event.sessionId, value: (current: string) => (current.trim() ? `${current}\n\n${joined}` : joined) });
				}
				return;
			}
			// 主进程瞬时状态反馈（如 abort 已请求停止）走 toast，不进会话时间线：
			// 系统卡片太抢眼，且插在 assistant 中间会打断 agent-run 分组。
			if (event.sourceChannel === "agents:notice" && event.payload && typeof event.payload === "object") {
				const notice = event.payload as {
					message?: string;
					i18nKey?: string;
					/** i18n 占位符参数：主进程无法本地化时把 source/command 等一起传下来。 */
					i18nParams?: Record<string, string | number>;
					kind?: NoticeKind;
					duration?: number;
					/** 主进程只能给符号化动作 id（它不掌握 UI 导航），在这里解析成实际跳转。 */
					action?: string;
				};
				const text = notice.i18nKey ? t(notice.i18nKey as TranslationKey, notice.i18nParams) : notice.message;
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
							: notice.action === "openMcpSettings"
								? {
										action: {
											// 去配置管理 → MCP 页（Pi 后端）；与设置页「配置管理」深链同一套目标结构。
											label: t("notice.openMcpSettings"),
											onClick: () => store.set(openSettingsAtom, { pane: "config", tab: "dev", backendPane: "pi", configTab: "mcp" }),
										},
									}
								: // 「停止响应较慢」：pi 被子进程堵住时 abort 永远不回包，只有重建运行时才停得下来。
									// 会话身份取 envelope 的 sessionId；重启经回调交给 App（带确认），
									// 桥不直接杀进程——误触一次就是丢一轮回答。
									notice.action === "restartSessionRuntime" && event.sessionId
									? {
											action: {
												label: t("notice.restartSessionRuntime"),
												onClick: () => callbacksRef.current.onRestartSessionRuntime?.(event.sessionId),
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
