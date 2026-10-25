import { useSetAtom, useStore } from "jotai";
import { useRef } from "react";
import type { ComposerAgentMode, ImageContent, SendSessionPromptInput, SendSessionPromptResult, SessionRuntimeTarget } from "../../../shared/types";
import { classifyComposerSlashCommand } from "../utils/composerSlashCommand";
import {
	bindSessionRuntimeAtom,
	bumpNewTurnCollapseTickAtom,
	cacheSessionMessagesAtom,
	sessionAttachmentsByIdAtom,
	sessionMessagesCacheAtom,
	sessionComposerModeByIdAtom,
	sessionDraftByIdAtom,
	sessionQuotesByIdAtom,
	sessionRecordsAtom,
	sessionRuntimeByIdAtom,
	sessionSendStateByIdAtom,
	setSessionAttachmentsAtom,
	setSessionDraftAtom,
	setSessionQuotesAtom,
	type SessionQuoteMap,
	setSessionSendStateAtom,
	upsertSessionAtom,
	dshRuntimeStatusAtom,
	openSettingsAtom,
	removePendingUserMessages,
} from "../atoms";
import { applyDshGoalSendTransform, buildComposerPromptSubmission, deriveComposerAgentMode, expandPromptTemplates } from "../composerBehavior";
import { expandQuoteTokens, stripQuoteTokens } from "../components/session/composer/quoteChip";
import { t, translateI18nDescriptor } from "../i18n";
import { DSH_INSTALL_SETTINGS_TARGET, maybeHintMissingDshRunnerNode, showDshRuntimeBlockHint } from "../utils/dshRuntimeHint";
import { toSessionRuntimeTarget } from "../utils/sessionCommands";
import { sessionReloadingByIdAtom } from "../atoms/session-commands-atoms";
import { dshSendBlockReason } from "../../../shared/types/dshRuntime";

export type EnqueuePromptSnapshot = {
	displayText: string;
	message: string;
	images?: ImageContent[];
	agentMode: string;
	/** 排队投递策略，决定在 agent busy/idle 哪个阶段排空。 */
	behavior?: "steer" | "followUp";
};

type PromptTemplate = {
	name: string;
	path: string;
	description: string;
	content: string;
	argumentHint?: string;
};

type SessionPromptApi = (input: SendSessionPromptInput) => Promise<SendSessionPromptResult>;

export type UseSessionSendOptions = {
	/** Stable public identity for every draft, request, queue entry, and runtime binding. */
	sessionId: string;
	sendPrompt: SessionPromptApi;
	/** Promotes a renderer-only pre-send surface to a persistent Session. */
	ensureSessionId?: (sessionId: string) => Promise<string>;
	/**
	 * 模板清单的**读取函数**而不是快照：模板表在 runtime 刚绑定/首次加载完成前可能是空的，
	 * 发送时按最新清单展开，避免「打开会话立刻发 /模板名 → 退回给 pi 展开 → 模板名丢失」。
	 */
	getTemplates: () => PromptTemplate[];
	/**
	 * 发送前补齐模板表（`/名称` 命中未知模板时补拉）。
	 *
	 * 队列分支（忙碌时 steer/followUp）在**入队时就展开**，比 prepareMessage 更早，
	 * 所以这条也得单独补一次：否则「刚打开的会话 + agent 还在收尾」时会用手上还空的
	 * 模板表展开，`/模板名` 原样入队、flush 时直接发给 pi，chip 随之丢失（2026-10 e2e 抓到）。
	 */
	ensureTemplates?: (message: string) => Promise<void>;
	/**
	 * 后端已接管的命令名（pi 扩展命令 / 技能、DSH host 命令）：这些 `/名称` 不能本地展开。
	 *
	 * 为什么必须传：展开成 `<prompt_template>` 后消息不再以 `/` 开头，pi 的扩展命令与
	 * DSH 的 slash 桥（`hostEntry.ts` 的 agent/pre-step 钩子）都不会再触发——
	 * 命令被静默降级成普通提示词文字。来源见 `collectReservedCommandNames`。
	 */
	getReservedCommandNames?: () => ReadonlySet<string>;
	prepareMessage?: (message: string) => Promise<string>;
	onDraftMutation?: (sessionId: string) => void;
	compact: (target: SessionRuntimeTarget, prompt?: string) => Promise<void>;
	/** `/new`：桌面拦截后新建 Agent 会话（不发给 pi）。 */
	createNewSession?: () => Promise<void>;
	/** `/login [providerId]`：桌面拦截后打开登录供应商弹框（pi 的登录只在它的 CLI 层，走认证例外通道）。 */
	openProviderLogin?: (providerId?: string) => void;
	/** `/reload`：桌面拦截后热重载 pi 资源（不写用户气泡、不占发送锁）。 */
	reloadResources?: (target: SessionRuntimeTarget) => Promise<void>;
	resetComposerUi?: () => void;
	recordPromptHistory?: (sessionId: string, message: string) => void;
	refreshProject?: (projectId: string) => void;
	showError?: (message: string, duration?: number) => void;
	showUnknown?: () => void;
	/** ACP 首启失败回收（可选）：会话激活从未成功（仍 draft 且被 agent 拒收）时由外层
	 *  删除会话并回收草稿到引导页；返回 true 表示已清理，发送链路立即结算。 */
	pruneFailedAcpDraft?: (sessionId: string) => Promise<boolean> | boolean;
	/** Called when streamingBehavior is "steer" before sending. Returns true if enqueued. */
	enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
};

export function normalizeComposerDomText(value: string): string {
	return value.replace(/\u200B/g, "");
}

export function mergeRejectedComposerDraft(rejectedDraft: string, currentDraft: string): string {
	return [rejectedDraft, currentDraft].filter((text) => text.trim()).join("\n\n");
}

export function mergeRejectedComposerImages(rejectedImages: ImageContent[] | undefined, currentImages: ImageContent[]): ImageContent[] {
	return rejectedImages?.length ? [...rejectedImages, ...currentImages] : currentImages;
}

export function hasComposerSubmission(message: string, images: ImageContent[] | undefined): boolean {
	return Boolean(message.trim() || images?.length);
}

export function classifySessionPromptResult(result: SendSessionPromptResult): "accepted" | "rejected" | "unknown" {
	if (result.accepted) return "accepted";
	return result.delivery === "unknown" ? "unknown" : "rejected";
}

export function createSessionSendLock() {
	const sessionIds = new Set<string>();
	return {
		has: (sessionId: string) => sessionIds.has(sessionId),
		claim: (sessionId: string) => {
			if (sessionIds.has(sessionId)) return false;
			sessionIds.add(sessionId);
			return true;
		},
		release: (sessionId: string) => {
			sessionIds.delete(sessionId);
		},
	};
}

export function useSessionSend(options: UseSessionSendOptions) {
	const store = useStore();
	const setDraft = useSetAtom(setSessionDraftAtom);
	const setAttachments = useSetAtom(setSessionAttachmentsAtom);
	const setQuotes = useSetAtom(setSessionQuotesAtom);
	const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);
	const setSendState = useSetAtom(setSessionSendStateAtom);
	const bindRuntime = useSetAtom(bindSessionRuntimeAtom);
	const upsertSession = useSetAtom(upsertSessionAtom);
	const sendingSessionIdsRef = useRef<Set<string>>(new Set());

	function clearSnapshot(targetSessionId: string) {
		options.onDraftMutation?.(targetSessionId);
		setDraft({ sessionId: targetSessionId, value: "" });
		setAttachments({ sessionId: targetSessionId, value: [] });
		// 草稿已清空，快照随之清理：避免会话内孤儿引用无限堆积
		setQuotes({ sessionId: targetSessionId, value: {} });
	}

	function restoreRejectedSnapshot(targetSessionId: string, message: string, imageSnapshot?: ImageContent[], quoteSnapshot?: SessionQuoteMap) {
		options.onDraftMutation?.(targetSessionId);
		setDraft({
			sessionId: targetSessionId,
			value: (current) => [message, current].filter((text) => text.trim()).join("\n\n"),
		});
		if (imageSnapshot) {
			setAttachments({
				sessionId: targetSessionId,
				value: (current) => [...imageSnapshot, ...current],
			});
		}
		if (quoteSnapshot) {
			// token 与全文必须一同回填；发送期间新增的引用保留，以免重试变成孤儿 token。
			setQuotes({ sessionId: targetSessionId, value: (current) => ({ ...quoteSnapshot, ...current }) });
		}
	}

	/**
	 * 投递被拒：撤掉这次请求的乐观用户气泡。
	 *
	 * 气泡只在「宿主确认后」才有资格留在时间线上——拒绝意味着它永远不会被写进会话日志，
	 * 留着会变成幽灵消息（下次读盘/切回又凭空消失）。文字已由 restoreRejectedSnapshot
	 * 回填草稿，用户可直接改完重发。
	 */
	function dropPendingUserMessage(targetSessionId: string, pendingRequestId: string) {
		const entry = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
		if (!entry?.messages?.length) return;
		const messages = removePendingUserMessages(entry.messages, pendingRequestId);
		if (messages.length === entry.messages.length) return;
		setCacheMessages({
			sessionId: targetSessionId,
			messages,
			source: entry.source ?? "runtime",
			windowStart: entry.windowStart,
			cardCount: entry.cardCount,
			history: entry.history,
			windowStartFilePos: entry.windowStartFilePos,
		});
	}

	/** 模板正文为空时统一的拦截提示：error 状态 + toast（带模板名，便于定位编辑）。 */
	function rejectEmptyTemplate(targetSessionId: string, templateName: string) {
		const message = t("app.promptTemplateEmptyBody", { name: templateName });
		setSendState({
			sessionId: targetSessionId,
			state: { status: "error", error: message },
		});
		options.showError?.(message, 4500);
	}

	/**
	 * 发送收尾时清空草稿快照。
	 * keepDraft=true（快捷消息直发）时跳过：那条路径消费的是外部文本，
	 * 用户正在写的草稿/附件/引用必须原样保留。
	 */
	function clearComposerSnapshot(targetSessionId: string, keepDraft: boolean) {
		if (keepDraft) return;
		clearSnapshot(targetSessionId);
	}

	/**
	 * 清空输入框的临时 UI 状态（↑ 历史游标、联想菜单、DOM 草稿镜像等）。
	 * keepDraft=true（快捷消息直发）时跳过：这些状态全属于用户正在编辑的那份草稿，
	 * 把 liveDomDraftRef 置空会让后续发送误以为输入框是空的。
	 */
	function resetComposerEphemeralUi(keepDraft: boolean) {
		if (keepDraft) return;
		options.resetComposerUi?.();
	}

	/**
	 * 投递被拒时把原文回填草稿，供用户修改重发。
	 * keepDraft=true（快捷消息直发）时跳过：那段文字原本不在草稿里，回填会污染用户输入
	 * （弹框里点一下就能重发，代价远低于把用户写了一半的内容顶下去）。
	 */
	function restoreRejectedPrompt(targetSessionId: string, keepDraft: boolean, message: string, imageSnapshot?: ImageContent[], quoteSnapshot?: SessionQuoteMap) {
		if (keepDraft) return;
		restoreRejectedSnapshot(targetSessionId, message, imageSnapshot, quoteSnapshot);
	}

	return async function sendSessionPrompt(streamingBehavior?: "steer" | "followUp", overrideText?: string) {
		const sourceSessionId = options.sessionId;
		// atom 随 bootstrap 提升且跨 Composer 重挂载保留；局部 ref 只守当前实例。
		const existingSend = store.get(sessionSendStateByIdAtom)[sourceSessionId];
		if (sendingSessionIdsRef.current.has(sourceSessionId) || existingSend?.status === "activating" || existingSend?.status === "sending") return;
		// 热重载会拆掉扩展运行时；期间禁止并发发送（含再次 /reload），避免把 handler 拆掉或让命令排队。
		if (store.get(sessionReloadingByIdAtom)[sourceSessionId]) {
			options.showError?.(t("sessionCommand.reloadResourcesBusy"), 3000);
			return;
		}

		// overrideText 有值 = 快捷消息直发：正文来自弹框条目而非当前草稿。
		// 这里固定三条约束（下面所有分支都靠 keepDraft 收口）：草稿/附件不参与本次发送、
		// 发送后不清空草稿、被拒时不回填草稿——用户可能正写到一半，直发一条「继续」
		// 把他的草稿清掉或把他贴的图一起发出去都不可接受。
		const keepDraft = overrideText !== undefined;
		const rawDraft = overrideText ?? store.get(sessionDraftByIdAtom)[sourceSessionId] ?? "";
		const attachmentSnapshot = keepDraft ? [] : (store.get(sessionAttachmentsByIdAtom)[sourceSessionId] ?? []);
		const imageSnapshot = attachmentSnapshot.length ? [...attachmentSnapshot] : undefined;
		if (!hasComposerSubmission(rawDraft, imageSnapshot)) return;
		// 引用展开唯一咽喉点（审计定稿）：后续乐观缓存/队列快照/历史记录全部消费自包含块文本，
		// #q token 永不出现在时间线气泡或发给 pi 的内容里。气泡只解析块的 label，模型仍读取全文。
		// 与斜杠命令混写时仍按普通消息继续走后续模板/会话引用展开（有意为之）。
		const quoteMap = store.get(sessionQuotesByIdAtom)[sourceSessionId];
		const message = expandQuoteTokens(rawDraft, (id) => quoteMap?.[id]) ?? rawDraft;
		// 只有引用没有任何正文/图片：引用是上下文不是消息，拦下并提示先写问题
		if (!stripQuoteTokens(rawDraft).trim() && !imageSnapshot) {
			options.showError?.(t("app.quoteNeedsQuestion"), 4000);
			return;
		}

		// DSH 会话在 runtime 不可用（未安装/损坏）时拦截发送：DSH host fork 依赖
		// @deepseek-ai/dsh-base 产物，runtime 缺失时主进程只会抛模块解析的裸报错。
		// 发送前给「去安装」提示（含直达入口），避免乐观气泡 + 失败回滚的体验；
		// checking 不算拦截——状态未定时不误拦正常发送。
		const recordAtEntry = store.get(sessionRecordsAtom)[sourceSessionId];
		const runtimeAtEntry = store.get(sessionRuntimeByIdAtom)[sourceSessionId];
		if (recordAtEntry?.backend === "dsh" || runtimeAtEntry?.backend === "dsh") {
			const dshStatusAtEntry = store.get(dshRuntimeStatusAtom);
			if (dshSendBlockReason(dshStatusAtEntry.state)) {
				const blockMessage =
					dshStatusAtEntry.state === "broken"
						? t("dsh.runtime.sendBroken", { reason: dshStatusAtEntry.reason ?? "" })
						: dshStatusAtEntry.state === "outdated"
							? t("dsh.runtime.sendOutdated", {
									installed: dshStatusAtEntry.runtimeVersion ?? "",
									declared: dshStatusAtEntry.declaredRuntimeVersion ?? "",
								})
							: t("dsh.runtime.sendNotInstalled");
				setSendState({
					sessionId: sourceSessionId,
					state: { status: "error", error: blockMessage },
				});
				showDshRuntimeBlockHint(() => store.set(openSettingsAtom, DSH_INSTALL_SETTINGS_TARGET), dshStatusAtEntry.state, dshStatusAtEntry.reason, {
					installed: dshStatusAtEntry.runtimeVersion,
					declared: dshStatusAtEntry.declaredRuntimeVersion,
				});
				return;
			}
			maybeHintMissingDshRunnerNode(() => store.set(openSettingsAtom, { tab: "dev", section: "dsh-runner-node" }));
		}

		const resolveSendMode = (targetSessionId: string): ComposerAgentMode => {
			const record = store.get(sessionRecordsAtom)[targetSessionId];
			const liveRuntime = store.get(sessionRuntimeByIdAtom)[targetSessionId];
			return deriveComposerAgentMode({
				// 真实 backend 透传（不能折叠成 pi/dsh 二选一）：deriveComposerAgentMode 对
				// acp 有「恒普通模式」守卫，折叠会把残留的 pi 会话 plan/goal 选择带进发送。
				backend: record?.backend ?? liveRuntime?.backend,
				localMode: store.get(sessionComposerModeByIdAtom)[targetSessionId],
				planModeActive: liveRuntime?.state?.planModeActive === true,
				goalPhase: liveRuntime?.state?.goal?.phase,
			});
		};

		sendingSessionIdsRef.current.add(sourceSessionId);
		const requestId = crypto.randomUUID();
		const trimmedMessage = message.trim();
		// 接管类命令统一由纯函数分类：这里只分派，不再散落正则（见 utils/composerSlashCommand.ts）。
		const slashCommand = classifyComposerSlashCommand(trimmedMessage);
		if (slashCommand.kind === "login") {
			// `/login` 同样不是发给模型的消息：不写乐观用户气泡、不 ensureSessionId，
			// 也不占 sending 锁（弹框里的登录与后续发送互不干扰）。
			clearComposerSnapshot(sourceSessionId, keepDraft);
			resetComposerEphemeralUi(keepDraft);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			options.openProviderLogin?.(slashCommand.providerId);
			return;
		}
		if (slashCommand.kind === "hotkeys") {
			// `/hotkeys` 跳设置里的快捷键页：pi 的 builtin 斜杠命令在 RPC 模式下不执行，
			// 发下去只会得到「命令被模型回答了」。同样不写乐观气泡、不占 sending 锁。
			clearComposerSnapshot(sourceSessionId, keepDraft);
			resetComposerEphemeralUi(keepDraft);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			store.set(openSettingsAtom, { tab: "shortcuts" });
			return;
		}
		if (slashCommand.kind === "reload") {
			// `/reload` 由桌面转成专用 IPC：主进程用内部扩展命令热重载 pi 资源，
			// 不写乐观用户气泡、不进模型消息流。
			clearComposerSnapshot(sourceSessionId, keepDraft);
			resetComposerEphemeralUi(keepDraft);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			const target = toSessionRuntimeTarget(sourceSessionId, runtimeAtEntry);
			if (!target) {
				options.showError?.(t("sessionCommand.runtimeUnavailable"), 4000);
				return;
			}
			if (!options.reloadResources) {
				options.showError?.(t("sessionCommand.reloadResourcesUnsupported"), 4000);
				return;
			}
			try {
				await options.reloadResources(target);
			} catch (error) {
				options.showError?.(error instanceof Error ? error.message : String(error), 5000);
			}
			return;
		}
		const isNewCommand = slashCommand.kind === "new";
		const isCompactCommand = slashCommand.kind === "compact";
		if (isNewCommand) {
			// 不写乐观用户气泡、不 ensureSessionId：/new 是桌面 chrome，不是发给模型的消息。
			clearComposerSnapshot(sourceSessionId, keepDraft);
			resetComposerEphemeralUi(keepDraft);
			try {
				await options.createNewSession?.();
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				setSendState({
					sessionId: sourceSessionId,
					state: { status: "error", error: errorMessage },
				});
				options.showError?.(errorMessage, 4000);
			} finally {
				sendingSessionIdsRef.current.delete(sourceSessionId);
			}
			return;
		}
		const usesLocalQueue = Boolean(options.enqueue && (streamingBehavior === "steer" || streamingBehavior === "followUp"));

		// 首次发送的运行时启动可能包含 spawn/get_state/会话绑定；先发布用户可见状态，
		// 让输入反馈与后台准备解耦，避免用户把冷启动时间误判成点击无效。
		// 队列和 /compact 保留原路径，因为它们分别需要排队快照或运行时命令语义。
		const publishOptimisticSubmission = (targetSessionId: string) => {
			setSendState({
				sessionId: targetSessionId,
				state: { status: "activating", requestId },
			});
			clearComposerSnapshot(targetSessionId, keepDraft);
			const cacheEntry = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
			const previousMessages = cacheEntry?.messages ?? [];
			setCacheMessages({
				sessionId: targetSessionId,
				messages: [
					...previousMessages,
					{
						id: requestId,
						agentId: "",
						role: "user" as const,
						text: message,
						timestamp: Date.now(),
						images: imageSnapshot,
						// 待宿主确认：DSH 模型解析失败时用户消息从未写入会话日志，
						// 快照里没有它——带标记才能在快照合并时接回（见 pendingUserMessage）。
						meta: { pendingUserMessage: true, requestId },
					},
				],
				source: "runtime" as const,
			});
			resetComposerEphemeralUi(keepDraft);
		};

		const publishBeforeActivation = !usesLocalQueue && !isCompactCommand;
		if (publishBeforeActivation) publishOptimisticSubmission(sourceSessionId);

		let sessionId = sourceSessionId;
		let trackedRecord = recordAtEntry;
		let submissionPublished = publishBeforeActivation;
		// 身份由来源会话与 requestId 决定，不由焦点或组件挂载决定：切栏仍可后台完成，
		// 删除/新请求接管后则禁止恢复草稿、回绑 runtime 或发布迟到状态。
		const isCurrentRequest = () => (!trackedRecord || Boolean(store.get(sessionRecordsAtom)[sessionId])) && (!submissionPublished || store.get(sessionSendStateByIdAtom)[sessionId]?.requestId === requestId);
		const releaseIfRetired = () => {
			if (isCurrentRequest()) return false;
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return true;
		};
		try {
			sessionId = options.ensureSessionId ? await options.ensureSessionId(sourceSessionId) : sourceSessionId;
		} catch (error) {
			if (releaseIfRetired()) return;
			// 普通发送已乐观清空草稿；队列与 /compact 尚未消费，不能重复回填。
			if (publishBeforeActivation) {
				restoreRejectedPrompt(sourceSessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
				dropPendingUserMessage(sourceSessionId, requestId);
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			setSendState({
				sessionId: sourceSessionId,
				state: { status: "error", error: errorMessage },
			});
			options.showError?.(errorMessage, 4000);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return;
		}

		trackedRecord = store.get(sessionRecordsAtom)[sessionId] ?? trackedRecord;
		if (releaseIfRetired()) return;
		const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
		const runtimeTarget = runtime?.agentId
			? {
					sessionId,
					agentId: runtime.agentId,
					runtimeGeneration: runtime.runtimeGeneration,
				}
			: undefined;
		const runtimeAgentId = runtimeTarget?.agentId;
		if (publishBeforeActivation && runtimeAgentId) {
			setSendState({
				sessionId,
				state: { status: "sending", requestId },
			});
			setCacheMessages({
				sessionId,
				messages: (store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? []).map((item) => (item.id === requestId ? { ...item, agentId: runtimeAgentId } : item)),
				source: "runtime",
			});
		}
		if (isCompactCommand) {
			if (!runtimeAgentId) {
				// No Agent yet — let normal send path start Agent first;
				// pi will handle /compact command once active.
			} else {
				// 提示词由分类器统一剥离（`/compact` 后的内容按 pi 语义是自定义提示词）。
				const compactPrompt = slashCommand.kind === "compact" ? slashCommand.prompt : "";
				clearComposerSnapshot(sessionId, keepDraft);
				resetComposerEphemeralUi(keepDraft);
				try {
					await options.compact(runtimeTarget, compactPrompt || undefined);
				} finally {
					// /compact 是 chrome 命令，不能占用 sending 锁；否则后续消息被静默丢掉。
					sendingSessionIdsRef.current.delete(sourceSessionId);
				}
				return;
			}
		}

		// Queue shortcut: when the agent is busy, enqueue locally instead of sending through
		// the session API. The queue panel shows the pending item and drain dispatches it
		// through the appropriate flush path based on behavior:
		//   steer    → flushQueuedSteerPrompts (while agent is busy)
		//   followUp → flushNextQueuedPrompt (when agent becomes idle)
		if (options.enqueue && (streamingBehavior === "steer" || streamingBehavior === "followUp")) {
			// fail-open：模板表补齐失败只影响「能否本地展开」，不能把整条消息卡住不给发
			await options.ensureTemplates?.(message).catch(() => undefined);
			const { message: expandedMessage, emptyTemplateName } = expandPromptTemplates(message, options.getTemplates(), { reservedNames: options.getReservedCommandNames?.() });
			if (emptyTemplateName) {
				// 展开器会保留空模板的 /命令原文，不能靠消息是否空白判断正文有效。
				sendingSessionIdsRef.current.delete(sourceSessionId);
				rejectEmptyTemplate(sessionId, emptyTemplateName);
				return;
			}
			const enqueued = options.enqueue(sessionId, {
				displayText: message,
				message: expandedMessage,
				images: imageSnapshot,
				agentMode: resolveSendMode(sessionId),
				behavior: streamingBehavior,
			});
			if (enqueued) {
				clearComposerSnapshot(sessionId, keepDraft);
				resetComposerEphemeralUi(keepDraft);
				sendingSessionIdsRef.current.delete(sourceSessionId);
				return;
			}
			// Queue full: fall through to direct send.
		}

		if (!publishBeforeActivation) {
			submissionPublished = true;
			setSendState({
				sessionId,
				state: {
					status: runtimeAgentId ? "sending" : "activating",
					requestId,
				},
			});
			clearComposerSnapshot(sessionId, keepDraft);

			// Special paths publish only after their runtime/session target is known.
			const cacheEntry = store.get(sessionMessagesCacheAtom)?.[sessionId];
			const previousMessages = cacheEntry?.messages ?? [];
			setCacheMessages({
				sessionId,
				messages: [
					...previousMessages,
					{
						id: requestId,
						agentId: runtimeAgentId ?? "",
						role: "user" as const,
						text: message,
						timestamp: Date.now(),
						images: imageSnapshot,
						// 同 publishOptimisticSubmission：待宿主快照确认的乐观气泡。
						meta: { pendingUserMessage: true, requestId },
					},
				],
				source: "runtime" as const,
			});
			resetComposerEphemeralUi(keepDraft);
		}

		let preparedMessage = message;
		try {
			preparedMessage = options.prepareMessage ? await options.prepareMessage(message) : message;
		} catch (error) {
			if (releaseIfRetired()) return;
			// 拒绝时回填原始草稿（含 token），保留 chip 形态供用户修改重发；
			// 同时撤掉乐观气泡：这条消息不会进会话日志（失败前就已发布过一次）。
			restoreRejectedPrompt(sessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
			dropPendingUserMessage(sessionId, requestId);
			const errorMessage = error instanceof Error ? error.message : String(error);
			// ensureSessionId 已把 composer 状态搬到真实会话；失败也必须结算同一身份。
			setSendState({
				sessionId,
				state: { status: "error", requestId, error: errorMessage },
			});
			options.showError?.(errorMessage, 4000);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return;
		}

		if (releaseIfRetired()) return;
		const { message: expandedMessage, description, emptyTemplateName } = expandPromptTemplates(preparedMessage, options.getTemplates(), { reservedNames: options.getReservedCommandNames?.() });
		if (emptyTemplateName) {
			// 展开器保留空模板的 /命令原文；按 verdict 拦截，避免误发到主进程。
			// 回填原始草稿（含引用 token），保留 chip 形态，并撤掉已发布的乐观气泡。
			restoreRejectedPrompt(sessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
			dropPendingUserMessage(sessionId, requestId);
			rejectEmptyTemplate(sessionId, emptyTemplateName);
			sendingSessionIdsRef.current.delete(sourceSessionId);
			return;
		}
		const record = store.get(sessionRecordsAtom)[sessionId];
		const liveRuntime = store.get(sessionRuntimeByIdAtom)[sessionId];
		const isDshSend = record?.backend === "dsh" || liveRuntime?.backend === "dsh";
		const sendMode: ComposerAgentMode = deriveComposerAgentMode({
			backend: isDshSend ? "dsh" : "pi",
			localMode: store.get(sessionComposerModeByIdAtom)[sessionId],
			planModeActive: liveRuntime?.state?.planModeActive === true,
			goalPhase: liveRuntime?.state?.goal?.phase,
		});
		// DSH 拒绝 agentMessage：首次目标改写成 /goal；已有目标则原文推进。
		const visibleMessage = isDshSend
			? applyDshGoalSendTransform({
					message: expandedMessage,
					mode: sendMode,
					goal: liveRuntime?.state?.goal,
				})
			: expandedMessage;
		const submission = buildComposerPromptSubmission(visibleMessage, isDshSend ? "normal" : sendMode);

		try {
			const result = await options.sendPrompt({
				sessionId,
				requestId,
				message: submission.message,
				...(imageSnapshot ? { images: imageSnapshot } : {}),
				...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
				...(description ? { description } : {}),
				...(streamingBehavior ? { streamingBehavior } : {}),
			});
			if (!isCurrentRequest()) return;
			const currentRuntime = store.get(sessionRuntimeByIdAtom)[sessionId];
			// 新代可来自本次启动；旧代/同代异进程不能回写运行时、路径或历史。
			// 但拒收/未知仍要按本请求结算，不能因换代丢掉草稿或未知投递提示。
			const staleRuntime = result.agentId && currentRuntime && ((result.runtimeGeneration !== undefined && result.runtimeGeneration < currentRuntime.runtimeGeneration) || ((result.runtimeGeneration ?? currentRuntime.runtimeGeneration) === currentRuntime.runtimeGeneration && currentRuntime.agentId !== result.agentId));
			if (staleRuntime && result.accepted) {
				setSendState({ sessionId, state: { status: "idle" } });
				return;
			}
			// 只有已接受的消息才开始新一轮；拒绝/未知投递不能折叠现有时间线。
			if (result.accepted) store.set(bumpNewTurnCollapseTickAtom, sessionId);
			if (result.agentId && !staleRuntime) {
				bindRuntime({
					sessionId,
					agentId: result.agentId,
					runtimeGeneration: result.runtimeGeneration,
					status: result.accepted ? "running" : undefined,
				});
			}

			const record = store.get(sessionRecordsAtom)[sessionId];
			if (record && result.accepted) {
				// DSH 的 sessionPath 是 host zstd，不能当 pi JSONL 写进 filePath。
				upsertSession({
					...record,
					...(record.backend === "dsh" || !result.sessionPath ? {} : { filePath: result.sessionPath }),
					status: "active",
					updatedAt: Date.now(),
				});
			}

			const outcome = classifySessionPromptResult(result);
			// toast 文案 = 本地化提示 + 具体原因：translateI18nDescriptor 命中通用 key 时
			// 只返回“消息发送失败。”这类概括，debugDetails（RPC 超时/pi 拒绝原文）必须带出，
			// 否则用户无从知道失败根因；同值去重、截断防 toast 过长。
			let deliveryError = "Prompt was not accepted";
			let toastMessage = deliveryError;
			if ("error" in result) {
				deliveryError = translateI18nDescriptor(result, result.error);
				const details = result.debugDetails && result.debugDetails !== deliveryError ? `（${result.debugDetails.length > 140 ? `${result.debugDetails.slice(0, 140)}…` : result.debugDetails}）` : "";
				toastMessage = `${deliveryError}${details}`;
			}
			if (outcome === "accepted") {
				options.recordPromptHistory?.(sessionId, message);
				setSendState({ sessionId, state: { status: "idle" } });
				if (record) options.refreshProject?.(record.projectId);
			} else if (outcome === "unknown") {
				setSendState({
					sessionId,
					state: {
						status: "unknown",
						requestId,
						error: deliveryError,
						unknownSnapshot: {
							message,
							...(imageSnapshot ? { images: imageSnapshot } : {}),
						},
					},
				});
				options.showUnknown?.();
			} else {
				// 拒绝时回填原始草稿（含 token）保留 chip 形态；unknown 快照仍存展开后文本（已实际投递的内容）
				restoreRejectedPrompt(sessionId, keepDraft, rawDraft, imageSnapshot, quoteMap);
				// 宿主明确拒绝 = 消息不会进日志：撤掉乐观气泡，避免幽灵消息。
				dropPendingUserMessage(sessionId, requestId);
				setSendState({
					sessionId,
					state: { status: "error", requestId, error: deliveryError },
				});
				options.showError?.(toastMessage, 4000);
				// ACP 首启失败回收：激活从未成功（result 无 agentId，agent 侧会话未建、无任何消息）
				// 的 acp 会话是纯垃圾条目（spawn/session-new 失败都走这）——外层删会话并把回填后的
				// 草稿搬回引导页，不在历史列表留「xxx agent」空会话。prune 成功即结算：后续状态都指向已删会话。
				// !result.agentId 是必要条件：runtime 已激活、agent 侧会话已建，只是 prompt 被 agent
				// 拒收（如网关 token 失效的 -32000 Authentication required）时，会话与错误现场都必须保留。
				// 不能只靠 record.status === "draft"：catalog 的 promoteToActive 是 void 异步写，
				// 失败帧到达时渲染层 record 常仍停在 draft，判定会随竞态漂移（2026-10 用户反馈：
				// 首启失败被弹回引导页，看不到失败原因）。
				if (!staleRuntime && !result.agentId && record?.backend === "acp" && record.status === "draft") {
					const pruned = await options.pruneFailedAcpDraft?.(sessionId);
					if (pruned) {
						sendingSessionIdsRef.current.delete(sourceSessionId);
						return;
					}
				}
			}
		} catch (error) {
			if (!isCurrentRequest()) return;
			setSendState({
				sessionId,
				state: {
					status: "unknown",
					requestId,
					error: error instanceof Error ? error.message : String(error),
					unknownSnapshot: {
						message,
						...(imageSnapshot ? { images: imageSnapshot } : {}),
					},
				},
			});
			options.showUnknown?.();
		} finally {
			sendingSessionIdsRef.current.delete(sourceSessionId);
		}
	};
}
