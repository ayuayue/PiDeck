import { useCallback, useRef } from "react";
import { useStore } from "jotai";
import { t, translateI18nDescriptor } from "../../i18n";
import { desktopApi as api } from "../../desktopApi";
import { applyDshGoalSendTransform, buildComposerPromptSubmission } from "../../composerBehavior";
import { resolveBusySendDelivery } from "../../../../shared/busySendDelivery";
import { PromptDeliveryUnknownError } from "../../utils/promptErrors";
import { busySendDeliveryAtom, bumpNewTurnCollapseTickAtom, currentSessionRuntimeAtom, sessionDraftByIdAtom, sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import type { ImageContent, ComposerAgentMode } from "../../../../shared/types";

export interface SessionPromptDispatchDeps {
	store: ReturnType<typeof useStore>;
	setSessionDraft: (payload: { sessionId: string; value: string }) => void;
	currentSessionId: string | undefined;
	currentSessionIdRef: React.MutableRefObject<string | undefined>;
	activeAgentIdRef: React.MutableRefObject<string | undefined>;
	showToast: (message: string, duration?: number) => void;
}

/**
 * 会话提示词分发域（Session-first 架构下的发送路径）：
 *
 * - livePromptByAgentRef：contentEditable 实时值镜像（发送路径读这里，权威源是 sessionDraft atom）；
 * - setPromptForAgent / setPrompt：写指定会话/当前会话的草稿（函数式更新从 atom 权威源取 previous，
 *   避免镜像滞后把已删除内容带回输入框）；
 * - dispatchPromptSnapshot：IPC sendPrompt 唯一出口——DSH 目标改写（agentMessage 拒绝 → /goal）、
 *   unknown 投递不降级（网络/IPC 抖动不可重试，防止重复发送）、成功后 bump 新一轮折叠 tick；
 * - submitPromptSnapshot：非队列入口——忙碌时按 busySendDelivery 设置解析投递语义（steer/followUp/直发）；
 * - isAgentCurrentlyBusy / translateAgentErrorMessage：忙碌判定与 BUSY_ 错误码本地化。
 *
 * 队列（排队消息 drain）在 useQueuedPrompt，编辑/重发在 useSessionHistoryMutations，
 * 均消费本 hook 的返回值。
 */
export function useSessionPromptDispatch({ store, setSessionDraft, currentSessionId, currentSessionIdRef, activeAgentIdRef, showToast }: SessionPromptDispatchDeps) {
	// contentEditable 的实时值通过 livePromptByAgentRef 保持最新，发送路径始终从这里读取草稿。
	const livePromptByAgentRef = useRef<Record<string, string>>({});

	function setPromptForAgent(agentId: string, value: string | ((current: string) => string)) {
		const targetAgentId = agentId;
		// previous 必须从 Session draft atom 读取（权威源）：输入框的编辑/删除都经 composer
		// setDraft 写入 atom，livePromptByAgentRef 只在 setPromptForAgent 内更新，若用它当
		// previous，「右键引用 → 删除 → 再右键引用」会把已删除的旧引用带回输入框。
		const previous = store.get(sessionDraftByIdAtom)[targetAgentId] ?? "";
		const nextValue = typeof value === "function" ? value(previous) : value;
		if (nextValue) livePromptByAgentRef.current[targetAgentId] = nextValue;
		else delete livePromptByAgentRef.current[targetAgentId];
		setSessionDraft({ sessionId: targetAgentId, value: nextValue });
	}

	function setPrompt(value: string | ((current: string) => string)) {
		const targetId = currentSessionIdRef.current ?? activeAgentIdRef.current;
		if (targetId) setPromptForAgent(targetId, value);
	}

	// isAgentBusy: synchronous store read (steer logic is callback-only, not render-time).
	const isAgentCurrentlyBusy = useCallback(() => {
		if (!currentSessionId) return false;
		const rt = store.get(currentSessionRuntimeAtom);
		// 与 composer isBusy 对齐（含 isExecutingTool）：DSH 工具执行期间 steer 也应可用。
		return rt?.status === "running" || Boolean(rt?.state?.isStreaming) || Boolean(rt?.state?.isExecutingTool);
	}, [currentSessionId, store]);

	const dispatchPromptSnapshot = useCallback(
		async (sessionId: string, message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp", agentMode: ComposerAgentMode = "normal", templateDescription?: string, options?: { requireAppliedModel?: boolean }) => {
			// 排队投递与输入框同一套规则：DSH 拒绝 agentMessage，首次目标改写成 /goal。
			const record = store.get(sessionRecordByIdAtomFamily(sessionId));
			const isDsh = record?.backend === "dsh";
			const visibleMessage = isDsh
				? applyDshGoalSendTransform({
						message,
						mode: agentMode,
						goal: store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))?.state?.goal,
					})
				: message;
			const submission = buildComposerPromptSubmission(visibleMessage, isDsh ? "normal" : agentMode);
			let result: Awaited<ReturnType<typeof api.sessions.sendPrompt>>;
			try {
				result = await api.sessions.sendPrompt({
					sessionId,
					requestId: crypto.randomUUID(),
					message: submission.message,
					images,
					...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
					...(templateDescription ? { description: templateDescription } : {}),
					...(streamingBehavior ? { streamingBehavior } : {}),
					// fork 化重发/编辑：主进程发前核对运行时模型，不一致就拒绝而不是静默换模型发送。
					...(options?.requireAppliedModel ? { requireAppliedModel: true } : {}),
				});
			} catch (error) {
				// IPC/fetch 在请求发出后断开时无法判断主进程是否已经提交给 pi；按未知处理，
				// 绝不能把它降级为可重试失败，否则网络/IPC 抖动会造成重复发送。
				throw new PromptDeliveryUnknownError(error instanceof Error ? error.message : String(error));
			}
			if (!result.accepted) {
				const localizedError = translateI18nDescriptor(result, result.error);
				if (result.delivery === "unknown") {
					throw new PromptDeliveryUnknownError(localizedError);
				}
				throw new Error(localizedError);
			}
			// 排队投递（steer「插入当前回合」/ followUp 排队）同样构成「新一轮」：
			// bump 会话 tick，timeline 侧非最新轮据此收起。
			// 普通发送由 useSessionSend 的 sendPrompt 返回值自己 bump；这里是队列 drain 的
			// 唯一出口，漏掉会导致中断轮（无最终回答）在新一轮开始后仍保持展开。
			store.set(bumpNewTurnCollapseTickAtom, sessionId);
		},
		[store],
	);

	const submitPromptSnapshot = useCallback(
		async (
			sessionId: string,
			message: string,
			images?: ImageContent[],
			/** 仅重发/编辑使用：要求「运行时模型 == 会话选择的模型」，否则拒绝发送（issue #370）。 */
			options?: { requireAppliedModel?: boolean },
		) => {
			// 非队列入口：当前选中 agent 忙碌时按「忙碌时投递行为」设置决定投递语义
			//（pi/dsh 统一；ACP 协议无 steer，resolve 内部恒收敛为 followUp）；空闲直发（undefined）。
			// 客户端队列 drain 直接调用 dispatchPromptSnapshot，并显式指定其投递语义。
			const behavior = resolveBusySendDelivery(sessionId === currentSessionId && isAgentCurrentlyBusy(), store.get(busySendDeliveryAtom), store.get(sessionRecordByIdAtomFamily(sessionId))?.backend);
			try {
				await dispatchPromptSnapshot(sessionId, message, images, behavior, "normal", undefined, options);
				return true;
			} catch (error) {
				if (error instanceof PromptDeliveryUnknownError) {
					showToast(t("app.queuedUnknown"), 6000);
					return "unknown" as const;
				}
				showToast(error instanceof Error ? error.message : String(error), 4000);
				return false;
			}
		},
		[currentSessionId, dispatchPromptSnapshot, isAgentCurrentlyBusy, showToast, store, t],
	);

	/** 将主进程抛出的错误消息中的 BUSY_ 前缀码转为前端多语言文案 */
	function translateAgentErrorMessage(msg: string): string {
		if (msg.startsWith("BUSY_STREAMING:")) return t("message.busyStreaming");
		if (msg.startsWith("BUSY_TOOL:")) return t("message.busyTool");
		if (msg.startsWith("BUSY_GENERIC:")) return t("message.busyGeneric");
		return msg;
	}

	return {
		livePromptByAgentRef,
		setPromptForAgent,
		setPrompt,
		isAgentCurrentlyBusy,
		dispatchPromptSnapshot,
		submitPromptSnapshot,
		translateAgentErrorMessage,
	};
}
