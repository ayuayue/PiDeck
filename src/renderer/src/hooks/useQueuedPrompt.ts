import { useState, useRef, useEffect } from "react";
import type { MutableRefObject } from "react";
import type { createStore } from "jotai";
import type { AgentTab, ComposerAgentMode, ImageContent, SessionRuntimeTarget } from "../../../shared/types";
import { currentSessionIdAtom, sessionRecordsAtom, sessionRuntimeByIdAtom } from "../atoms";
import { acknowledgeUnknownPrompt, claimIdleHead, claimNextSteerPrompt, enqueuePrompt, QUEUED_PROMPT_LIMIT, replaceSessionQueue, resolveClaimedPrompt, retractPrompt, updateQueuedPromptBehavior, type QueuedPromptSnapshot } from "../utils/queuedPromptQueue";
import { queueDrainSuppressedByIdAtom, sessionDraftByIdAtom, setSessionDraftAtom, setSessionAttachmentsAtom, setSessionComposerModeAtom } from "../atoms/composer-atoms";
import { PromptDeliveryUnknownError } from "../utils/promptErrors";
import { isLiveRuntimeStatus, toSessionRuntimeTarget } from "../utils/sessionCommands";
import { t } from "../i18n";

export type QueuedPrompt = QueuedPromptSnapshot;

export interface UseQueuedPromptOptions {
	displayAgentsRef: MutableRefObject<AgentTab[]>;
	queueFlushBySessionRef: MutableRefObject<Set<string>>;
	composerTextareaRef: MutableRefObject<HTMLDivElement | null>;
	pendingComposerCaretRef: MutableRefObject<number | null>;

	/** Jotai store for restoring Session composer state in retract-to-edit. */
	store: ReturnType<typeof createStore>;

	setComposerCursor: (value: React.SetStateAction<number>) => void;
	showToast: (message: string, duration?: number) => void;
	/** i18n-aware message shown when delivery result is unknown. */
	unknownDeliveryMessage?: string;

	dispatchPromptSnapshot: (sessionId: string, message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp", agentMode?: ComposerAgentMode, templateDescription?: string) => Promise<void>;
}

/** 队列发送超时：防止 dispatchPromptSnapshot 长时间挂起导致队列项永久卡在 sending。 */
const QUEUED_SEND_TIMEOUT_MS = 30_000;

/** 取消只结束本地等待，不表示撤销已经发给主进程的消息。 */
async function withSendTimeout(promise: Promise<void>, signal: AbortSignal): Promise<boolean> {
	let timer: number | undefined;
	let cancel = () => {};
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<false>((resolve) => {
				cancel = () => {
					window.clearTimeout(timer);
					resolve(false);
				};
				if (signal.aborted) return cancel();
				signal.addEventListener("abort", cancel, { once: true });
				timer = window.setTimeout(() => resolve(false), QUEUED_SEND_TIMEOUT_MS);
			}),
		]);
	} finally {
		window.clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

/** 一次 drain 的所有权；运行时只约束后续投递，不抹掉已收到的接受结果。 */
type QueueFlush = { target: SessionRuntimeTarget; controller: AbortController };

export function useQueuedPrompt(options: UseQueuedPromptOptions) {
	const { displayAgentsRef, queueFlushBySessionRef, composerTextareaRef, pendingComposerCaretRef, store, setComposerCursor, showToast, unknownDeliveryMessage = t("app.queuedDeliveryUnknown"), dispatchPromptSnapshot } = options;

	const [queuedPrompts, setQueuedPrompts] = useState<Record<string, QueuedPrompt[]>>({});
	const queuedPromptsRef = useRef<Record<string, QueuedPrompt[]>>({});
	const mountedRef = useRef(false);
	const flushesRef = useRef(new Map<string, QueueFlush>());
	const idleTimersRef = useRef(new Map<string, number>());
	const editFramesRef = useRef(new Map<number, string>());
	/** 「停止响应」抑制：会话 → 是否已观测到空闲（用于判定用户重新发起回合）。 */
	const suppressedRef = useRef(new Map<string, { sawIdle: boolean }>());

	/** 只释放本 hook 拥有的锁；旧请求的 finally 不得解开同 ID 新会话的锁。 */
	function cancelSessionWork(sessionId: string) {
		const flush = flushesRef.current.get(sessionId);
		if (flush) {
			flushesRef.current.delete(sessionId);
			queueFlushBySessionRef.current.delete(sessionId);
			flush.controller.abort();
		}
		window.clearTimeout(idleTimersRef.current.get(sessionId));
		idleTimersRef.current.delete(sessionId);
		for (const [frame, owner] of editFramesRef.current) {
			if (owner !== sessionId) continue;
			cancelAnimationFrame(frame);
			editFramesRef.current.delete(frame);
		}
		if (suppressedRef.current.delete(sessionId)) syncDrainSuppressedAtom(sessionId);
	}

	useEffect(() => {
		// StrictMode 重放 effect 时重新置 true；取消的 drain 仍由独立 token 拒绝迟到回包。
		mountedRef.current = true;
		// 会话身份 = catalog 记录 + 运行时绑定，两者都消失才算真正删除：
		// - removeSessionStateAtom 先删 records 再删 runtime，单一订阅会在中间态漏删，必须双订阅；
		// - 目录源/backend 切换只把记录从列表过滤掉（runtime 仍在），此时队列应保留休眠，
		//   切回后继续投递，不能按「删除」误清。
		const pruneRemovedSessions = () => {
			const records = store.get(sessionRecordsAtom);
			const runtimes = store.get(sessionRuntimeByIdAtom);
			// 抑制解除判定：只依据被订阅的 runtime 原子自身的状态转移。agent 状态（displayAgents）
			// 是另一条更新链，在本次通知回调里可能是旧值；混合判定会把「观测到空闲」误判成忙，
			// 导致抑制永不解除（表现为停一次之后队列永远不再自动发送）。
			// 先观测到 idle（abort 风口结束），其后出现 starting/running = 用户重新发起回合，解除抑制。
			for (const [sessionId, flag] of suppressedRef.current) {
				if (!records[sessionId] || !runtimes[sessionId]) continue; // 删除路径由 cancelSessionWork 统一清理
				const status = runtimes[sessionId].status;
				if (status === "idle") flag.sawIdle = true;
				else if (status === "starting" || status === "running") {
					if (flag.sawIdle) {
						suppressedRef.current.delete(sessionId);
						syncDrainSuppressedAtom(sessionId);
					}
				}
			}
			const ownedIds = new Set([...Object.keys(queuedPromptsRef.current), ...flushesRef.current.keys(), ...idleTimersRef.current.keys(), ...editFramesRef.current.values(), ...suppressedRef.current.keys()]);
			for (const sessionId of ownedIds) {
				if (records[sessionId] || runtimes[sessionId]) continue;
				cancelSessionWork(sessionId);
				updateQueuedPrompts((current) => replaceSessionQueue(current, sessionId, () => []));
			}
		};
		const unsubscribeRecords = store.sub(sessionRecordsAtom, pruneRemovedSessions);
		const unsubscribeRuntimes = store.sub(sessionRuntimeByIdAtom, pruneRemovedSessions);
		pruneRemovedSessions();
		return () => {
			mountedRef.current = false;
			unsubscribeRecords();
			unsubscribeRuntimes();
			for (const sessionId of new Set([...flushesRef.current.keys(), ...idleTimersRef.current.keys(), ...editFramesRef.current.values(), ...suppressedRef.current.keys()])) cancelSessionWork(sessionId);
		};
	}, [store, queueFlushBySessionRef]);

	function updateQueuedPrompts(updater: (current: Record<string, QueuedPrompt[]>) => Record<string, QueuedPrompt[]>) {
		if (!mountedRef.current) return;
		const next = updater(queuedPromptsRef.current);
		queuedPromptsRef.current = next;
		setQueuedPrompts(next);
	}

	/** 队列只属于仍在目录中的会话；切换焦点或关闭 Tab 不影响归属。 */
	function hasSession(sessionId: string) {
		return mountedRef.current && Boolean(store.get(sessionRecordsAtom)[sessionId]);
	}

	/** ref 是逻辑真值（同步读、无异步窗口）；原子只是队列面板「已暂停自动发送」提示的 UI 投影。 */
	function syncDrainSuppressedAtom(sessionId: string) {
		store.set(queueDrainSuppressedByIdAtom, (current) => {
			if (suppressedRef.current.has(sessionId) === Boolean(current[sessionId])) return current;
			const next = { ...current };
			if (suppressedRef.current.has(sessionId)) next[sessionId] = true;
			else delete next[sessionId];
			return next;
		});
	}

	function setSessionQueuedPrompts(sessionId: string, updater: (current: QueuedPrompt[]) => QueuedPrompt[]) {
		if (!hasSession(sessionId)) return;
		updateQueuedPrompts((current) => replaceSessionQueue(current, sessionId, updater));
	}

	/** 入队；满员时返回 false，调用方应保留输入框内容并 toast。 */
	function enqueueQueuedPrompt(sessionId: string, queuedPrompt: QueuedPrompt): boolean {
		if (!hasSession(sessionId)) return false;
		const before = queuedPromptsRef.current[sessionId]?.length ?? 0;
		if (before >= QUEUED_PROMPT_LIMIT) return false;
		updateQueuedPrompts((current) => enqueuePrompt(current, sessionId, queuedPrompt));
		return (queuedPromptsRef.current[sessionId]?.length ?? 0) > before;
	}

	function appendUnknownQueuedPrompt(sessionId: string, queuedPrompt: QueuedPrompt, error?: string) {
		setSessionQueuedPrompts(sessionId, (current) => {
			if (current.length >= QUEUED_PROMPT_LIMIT) return current;
			return [...current, { ...queuedPrompt, status: "unknown", error }];
		});
	}

	function retractQueuedPrompt(sessionId: string, promptId: string) {
		updateQueuedPrompts((current) => retractPrompt(current, sessionId, promptId));
	}

	/** 丢弃：pending/failed 走 retract；unknown 仅移除提示（不重发）。sending 不可丢弃。 */
	function discardQueuedPrompt(sessionId: string, promptId: string) {
		const live = queuedPromptsRef.current[sessionId]?.find((item) => item.id === promptId);
		if (!live || live.status === "sending") return;
		if (live.status === "unknown") {
			updateQueuedPrompts((current) => acknowledgeUnknownPrompt(current, sessionId, promptId));
			return;
		}
		retractQueuedPrompt(sessionId, promptId);
	}

	function retractQueuedPromptForEdit(sessionId: string, queuedPrompt: QueuedPrompt) {
		if (!hasSession(sessionId)) return;
		const livePrompt = queuedPromptsRef.current[sessionId]?.find((promptItem) => promptItem.id === queuedPrompt.id);
		if (!livePrompt || livePrompt.status === "sending" || livePrompt.status === "unknown") return;
		retractQueuedPrompt(sessionId, livePrompt.id);

		// Resolve Session binding; if found, restore through Session atoms so the modern
		// ComposerArea (which reads sessionDraftByIdAtom / sessionAttachmentsByIdAtom /
		// sessionComposerModeByIdAtom) sees the restored content immediately.
		const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
		const restoredPrompt = [livePrompt.displayText, currentDraft].filter((text) => text.trim()).join("\n\n");
		store.set(setSessionDraftAtom, { sessionId, value: restoredPrompt });
		if (livePrompt.images?.length) {
			store.set(setSessionAttachmentsAtom, {
				sessionId,
				value: (current: ImageContent[]) => [...livePrompt.images!, ...current],
			});
		}
		store.set(setSessionComposerModeAtom, { sessionId, mode: livePrompt.agentMode });
		if (store.get(currentSessionIdAtom) === sessionId) {
			setComposerCursor(restoredPrompt.length);
			pendingComposerCaretRef.current = restoredPrompt.length;
			const editor = composerTextareaRef.current;
			const frame = requestAnimationFrame(() => {
				editFramesRef.current.delete(frame);
				if (!hasSession(sessionId) || store.get(currentSessionIdAtom) !== sessionId || composerTextareaRef.current !== editor) return;
				editor?.focus();
				if (editor) editor.scrollTop = editor.scrollHeight;
			});
			editFramesRef.current.set(frame, sessionId);
		}
	}

	/** catalog 与运行时必须同时有效，不能被已关闭进程残留的 busy 标志复活。 */
	function liveTarget(sessionId: string) {
		const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
		return hasSession(sessionId) && isLiveRuntimeStatus(runtime?.status) ? toSessionRuntimeTarget(sessionId, runtime) : undefined;
	}

	function isSessionRuntimeBusy(sessionId: string) {
		if (!liveTarget(sessionId)) return false;
		const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
		const agent = displayAgentsRef.current.find((item) => item.id === runtime.agentId);
		const runtimeState = runtime.state;
		return Boolean(runtime.status === "starting" || runtime.status === "running" || agent?.status === "starting" || agent?.status === "running" || runtimeState?.isStreaming || runtimeState?.isExecutingTool);
	}

	function canFlushQueuedPrompt(sessionId: string) {
		return Boolean(liveTarget(sessionId)) && store.get(sessionRuntimeByIdAtom)[sessionId]?.status === "idle" && !isSessionRuntimeBusy(sessionId) && !suppressedRef.current.has(sessionId);
	}

	/** 「停止响应」打断的是整个回合，队列必须交还用户：自动投递暂停，直到用户再次发起回合。
	 *  只 gate 后续投递，不打断已 claim 的 in-flight dispatch（其结果照常结算）。 */
	function suppressSessionQueueAutoDrain(sessionId: string) {
		if (!hasSession(sessionId) || suppressedRef.current.has(sessionId)) return;
		if (!queuedPromptsRef.current[sessionId]?.length) return;
		// 置位时只用 runtime 原子状态初始化（与解除判定同源）：已在空闲中置抑制的，
		// 下一个 busy 转移即视为重新发起回合并解除。
		suppressedRef.current.set(sessionId, store.get(sessionRuntimeByIdAtom)[sessionId]?.status === "idle" ? { sawIdle: true } : { sawIdle: false });
		syncDrainSuppressedAtom(sessionId);
		window.clearTimeout(idleTimersRef.current.get(sessionId));
		idleTimersRef.current.delete(sessionId);
		showToast(t("app.queuedDrainSuspendedAfterStop"), 4000);
	}

	/** claim 与锁均在首个 await 前建立；新的 drain 会取代旧的空闲定时器。 */
	function beginFlush(sessionId: string): QueueFlush | undefined {
		const target = liveTarget(sessionId);
		if (!target || queueFlushBySessionRef.current.has(sessionId)) return;
		window.clearTimeout(idleTimersRef.current.get(sessionId));
		idleTimersRef.current.delete(sessionId);
		const flush = { target, controller: new AbortController() };
		flushesRef.current.set(sessionId, flush);
		queueFlushBySessionRef.current.add(sessionId);
		return flush;
	}

	function finishFlush(sessionId: string, flush: QueueFlush): boolean {
		if (flushesRef.current.get(sessionId) !== flush) return false;
		flushesRef.current.delete(sessionId);
		queueFlushBySessionRef.current.delete(sessionId);
		return true;
	}

	/** 新运行时须由新的事件启动 drain，不能承接旧回包或旧定时器的续排。 */
	function canContinueFlush(sessionId: string, flush: QueueFlush): boolean {
		const current = liveTarget(sessionId);
		return !flush.controller.signal.aborted && current?.agentId === flush.target.agentId && current?.runtimeGeneration === flush.target.runtimeGeneration;
	}

	/** 结算原 claim；超时/未知结果保留屏障，删除或卸载后的回包不写回也不弹错。 */
	async function dispatchClaimedPrompt(sessionId: string, queuedPrompt: QueuedPrompt, flush: QueueFlush): Promise<boolean> {
		const ownsClaim = () => hasSession(sessionId) && flushesRef.current.get(sessionId) === flush;
		try {
			const accepted = await withSendTimeout(dispatchPromptSnapshot(sessionId, queuedPrompt.message, queuedPrompt.images, queuedPrompt.behavior === "direct" ? undefined : queuedPrompt.behavior, queuedPrompt.agentMode, queuedPrompt.templateDescription), flush.controller.signal);
			if (!ownsClaim()) return false;
			updateQueuedPrompts((current) => resolveClaimedPrompt(current, sessionId, queuedPrompt.id, accepted ? { type: "accepted" } : { type: "unknown", error: unknownDeliveryMessage }));
			if (!accepted && canContinueFlush(sessionId, flush)) showToast(unknownDeliveryMessage, 6000);
			return accepted;
		} catch (error) {
			if (!ownsClaim()) return false;
			const errorMessage = error instanceof Error ? error.message : String(error);
			const deliveryUnknown = error instanceof PromptDeliveryUnknownError;
			updateQueuedPrompts((current) => resolveClaimedPrompt(current, sessionId, queuedPrompt.id, { type: deliveryUnknown ? "unknown" : "failed", error: errorMessage }));
			if (canContinueFlush(sessionId, flush)) showToast(deliveryUnknown ? unknownDeliveryMessage : errorMessage, deliveryUnknown ? 6000 : 4000);
			return false;
		}
	}

	async function flushQueuedSteerPrompts(sessionId: string) {
		if (suppressedRef.current.has(sessionId)) return; // 用户正在停止该回合：不得再插队
		if (!isSessionRuntimeBusy(sessionId)) return;
		// ACP 协议无 steer 通道：忙碌时派发只会被 AcpAgentManager 拒收成失败队列项；
		// steer 项保留给空闲 drain（claimIdleHead 按序发，空闲时 steer 语义≈直发）。
		if (store.get(sessionRecordsAtom)[sessionId]?.backend === "acp") return;
		const flush = beginFlush(sessionId);
		if (!flush) return;
		try {
			while (canContinueFlush(sessionId, flush) && isSessionRuntimeBusy(sessionId) && !suppressedRef.current.has(sessionId)) {
				const claimed = claimNextSteerPrompt(queuedPromptsRef.current, sessionId);
				if (!claimed.prompt) break;
				updateQueuedPrompts(() => claimed.queues);
				if (!(await dispatchClaimedPrompt(sessionId, claimed.prompt, flush))) break;
			}
		} finally {
			if (finishFlush(sessionId, flush) && canContinueFlush(sessionId, flush) && canFlushQueuedPrompt(sessionId)) void flushNextQueuedPrompt(sessionId);
		}
	}

	/** 串行策略：agent 每次空闲只发送队首，其余消息继续可撤回。 */
	async function flushNextQueuedPrompt(sessionId: string) {
		if (queueFlushBySessionRef.current.has(sessionId) || !canFlushQueuedPrompt(sessionId)) return;
		const claimed = claimIdleHead(queuedPromptsRef.current, sessionId);
		if (!claimed.prompt) return;
		const flush = beginFlush(sessionId);
		if (!flush) return;
		updateQueuedPrompts(() => claimed.queues);
		try {
			await dispatchClaimedPrompt(sessionId, claimed.prompt, flush);
		} finally {
			if (finishFlush(sessionId, flush) && canContinueFlush(sessionId, flush)) {
				const timer = window.setTimeout(() => {
					if (idleTimersRef.current.get(sessionId) !== timer) return;
					idleTimersRef.current.delete(sessionId);
					if (canContinueFlush(sessionId, flush) && canFlushQueuedPrompt(sessionId)) void flushNextQueuedPrompt(sessionId);
				}, 150);
				idleTimersRef.current.set(sessionId, timer);
			}
		}
	}

	function setQueuedPromptBehavior(sessionId: string, promptId: string, behavior: "steer" | "followUp") {
		const live = queuedPromptsRef.current[sessionId]?.find((item) => item.id === promptId);
		if (!live) return;
		updateQueuedPrompts((current) => updateQueuedPromptBehavior(current, sessionId, promptId, behavior));
		// 改成插入当前回合后，若 agent 仍忙，立刻走 steer flush，不必等下一轮 tool-end。
		if (behavior === "steer" && isSessionRuntimeBusy(sessionId)) {
			void flushQueuedSteerPrompts(sessionId);
		}
	}

	return {
		queuedPrompts,
		setQueuedPrompts,
		queuedPromptsRef,
		updateQueuedPrompts,
		setSessionQueuedPrompts,
		enqueueQueuedPrompt,
		appendUnknownQueuedPrompt,
		retractQueuedPrompt,
		discardQueuedPrompt,
		retractQueuedPromptForEdit,
		setQueuedPromptBehavior,
		suppressSessionQueueAutoDrain,
		isSessionRuntimeBusy,
		canFlushQueuedPrompt,
		flushQueuedSteerPrompts,
		flushNextQueuedPrompt,
	};
}
