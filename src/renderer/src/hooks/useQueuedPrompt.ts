import { useState, useRef, useEffect } from "react";
import type { MutableRefObject } from "react";
import type { createStore } from "jotai";
import type { AgentTab, ComposerAgentMode, ImageContent, SessionRuntimeTarget } from "../../../shared/types";
import { currentSessionIdAtom, sessionRecordsAtom, sessionRuntimeByIdAtom } from "../atoms";
import { acknowledgeUnknownPrompt, canChangeQueuedPromptBehavior, claimIdleHead, claimNextSteerPrompt, enqueuePrompt, promotePrompt, QUEUED_PROMPT_LIMIT, replaceSessionQueue, resolveClaimedPrompt, retractPrompt, updateQueuedPromptBehavior, type QueuedPromptSnapshot } from "../utils/queuedPromptQueue";
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

/** 队列发送超时：防止「入队即回」的后端长时间挂起、把队列项永久卡在 sending。
 *  ACP 不适用（`session/prompt` 的回包就是回合结算，见 acksAtTurnEnd）。 */
const QUEUED_SEND_TIMEOUT_MS = 30_000;

type SendWait = "settled" | "timeout" | "aborted";

/** 取消只结束本地等待，不表示撤销已经发给主进程的消息。
 *  timeoutMs === undefined：该后端没有短平快的投递确认（ACP 的回合可能跑上十分钟），
 *  只能等回包或本地取消，不能拿一个固定窗口当作「没送到」。 */
async function withSendTimeout(promise: Promise<void>, signal: AbortSignal, timeoutMs: number | undefined): Promise<SendWait> {
	const settled = promise.then(() => "settled" as const);
	// 竞速已经结束（超时/取消）后才 reject 的投递：挂一个空 catch，避免变成未处理拒绝。
	settled.catch(() => {});
	if (signal.aborted) return "aborted";
	let timer: number | undefined;
	let onAbort = () => {};
	const interrupted = new Promise<Exclude<SendWait, "settled">>((resolve) => {
		onAbort = () => resolve("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) timer = window.setTimeout(() => resolve("timeout"), timeoutMs);
	});
	try {
		return await Promise.race([settled, interrupted]);
	} finally {
		window.clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/** drain 之后到「回合真的开始」之间的门禁（判据见 canFlushQueuedPrompt）。
 *  超时只是兜底：后端事件若没到，宁可慢发也不能在 accepted 窗口里连发。 */
const QUEUE_DRAIN_GATE_TIMEOUT_MS = 2_000;

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
	/** 会话 → 最近一次成功 drain 的门禁：把「accepted」和「回合已开始」分开，见 canFlushQueuedPrompt。
	 *  timer 是到期唤醒：门禁必须自己叫人，不能指望下一条外部事件。 */
	const drainGatesRef = useRef(new Map<string, { at: number; generation?: number; timer?: number }>());

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
		clearDrainGate(sessionId);
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
			// drain 门禁解除：状态投影里出现 starting/running 即「回合真的开始了」。这里订阅的是
			// runtime 原子本身，不依赖调用方恰好在忙的时候来问；解除后要等它回到 idle 才放行下一条。
			for (const sessionId of drainGatesRef.current.keys()) {
				const gateRuntime = runtimes[sessionId];
				if (gateRuntime?.status === "starting" || gateRuntime?.status === "running" || gateRuntime?.state?.isStreaming || gateRuntime?.state?.isExecutingTool) clearDrainGate(sessionId);
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
		const record = store.get(sessionRecordsAtom)[sessionId];
		// ACP 的 tab status 可能滞后于回合结算：isTurnActive 显式 false 即回合已结束，
		// 不能再用 displayAgents 里滞后的 running 把队列 drain 永久挡住。
		if ((record?.backend === "acp" || runtime.backend === "acp") && runtime.state?.isTurnActive === false) return false;
		const agent = displayAgentsRef.current.find((item) => item.id === runtime.agentId);
		const runtimeState = runtime.state;
		return Boolean(runtime.status === "starting" || runtime.status === "running" || agent?.status === "starting" || agent?.status === "running" || runtimeState?.isStreaming || runtimeState?.isExecutingTool);
	}

	/** 后端是否支持「插入当前回合」：ACP 协议无 steer 通道，忙时派发只会被拒收。
	 *  record 与 runtime 两侧都看：record 未回写时 runtime 已经生效，反之亦然。 */
	function supportsSteer(sessionId: string): boolean {
		return store.get(sessionRecordsAtom)[sessionId]?.backend !== "acp" && store.get(sessionRuntimeByIdAtom)[sessionId]?.backend !== "acp";
	}

	/** 门禁到期必须自己叫醒队列：后端事件丢了、或回合根本没有下一个「开始」事件时，
	 *  只靠外部 effect 会永久停摆。 */
	function armDrainGate(sessionId: string) {
		clearDrainGate(sessionId);
		const timer = window.setTimeout(() => {
			const gate = drainGatesRef.current.get(sessionId);
			if (!gate || gate.timer !== timer) return;
			drainGatesRef.current.delete(sessionId);
			if (canFlushQueuedPrompt(sessionId)) void flushNextQueuedPrompt(sessionId);
		}, QUEUE_DRAIN_GATE_TIMEOUT_MS);
		drainGatesRef.current.set(sessionId, { at: Date.now(), generation: store.get(sessionRuntimeByIdAtom)[sessionId]?.runtimeGeneration, timer });
	}

	function clearDrainGate(sessionId: string) {
		const gate = drainGatesRef.current.get(sessionId);
		if (gate === undefined) return;
		window.clearTimeout(gate.timer);
		drainGatesRef.current.delete(sessionId);
	}

	function canFlushQueuedPrompt(sessionId: string) {
		const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
		const record = store.get(sessionRecordsAtom)[sessionId];
		// drain 门禁：accepted 只代表后端收下了消息（pi/dsh 入队即回），回合未必已经开始。
		// 这段窗口里 runtime 仍是 idle，任何再次触发（队列 state 变化、状态投影、续排 timer）
		// 都会把下一条也发出去 —— 表现就是「排队的消息连发两条」。解除只有两条：真的观测到
		// 忙起来，或超时兜底（事件丢了也不能让队列永久卡住）。
		const gate = drainGatesRef.current.get(sessionId);
		if (gate !== undefined) {
			// 换代（重启/换 agent）意味着旧回合的去向已经无关：门禁必须立刻作废，否则新运行时
			// 上第一次 drain 会被旧回合的等待挡住。
			if (gate.generation !== runtime?.runtimeGeneration || isSessionRuntimeBusy(sessionId) || Date.now() - gate.at > QUEUE_DRAIN_GATE_TIMEOUT_MS) clearDrainGate(sessionId);
			else return false;
		}
		// 与 isSessionRuntimeBusy 同口径：ACP 回合已结算时，即使 status 仍是 running 也允许 drain。
		const acpTurnIdle = (record?.backend === "acp" || runtime?.backend === "acp") && runtime?.state?.isTurnActive === false;
		return Boolean(liveTarget(sessionId)) && (runtime?.status === "idle" || acpTurnIdle) && !isSessionRuntimeBusy(sessionId) && !suppressedRef.current.has(sessionId);
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

	/** ACP 的 `session/prompt` 回包就是整个回合的结算：投递确认在回合结束才到，
	 *  没有 pi/dsh 那种「入队即回」。对它套 30s 投递窗口只会把已经上屏的消息误判成
	 *  「未确认」，并把队首钉成一条既不能撤回也不能丢弃的屏障。 */
	function acksAtTurnEnd(sessionId: string): boolean {
		const record = store.get(sessionRecordsAtom)[sessionId];
		const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
		return record?.backend === "acp" || runtime?.backend === "acp";
	}

	/** 结算原 claim；超时/未知结果保留屏障，删除或卸载后的回包不写回也不弹错。 */
	async function dispatchClaimedPrompt(sessionId: string, queuedPrompt: QueuedPrompt, flush: QueueFlush): Promise<boolean> {
		const ownsClaim = () => hasSession(sessionId) && flushesRef.current.get(sessionId) === flush;
		// 删除、换代或卸载后的回包不写回也不弹错；本地取消只结束等待，同样不改行状态。
		const settle = (outcome: { type: "accepted" } | { type: "failed" | "unknown"; error: string }) => {
			if (!mountedRef.current || !ownsClaim()) return;
			updateQueuedPrompts((current) => resolveClaimedPrompt(current, sessionId, queuedPrompt.id, outcome));
		};
		try {
			const wait = await withSendTimeout(
				dispatchPromptSnapshot(sessionId, queuedPrompt.message, queuedPrompt.images, queuedPrompt.behavior === "direct" ? undefined : queuedPrompt.behavior, queuedPrompt.agentMode, queuedPrompt.templateDescription),
				flush.controller.signal,
				acksAtTurnEnd(sessionId) ? undefined : QUEUED_SEND_TIMEOUT_MS,
			);
			if (wait === "aborted") return false;
			const accepted = wait === "settled";
			settle(accepted ? { type: "accepted" } : { type: "unknown", error: unknownDeliveryMessage });
			if (!accepted && ownsClaim() && canContinueFlush(sessionId, flush)) showToast(unknownDeliveryMessage, 6000);
			return accepted;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const deliveryUnknown = error instanceof PromptDeliveryUnknownError;
			settle({ type: deliveryUnknown ? "unknown" : "failed", error: errorMessage });
			if (ownsClaim() && canContinueFlush(sessionId, flush)) showToast(deliveryUnknown ? unknownDeliveryMessage : errorMessage, deliveryUnknown ? 6000 : 4000);
			return false;
		}
	}

	async function flushQueuedSteerPrompts(sessionId: string) {
		if (suppressedRef.current.has(sessionId)) return; // 用户正在停止该回合：不得再插队
		if (!isSessionRuntimeBusy(sessionId)) return;
		// ACP 协议无 steer 通道：忙碌时派发只会被 AcpAgentManager 拒收成失败队列项；
		// steer 项保留给空闲 drain（claimIdleHead 按序发，空闲时 steer 语义≈直发）。
		if (!supportsSteer(sessionId)) return;
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
			// 投递被接受就落门禁：下一条必须等本回合真的忙起来（或超时）才允许发。
			if (await dispatchClaimedPrompt(sessionId, claimed.prompt, flush)) {
				// ACP 的 accepted 就是回合结算，不存在「已收下但还没开始」的窗口；
				// 对它设门禁只会让下一条空等超时（此刻已经没有后续的回合事件了）。
				if (!acksAtTurnEnd(sessionId)) armDrainGate(sessionId);
			}
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

	/**
	 * 立即发送某条排队消息（不等当前回合结束，也不必先撤回进输入框再发）。
	 *
	 * - 空闲：置顶后直接走 idle drain，并解除「停止响应」的自动投递抑制——
	 *   抑制挡的是「自动发」，用户点名要发这条就不该再挡（否则停一次后队列只能靠编辑发）。
	 * - 忙且后端有 steer 通道（pi/dsh）：切成 steer 并立即插入当前回合。
	 * - 忙且 ACP：协议无 steer，只能「停当前回合 → 当作新回合发」；调用方须先停止
	 *   （abortAgent 会同步置抑制，所以顺序是先停后调这里），回合结算后由 idle drain 发出。
	 */
	function sendQueuedPromptNow(sessionId: string, promptId: string) {
		const live = queuedPromptsRef.current[sessionId]?.find((item) => item.id === promptId);
		if (!live || !canChangeQueuedPromptBehavior(live.status)) return;
		if (suppressedRef.current.delete(sessionId)) syncDrainSuppressedAtom(sessionId);
		updateQueuedPrompts((current) => promotePrompt(current, sessionId, promptId));
		if (!isSessionRuntimeBusy(sessionId)) {
			void flushNextQueuedPrompt(sessionId);
			return;
		}
		if (!supportsSteer(sessionId)) return;
		updateQueuedPrompts((current) => updateQueuedPromptBehavior(current, sessionId, promptId, "steer"));
		void flushQueuedSteerPrompts(sessionId);
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
		sendQueuedPromptNow,
		suppressSessionQueueAutoDrain,
		isSessionRuntimeBusy,
		canFlushQueuedPrompt,
		flushQueuedSteerPrompts,
		flushNextQueuedPrompt,
	};
}
