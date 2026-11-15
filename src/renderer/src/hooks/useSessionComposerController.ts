import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AgentBackend, ChatMessage, ComposerAgentMode, FileTreeNode, ImageContent, PiCommand, ResolvedLaunchDefaults, SessionRuntimeTarget, SessionSummary } from "../../../shared/types";
import { DEFAULT_IMAGE_GEN_OUTPUT_FORMAT, DEFAULT_IMAGE_GEN_SIZE, DEFAULT_IMAGE_GEN_WATERMARK, parseImageGenOutputFormat, parseImageGenSize, parseImageGenWatermark } from "../../../shared/imageGenParams";
import { resolveBusySendDelivery } from "../../../shared/busySendDelivery";
import { isRemoteProject } from "../../../shared/projectLocation";
import { classifyCompactError, compactOwnerReason, compactRoutedCommand, type CompactNoticeKind } from "../../../shared/compactFeedback";
import { isRendererVirtualSessionId } from "../../../shared/rendererVirtualSessionId";
import { findImageGenProvider } from "../../../shared/imageGenConfig";
import { findVideoGenProvider } from "../../../shared/videoGenConfig";
import { buildSessionReferenceContext } from "../../../shared/sessionReferenceContext";
import { resolveEnhanceTargetModel } from "../../../shared/enhanceModelPreference";
import { collectPromptEnhanceContext } from "../utils/promptEnhanceContext";
import { sessionCommandsRefreshTickAtom } from "../atoms/session-commands-atoms";
import type { ImageGenMeta } from "../../../shared/types/imagegen";
import type { VideoGenMeta } from "../../../shared/types/videogen";
import {
	busySendDeliveryAtom,
	cacheSessionMessagesAtom,
	effectiveAgentBackendAtom,
	enhanceModelAtom,
	enhanceIncludeContextAtom,
	promptSuggestionEnabledAtom,
	promptSuggestionModelAtom,
	imageGenConfigAtom,
	projectByIdAtomFamily,
	sessionAttachmentsBySessionIdAtomFamily,
	sessionComposerModeBySessionIdAtomFamily,
	sessionDraftByIdAtom,
	sessionDraftBySessionIdAtomFamily,
	sessionMessageCacheBySessionIdAtomFamily,
	sessionMessagesCacheAtom,
	sessionPasteFilesBySessionIdAtomFamily,
	sessionRecordByIdAtomFamily,
	sessionRecordsAtom,
	sessionRuntimeBySessionIdAtomFamily,
	sessionRuntimeUiBySessionIdAtomFamily,
	sessionQuotesBySessionIdAtomFamily,
	sessionSendStateBySessionIdAtomFamily,
	sessionSummariesByProjectIdAtomFamily,
	setSessionAttachmentsAtom,
	setSessionComposerModeAtom,
	setSessionDraftAtom,
	setSessionPasteFilesAtom,
	setSessionSendStateAtom,
	videoGenConfigAtom,
	upsertSessionAtom,
	promoteSessionComposerStateAtom,
	removeSessionStateAtom,
	currentSessionIdAtom,
	acpEnabledAtom,
	acpToolsAtom,
	dshRuntimeStatusAtom,
	type PastedTextFile,
} from "../atoms";
import {
	appendContentToDraft,
	appendSlashCommandToDraft,
	stripMarkdownFrontmatter,
	toSkillInvocationToken,
	getComposerEnterIntent,
	resolveComposerHistoryIntent,
	isComposingKeyboardEvent,
	isPlanModeSendKey,
	parseArgumentHint,
	translateBuiltinPromptDescription,
	extractUserPrompts,
	mergePromptHistory,
	deriveComposerAgentMode,
	type PromptTemplateInfo,
} from "../composerBehavior";
import { applySuggestion, buildSuggestionItems, clearSuggestionTrigger, detectTrigger, DSH_COMMAND_SUGGESTIONS, fileNodeDragPayloadToRef, flattenFiles, mergeCommands, PI_FILE_NODE_DRAG_MIME, PI_FILE_PATH_DRAG_MIME, readFileNodeDragPayload, type SuggestionItem } from "../components/app/AppUtils";
import { SESSION_TAB_DRAG_MIME } from "../utils/sessionSplitEdge";
import { fileTreeNodeKey, loadAtFileNameSearch, mergeAtFileNameSearchFiles, mergeFileTreeChildren, resolveAtDrillDirectory, shouldSearchFileNames, type AtFileNameSearchSnapshot } from "../utils/fileTreeLazy";
import { formatFilePathRef, type ComposerChip } from "../components/session/composer/chips";
import type { ComposerCaretRequest } from "../components/session/composer/types";
import { getComposerCaretCoords, getComposerCaretOffset, getComposerCaretBlockEdge, getComposerSelectionRange, isComposerAtVisualEdge } from "../components/session/composer/caretCoords";
import { desktopApi } from "../desktopApi";
import { useAskPanel } from "./useAskPanel";
import { useComposerGeneration } from "./session/composer/useComposerGeneration";
import { useComposerSendInteraction } from "./session/composer/useComposerSendInteraction";
import { useComposerDraftAssist } from "./session/composer/useComposerDraftAssist";
import { useComposerPaste } from "./session/composer/useComposerPaste";
import { formatBytes } from "../../../shared/formatBytes";
import { t } from "../i18n";
import { COMPOSER_ATTACHMENT_BUDGET_BYTES, COMPOSER_IMAGE_MAX_BYTES, ComposerImageError, attachmentBytes, base64DataBytes, dataUrlToFile, getClipboardImageFiles, getDroppedImageFiles, imageMimeTypeFromPath, isImageFilePath, processComposerImageFile } from "../utils/composerImages";
import { PASTE_TO_FILE_MIN_CHARS } from "../rendererUtils";
import { resolveBackendSwitchDefaults } from "../utils/backendSwitchDefaults";
import { GUIDE_BOOTSTRAP_SESSION_ID, readWelcomeDshModelPreference, readWelcomeModelPreference, resolveGuidePageBackend, resolveNewSessionTarget, type NewSessionBackendTarget } from "../utils/chatSessionBootstrap";
import { expandSessionReferences } from "../sending/outgoingExpansion";
import { showNotice } from "../utils/notice";
import { requireSessionCommand, toSessionRuntimeTarget } from "../utils/sessionCommands";
import { collectReservedCommandNames, needsTemplateRefetch } from "../utils/reservedCommandNames";
import { assembleTemplates, mergeRuntimeTemplates } from "../utils/templateCatalog";
import { buildDraftResourceCommands, draftResourceCommandsForProject, mergeDshSkillCommands, selectComposerSuggestionCommands, standbyPreviewCommandsForProject, type DraftResourceCommandSnapshot, type StandbyPreviewCommandSnapshot } from "../utils/draftResourceCommands";
import { isAcpComposerInitializing } from "../utils/composerInitializing";
import { isSessionRuntimeBusy, isUserFacingSessionStart } from "./useSessionTimelineController";
import { truncateQuoteLabel } from "../components/session/composer/quoteChip";
import { useSessionSend, type EnqueuePromptSnapshot } from "./useSessionSend";

/** 粘贴文件折叠进草稿时的单文件读取上限（主进程 stat 预检拦截超大文件，避免全量读入
 * 主进程再经 IPC 传输压垮两侧内存）随折叠逻辑一起拆到 `session/composer/useComposerSendInteraction.ts`。 */
import { useVoiceTranscription } from "./useVoiceTranscription";
import { usePromptEnhance, type PromptEnhanceRequest } from "./usePromptEnhance";
import { usePromptSuggestion } from "./usePromptSuggestion";
import { isSessionTurnRunning } from "../utils/sessionActivityClock";
import { resolveVoiceTranscriptionInsertion, type VoiceTranscriptionTarget } from "../utils/voiceTranscriptionInsert";

/** 统一压缩结果 → 用户可见文案；所有分支都给文案（取消也要可见，见 classifyCompactError）。 */
function compactNotice(kind: CompactNoticeKind, detail?: string): string | null {
	switch (kind) {
		case "done":
			return t("app.compactDone");
		case "nothingToDo":
			return t("app.compactNothingToDo");
		case "tooSmall":
			return t("app.compactSessionTooSmall");
		case "inProgress":
			return t("app.compactInProgress");
		case "routedToOwner": {
			// 接管者有自己的入口：主进程已把请求改写成它的扩展命令（标记后跟命令名）。
			const command = compactRoutedCommand(detail ?? "");
			return command ? t("app.compactRoutedToOwner", { command }) : t("app.compactDone");
		}
		case "cancelledByOwner": {
			const reason = compactOwnerReason(detail ?? "");
			return reason ? t("app.compactCancelledByOwnerWithReason", { reason }) : t("app.compactCancelledByOwner");
		}
		case "interrupted":
			return t("app.compactInterrupted");
		case "timeout":
			// 等待超时≠失败：pi 仍在后台压，最终结果由 compaction_end 补发系统消息（#303）。
			// 长停留：用户需要看清「现在没失败，稍后有结局」这件事本身。
			return t("app.compactWaitTimeout");
		case "cancelled":
			return t("app.compactCancelled");
		case "failed":
			return detail ? t("app.compactFailedWithReason", { error: detail }) : t("app.compactFailed");
	}
}

/**
 * compact 错误友好文案：requireSessionCommand 的 message 是 i18n 通用失败，
 * pi 原错在 debugDetails。分类走 shared/compactFeedback（按钮 / /compact 共用）。
 *
 * 取消类（cancelled / cancelledByOwner / interrupted）必须弹提示：手动压缩是用户
 * 主动点的，静默会让「压缩被扩展接管」表现为「点了没反应」。延迟到达的取消响应
 * 也不会误导——文案本身就是「已取消」，不再依赖「不提示」掩盖。
 */
function friendlyCompactError(error: unknown): { text: string; durationMs: number } | null {
	const debugDetails = error && typeof error === "object" && "debugDetails" in error ? String((error as { debugDetails?: unknown }).debugDetails ?? "").trim() : "";
	const rawMessage = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
	const raw = debugDetails || rawMessage;
	const detail = raw
		.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
		.replace(/^Error:\s*/i, "")
		.trim();
	const kind = classifyCompactError(detail);
	const text = compactNotice(kind, detail);
	if (!text) return null;
	// 取消 / 改写 / 超时类提示要用户看清「压缩现在是什么状态、为什么换了个方式」，停留时间长于普通完成提示。
	const durationMs = kind === "done" ? 4000 : kind === "cancelledByOwner" || kind === "routedToOwner" || kind === "timeout" ? 10000 : 7000;
	return { text, durationMs };
}

export type ComposerPickerKind = "model" | "thinking" | "template" | "skill";

export type UseSessionComposerControllerOptions = {
	sessionId: string;
	/**
	 * 引导页等无 record 虚拟会话的项目上下文（ProjectEmptyState 经
	 * SessionStartSurface 传选中的 activeProject.id）。有 record 时一律以
	 * record.projectId 为准；仅给 @ 文件引用/默认偏好提供项目来源，不参与
	 * 会话创建（发送 / 选择 ACP 均由 App.ensureSessionForSend 落地）。
	 */
	bootstrapProjectId?: string;
	/** target：引导页首次发送 / 选择 ACP 时的后端选择（缺省按设置默认创建）。 */
	ensureSessionId?: (sessionId: string, target?: NewSessionBackendTarget) => Promise<string>;
	/** 用户主动发消息时回调（预览 Tab 晋升常驻）；来自 SessionPaneServices 装配。 */
	onPromoteSession?: (sessionId: string) => void;
	/** `/new` 拦截后新建会话（与侧栏 + 同源）；来自 SessionPaneServices。 */
	onCreateSession?: () => Promise<void>;
	/** `/login` 拦截后打开登录供应商弹框；来自 SessionPaneServices。 */
	onProviderLogin?: (providerId?: string) => void;
	/** `/reload` 拦截后热重载 pi 资源（不写用户气泡）；来自 SessionPaneServices。 */
	onReloadResources?: (target: SessionRuntimeTarget) => Promise<void>;
	/** Passed through to useSessionSend.enqueue. */
	enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
	/** 「停止响应」时抑制排队消息自动投递；由 SessionPaneServices 注入 queue.suppressSessionQueueAutoDrain。 */
	suppressQueuedDrain?: (sessionId: string) => void;
};

export type ComposerDraftGuard = {
	sessionId: string;
	agentId?: string;
	runtimeGeneration: number;
	baselineDraft: string;
	version: number;
	pristine: boolean;
};

export function createComposerDraftGuard(input: { sessionId: string; agentId?: string; runtimeGeneration?: number; draft: string }): ComposerDraftGuard {
	return {
		sessionId: input.sessionId,
		agentId: input.agentId,
		runtimeGeneration: input.runtimeGeneration ?? 0,
		baselineDraft: input.draft,
		version: 0,
		pristine: input.draft.length === 0,
	};
}

export function markComposerDraftMutation(guard: ComposerDraftGuard): ComposerDraftGuard {
	return { ...guard, version: guard.version + 1, pristine: false };
}

export function canApplyRuntimeEditorText(
	guard: ComposerDraftGuard,
	input: {
		sessionId: string;
		agentId: string;
		runtimeGeneration: number;
		currentDraft: string;
	},
): boolean {
	return guard.sessionId === input.sessionId && guard.agentId === input.agentId && guard.runtimeGeneration === input.runtimeGeneration && guard.pristine && guard.baselineDraft === input.currentDraft;
}

export type LatestRequestToken = { key: string; sequence: number };

export function createLatestRequestGate() {
	let current = { key: "", sequence: 0 };
	return {
		begin(key: string): LatestRequestToken {
			current = { key, sequence: current.sequence + 1 };
			return current;
		},
		invalidate(key: string) {
			current = { key, sequence: current.sequence + 1 };
		},
		isCurrent(token: LatestRequestToken) {
			return token.key === current.key && token.sequence === current.sequence;
		},
	};
}

type SessionReferenceMessage = {
	role: string;
	content: string;
	timestamp: number;
};

/** 发送历史会话级 LRU 上限：每会话条目已有 50 条 slice 上限，但会话键（含已删除
 *  的草稿/临时会话）无人清理，桌面进程长运行无界增长；与 stickyEmptySessionIds /
 *  latestLoadBySession 同构，超限淘汰最早访问的会话键。访问序在模块级 Map 里，
 *  history 数据本体仍是调用方（hook ref）单一 owner。 */
const PROMPT_HISTORY_SESSION_LRU_LIMIT = 50;
const promptHistorySessionOrder = new Map<string, true>();
function markPromptHistorySessionAccess(history: Record<string, string[]>, sessionId: string) {
	// delete+set 把本次访问的键移到 Map 尾部（迭代序 = 访问序）
	promptHistorySessionOrder.delete(sessionId);
	promptHistorySessionOrder.set(sessionId, true);
	if (promptHistorySessionOrder.size <= PROMPT_HISTORY_SESSION_LRU_LIMIT) return;
	const oldest = promptHistorySessionOrder.keys().next().value;
	if (oldest !== undefined && oldest !== sessionId) {
		promptHistorySessionOrder.delete(oldest);
		// 键可能不属于本挂载的 history 对象（多栏各自 ref）：delete 不存在键无害
		delete history[oldest];
	}
}

export type SessionReferenceSelection = {
	selectedIndices: number[];
	entries: Array<{ index: number; message: SessionReferenceMessage }>;
};

export function createSessionReferenceSelection(selectedIndices: number[], selectedMessages: SessionReferenceMessage[]): SessionReferenceSelection {
	const entries = selectedIndices.map((index, position) => ({ index, message: selectedMessages[position] })).filter((entry): entry is { index: number; message: SessionReferenceMessage } => Boolean(entry.message));
	return { selectedIndices: entries.map((entry) => entry.index), entries };
}

export function selectedSessionReferenceMessages(selection: SessionReferenceSelection): SessionReferenceMessage[] {
	return [...selection.entries].sort((left, right) => left.index - right.index).map((entry) => entry.message);
}

function getBangMode(text: string): "none" | "bang" | "bang-bang" {
	if (text.startsWith("!!")) return "bang-bang";
	if (text.startsWith("!")) return "bang";
	return "none";
}

export function useSessionComposerController(options: UseSessionComposerControllerOptions) {
	const { sessionId, enqueue, ensureSessionId, suppressQueuedDrain } = options;
	// changeBackend 的依赖数组是既有契约测试锁定的形状；ensureSessionId 会随
	// activeProjectId 变化，用 ref 取最新值，避免闭包拿到旧项目上下文。
	const ensureSessionIdRef = useRef(ensureSessionId);
	ensureSessionIdRef.current = ensureSessionId;
	const store = useStore();
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const enhanceModelConfig = useAtomValue(enhanceModelAtom);
	const enhanceIncludeContext = useAtomValue(enhanceIncludeContextAtom);
	// 引导页虚拟会话没有 record：文件树/@ 引用回退到引导页选中的项目，
	// 否则 files 恒为空、@ 输入永远匹配不到任何文件。
	const effectiveProjectId = record?.projectId ?? options.bootstrapProjectId;
	// 粘贴转文件/@ 引用的项目路径来源：catalog 会话 record 不一定携带 projectPath
	// （主进程扫描只在会话文件位于项目内时才推断，旧数据/独立目录会话恒缺省），
	// 统一经 projectId 反查项目清单，拿到已登记的项目根路径，避免把有项目会话
	// 误当成匿名会话（用户反馈：粘贴大文本发送后消息里被展开成普通文本）。
	const composerProject = useAtomValue(projectByIdAtomFamily(effectiveProjectId ?? ""));
	// 远端项目只跑主机上的 pi：底栏不提供后端切换，引导页也不能把 dsh/acp 偏好带进来。
	// （dsh/acp 是本地 runtime，绑到远端项目上必然起不来；创建侧在 App.ensureSessionForSend 同源钳制。）
	const isRemoteProjectSession = composerProject !== undefined && isRemoteProject(composerProject);
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId));
	const projectSessions = useAtomValue(sessionSummariesByProjectIdAtomFamily(effectiveProjectId ?? ""));
	// H6：按 sessionId 隔离订阅——分屏时一栏打字/流式不再牵连其他栏重渲染。
	// atomFamily 本身按 sessionId 记忆化，useMemo 再固定一次引用。
	const draftAtom = useMemo(() => sessionDraftBySessionIdAtomFamily(sessionId), [sessionId]);
	const attachmentsAtom = useMemo(() => sessionAttachmentsBySessionIdAtomFamily(sessionId), [sessionId]);
	const pasteFilesAtom = useMemo(() => sessionPasteFilesBySessionIdAtomFamily(sessionId), [sessionId]);
	const modeAtom = useMemo(() => sessionComposerModeBySessionIdAtomFamily(sessionId), [sessionId]);
	const sendStateAtom = useMemo(() => sessionSendStateBySessionIdAtomFamily(sessionId), [sessionId]);
	const messageCacheAtom = useMemo(() => sessionMessageCacheBySessionIdAtomFamily(sessionId), [sessionId]);
	const quotesAtom = useMemo(() => sessionQuotesBySessionIdAtomFamily(sessionId), [sessionId]);
	const draft = useAtomValue(draftAtom);
	const attachments = useAtomValue(attachmentsAtom);
	const pasteFiles = useAtomValue(pasteFilesAtom);
	const localMode = useAtomValue(modeAtom);
	const sendState = useAtomValue(sendStateAtom);
	const messageCache = useAtomValue(messageCacheAtom);
	const imageGenConfig = useAtomValue(imageGenConfigAtom);
	const setImageGenConfig = useSetAtom(imageGenConfigAtom);
	// 生视频配置独立落盘（videogen.json），与生图同构：composer 只读这份，不碰会话 LLM 模型。
	const videoGenConfig = useAtomValue(videoGenConfigAtom);
	const setVideoGenConfig = useSetAtom(videoGenConfigAtom);
	const setDraftAtom = useSetAtom(setSessionDraftAtom);
	const setAttachmentsAtom = useSetAtom(setSessionAttachmentsAtom);
	const setPasteFilesAtom = useSetAtom(setSessionPasteFilesAtom);
	const setModeAtom = useSetAtom(setSessionComposerModeAtom);
	const setSendStateAtom = useSetAtom(setSessionSendStateAtom);
	const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);

	// DSH：plan 由 host 持有；goal 由本地选择或进行中/阻塞的目标驱动（切回普通会 pause）。
	// 生图为独立供应商配置，不属于 pi/dsh 任一后端，两种后端均可用。
	// 引导页虚拟会话的后端显式选择：无 record、不落 catalog，切换只写本页 state。
	// 刻意不从 localStorage 恢复「上次选择」：新建会话默认后端只跟随设置项——
	// 自动沿用 ACP 会在冷启动把握手加载态塞进输入框（用户反馈体验差），用户要
	// 换后端就在输入框里手动切；pi/DSH 首次发送按当前选择创建真实会话，
	// ACP 选择即创建（configOptions 需要 runtime 握手，见 changeBackend）。
	const defaultAgentBackend = useAtomValue(effectiveAgentBackendAtom);
	const isGuideBootstrapSession = sessionId === GUIDE_BOOTSTRAP_SESSION_ID;
	const [guideBackendOverride, setGuideBackendOverride] = useState<AgentBackend | undefined>(undefined);
	// 引导页 ACP 工具预选单独入 state：acp→acp 换工具时后端名不变，
	// setGuideBackendOverride("acp") 同值不触发重渲染，trigger 回显会停在旧工具；
	// 工具 id 必须自己有 state 才能让受控 Select 刷新。
	const [guideAcpToolOverride, setGuideAcpToolOverride] = useState<string | undefined>(undefined);
	// 引导页当前展示/将创建的后端：本页手动切换优先，否则设置默认（已按 DSH 安装态钳制）。
	const guideBackend: AgentBackend = isGuideBootstrapSession ? (guideBackendOverride ?? defaultAgentBackend) : defaultAgentBackend;
	const isDshBackend = record?.backend === "dsh" || runtime?.backend === "dsh" || (isGuideBootstrapSession && guideBackend === "dsh");
	// ACP 后端：忙碌投递恒收敛为 followUp（协议无 steer 通道，插队必被 manager 拒收），
	// 拆分菜单的「插入当前回合」项也整体隐藏。
	const isAcpBackend = record?.backend === "acp" || runtime?.backend === "acp" || (isGuideBootstrapSession && guideBackend === "acp");
	const hasImageGenHistory = (messageCache?.messages ?? []).some((message) => Boolean(message.meta?.imageGen));
	// 生视频不存在 legacy 混排（videogen 是新后端，只有它自己会写 meta.videoGen），不需要历史锁。
	const isVideoGenBackend = record?.backend === "videogen";
	// 生图供应商/模型来自独立 imagegen.json，与会话 LLM 模型无关。
	const activeImageGenProviderId = imageGenConfig.activeProviderId;
	const activeImageGenModelId = imageGenConfig.activeModel;
	const mode: ComposerAgentMode =
		record?.backend === "imagegen" || hasImageGenHistory
			? "imagegen"
			: isVideoGenBackend
				? "videogen"
				: deriveComposerAgentMode({
						backend: isDshBackend ? "dsh" : isAcpBackend ? "acp" : "pi",
						localMode: localMode,
						planModeActive: runtime?.state?.planModeActive === true,
						goalPhase: runtime?.state?.goal?.phase,
					});
	// 生图判据（与 ComposerComponents 的 imageGenComposer 同义）：模式 or 引导页选中的生图后端。
	// 生图附件是参考图，@path 引用不会被解析：选图/拖入都统一进附件栏。
	const imageGenComposer = mode === "imagegen" || (isGuideBootstrapSession && guideBackend === "imagegen");
	// DSH 部署默认模型选择（settings.yaml agent-default-model）：草稿/未激活会话
	// 的底栏与选择器用它展示默认模型/思考档位（host 会话创建前没有 runtime state）。
	// settings.yaml 未配 reasoningEffort 时，回退到默认模型自身的 defaultEffort
	// （DSH 官方语义：每个模型都有 reasoning.defaultEffort）。
	const [dshDefault, setDshDefault] = useState<
		| {
				provider: string;
				model: string;
				reasoningEffort?: string;
				defaultEffort?: string;
		  }
		| undefined
	>(undefined);
	useEffect(() => {
		if (!isDshBackend) {
			// 离开 dsh 后端（切回 pi/生图）时清掉残留的 DSH 部署默认模型：
			// 底栏 defaultModel = dshDefaultModel ?? bootstrapDefaultModel，
			// 残留会让 pi 会话误显示 DSH 的默认模型（用户反馈「切回 pi 默认模型变了」）。
			setDshDefault(undefined);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const next = await desktopApi.sessions.getDshDefaultModel();
				if (!next || cancelled) {
					if (!cancelled) setDshDefault(next);
					return;
				}
				let defaultEffort = next.reasoningEffort;
				if (!defaultEffort) {
					try {
						const models = await desktopApi.sessions.listDshModels();
						const defaultModel = models.find((model) => model.provider === next.provider && model.id === next.model);
						defaultEffort = defaultModel?.defaultEffort;
					} catch {
						// 目录读取失败不影响 settings.yaml 的默认模型展示。
					}
				}
				if (!cancelled) setDshDefault({ ...next, defaultEffort });
			} catch {
				if (!cancelled) setDshDefault(undefined);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isDshBackend]);
	// 引导页虚拟会话（无 record）：预取主进程解析的启动默认（与 createDraft 缺省
	// 同一解析器 launchDefaults），让底栏/选择器在用户从未设置欢迎页偏好时也能
	// 显示当前默认模型/思考档位。真实会话的默认值写在 record 里走原链路，
	// 不需要这里重复解析。
	// 后端必须取「引导页实际展示的后端」（用户显式切换优先），不能只看设置项
	// （issue #253）：引导页切到 DSH 后若仍按 pi 解析，launchDefaults 会返回 pi 的
	// 默认模型，底栏就显示一个 DSH 下永远不会用的模型（用户报告的
	// 「切到 dsh 后底栏显示 pi 模型」）。按 dsh 解析时该 IPC 不返回模型（模型归属
	// host settings），底栏自然回落到 dshDefaultModel。
	// 仍然经 effectiveAgentBackendAtom 取默认值（DSH runtime 安装态钳制）。
	const guidePageBackend: AgentBackend = isRemoteProjectSession ? "pi" : isGuideBootstrapSession ? resolveGuidePageBackend({ override: guideBackendOverride, effectiveDefault: defaultAgentBackend }) : defaultAgentBackend;
	const [bootstrapDefaults, setBootstrapDefaults] = useState<ResolvedLaunchDefaults | undefined>(undefined);
	useEffect(() => {
		if (record) return;
		let cancelled = false;
		void desktopApi.sessions
			.resolveLaunchDefaults({ backend: guidePageBackend })
			.then((next) => {
				if (!cancelled) setBootstrapDefaults(next);
			})
			.catch(() => {
				// 解析失败退回“无预选”形态：底栏不显示默认模型，但不影响发送。
				if (!cancelled) setBootstrapDefaults(undefined);
			});
		return () => {
			cancelled = true;
		};
	}, [guidePageBackend, record]);
	const editorRef = useRef<HTMLDivElement | null>(null);
	// 程序化光标请求（带归属 forValue，见 composer/types.ts 的 ComposerCaretRequest）；
	// 编辑器只在内容同步到 forValue 的同一趟 layout pass 配对消费，过期请求会被丢弃。
	const caretRef = useRef<ComposerCaretRequest | null>(null);
	const liveDomDraftRef = useRef({ sessionId, value: draft });
	const draftGuardRef = useRef(
		createComposerDraftGuard({
			sessionId,
			agentId: runtime?.agentId,
			runtimeGeneration: runtime?.runtimeGeneration,
			draft,
		}),
	);
	const templateRequestGateRef = useRef(createLatestRequestGate());
	const promptHistoryRef = useRef<Record<string, string[]>>({});
	/**
	 * 当前会话可导航的输入历史 = 本次运行发送记录（promptHistoryRef，最新在前）
	 * + 会话已有消息里的用户输入（从 sessionMessagesCacheAtom 懒读取，零订阅零重渲染）。
	 * 未启动的 Agent 没有发送记录，但 timeline 加载会话时已把 disk 消息写入缓存，
	 * 因此激活前后上下键历史行为一致（issue-139）。
	 */
	const getPromptHistory = useCallback(() => {
		markPromptHistorySessionAccess(promptHistoryRef.current, sessionId);
		const runtimeHistory = promptHistoryRef.current[sessionId] ?? [];
		const sessionHistory = extractUserPrompts(store.get(sessionMessagesCacheAtom)[sessionId]?.messages ?? []);
		return mergePromptHistory(runtimeHistory, sessionHistory);
	}, [sessionId, store]);
	const lastEditorTextEnvelopeRef = useRef("");
	const [cursor, setCursor] = useState(0);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [savedDraft, setSavedDraft] = useState("");
	const [busyDraftLocked, setBusyDraftLocked] = useState(false);
	const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
	// 生图尺寸/水印记在 AppSettings，跨会话复用；非法磁盘值回落到默认。
	const [imageGenSize, setImageGenSizeState] = useState<string>(DEFAULT_IMAGE_GEN_SIZE);
	const [imageGenWatermark, setImageGenWatermarkState] = useState(DEFAULT_IMAGE_GEN_WATERMARK);
	const [imageGenOutputFormat, setImageGenOutputFormatState] = useState(DEFAULT_IMAGE_GEN_OUTPUT_FORMAT);
	const [picker, setPicker] = useState<ComposerPickerKind | null>(null);
	const [commands, setCommands] = useState<PiCommand[]>([]);
	// 热重载后扩展/技能/提示词可能变化，但 runtime 身份不变；tick 强制重拉命令表。
	const commandsRefreshTick = useAtomValue(sessionCommandsRefreshTickAtom);
	const [draftResourceCommandSnapshot, setDraftResourceCommandSnapshot] = useState<DraftResourceCommandSnapshot>({ projectId: undefined, commands: [] });
	const [standbyPreviewCommandSnapshot, setStandbyPreviewCommandSnapshot] = useState<StandbyPreviewCommandSnapshot>({ projectId: undefined, commands: [] });
	const [files, setFiles] = useState<FileTreeNode[]>([]);
	// @ 引用懒加载状态：已按 maxDepth 0 拉过子项的目录绝对路径（防重复请求），
	// 与在途加载集合成对出现；目录不在任一集合才能发新请求。
	const loadedDirPathsRef = useRef<Set<string>>(new Set());
	const loadingDirPathsRef = useRef<Set<string>>(new Set());
	// 深层 @ 搜索只返回按项目/查询标记的有界命中，不扩张目录懒加载树。
	const [atFileNameSearch, setAtFileNameSearch] = useState<AtFileNameSearchSnapshot | null>(null);
	// 运行时模板正文按「agentId:generation」缓存键刷新：runtime 对象本身每次状态变更都会换
	// 引用，直接进依赖会让模板表随每次流式状态变化重拉。
	const runtimeTargetKey = runtime?.agentId && runtime.runtimeGeneration !== undefined ? `${runtime.agentId}:${runtime.runtimeGeneration}` : "";
	const templateKey = `${sessionId}:${record?.projectPath ?? ""}`;
	const [templateState, setTemplateState] = useState<{
		key: string;
		items: PromptTemplateInfo[];
	}>({ key: templateKey, items: [] });
	const templates = templateState.key === templateKey ? templateState.items : [];
	/**
	 * 发送期读取的模板清单（同步引用）。
	 *
	 * 为什么不能用 state：`loadTemplates` 内部 `setTemplateState` 之后要等下一次渲染，而
	 * 「打开会话立刻发 /模板名」这一拍里发送路径读到的还是旧数组——展开器认不出模板名，
	 * 消息原样发给 pi，模板名就丢了（2026-10 e2e 抓到的竞态）。这里由 `loadTemplates`
	 * 同步写入，发送路径用 `getTemplates()` 读它。
	 */
	const templatesRef = useRef<PromptTemplateInfo[]>(templates);
	/** 模板加载写入序列：并发加载时只让「最后发起」的那份写进 templatesRef。 */
	const templateWriteSeqRef = useRef(0);
	const templateWrittenSeqRef = useRef(0);
	const [sendShortcut, setSendShortcut] = useState<"enter-send" | "ctrl-enter-send" | "shift-enter-send">("enter-send");
	const [sessionReference, setSessionReference] = useState<SessionSummary | null>(null);
	const [sessionReferenceSelections, setSessionReferenceSelections] = useState<Record<string, SessionReferenceSelection>>({});

	const markDraftMutation = useCallback(
		(targetSessionId = sessionId) => {
			if (targetSessionId !== sessionId) return;
			draftGuardRef.current = markComposerDraftMutation(draftGuardRef.current);
		},
		[sessionId],
	);

	const setDraft = useCallback(
		(value: string | ((current: string) => string)) => {
			markDraftMutation();
			setDraftAtom({ sessionId, value });
		},
		[markDraftMutation, sessionId, setDraftAtom],
	);

	const setAttachments = useCallback(
		(value: ImageContent[] | ((current: ImageContent[]) => ImageContent[])) => {
			setAttachmentsAtom({ sessionId, value });
		},
		[sessionId, setAttachmentsAtom],
	);

	const setPasteFiles = useCallback(
		(value: PastedTextFile[] | ((current: PastedTextFile[]) => PastedTextFile[])) => {
			setPasteFilesAtom({ sessionId, value });
		},
		[sessionId, setPasteFilesAtom],
	);

	const setMode = useCallback(
		(nextMode: ComposerAgentMode) => {
			// 生图历史是独立消息协议，普通/计划/目标模式的命令语义不适用；
			// 同一会话一旦产生生图记录（或本身是 imagegen 后端），必须保持生图模式，避免误发普通请求。
			if ((hasImageGenHistory || record?.backend === "imagegen") && nextMode !== "imagegen") return;
			// videogen 同为独立后端：会话一旦是生视频后端，不允许切回普通/计划/目标（命令语义不适用）。
			if (record?.backend === "videogen" && nextMode !== "videogen") return;
			// DSH：plan 走 host /plan；goal 走 create/resume/pause IPC（切回普通暂停，不清除）。
			// 本地 atom 仍写入 goal，让选择器立刻切到目标模式；首条用户消息再 /goal 创建。
			if (isDshBackend) {
				const currentPhase = runtime?.state?.goal?.phase;
				const agentId = runtime?.agentId;
				if (nextMode === "plan" || (nextMode === "normal" && mode === "plan")) {
					const command = nextMode === "plan" ? "/plan" : "/plan off";
					void desktopApi.sessions
						.sendPrompt({
							sessionId,
							requestId: crypto.randomUUID(),
							message: command,
						})
						.then((result) => {
							if (!result.accepted) {
								showNotice(result.error ?? t("dshPlan.switchFailed"), 4000);
							} else if (nextMode === "plan") {
								showNotice(t("dshPlan.pendingNotice"), 3000);
							}
						})
						.catch((error) => {
							showNotice(error instanceof Error ? error.message : String(error), 4000);
						});
					if (nextMode === "plan") {
						setModeAtom({ sessionId, mode: "normal" });
						// 模式选择器互斥：进 plan 时暂停进行中的 goal，不清除。
						if (agentId && (currentPhase === "active" || currentPhase === "blocked")) {
							void desktopApi.sessions.runDshGoalAction(agentId, "pause").catch((error) => {
								showNotice(error instanceof Error ? error.message : String(error), 4000);
							});
						}
					}
					return;
				}
				if (nextMode === "goal") {
					if (mode === "plan") {
						void desktopApi.sessions
							.sendPrompt({
								sessionId,
								requestId: crypto.randomUUID(),
								message: "/plan off",
							})
							.catch((error) => {
								showNotice(error instanceof Error ? error.message : String(error), 4000);
							});
					}
					setModeAtom({ sessionId, mode: "goal" });
					if (agentId && (currentPhase === "paused" || currentPhase === "blocked")) {
						void desktopApi.sessions.runDshGoalAction(agentId, "resume").catch((error) => {
							showNotice(error instanceof Error ? error.message : String(error), 4000);
						});
					} else if (!currentPhase || currentPhase === "complete") {
						showNotice(t("dshGoal.pendingNotice"), 3000);
					}
					return;
				}
				if (nextMode === "normal" && mode === "goal") {
					setModeAtom({ sessionId, mode: "normal" });
					if (agentId && (currentPhase === "active" || currentPhase === "blocked")) {
						void desktopApi.sessions.runDshGoalAction(agentId, "pause").catch((error) => {
							showNotice(error instanceof Error ? error.message : String(error), 4000);
						});
					}
					return;
				}
			}
			// pi：切回普通立刻发 /goal pause，不要等下一条无标记消息才停。
			if (!isDshBackend && nextMode === "normal" && mode === "goal") {
				setModeAtom({ sessionId, mode: "normal" });
				void desktopApi.sessions
					.sendPrompt({
						sessionId,
						requestId: crypto.randomUUID(),
						message: "/goal pause",
					})
					.catch((error) => {
						showNotice(error instanceof Error ? error.message : String(error), 4000);
					});
				return;
			}
			setModeAtom({ sessionId, mode: nextMode });
		},
		[hasImageGenHistory, isDshBackend, mode, runtime?.agentId, runtime?.state?.goal?.phase, sessionId, setModeAtom],
	);

	const loadTemplates = useCallback(async () => {
		const token = templateRequestGateRef.current.begin(templateKey);
		// 写入序号在**发起时**分配（不是在结束时）：结束时分配会让「切走前发起、切走后完成」
		// 的加载拿到更大的序号，把上一个会话的模板表写进 templatesRef，随后该会话的发送会用
		// 错项目的模板正文展开（跨会话污染）。发起顺序才代表新旧。
		const sequence = ++templateWriteSeqRef.current;
		let globalTemplates: PromptTemplateInfo[] = [];
		let projectTemplates: PromptTemplateInfo[] = [];
		try {
			const globalResult = await desktopApi.prompts.list();
			globalTemplates = globalResult.templates.map((template) => ({
				...template,
				description: translateBuiltinPromptDescription(template),
				argumentHint: parseArgumentHint(template.content),
			}));
		} catch {
			// Project templates remain usable when the global store is unavailable.
		}
		if (record?.projectId) {
			try {
				const projectResult = await desktopApi.prompts.listByProject(record.projectId);
				projectTemplates = projectResult.templates.map((template) => ({
					...template,
					argumentHint: parseArgumentHint(template.content),
				}));
			} catch {
				// A project does not have to provide .pi/prompts.
			}
		}
		// 同名以项目为准、禁用不进表——与 pi 的 rank + 去重规则一致（见 assembleTemplates）
		let next: PromptTemplateInfo[] = assembleTemplates({ project: projectTemplates, global: globalTemplates });
		// 来源 B：pi 实际加载的全部模板（含 npm 包声明的 pi.prompts）。缺了它，
		// `/parallel-review` 这类包带模板只能交给 pi 展开，模板名不进会话文件，
		// 时间线就还原不出 chip（2026-10 现场：运行中有 chip、暂停后变全文）。
		const target = toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeBySessionIdAtomFamily(sessionId)));
		if (target) {
			try {
				const result = await desktopApi.sessions.listRuntimePromptTemplates(target);
				if (result.ok) next = mergeRuntimeTemplates(next, result.value.value);
			} catch {
				// 读正文失败/进程换代：保留来源 A，行为退回「交给 pi 展开」
			}
		} else if (record?.projectId) {
			// 草稿会话（还没绑定 runtime）没有 target：借 standby 池的命令表读同一份正文，
			// 否则「打开会话立刻发 /模板名」这条消息只能交给 pi 展开，chip 当场丢失。
			// 池未就绪/关闭时返回 null，行为退回来源 A。
			try {
				const templates = await desktopApi.sessions.draftPromptTemplates(record.projectId);
				if (templates?.length) next = mergeRuntimeTemplates(next, templates);
			} catch {
				// 同上：预览失败不影响模板 A 与发送
			}
		}
		// 发送期引用（templatesRef）不看 gate 的 current：并发加载时 gate 会作废较早的 token，
		// 但那一份数据往往正是这次发送要的——按发起顺序，只让更新的那份覆盖已有的。
		if (sequence >= templateWrittenSeqRef.current) {
			templateWrittenSeqRef.current = sequence;
			templatesRef.current = next;
		}
		if (templateRequestGateRef.current.isCurrent(token)) {
			setTemplateState({ key: templateKey, items: next });
		}
		return next;
	}, [record?.projectId, sessionId, store, templateKey, runtimeTargetKey]);

	useEffect(() => {
		liveDomDraftRef.current = { sessionId, value: draft };
		setCursor(draft.length);
		setSuggestionsOpen(false);
		setSelectedSuggestionIndex(0);
		setHistoryIndex(-1);
		setSavedDraft("");
		setBusyDraftLocked(false);
		// 注意：这里不再写 caretRef。该写入发生在编辑器 layout effect 之后、且 layout
		// effect 只在 value 变化时重跑，会留下一条过期待消费光标——首次输入（打字/
		// 粘贴/语音）时把选区重置回 0。恢复光标到文末由编辑器在内容同步（setContent）
		// 时兜底完成，见 useTipTapComposerEditor 同步 effect。
		draftGuardRef.current = createComposerDraftGuard({
			sessionId,
			agentId: runtime?.agentId,
			runtimeGeneration: runtime?.runtimeGeneration,
			draft,
		});
		lastEditorTextEnvelopeRef.current = "";
	}, [sessionId]);

	useEffect(() => {
		const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
		draftGuardRef.current = createComposerDraftGuard({
			sessionId,
			agentId: runtime?.agentId,
			runtimeGeneration: runtime?.runtimeGeneration,
			draft: currentDraft,
		});
		lastEditorTextEnvelopeRef.current = "";
	}, [runtime?.agentId, runtime?.runtimeGeneration, sessionId, store]);

	useEffect(() => {
		if (liveDomDraftRef.current.sessionId === sessionId && liveDomDraftRef.current.value !== draft) {
			liveDomDraftRef.current = { sessionId, value: draft };
		}
	}, [draft, sessionId]);

	useEffect(() => {
		const editorText = runtimeUi?.editorText;
		if (!runtime?.agentId || !editorText || runtimeUi.agentId !== runtime.agentId || runtimeUi.runtimeGeneration !== runtime.runtimeGeneration) {
			return;
		}
		const envelope = `${sessionId}:${runtime.runtimeGeneration}:${editorText.revision}`;
		if (lastEditorTextEnvelopeRef.current === envelope) return;
		lastEditorTextEnvelopeRef.current = envelope;
		const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
		if (
			!canApplyRuntimeEditorText(draftGuardRef.current, {
				sessionId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
				currentDraft,
			})
		) {
			return;
		}
		liveDomDraftRef.current = { sessionId, value: editorText.text };
		setDraft(editorText.text);
		setCursor(editorText.text.length);
		caretRef.current = { pos: editorText.text.length, forValue: editorText.text };
	}, [runtime, runtimeUi, sessionId, setDraft, store]);

	useEffect(() => {
		void desktopApi.settings
			.get()
			.then((settings) => {
				setSendShortcut(settings.sendShortcut);
				setImageGenSizeState(parseImageGenSize(settings.imageGenSize) ?? DEFAULT_IMAGE_GEN_SIZE);
				setImageGenWatermarkState(parseImageGenWatermark(settings.imageGenWatermark));
				setImageGenOutputFormatState(parseImageGenOutputFormat(settings.imageGenOutputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT);
			})
			.catch(() => undefined);
	}, []);

	// 单栏会话复用同一 Composer 实例：切 tab 必须清掉 picker/建议/预览等本地 UI，
	// 草稿和附件走 per-session atom，这里只重置不属于 atom 的瞬时状态。
	useEffect(() => {
		setCursor(0);
		setSuggestionsOpen(false);
		setSelectedSuggestionIndex(0);
		setHistoryIndex(-1);
		setSavedDraft("");
		setBusyDraftLocked(false);
		setPreviewImage(null);
		setPicker(null);
		setSessionReference(null);
		setSessionReferenceSelections({});
	}, [sessionId]);

	useEffect(() => {
		if (!effectiveProjectId) {
			setFiles([]);
			return;
		}
		let current = true;
		// @ 引用跟文件抽屉同一套懒加载：maxDepth 0 只扫根层，展开再补子目录。
		// 旧实现扫 8 层会在切项目时把主进程/渲染都拖死（大会话项目尤其明显）。
		// 引导页虚拟会话没有 record，靠 bootstrapProjectId 兑底加载文件树。
		void desktopApi.files
			.list(effectiveProjectId, { maxDepth: 0, skipGeneratedDirs: true })
			.then((next) => {
				if (current) setFiles(next);
			})
			.catch(() => {
				if (current) setFiles([]);
			});
		return () => {
			current = false;
		};
	}, [effectiveProjectId]);

	// 切项目时清掉懒加载进度：老项目的目录缓存/在途请求不能让新项目复用。
	// （真实请求仍受主进程 isPathInsideProject 拦截，这里双保险。）
	useEffect(() => {
		loadedDirPathsRef.current = new Set();
		loadingDirPathsRef.current = new Set();
	}, [effectiveProjectId]);

	useEffect(() => {
		// D15：DSH 会话的命令补全优先走 live 注册表（host 侧 ctx.commands.list，
		// 含用户/插件注册的命令）；会话未激活（无 live Agent）或桥失败时降级为
		// 已知命令建议集（与 dsh-web 命名空间一致；slash 桥未命中会放行给模型）。
		if (isDshBackend) {
			const staticCommands = DSH_COMMAND_SUGGESTIONS.map((command) => ({
				name: command.name,
				description: t(command.descriptionKey),
				source: command.source,
			}));
			const dshTarget = toSessionRuntimeTarget(sessionId, runtime);
			if (!dshTarget) {
				setCommands(staticCommands);
				return;
			}
			let current = true;
			// 命令表与技能目录并行：命令先到先出，技能后到再合并，避免 skill.list 拖慢 `/` 菜单。
			let liveCommands: PiCommand[] = staticCommands;
			let skillCommands: ReadonlyArray<{ name: string; description?: string }> = [];
			const publish = () => {
				if (current) setCommands(mergeDshSkillCommands(liveCommands, skillCommands));
			};
			void desktopApi.sessions
				.listRuntimeCommands(dshTarget)
				.then((result) => {
					if (!current) return;
					const live = requireSessionCommand(result).value;
					// live 清单可能不含 help 等基础命令（部分命令仅桌面侧存在）：
					// 与静态建议集合并去重，优先 live 描述。
					const names = new Set(live.map((command) => command.name));
					liveCommands = [...live, ...staticCommands.filter((command) => !names.has(command.name))];
					publish();
				})
				.catch(() => {
					liveCommands = staticCommands;
					publish();
				});
			if (!isRendererVirtualSessionId(sessionId)) {
				void desktopApi.sessions
					.listDshSkills({ sessionId })
					.then((skills) => {
						skillCommands = skills;
						publish();
					})
					.catch(() => {
						// 技能目录失败不影响命令补全；鼠标选择器仍有独立的加载/报错路径。
					});
			}
			return () => {
				current = false;
			};
		}
		const target = toSessionRuntimeTarget(sessionId, runtime);
		if (!target) {
			setCommands([]);
			return;
		}
		let current = true;
		void desktopApi.sessions
			.listRuntimeCommands(target)
			.then((result) => {
				if (current) setCommands(requireSessionCommand(result).value);
			})
			.catch(() => {
				if (current) setCommands([]);
			});
		return () => {
			current = false;
		};
	}, [isDshBackend, runtime?.agentId, runtime?.runtimeGeneration, sessionId, commandsRefreshTick]);

	// Draft sessions have no Pi process to ask for get_commands. Discover the same local
	// skills/prompts Pi will load; as soon as a runtime exists, its RPC list is authoritative.
	// ACP 草稿除外：这些 /skill:*、/prompt 命令是 pi 进程的，ACP CLI 不认识，
	// 列进建议只会发出无效文本（keep snapshot empty）。
	useEffect(() => {
		if (isDshBackend || isAcpBackend || runtime?.agentId) {
			setDraftResourceCommandSnapshot({ projectId: effectiveProjectId, commands: [] });
			return;
		}
		let current = true;
		setDraftResourceCommandSnapshot({ projectId: effectiveProjectId, commands: [] });
		const globalSkills = desktopApi.skills
			.list()
			.then((result) => result.skills)
			.catch(() => []);
		const projectSkills = effectiveProjectId ? desktopApi.projectResources.list(effectiveProjectId).catch(() => undefined) : Promise.resolve(undefined);
		const discovered = desktopApi.projectResources.discovery(effectiveProjectId ?? undefined).catch(() => ({ projectResourcesAllowed: false, overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] }, skills: [], prompts: [], extensions: [] }));
		void Promise.all([globalSkills, projectSkills, discovered]).then(([global, project, resources]) => {
			if (!current) return;
			const skills = [...(project?.skills ?? []), ...global, ...resources.skills];
			const prompts = [...templates, ...resources.prompts];
			setDraftResourceCommandSnapshot({
				projectId: effectiveProjectId,
				commands: buildDraftResourceCommands(skills, prompts, {
					projectResourcesAllowed: resources.projectResourcesAllowed,
					disabledGlobalSkillKeys: resources.overrides.disabledGlobalSkills,
					disabledGlobalPromptNames: resources.overrides.disabledGlobalPrompts,
				}),
			});
		});
		return () => {
			current = false;
		};
	}, [effectiveProjectId, isAcpBackend, isDshBackend, runtime?.agentId, templates]);

	// Issue #316：草稿会话在 standby 池里有同项目已握手进程时，只读借用其 get_commands
	// 预览扩展注册的命令（本地技能/提示词发现覆盖不到）。拿不到预览就保持空快照，
	// 建议列表回退上面的本地发现；runtime 建立后上面 RPC 拉取的命令表重新成为唯一来源。
	// ACP 草稿除外：standby 池是 pi 进程，预览出的命令对 ACP CLI 无效。
	useEffect(() => {
		if (isDshBackend || isAcpBackend || runtime?.agentId || !effectiveProjectId) {
			setStandbyPreviewCommandSnapshot({ projectId: effectiveProjectId, commands: [] });
			return;
		}
		let current = true;
		setStandbyPreviewCommandSnapshot({ projectId: effectiveProjectId, commands: [] });
		void desktopApi.sessions
			.draftCommands(effectiveProjectId)
			.then((preview) => {
				if (current && preview) setStandbyPreviewCommandSnapshot({ projectId: effectiveProjectId, commands: preview });
			})
			.catch(() => undefined);
		return () => {
			current = false;
		};
	}, [effectiveProjectId, isAcpBackend, isDshBackend, runtime?.agentId]);

	useEffect(() => {
		templateRequestGateRef.current.invalidate(templateKey);
		templatesRef.current = [];
		templateWrittenSeqRef.current = ++templateWriteSeqRef.current;
		setTemplateState({ key: templateKey, items: [] });
		void loadTemplates();
	}, [loadTemplates, templateKey]);

	const flatFiles = useMemo(() => flattenFiles(files), [files]);

	const mergedCommands = useMemo(() => mergeCommands(commands), [commands]);
	/**
	 * 后端已接管的命令名（本地展开要避让）。用 ref 让发送路径读最新值：
	 * 命令表是异步加载的，state 在「打开会话立刻发」这一拍还是空的。
	 */
	const reservedCommandNames = useMemo(() => collectReservedCommandNames(commands), [commands]);
	const reservedCommandNamesRef = useRef<ReadonlySet<string>>(reservedCommandNames);
	reservedCommandNamesRef.current = reservedCommandNames;
	const validCommandNames = useMemo(() => new Set([...mergedCommands.map((command) => command.name), ...templates.map((template) => template.name)]), [mergedCommands, templates]);
	const validFilePaths = useMemo(() => new Set(flatFiles.map((file) => file.relativePath)), [flatFiles]);
	const validSessionRefs = useMemo(() => new Set(projectSessions.map((session) => session.name ?? session.filePath)), [projectSessions]);
	const atFileQuery = useMemo(() => {
		const trigger = detectTrigger(draft, cursor, validSessionRefs);
		return trigger?.char === "@" && shouldSearchFileNames(trigger.query) ? trigger.query : null;
	}, [cursor, draft, validSessionRefs]);
	const atFileSearchKey = effectiveProjectId && atFileQuery !== null ? `${effectiveProjectId}\0${atFileQuery}` : "";
	const suggestionFiles = useMemo(() => mergeAtFileNameSearchFiles(flatFiles, atFileNameSearch && `${atFileNameSearch.projectId}\0${atFileNameSearch.query}` === atFileSearchKey ? atFileNameSearch.files : []), [atFileNameSearch, atFileSearchKey, flatFiles]);
	// 引用 chip 白名单：id → 截断后的快照预览 label；无快照时返回 undefined，
	// 解析器直接跳过引用分支（零开销快速路径）
	const sessionQuotes = useAtomValue(quotesAtom);
	const validQuotes = useMemo(() => {
		if (!sessionQuotes) return undefined;
		const entries = Object.entries(sessionQuotes);
		if (entries.length === 0) return undefined;
		return new Map(entries.map(([id, snippet]) => [id, truncateQuoteLabel(snippet.text)]));
	}, [sessionQuotes]);
	const draftResourceCommands = draftResourceCommandsForProject(draftResourceCommandSnapshot, effectiveProjectId);
	const standbyPreviewCommands = standbyPreviewCommandsForProject(standbyPreviewCommandSnapshot, effectiveProjectId);
	const suggestionCommands = selectComposerSuggestionCommands(isDshBackend, Boolean(runtime?.agentId), commands, draftResourceCommands, standbyPreviewCommands);
	const suggestionItems = useMemo(() => (suggestionsOpen ? buildSuggestionItems(draft, cursor, suggestionCommands, suggestionFiles, projectSessions) : []), [cursor, draft, projectSessions, suggestionCommands, suggestionFiles, suggestionsOpen]);

	// @ 引用向下钻取：随输入懒加载子目录（maxDepth 0 只拉一层，与文件抽屉同语义）。
	// 修复 maxDepth 0 化后只能引用到项目根一层（71d27ed1 为保主进程响应把 8 层递归改成
	// 根层，但没补抽屉那套展开逻辑，导致 @src/xxx 永远匹配不到深层文件）。
	useEffect(() => {
		if (!effectiveProjectId) return;
		const trigger = detectTrigger(draft, cursor, validSessionRefs);
		if (!trigger || trigger.char !== "@") return;
		const dirNode = resolveAtDrillDirectory(trigger.query, files);
		if (!dirNode) return;
		const directoryKey = fileTreeNodeKey(dirNode);
		if (Array.isArray(dirNode.children) || loadingDirPathsRef.current.has(directoryKey)) return;
		if (!dirNode.target && !dirNode.path) return;
		let current = true;
		loadingDirPathsRef.current.add(directoryKey);
		const listTarget = dirNode.target ?? effectiveProjectId;
		const listOptions = dirNode.target ? { maxDepth: 0, skipGeneratedDirs: true } : { maxDepth: 0, directory: dirNode.path, skipGeneratedDirs: true };
		void desktopApi.files
			.list(listTarget, listOptions)
			.then((children) => {
				if (!current) return;
				setFiles((prev) => mergeFileTreeChildren(prev, directoryKey, children));
				loadedDirPathsRef.current.add(directoryKey);
			})
			.catch(() => {
				// 目录被删/权限不足：保留已加载部分，下次输入自然重试
			})
			.finally(() => {
				loadingDirPathsRef.current.delete(directoryKey);
			});
		return () => {
			current = false;
		};
	}, [cursor, draft, effectiveProjectId, files, validSessionRefs]);

	// @ 纯文件名搜索走已有 Go 索引/有界 BFS；纯名查询延迟合并连续输入，目录下钻仍按需加载。
	useEffect(() => {
		setAtFileNameSearch(null);
		if (!effectiveProjectId || atFileQuery === null) return;
		const projectId = effectiveProjectId;
		const query = atFileQuery;
		let current = true;
		const timer = window.setTimeout(() => {
			// files:search（旧形状）已下线：公共搜索页本机/远端同形，results 就是文件名命中。
			void loadAtFileNameSearch(projectId, query, async (id, text) => {
				const page = await desktopApi.files.searchPage(id, text);
				return page.ok ? page.value.results : [];
			})
				.then((snapshot) => {
					if (current) setAtFileNameSearch(snapshot);
				})
				.catch(() => {
					if (current) setAtFileNameSearch({ projectId, query, files: [] });
				});
		}, 150);
		return () => {
			current = false;
			window.clearTimeout(timer);
		};
	}, [atFileQuery, effectiveProjectId]);
	const suggestionAnchorStyle = useMemo<CSSProperties | undefined>(() => {
		if (!suggestionsOpen) return undefined;
		const menuWidth = Math.min(520, window.innerWidth - 120);
		const menuHeight = 380;
		const gap = 8;
		// 兜底定位（原 CSS .command-palette 的「默认居中 + 底部 160px」语义收进 JS）：
		// 拿不到编辑器/光标坐标时，面板仍然有确定位置，CSS 不再承载任何定位假设。
		const fallback: CSSProperties = {
			top: "auto",
			bottom: 160,
			left: Math.max(16, (window.innerWidth - menuWidth) / 2),
		};
		const root = editorRef.current;
		if (!root) return fallback;
		const coordinates = getComposerCaretCoords(root, cursor);
		if (!coordinates) return fallback;
		let left = coordinates.left;
		if (left + menuWidth > window.innerWidth - 16) {
			left = Math.max(16, window.innerWidth - menuWidth - 16);
		}
		const below = coordinates.top + gap;
		if (below + menuHeight <= window.innerHeight - 16) {
			return { top: below, left, bottom: "auto" };
		}
		const above = coordinates.top - gap;
		if (above - menuHeight >= 0) {
			return {
				top: "auto",
				bottom: window.innerHeight - above,
				left,
			};
		}
		return { top: "auto", bottom: 16, left };
	}, [cursor, suggestionsOpen]);

	// 回合边界（isTurnActive）与忙碌态分开算：ACP 的 tab status 可能滞后于回合结算，
	// 预测 ghost 已按 isTurnActive=false 出现时，发送也必须按空闲直发，不能进 followUp 队列。
	const sessionTurnRunning = isSessionTurnRunning(runtime?.state, runtime?.status);
	const isBusy = isSessionRuntimeBusy(runtime?.status, runtime?.state, isAcpBackend ? "acp" : undefined);
	// 预热只创建进程，不能把编辑器 setEditable(false)：contenteditable 关掉会失焦，输入一半就断。
	// 「启动中」只认 activating（用户按下发送后的会话创建期）：预热（prewarm）不算——
	// 预热进程不阻塞输入，用户此时编辑草稿/选模型都是合法的（有意设计，非漏判；
	// 若把预热也当启动，输入框会在后台预热时被无理由锁住）。
	const isStarting = isUserFacingSessionStart(sendState.status);
	// ACP 预热（握手 + 枚举 configOptions）可能持续数秒：编辑器照常可输入，
	// 输入框底栏同时显示初始化指示。**发送不被它拦住**：主进程的激活闸门（ensureRuntime 复用同一条
	// pending activation）会把这一发排到握手之后，用户不用先等选项落地再按发送。
	const isAcpInitializing = isAcpComposerInitializing(isAcpBackend, runtime?.status);
	const hasContent = Boolean(draft.trim() || attachments.length || pasteFiles.length);

	const resetEphemeralUi = useCallback(() => {
		setHistoryIndex(-1);
		setSavedDraft("");
		setSuggestionsOpen(false);
		setBusyDraftLocked(false);
		liveDomDraftRef.current = { sessionId, value: "" };
	}, [sessionId]);

	/**
	 * 发送前补齐模板表：`/名称` 命中未知模板、或命中的缓存正文为空时补拉一次。
	 *
	 * 兜三类时机：runtime 刚绑定（模板表还没拉回来）、**草稿会话的第一条消息**
	 * （此刻还没有 runtime target，但项目的 standby 池能给出同一份清单），
	 * 以及**在设置页新建/编辑模板后**（模板表是会话级缓存，不会自动回灌；
	 * 旧缓存里正文还是空的，不补拉就会误报“模板正文为空”，#518）。
	 * 补充失败保持原样，交给 pi 兜底展开。
	 */
	const ensureTemplatesForMessage = useCallback(
		async (message: string) => {
			const match = /^\/([^\s]+)/.exec(message.trim());
			if (!match) return;
			const name = match[1];
			// 后端接管的命令（DSH host / pi 扩展 / 技能）永远不在模板表里：补拉只会白跑三趟
			// IPC，而且它本来就不该被展开。
			if (!needsTemplateRefetch(name, templatesRef.current, reservedCommandNamesRef.current)) return;
			// 来源 A（prompts:list）不依赖 runtime/项目，因此不再按这两者早退：
			// 否则不给项目开池的会话里新加/新改的全局模板永远补不进来。
			// 补齐失败不影响发送本身（loadTemplates 内部各来源已各自兜错，这里再兜一层）
			await loadTemplates().catch(() => undefined);
		},
		[loadTemplates],
	);

	const resolveSessionReferences = useCallback(
		async (message: string) => {
			// 展开与保护区判定收口在 sending/outgoingExpansion（纯函数、可单测）：
			// 引用块内的 `&会话名` 属于被引述的原文，不能当成真引用展开。
			const targets = projectSessions.map((session) => ({ id: session.id, name: session.name ?? session.filePath }));
			return await expandSessionReferences(message, targets, async (session) => {
				const saved = sessionReferenceSelections[`&${session.name}`];
				const selectedMessages = saved ? selectedSessionReferenceMessages(saved) : await desktopApi.sessions.readReferenceMessages(session.id);
				// 取文口径与预算统一收口在 shared/sessionReferenceContext：thinking 不进引用上下文，
				// 超出预算时保留最近的消息并提示用户。这段正文会写进用户消息落盘，之后每轮请求
				// 都随历史重传，所以必须在这里一次性封顶，不能交给上游上下文水位兜底。
				const context = buildSessionReferenceContext(selectedMessages);
				if (context.dropped > 0) {
					const params = { kept: context.kept, dropped: context.dropped };
					showNotice(t("sessionRef.truncated", params), 6000);
					// 块内留一行说明：模型要知道这是「最近一段」而不是完整会话，否则会答“我没看到那条”。
					return `${t("sessionRef.truncatedNote", params)}\n${context.body}`;
				}
				return context.body;
			});
		},
		[projectSessions, sessionReferenceSelections],
	);

	/**
	 * 手动压缩唯一入口：圆环按钮与 /compact 共用。
	 * 不再设占用门槛（数据可用即可压，低占用时 pi 自行判定 nothing-to-do/too-small）；
	 * 压缩中拒绝重复点击；成功弹完成。
	 */
	const runManualCompact = useCallback(
		async (target: { sessionId: string; agentId: string; runtimeGeneration: number }, prompt?: string) => {
			const live = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
			const compacting = live?.state?.isCompacting === true;
			if (compacting) {
				showNotice(t("app.compactInProgress"), 4000);
				return;
			}
			try {
				requireSessionCommand(await desktopApi.sessions.compactRuntime(target, prompt));
				showNotice(t("app.compactDone"), 4000);
			} catch (error) {
				const notice = friendlyCompactError(error);
				if (notice) showNotice(notice.text, notice.durationMs);
			}
		},
		[sessionId, store],
	);

	const send = useSessionSend({
		sessionId,
		sendPrompt: (input) => desktopApi.sessions.sendPrompt(input),
		// 引导页首次发送：把本页当前后端选择（含 ACP 工具）带给创建链路，
		// 不再依赖 localStorage 的「上次选择」；非引导页会话直接透传。
		ensureSessionId: ensureSessionId
			? (id) =>
					ensureSessionId(
						id,
						isGuideBootstrapSession
							? resolveNewSessionTarget({
									requested: guideBackendOverride,
									requestedAcpToolId: guideAcpToolOverride,
									defaultBackend: defaultAgentBackend,
									dshAvailable: store.get(dshRuntimeStatusAtom).state === "installed",
									acpEnabled: store.get(acpEnabledAtom),
									acpTools: store.get(acpToolsAtom),
								})
							: undefined,
					)
			: undefined,
		getTemplates: () => templatesRef.current,
		getReservedCommandNames: () => reservedCommandNamesRef.current,
		ensureTemplates: ensureTemplatesForMessage,
		prepareMessage: async (message) => {
			// 模板表可能在 runtime 刚绑定/首次加载完成前是空的：命中未知 `/名称` 时补拉一次，
			// 否则这条消息会退回「交给 pi 展开」，模板名不进会话文件（chip 随之丢失）。
			await ensureTemplatesForMessage(message);
			const resolved = await resolveSessionReferences(message);
			// 条上暂停后 composer 仍可能停在目标模式：发送前先 resume，否则 host 不会续轮。
			if (isDshBackend && mode === "goal") {
				const phase = runtime?.state?.goal?.phase;
				if (runtime?.agentId && (phase === "paused" || phase === "blocked")) {
					try {
						await desktopApi.sessions.runDshGoalAction(runtime.agentId, "resume");
					} catch (error) {
						showNotice(error instanceof Error ? error.message : String(error), 4000);
					}
				}
			}
			return resolved;
		},
		onDraftMutation: markDraftMutation,
		createNewSession: options.onCreateSession,
		openProviderLogin: options.onProviderLogin,
		reloadResources: options.onReloadResources,
		compact: async (target, prompt) => {
			await runManualCompact(target, prompt);
		},
		resetComposerUi: resetEphemeralUi,
		recordPromptHistory: (targetSessionId, message) => {
			if (!message.trim() || message.startsWith("!")) return;
			const normalized = message.trim();
			const previous = promptHistoryRef.current[targetSessionId] ?? [];
			promptHistoryRef.current[targetSessionId] = [normalized, ...previous.filter((item) => item !== normalized)].slice(0, 50);
			markPromptHistorySessionAccess(promptHistoryRef.current, targetSessionId);
		},
		showError: (message, duration) => showNotice(message, duration),
		showUnknown: (message) => showNotice(message ?? t("app.queuedUnknown"), 6000),
		// ACP 首启失败回收：激活从未成功（draft + 拒收）的 acp 会话没有任何可恢复内容
		// （agent 侧会话未建、无消息），删除后把回填的草稿搬回引导页，不留在历史列表。
		pruneFailedAcpDraft: async (failedSessionId) => {
			const failed = store.get(sessionRecordsAtom)[failedSessionId];
			if (!failed || failed.backend !== "acp" || failed.status !== "draft") return false;
			// 先搬草稿（restoreRejectedPrompt 已把输入回填到该会话 composer），再删会话——
			// 反序会让 promote 读不到源会话状态，用户输入丢失。
			store.set(promoteSessionComposerStateAtom, { fromSessionId: failedSessionId, toSessionId: GUIDE_BOOTSTRAP_SESSION_ID });
			await desktopApi.sessions.deleteRecord(failedSessionId).catch(() => undefined);
			// 先清空选中再删会话：被回收的会话记录消失后，仍指向它的 currentSessionId
			// 会让 App 给一个查不到记录的会话挂真实面板（面板里 session=undefined →
			// 渲染「开始新的 Session」空态）。目标状态必须是「没有当前会话」——引导页
			// 就是 currentSessionId 为 undefined，不能写 GUIDE_BOOTSTRAP_SESSION_ID：
			// 它只是引导页输入框的虚拟会话 id，同样没有 catalog 记录，写进去看到的
			// 依旧是那个空态面板、回填的草稿也不可见（2026-10 用户反馈：acp 首启
			// 失败后「跳到了这个页面」）。先设好再 remove：removeSessionStateAtom
			// 发现删的不是当前会话就不会二次改写，不会闪。
			if (store.get(currentSessionIdAtom) === failedSessionId) {
				store.set(currentSessionIdAtom, undefined);
			}
			store.set(removeSessionStateAtom, failedSessionId);
			return true;
		},
		enqueue,
	});

	// 并行发送（拆分菜单「并行发送」）：把当前草稿文本送进独立 Ask 会话后台处理，不打断当前会话。
	// useAskPanel 内部用全局 atom 管会话/胶囊状态，会话各处共享同一实例，重复调用安全。
	const askPanel = useAskPanel();
	// 生图 / 生视频提交（占位消息上屏、门禁、结果回填）：独立后端链路，整域搬进子 hook。
	const { persistImageGenSelection, generateImage, submitVideo, confirmVideoGen, cancelVideoGen, generatingImage, submittingVideo, videoConfirmPending } = useComposerGeneration({
		sessionId,
		draft,
		attachments,
		record,
		imageGenSize,
		imageGenWatermark,
		imageGenOutputFormat,
		setDraft,
		setAttachments,
	});

	// 发送入口 + 键盘接管（Enter/历史回溯/@ 补全/ghost 采纳）：谁能触发发送的唯一判定点。
	const { promoteAndSend, selectSuggestion, closeSuggestions, onChange, suggestionRef, onKeyDown } = useComposerSendInteraction({
		sessionId,
		draft,
		setDraft,
		cursor,
		setCursor,
		editorRef,
		liveDomDraftRef,
		caretRef,
		validSessionRefs,
		suggestionItems,
		suggestionsOpen,
		setSuggestionsOpen,
		selectedSuggestionIndex,
		setSelectedSuggestionIndex,
		historyIndex,
		setHistoryIndex,
		savedDraft,
		setSavedDraft,
		getPromptHistory,
		mode,
		isBusy,
		isAcpBackend,
		sendShortcut,
		pasteFiles,
		setPasteFiles,
		send,
		onPromoteSession: options.onPromoteSession,
		generateImage,
		submitVideo,
	});

	// 草稿写入与辅助生成（光标处插入、图片附件、语音、增强、输入预测）。
	const { addImageFiles, insertRefTexts, insertFilePathRefs, insertPlainTextAtCursor, voice, enhance, suggestion } = useComposerDraftAssist({
		sessionId,
		draft,
		setDraft,
		cursor,
		setCursor,
		editorRef,
		liveDomDraftRef,
		caretRef,
		suggestionRef,
		setAttachments,
		record,
		isDshBackend,
		dshDefault,
		bootstrapDefaults,
		sessionTurnRunning,
		hasContent,
	});

	// 粘贴 / 拖拽 / 附件栏 chip。
	const { pasteFromClipboard, onPaste, onDrop, attachFile, attachReferenceImages, removePasteFile, clearPasteFiles, onChipClick } = useComposerPaste({
		composerProject,
		pasteFiles,
		setPasteFiles,
		imageGenComposer,
		projectSessions,
		setSessionReference,
		addImageFiles,
		insertRefTexts,
		insertFilePathRefs,
		insertPlainTextAtCursor,
	});

	useEffect(() => {
		if (!hasContent) {
			setBusyDraftLocked(false);
		} else if (isBusy) {
			setBusyDraftLocked(true);
		}
	}, [hasContent, isBusy, sessionId]);

	const abort = useCallback(async () => {
		const target = toSessionRuntimeTarget(sessionId, runtime);
		if (!target) {
			// 运行时信息缺失（如 agent 尚未绑定）：停止无意义，但不应静默——
			// 提示用户当前会话没有可停止的 Agent，避免「点了停止没反应」的困惑。
			showNotice(t("sessionCommand.runtimeUnavailable"), 4000);
			return;
		}
		try {
			// 用户意图先落地（先于 IPC）：与 useSessionRunControl.abortAgent 同口径——
			// abort 结算后队列不得自动续发；会话再次变忙时由 useQueuedPrompt 自动解除。
			suppressQueuedDrain?.(sessionId);
			requireSessionCommand(await desktopApi.sessions.abortRuntime(target));
		} catch (error) {
			// abort 失败必须可见：之前这里直接 throw 变成未处理 rejection，
			// 用户点停止后毫无反馈、agent 继续运行，表现为「停止不了」。
			// 异常常驻提示，直到用户手动关闭。
			showNotice(error instanceof Error ? error.message : String(error), Number.POSITIVE_INFINITY);
		}
	}, [runtime?.agentId, runtime?.runtimeGeneration, sessionId, suppressQueuedDrain]);

	const acknowledgeUnknownDelivery = useCallback(() => {
		setSendStateAtom({ sessionId, state: { status: "idle" } });
	}, [sessionId, setSendStateAtom]);

	const upsertSession = useSetAtom(upsertSessionAtom);

	/**
	 * 切换后端（pi ↔ dsh ↔ imagegen/videogen/acp）：仅「未开始对话」期可用。
	 * 锁定判据是「会话已有真实内容」——catalog 抬 active（= 已发出第一条消息并落盘，
	 * dsh/acp 由 prompt dispatch 显式 promoteToActive，pi/imagegen 由首次落盘触发）
	 * 或消息缓存里已出现用户消息（覆盖落盘前的窗口）。
	 * 一旦有内容即锁定：pi 会话文件（JSONL）、DSH host session log、生图/生视频历史
	 * 格式互不相同，中途切换会导致时间线消息来源混乱、同步渲染不可靠。
	 * 不再看 runtime 绑定：预热/认领出来的进程还没产生任何消息，此时切换是安全的
	 * （旧实现把「Agent 已启动」当锁定条件，导致新建会话一切到生图/生视频就永久锁死，
	 * 连生视频模式都无法退出）。
	 */
	const hasUserMessage = (messageCache?.messages ?? []).some((message) => message.role === "user");
	const backendLocked = record?.status === "active" || hasUserMessage;
	const changeBackend = useCallback(
		async (next: AgentBackend, explicitAcpToolId?: string) => {
			// 远端项目固定 pi；选择器已经隐藏，这里再挡一次键盘/程序化切换。
			if (isRemoteProjectSession) return;
			if (backendLocked) return;
			// 引导页虚拟会话（无 catalog record）：与 pickModel/pickThinking 的引导页
			// 分支同构——显式选择写 localStorage 偏好并本地即时回显，不走 IPC。
			// 直接 updateRecord("renderer:guide-bootstrap") 在主进程必然查不到会话，
			// 报「会话不存在，请刷新会话列表后重试」（2026-09 用户反馈的新建页切 DSH 报错）。
			// 首次发送时 App.ensureSessionForSend 读取同一份偏好创建真实会话，选择不丢失。
			if (isGuideBootstrapSession) {
				// acp 偏好携带工具 id（"acp:<toolId>"）；工具表为空/未选时不切也不存
				let guideToolId: string | undefined;
				if (next === "acp") {
					const tools = store.get(acpToolsAtom);
					const toolId = explicitAcpToolId ?? tools[0]?.id;
					if (!toolId) {
						showNotice(t("app.acpNoTools"), 4000);
						return;
					}
					guideToolId = toolId;
				}
				// ACP 与其它后端不同：configOptions（模型/模式枚举）只能由 runtime 握手
				// （session/new/load）产出，而引导页是 renderer-only 虚拟会话，activateRuntime
				// 必然查不到 catalog 记录。只写本地偏好的话，用户在选择 ACP 后永远看不到
				// 参数加载、ACP 进程也不会启动，必须等到首次发送（2026-10 用户反馈：
				// 导入新目录后选 ACP 不自动加载/启动）。选择 ACP 即用户意图：立刻落成真实
				// draft 并切过去，与项目「+」/Tab「+」的 createAcp 同一条创建链；composer
				// 状态（草稿/附件/模式）由 App.ensureSessionForSend 整体提升，不丢输入。
				if (next === "acp" && ensureSessionIdRef.current) {
					try {
						await ensureSessionIdRef.current(GUIDE_BOOTSTRAP_SESSION_ID, { backend: "acp", acpToolId: guideToolId });
					} catch (error) {
						showNotice(error instanceof Error ? error.message : String(error), 4000);
					}
					return;
				}
				setGuideBackendOverride(next);
				// acp→acp 换工具：后端同值不触发重渲染，工具 id 单独 set（见 state 声明处注释）
				if (guideToolId) setGuideAcpToolOverride(guideToolId);
				return;
			}
			// 未开始对话的会话允许换后端：先把预热/认领出来的 runtime 停掉再改 record。
			// 停掉没人用的进程正是用户诉求——否则预热出来的 pi 进程会一直挂到会话被删。
			// 预热中的 ACP 握手在这拿不到 agentId（合成 starting 事件不带），靠主进程的
			// cancelActivation 作废（停进程 + 禁 bind），所以这里停不掉也不拦。
			const boundAgentId = runtime?.agentId;
			if (boundAgentId) {
				try {
					await desktopApi.system.stopAgent(boundAgentId);
				} catch {
					// 忽略：主进程仍会以「后端已锁定」拒绝本次变更，用户能看到明确原因
				}
			}
			try {
				// ACP：切换时必须带上工具预选（激活链 spawn 按工具表取命令行），
				// 默认沿用会话已选或登记表第一项；工具表为空（开关刚被关）不切换。
				let acpToolId: string | undefined;
				if (next === "acp") {
					const tools = store.get(acpToolsAtom);
					// picker 两页式弹层内选定的工具优先；否则沿用会话已选 ?? 登记表第一项
					acpToolId = explicitAcpToolId ?? record?.acpToolId ?? tools[0]?.id;
					if (!acpToolId) {
						showNotice(t("app.acpNoTools"), 4000);
						return;
					}
				}
				// 切回 pi 时按 pi 配置重新解析默认模型/思考档位（与 createDraft 缺省填充
				// 同一解析器 launchDefaults），而不是直接清空——否则用户 pi 配置里的
				// defaultProvider/defaultModel 不会出现在切回后的会话（底栏回退残留 DSH 默认）。
				// dsh/imagegen/acp 后端模型由各自部署默认决定，record 保持清空。
				const resolved = next === "pi" ? await desktopApi.sessions.resolveLaunchDefaults({ backend: "pi" }).catch(() => undefined) : undefined;
				const defaults = resolveBackendSwitchDefaults(next, resolved);
				const updated = await desktopApi.sessions.updateRecord(sessionId, {
					backend: next,
					model: defaults.model,
					thinkingLevel: defaults.thinkingLevel,
					...(next === "acp" && acpToolId ? { acpToolId } : {}),
				});
				upsertSession(updated);
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error), 4000);
			}
		},
		[backendLocked, isGuideBootstrapSession, isRemoteProjectSession, record, runtime?.agentId, sessionId, store, upsertSession],
	);

	/**
	 * ACP 工具二级选择（仅草稿期；激活后工具即固定，UI 不再渲染选择器）：
	 * 写 record.acpToolId，激活链据此从工具表取命令行 spawn。
	 */
	const changeAcpTool = useCallback(
		async (toolId: string) => {
			if (backendLocked || record?.backend !== "acp") return;
			try {
				const updated = await desktopApi.sessions.updateRecord(sessionId, { acpToolId: toolId });
				upsertSession(updated);
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error), 4000);
			}
		},
		[backendLocked, record?.backend, sessionId, upsertSession],
	);

	const compact = useCallback(async () => {
		const target = toSessionRuntimeTarget(sessionId, runtime);
		if (!target) {
			// No Agent yet: write /compact to draft and send → starts Agent + compacts
			setDraft("/compact");
			caretRef.current = { pos: "/compact".length, forValue: "/compact" };
			void promoteAndSend();
			return;
		}
		await runManualCompact(target);
	}, [runtime?.agentId, runtime?.runtimeGeneration, sessionId, setDraft, promoteAndSend, runManualCompact]);

	const openPicker = useCallback(
		(kind: ComposerPickerKind) => {
			if (kind === "template") void loadTemplates();
			setPicker(kind);
		},
		[loadTemplates],
	);

	const insertTemplate = useCallback(
		(template: PromptTemplateInfo) => {
			const next = appendSlashCommandToDraft(draft, template.name);
			liveDomDraftRef.current = { sessionId, value: next };
			setDraft(next);
			caretRef.current = { pos: next.length, forValue: next };
			setPicker(null);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[draft, sessionId, setDraft],
	);

	// 技能选择器选中后插入技能斜杠命令到草稿尾（与 insertTemplate 同构）：
	// pi 用 /skill:名称（裸 /名称 pi 当未知命令拒绝——斜线命令与技能冲突的根因），
	// DSH 由宿主把裸 /名称注册成技能命令；插入后光标落末尾，回车即可发送。
	const insertSkillInvocation = useCallback(
		(name: string) => {
			const token = toSkillInvocationToken(isDshBackend ? "dsh" : "pi", name);
			const next = appendSlashCommandToDraft(draft, token);
			liveDomDraftRef.current = { sessionId, value: next };
			setDraft(next);
			caretRef.current = { pos: next.length, forValue: next };
			setPicker(null);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[draft, isDshBackend, sessionId, setDraft],
	);

	// 「一键插入全文」：选择器条目上的插入按钮把提示词/技能正文整段塞进草稿
	// （不是斜线命令形态），便于用户直接编辑或原文发送；与斜线插入是并列入口。
	// 插入内容先剥离 YAML frontmatter「描述头」（name/description 元数据是给选择器用的，
	// 不该出现在输入框里）——预览详情仍显示原文件，只有插入动作做剥离。
	const insertTemplateContent = useCallback(
		(template: PromptTemplateInfo) => {
			const next = appendContentToDraft(draft, stripMarkdownFrontmatter(template.content));
			liveDomDraftRef.current = { sessionId, value: next };
			setDraft(next);
			caretRef.current = { pos: next.length, forValue: next };
			setPicker(null);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[draft, sessionId, setDraft],
	);

	const insertSkillContent = useCallback(
		(content: string) => {
			const next = appendContentToDraft(draft, stripMarkdownFrontmatter(content));
			liveDomDraftRef.current = { sessionId, value: next };
			setDraft(next);
			caretRef.current = { pos: next.length, forValue: next };
			setPicker(null);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[draft, sessionId, setDraft],
	);

	// 快捷消息插入：把条目原文追加到草稿尾（与 insertSkillContent 同构），
	// 但刻意不剥 frontmatter——用户写下的条目正文就该原样进输入框，
	// 不能被当成「提示词模板头」处理（否则以 --- 开头的条目会被吃掉一段）。
	const insertQuickMessage = useCallback(
		(text: string) => {
			const next = appendContentToDraft(draft, text.trim());
			liveDomDraftRef.current = { sessionId, value: next };
			setDraft(next);
			caretRef.current = { pos: next.length, forValue: next };
			setPicker(null);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
		[draft, sessionId, setDraft],
	);

	return {
		sessionId,
		record,
		runtime,
		/** 模型目录路由用的项目：有 record 用 record.projectId，引导页/草稿用选中项目。
		 *  远端项目靠它把 `sessions:list-models` 路由到那台主机上的 pi（不是本机目录）。 */
		catalogProjectId: effectiveProjectId,
		// 引导页优先回显本页手动切换，否则就是设置默认后端（不沿用上次选择）；
		// 真实会话以 record 为准。
		backend: isRemoteProjectSession ? "pi" : (record?.backend ?? (isGuideBootstrapSession ? guideBackend : undefined) ?? "pi"),
		/** 草稿期可切换后端；激活后锁定、远端项目固定 pi（undefined → UI 隐藏切换器）。 */
		changeBackend: backendLocked || isRemoteProjectSession ? undefined : changeBackend,
		/** 远端项目固定 pi：底栏据此显示准确的锁定原因（不是「已发送消息后不可切换」）。 */
		backendFixedToPi: isRemoteProjectSession,
		// ACP 工具二级选择（草稿期；激活后 UI 不再渲染选择器）
		acpTool:
			record?.backend === "acp"
				? { toolId: record.acpToolId, onChange: backendLocked ? undefined : changeAcpTool }
				: // 引导页（无 record）：工具 id 从 localStorage 偏好读，picker 组内高亮当前工具
					isGuideBootstrapSession && guideBackendOverride === "acp"
					? { toolId: guideAcpToolOverride, onChange: backendLocked ? undefined : changeAcpTool }
					: undefined,
		// ACP 会话的 composer 占位符展示工具名（「发送给 Codex CLI…」）：激活后取 runtime 的
		// modelName（即工具名），草稿期用 record.acpToolId 在已登记工具表里查；非 ACP 为空。
		acpToolName:
			record?.backend === "acp" && record.acpToolId
				? (store.get(acpToolsAtom).find((candidate) => candidate.id === record.acpToolId)?.name ?? runtime?.state?.modelName)
				: isGuideBootstrapSession && guideBackendOverride === "acp" && guideAcpToolOverride
					? store.get(acpToolsAtom).find((candidate) => candidate.id === guideAcpToolOverride)?.name
					: undefined,
		/** DSH 部署默认模型（settings.yaml agent-default-model）；仅 dsh 后端时展示，
		 *  离开 dsh 时清空（否则残留值会随 defaultModel 泄漏到 pi 会话底栏）。 */
		dshDefaultModel: isDshBackend && dshDefault ? { provider: dshDefault.provider, modelId: dshDefault.model, modelName: dshDefault.model } : undefined,
		/** DSH 部署默认思考档位：settings.yaml 的 reasoningEffort 优先，缺省用模型自身 defaultEffort。 */
		dshDefaultThinkingLevel: isDshBackend ? (dshDefault?.reasoningEffort ?? dshDefault?.defaultEffort) : undefined,
		/** 引导页（无 record）预选默认：主进程按 pi 配置/模型目录解析（显式默认 > 切换列表 > 上次使用），展示用。
		 *  注：该 IPC 不传 welcomeModel（偏好只存在于渲染层 localStorage），引导页点选由
		 *  resolveGuideDisplayModel 在本值之上叠加，次序与主进程 resolveLaunchDefaultOptions 一致。 */
		bootstrapDefaultModel: bootstrapDefaults?.model,
		bootstrapDefaultThinkingLevel: bootstrapDefaults?.thinkingLevel,
		/** 每模型默认思考档位表（pi settings.modelThinkingLevels）：引导页改选模型后，
		 *  底栏/选择器按当前展示的模型反查，与 createDraft 按最终模型查表同序。
		 *  非 DSH 后端才会带上（主进程已按后端裁剪）。 */
		bootstrapModelThinkingLevels: bootstrapDefaults?.modelThinkingLevels,
		draft,
		attachments,
		mode,
		sendState,
		templates,
		picker,
		previewImage,
		sessionReference,
		sessionReferenceSelection: sessionReference ? sessionReferenceSelections[`&${sessionReference.name ?? sessionReference.filePath}`] : undefined,
		bangMode: getBangMode(draft),
		isBusy,
		isStarting,
		isAcpInitializing,
		hasContent,
		busyDraftLocked,
		voice,
		enhance,
		// 输入预测只对外暴露渲染所需的两个字段：文本与可见性（采纳/忽略走 keydown 内部）。
		suggestion: { text: suggestion.text, visible: suggestion.visible },
		editor: {
			ref: editorRef,
			caretRef,
			cursor,
			validCommandNames,
			validFilePaths,
			validSessionRefs,
			validQuotes,
			onChange,
			onCursorChange: setCursor,
			onKeyDown,
			onPaste,
			onPasteClipboard: pasteFromClipboard,
			onDrop,
			onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
				// 会话 Tab / 侧栏分屏拖拽交给 SessionSplitStage（capture），composer 不抢落点
				if (event.dataTransfer.types.includes(SESSION_TAB_DRAG_MIME)) return;
				event.preventDefault();
				// 文件树拖拽的 effectAllowed 含 move（内部移动语义），拖入 composer 时
				// 显式声明 copy，避免光标显示为“移动”，实际行为是插入引用
				if (event.dataTransfer.types.includes(PI_FILE_NODE_DRAG_MIME) || event.dataTransfer.types.includes(PI_FILE_PATH_DRAG_MIME)) {
					event.dataTransfer.dropEffect = "copy";
				}
			},
			onFocus: () => setSuggestionsOpen(detectTrigger(draft, cursor, validSessionRefs) !== null),
			onBlur: () => setSuggestionsOpen(false),
			onChipClick,
			attachFile,
			attachReferenceImages,
		},
		suggestions: {
			open: suggestionsOpen,
			items: suggestionItems,
			selectedIndex: selectedSuggestionIndex,
			anchorStyle: suggestionAnchorStyle,
			setSelectedIndex: setSelectedSuggestionIndex,
			close: closeSuggestions,
			pick: selectSuggestion,
		},
		images: {
			preview: setPreviewImage,
			add: (image: ImageContent) => setAttachments((current) => [...current, image]),
			remove: (index: number) => setAttachments((current) => current.filter((_, item) => item !== index)),
			clear: () => setAttachments([]),
		},
		pasteFiles: {
			files: pasteFiles,
			remove: removePasteFile,
			clear: clearPasteFiles,
		},
		delivery: {
			// 发送/追问都算主动交互：先把预览 Tab 晋升常驻，再投递（幂等，非预览无副作用）。
			// 忙碌时按「忙碌时投递行为」设置决定语义（pi/dsh 统一，不再按后端分叉）；
			// 空闲直发。排队项的插入/排队切换走输入框上方队列面板的行内按钮。
			send: () => {
				void promoteAndSend(resolveBusySendDelivery(isBusy, store.get(busySendDeliveryAtom), isAcpBackend ? "acp" : undefined));
			},
			// 拆分菜单（发送钮右侧 caret）：把「加入当前回合 / 排队到下一轮 / 并行发送」前置到发送现场。
			// 主钮仍走「忙碌时投递行为」设置；这三项是显式覆盖，不受设置影响。
			// steer = 立刻插队进当前回合（仅忙碌时有意义）；followUp = 排队到下一轮再排空。
			// ACP 无 steer 通道：置 undefined → 菜单项隐藏（ComposerPanels 按 truthy 渲染该项）。
			sendSteer: isAcpBackend
				? undefined
				: () => {
						void promoteAndSend("steer");
					},
			sendFollowUp: () => {
				void promoteAndSend("followUp");
			},
			/**
			 * 快捷消息直发：正文来自弹框清单而非草稿，其余语义与普通发送一致
			 * （预览 Tab 晋升、忙碌时按「忙碌时投递行为」设置决定 steer / 排队）。
			 * 草稿与附件的隔离由 useSessionSend 的 overrideText 契约保证。
			 */
			sendQuickMessage: (text: string) => {
				const trimmed = text.trim();
				if (!trimmed) return;
				void promoteAndSend(resolveBusySendDelivery(isBusy, store.get(busySendDeliveryAtom), isAcpBackend ? "acp" : undefined), trimmed);
			},
			/**
			 * 快捷消息直发可用性：与 canSend 同源，但去掉「草稿非空」这一项——
			 * 快捷消息的正文来自清单，发它的时候输入框通常是空的。
			 * submittingVideo 与 canSend 一致纳入（Wave 4 状态统一）：视频提交中任何发送入口都应锁。
			 */
			canSendQuickMessage: !isStarting && !generatingImage && !submittingVideo && (!isDshBackend || runtime?.state?.modelRoutable !== false),
			// 并行发送（拆分菜单）：当前草稿文本进独立 Ask 会话后台处理，成功后清空草稿。
			// 上下文由 useAskPanel 按 originSessionId 自动生成（与队列面板共用同一口径），
			// 这里只负责把来源会话传下去；不要在本入口另建一份 context，否则会再次分叉。
			// 仅投递纯文本：并行问询不支持图片附件（与队列面板 onSendAsk 的 canAsk 判据一致），
			// 带图时 ComposerSendControls 端按 canSendParallel=false 置灰。
			// 不查 modelRoutable（并行走 Ask 会话独立后端，不吃当前 DSH 绑定）；
			// submittingVideo 纳入（Wave 4 状态统一）：视频提交中任何发送入口都应锁。
			canSendParallel: Boolean(draft.trim()) && attachments.length === 0 && !isStarting && !generatingImage && !submittingVideo && Boolean(effectiveProjectId),
			sendParallel: () => {
				const text = draft.trim();
				if (!text || !effectiveProjectId) return;
				void askPanel.sendToAsk(effectiveProjectId, text, { originSessionId: sessionId }).then((ok) => {
					// 并行会话已接管这条问题：成功后清空当前草稿，避免用户重复发送同一句。
					if (ok) setDraft("");
				});
			},
			abort: () => void abort(),
			compact: () => void compact(),
			// 上下文超限失败时，即使 contextPercent 缺失，仍保留当前绑定作为压缩恢复目标。
			overflowRecoveryTarget: runtime?.state?.contextOverflow ? toSessionRuntimeTarget(sessionId, runtime) : undefined,
			onOverflowRecovery: (target: SessionRuntimeTarget) => void runManualCompact(target),
			imageGenConfig,
			imageGenProviderId: activeImageGenProviderId,
			imageGenModelId: activeImageGenModelId,
			imageGenSize,
			imageGenWatermark,
			imageGenOutputFormat,
			imageGenModeLocked: hasImageGenHistory || record?.backend === "imagegen",
			videoGenConfig,
			videoGenModeLocked: isVideoGenBackend,
			submittingVideo,
			submitVideo,
			videoConfirmPending,
			confirmVideoGen,
			cancelVideoGen,
			setVideoGenSelection: (providerId: string, modelId: string) => {
				const nextProvider = findVideoGenProvider(videoGenConfig, providerId);
				if (!nextProvider?.models.includes(modelId)) return;
				const next = { ...videoGenConfig, activeProviderId: nextProvider.id, activeModel: modelId, activeParams: { ...nextProvider.defaults } };
				setVideoGenConfig(next);
				void desktopApi.videogen.saveConfig(next).catch(() => undefined);
			},
			setVideoGenParam: (key: "resolution" | "duration" | "ratio", value: string | undefined) => {
				const next = { ...videoGenConfig, activeParams: { ...videoGenConfig.activeParams, [key]: value } };
				setVideoGenConfig(next);
				void desktopApi.videogen.saveConfig(next).catch(() => undefined);
			},
			setImageGenSelection: (providerId: string, modelId: string) => {
				const nextProvider = findImageGenProvider(imageGenConfig, providerId);
				if (!nextProvider?.models.includes(modelId)) return;
				persistImageGenSelection(nextProvider.id, modelId);
			},
			setImageGenSize: (size: string) => {
				const parsed = parseImageGenSize(size);
				if (!parsed) return;
				setImageGenSizeState(parsed);
				void desktopApi.settings.update({ imageGenSize: parsed }).catch(() => undefined);
			},
			setImageGenWatermark: (watermark: boolean) => {
				setImageGenWatermarkState(watermark);
				void desktopApi.settings.update({ imageGenWatermark: watermark }).catch(() => undefined);
			},
			setImageGenOutputFormat: (format: string) => {
				const parsed = parseImageGenOutputFormat(format, null);
				if (!parsed) return;
				setImageGenOutputFormatState(parsed);
				void desktopApi.settings.update({ imageGenOutputFormat: parsed }).catch(() => undefined);
			},
			unknown: sendState.status === "unknown",
			unknownError: sendState.error,
			acknowledgeUnknown: acknowledgeUnknownDelivery,
			// DSH 只在 host 明确报告 routable=false 时锁住发送；undefined 代表尚未确认或目录加载失败。
			canSend: hasContent && !isStarting && !generatingImage && !submittingVideo && (!isDshBackend || runtime?.state?.modelRoutable !== false),
			generatingImage,
		},
		pickers: {
			open: openPicker,
			close: () => setPicker(null),
			setMode,
			insertTemplate,
			insertTemplateContent,
			insertSkillInvocation,
			insertSkillContent,
			insertQuickMessage,
		},
		modals: {
			closePreview: () => setPreviewImage(null),
			closeSessionReference: () => setSessionReference(null),
			confirmSessionReference: (sessionName: string, messages: Array<{ role: string; content: string; timestamp: number }>, selectedIndices: number[]) => {
				setSessionReferenceSelections((current) => ({
					...current,
					[`&${sessionName}`]: createSessionReferenceSelection(selectedIndices, messages),
				}));
				setSessionReference(null);
			},
		},
	};
}

export type SessionComposerController = ReturnType<typeof useSessionComposerController>;
