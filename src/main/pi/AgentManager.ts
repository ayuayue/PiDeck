import { app, shell, type BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type {
	AgentBackend,
	AgentGatewayCapability,
	AgentRuntimeState,
	AgentTab,
	AppSettings,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ForkMessage,
	SessionFactsResult,
	SessionOutlineSnapshot,
	I18nParams,
	ImageContent,
	LocalProject,
	Project,
	RemoteProject,
	RewindCheckpointHealth,
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	SendPromptInput,
	SendPromptResult,
	PiCommand,
	SessionEnvironment,
	SessionBranchTree,
	SessionMessageImageTarget,
	SessionMessagePage,
	SessionRuntimeModelSelection,
	SessionTodoSnapshot,
} from "../../shared/types";
import { agentEventTags, ipcChannels } from "../../shared/ipc";
import { isLocalProject, isRemoteProject } from "../../shared/projectLocation";
import { collectSessionFileChanges } from "../../shared/fileChanges";
import { parseBusySendDelivery } from "../../shared/busySendDelivery";
import { COMPACT_CANCELLED_BY_OWNER, COMPACT_CANCELLED_BY_USER_ABORT, COMPACT_HOOK_REJECT_MAX_MS, COMPACT_OBSERVATION_MAX_AGE_MS, COMPACT_USER_ABORT_WINDOW_MS } from "../../shared/compactFeedback";
import { SessionLocatorRouter } from "../sessions/SessionLocatorRouter";
import { PiProcess, type WhitelistSkip } from "./PiProcess";
import { resolveWhitelistSkipCopy } from "./whitelistSkipNotice";
import { APP_DISPLAY_NAME } from "../utils/appBrand";
import { isMainWindowFocused, shouldAlertNow } from "../notifications/alertFocusGate";
import { resolveNotificationLogoUri } from "../notifications/notificationToast";
import { showAgentToast, type AgentToastDeps } from "../notifications/agentToast";
import type { PiCompactionOwnership } from "./compactionOwner";
import { CompactionRunner } from "./compactionRunner";
import { mergeSubagentSources } from "./derivedSubagents";
import { parseAvailableThinkingLevelsResponse } from "./thinkingLevels";
import { listActiveBuiltInExtensionPaths } from "../extensions/builtInExtensions";
import { createPiProcessExtensionResolvers } from "../extensions/piProcessExtensionResolvers";
import { piVersionAtLeast } from "../extensions/extensionVersionGate";
import { PI_DECK_MODE_MARKER_EXTENSIONS } from "../../shared/composerModeMarkers";
import { resolveLoadableExtensionPaths } from "../extensions/enabledExtensionResolver";
import { collectEntryRendererTypes } from "./extensionEntryRendererScan";
import { resolveBuiltInExtensionsOverlayDir } from "../extensions/builtInExtensions";
import { getModelTraceServer } from "./modelTrace/ModelTraceServer";
import { StandbyAgentPool, STANDBY_TTL_MS } from "./StandbyAgentPool";
import { computeStandbyFingerprint } from "./standbyFingerprint";
import { STANDBY_CLAIM_WAIT_MS, StandbyWarmupTracker } from "./standbyWarmup";
import type { ModelTraceInput } from "../../shared/types/modelTrace";
import { describeExtensionFallbackSkip, formatExtensionFallbackDebug, resolveDisabledExtensionsCopy, resolveDisabledExtensionsReason, shouldRetryWithoutExtensions } from "./extensionStartupFallback";
import type { DisabledExtensionsReason } from "./extensionStartupFallback";
import { StartupDiagnosticsQueue } from "./startupDiagnosticsQueue";
import type { QueuedStartupDiagnostic } from "./startupDiagnosticsQueue";

export type { QueuedStartupDiagnostic };
import { formatExtensionErrorReason } from "./extensionError";
import type { RpcResponse } from "./PiRpcClient";
import { formatBashToolMessage } from "./bashResult";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { remotePiDiscoveryCopyKey } from "../remote/remotePiDiscoveryCopy";
// 会话身份稳定码的可读文案：与探测码同一套路，避免用户只看到一个裸码。
import { remoteSessionCodeCopyKey } from "../remote/remoteSessionCopy";
import { mergeHistoryWithPreservedMessages, stabilizeProjectedIdsFromIdentities, stabilizeReloadedMessageIds } from "./historyMessages";
import { buildAgentSessionKey, type AgentSessionIdentityDefaults } from "./agentSessionIdentity";
// 远端 pi 的会话文件可能是相对 cwd 的（项目级 `sessionDir`）：归一化只允许这一份实现。
import { isAbsoluteRemoteSessionPath, resolveRemoteReportedSessionPath } from "./remoteSessionPath";
import { ReportedSessionPathResolver } from "./agentReportedSessionPath";
import type { PiRuntimeLauncher, RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import { REMOTE_RUNTIME_CODES, type RemoteRuntimePort } from "./remoteRuntimePort";
import type { RemoteSessionRegistration } from "../sessions/SessionCatalog";
import { SessionFileEditor, type SessionEntryTarget, type SessionFileRef } from "./SessionFileEditor";
import { SessionHistoryReader, applySessionContextEdits, boundTurnWindowStart } from "./SessionHistoryReader";
import { createTrajectoryFactsReader, type TrajectoryFactsReader } from "../sessions/trajectoryFactsReader";
import { estimateMessagesPayloadBytes } from "./messagePayloadSize";
import { bindRemoteUserMessageTimestamp } from "./remoteMessageTimestamp";
import { StoppedMessageIdentityCache } from "./stoppedMessageIdentity";
import { currentIndexTree, diffCheckpoints, loadAllCheckpoints, loadCheckpointFromRef, MUTATING_TOOLS, restoreCheckpoint as applyCheckpointRestore, toCheckpointSummary } from "../rewind/index.ts";
import { AgentMessageProjector, buildActiveBranchEntryIds as buildActiveBranchEntryIdsForDisplay } from "./AgentMessageProjector";
import { RewindCheckpointCoordinator } from "./RewindCheckpointCoordinator";
import { LiveStreamChannel } from "./liveStreamChannel";
import { resolveNotificationSessionId } from "./agentUtils";
import { isRoleMessageRole } from "./sessionEntryIds";
import { createStreamGateState, isStreamGateSealed, noteAbortSettled, openStreamGateForNewRun, sealStreamGate, type StreamGateState } from "./streamGate";
import { RpcLiveLogTap } from "./rpcLiveLogTap";
import { MessagePerfTracker } from "./messagePerfTracker";
import { AbortStreamGateController } from "./abortStreamGateController";
import { MessageEmitBatcher } from "./messageEmitBatcher";
import { ToolMessageAssembler } from "./toolMessageAssembler";
import { RuntimeHistoryLoader } from "./runtimeHistoryLoader";
import { RuntimeStateReader, normalizedRuntimeName } from "./runtimeStateReader";
import type { CacheHitStats } from "./cacheHitStats";
import {
	stripAnsi,
	pickNumber,
	clampPercent,
	asRecord,
	nonEmptyString,
	trimHistoryMessages,
	turnTrimStartIndex,
	countRoleMessagesBefore,
	buildMessageFlushPayload,
	leadingSummaryCards,
	stripToolResultForDelivery,
	cleanTitle,
	inferTitleFromMessages,
	isDefaultAgentTitle,
	looksLikePiSessionFileStem,
	shouldReloadMessagesAfterCompaction,
} from "./agentUtils";
import { updateActiveToolCalls, type ActiveToolCallState } from "../../shared/toolRuntimeState";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SecurityStore } from "../security/SecurityStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RpcLogger } from "../logging/RpcLogger";
import { buildModelTraceLogEntry } from "../logging/ModelTrace";
import type { RpcLogEntry } from "../../shared/types/rpcLog";
import type { AppLogger } from "../logging/AppLogger";
import { toWindowsHostPath, toWslLinuxPath, type WslEnvironment } from "../wsl/WslPaths";
import { ProjectTrustGate } from "./projectTrustGate";
import { ExtensionUiGate } from "./extensionUiGate";
import type { ProjectTrustChoice } from "./projectTrustGate";

export type { ProjectTrustChoice };
import { emitAgentMessageMeasured } from "../perf/messageFlushMeter";
import { isContextOverflowError } from "../../shared/contextOverflow";
import { reasoningText } from "../../shared/reasoningText";

/**
 * prompt / steer / follow_up 响应的 disposition 取值（pi CHANGELOG 0.99.0 #9098）。
 * - "started"：已启动一次 agent run；
 * - "queued"：当前有 run 在跑，消息进入队列（prompt 的 streamingBehavior 排队路径）；
 * - "handled"：被扩展命令或 input handler 消费，**没有**启动 run。
 */
export type PromptDisposition = "started" | "queued" | "handled";

/**
 * 从 prompt RPC 成功响应的 data 里读 disposition；老版本 pi 不带该字段 → undefined。
 *
 * 为什么主进程要知道这件事：disposition === "handled" 表示这条 prompt 不会产生
 * agent_start / agent_end，等待 agent_end 恢复 idle 的常规链路永远等不到——必须在
 * 此处改走 scheduleIdleCheckAfterExtensionCommand（pi 的 get_state 兜底）。
 */
function readPromptDisposition(data: unknown): PromptDisposition | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const disposition = Reflect.get(data, "disposition");
	return disposition === "started" || disposition === "queued" || disposition === "handled" ? disposition : undefined;
}

/**
 * pi 的忙碌拒收文案（Issue #371）：pi 侧 isStreaming 为 true 时，prompt 不带
 * streamingBehavior 会被直接拒收。PiDeck 本地状态在 abort 超时后已复位 idle，
 * 只有拿到这条错误才能确认 pi 的真实忙碌——据此补一次带 streamingBehavior 的重发。
 * 与 src/main/ipc/gitIpc.ts 的 GIT_COMMIT_BUSY 判据同款。
 */
function isPiBusyRejection(message: string): boolean {
	return /Agent is already processing/i.test(message);
}

/**
 * PiDeck 自动命名的来源（#266）："auto" = 内置扩展经 marker 校验的模型标题（终态），
 * "fallback" = 首条消息派生的兜底名（可被 auto 升级）。catalog 据此决定是否能领取占位标题。
 */
export type AutomaticTitleSource = "auto" | "fallback";

/** 会话身份 key 只读这些字段（与 `buildAgentSessionKey` 的入参同域；`sessionKeyFor` 追加远端主机限定）。 */
type AgentSessionKeyInput = Pick<CreateAgentInput, "projectId" | "sessionPath" | "environment" | "source" | "wslDistro" | "wslUser" | "importedSourceId">;

export class AgentManager {
	private readonly sessionLocatorRouter = new SessionLocatorRouter();
	/** 本网关的运行时后端身份：pi。 */
	readonly backend: AgentBackend = "pi";
	/** pi 后端支持全部可选能力。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set(["compact", "fork", "getForkMessages", "editMessage", "deleteMessage", "getCommands", "reloadResources", "exportHtml"]);
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly messages = new Map<string, ChatMessage[]>();
	/** 当前正在流式更新文本的 agent（message_start/text_delta/thinking_delta 置位，
	 *  message_end/done/error/agent_end/agent_settled/abort 清除）。
	 *  isStreaming 不再只依赖 pi get_state 轮询：轮询在 text_delta 期间不触发，
	 *  前端 streamingMessageId → MarkdownStream 逐字渐显依赖它，缺失会“整段蹦出”。 */
	private readonly streamingAgents = new Set<string>();

	/** 当前是否有任何 agent 正在流式输出（内存采样探针用，避免直接暴露内部 Set）。 */
	hasActiveStreaming(): boolean {
		return this.runtimeState.hasActiveStreaming();
	}
	/** 当前正在流式更新的 assistant 消息；tool 事件插入时仍要继续更新同一个回答块。 */
	private readonly activeAssistantMessageIds = new Map<string, string>();
	/** pi 的 toolCallId 贯穿 start/update/end，用它把同一次工具调用合并成一条 UI 记录。 */
	private readonly toolMessageIds = new Map<string, Map<string, string>>();
	/** 每个 agent 保留一条「进行中」的自动重试状态消息，避免短暂 5xx/网络错误把会话刷屏；
	 *  一次重试周期（auto_retry_start → auto_retry_end）一张卡，已收敛的卡片不再被改写。
	 *  其中「重试成功」卡由渲染层当瞬态卡隐藏（timelineFailureNotice.isTransientRetryCard）：
	 *  同一轮 run 内多次 5xx 会各收一张成功卡，不退场就会堆成一排。 */
	private readonly retryStatusMessageIds = new Map<string, string>();
	/** 同一历史会话正在创建 Agent 时共享同一个 Promise，避免快速重复点击/IPC 竞态创建多个进程。 */
	private readonly creatingSessionAgents = new Map<string, Promise<AgentTab>>();
	/** 工具 start/end 事件的单调序号，renderer 用它忽略迟到的异步完整状态。 */
	private readonly toolStateSequenceByAgent = new Map<string, number>();
	/** 每个 agent 当前仍在执行的 toolCall；并行工具必须等最后一个结束才发 false 边沿。 */
	private readonly activeToolCallsByAgent = new Map<string, Map<string, string>>();
	/** 记录每个 agent 当前执行的工具名称，无工具时为 null */
	private readonly toolExecutingByAgent = new Map<string, string | null>();
	/** 工具边沿完整 runtime state 补发的尾沿去抖定时器（收口在 RuntimeStateReader，按引用注入）。 */
	private readonly toolEdgeStateTimers = new Map<string, NodeJS.Timeout>();
	private readonly sessionFileEditor: SessionFileEditor;
	private readonly sessionHistoryReader: SessionHistoryReader;
	private readonly trajectoryFacts: TrajectoryFactsReader;
	private readonly messageProjector: AgentMessageProjector;
	/**
	 * agents:message 的节流批处理/增量标记/显示窗口推进收口在 MessageEmitBatcher；
	 * 消息数组本体与窗口数学入口（computeDisplayWindowStart）仍在此。
	 * public：行为测试注入窗口起点/读取待发滑出（agentManagerRuntimeCache H2/M2）。
	 */
	public readonly messageEmit: MessageEmitBatcher;
	/** 工具/assistant 消息装配域（工具卡 upsert + 工具完整文本 LRU + 流式回答块 identity）；
	 *  本类只保留 messages 列表所有权与生命周期清理入口。 */
	private readonly toolMessages: ToolMessageAssembler;
	/** 历史窗口加载域（loadMessages / 缓存优先翻页 / 压缩后单飞重载）；本类只保留生命周期与编排。 */
	private readonly historyLoader: RuntimeHistoryLoader;
	/** 手动压缩域（compact 请求编排 / 接管者改写 / 失败重连）；本类只保留同名薄包装与压缩过程状态。 */
	private readonly compaction: CompactionRunner;
	/** 运行时状态读取/忙碌判据域（拆分第八刀）：getRuntimeState 快照装配与工具调用状态合成；
	 *  过程集合仍由本类持有（handlePiEvent/clearAgentState 直接读写），按引用注入。 */
	private readonly runtimeState: RuntimeStateReader;
	/** catalog 改写发生在 stop 之后：保留受限身份摘要，而不是保留整个已停 runtime。 */
	private readonly stoppedMessageIdentities = new StoppedMessageIdentityCache();
	/**
	 * 运行期消息缓存头部在会话文件消息下标空间中的偏移（entryId 缺失时的数值游标换算）。
	 * loadMessages / trimRuntimeCache 维护；-1 表示未知（匿名会话等无文件场景）。
	 */
	private readonly messageHeadOffsetByAgent = new Map<string, number>();
	/** 会话文件版本（mtime:size）：随消息载荷下发，渲染层据此检测压缩改写并丢弃 disk 前缀。 */
	private readonly sessionFileVersionByAgent = new Map<string, string>();
	/** Live 双通道（thinking/正文）流式状态机（Wave 3 拆分）：缓冲/节流发射/增量基准/思考段生命周期见 liveStreamChannel.ts；
	 *  100ms 合并窗口（2026-08 占用治理）与 delta 基准治理（2026-08 IPC 治理）的历史注释随域迁往该模块。 */
	private readonly liveStream = new LiveStreamChannel({
		emit: (channel, payload) => this.emit(channel, payload),
		onTextStreamPushed: (agentId) => this.emitStreamingStatePatch(agentId),
		streamRuntimeTriple: (agentId) => this.streamRuntimeTriple(agentId),
		ensureSegmentMount: (agentId) => this.mountThinkingSegment(agentId),
	});
	/** 流式 emit 合并窗口（毫秒）。50ms 兼顾流畅度与传输量，肉眼几乎无延迟。 */
	/** 激活显示窗口轮数：renderer atom 常驻最近 9 轮，DOM 仍按 3 轮窗口渐进挂载；更早历史走轮次分页。 */
	private static readonly DISPLAY_WINDOW_TURNS = 9;
	/**
	 * 激活显示窗口的条目预算（9 轮窗口之上叠的硬上限）。
	 * flush 会把窗口段全量下发一次，窗口越大单次 IPC payload 越大；1200 给正常
	 * 重工具会话留足余量，仅在「单轮几百条」的极端会话里把窗口缩到更少轮次（#213）。
	 * 缩窗口不丢内容：滑出的轮次走 pendingSlideOut → 渲染层历史前缀，仍可翻回。
	 */
	private static readonly MAX_DISPLAY_WINDOW_ENTRIES = 1200;
	/**
	 * agent_end 后等待 agent_settled 的超时时间（毫秒）。
	 * 如果 Pi 在此时间内未发送 agent_settled，桌面端将主动查询 get_state 并尝试恢复 idle。
	 * 这补偿了 Pi 在某些边缘情况下不发送 agent_settled 导致动画永久卡住的问题。
	 */
	private static readonly AGENT_SETTLED_TIMEOUT_MS = 5000;
	/**
	 * 超过该大小的历史会话跳过 get_messages RPC，改为直接从 JSONL 文件尾部读取最近 N 条消息。
	 * pi 当前不支持 limit/cursor，40MB JSONL 会以单行大 JSON 返回，主进程 JSON.parse 会短暂冻结整个应用。
	 * 文件直接读取仅解析近尾部少量消息，避免大会话加载导致的界面冻结。
	 */
	private static readonly MAX_AUTO_HISTORY_LOAD_BYTES = 5 * 1024 * 1024;
	/**
	 * 大会话直接从文件尾部读取时，最多保留的最近消息轮次（每条 user 消息算一轮）。
	 * 12 轮 = 4 次 3 轮翻页，覆盖绝大多数回看需求；更早历史走磁盘轮次分页。
	 */
	private static readonly MAX_HISTORY_LOAD_TURNS = 12;
	/**
	 * 运行期消息缓存上限（轮）：agent_settled 后把主进程数组裁到最近 N 轮。
	 * 12 轮覆盖激活显示窗口（9 轮）外再缓存 1 页历史（3 轮）；更早历史随时可从文件分页读回。
	 */
	private static readonly MAX_RUNTIME_CACHE_TURNS = 12;
	/**
	 * 运行期消息缓存的条目预算（12 轮之上叠的硬上限）。
	 * 主进程数组是内存占用最大的一份消息拷贝（带完整 tool 结果），只按轮数裁在
	 * 「单轮几百条」的会话里依然无界；与加载窗口同口径（1600），超预算时少留几轮，
	 * 更早历史随时可从文件分页读回。
	 */
	private static readonly MAX_RUNTIME_CACHE_ENTRIES = 1600;
	/**
	 * 工具结果文本截断阈值（字符数）。工具结果（如 bash 输出、文件读取）可能达数十 KB，
	 * 若完整存入 ChatMessage.meta 并随流式 emit 反复全量传输，会显著放大 IPC payload
	 * 并推高渲染进程内存，是大会话白屏的重要诱因。超长结果保留首尾各一部分，中间省略。
	 */
	/** 本地事件监听器（用于 FeishuBridge 等主进程内部订阅） */
	private readonly localEventListeners = new Set<(agentId: string, event: unknown) => void>();
	/** 状态变更监听器（用于 PetStateBridge 等主进程内部模块订阅 AgentTab[] 聚合状态） */
	private readonly stateListeners = new Set<(tabs: AgentTab[]) => void>();
	/** 主进程内部观察所有 renderer 输出，用于增量桥接 session-addressed 事件。 */
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();
	/** RPC 实时日志广播（记录/观看闸门 + 批量聚合推送）收口在 RpcLiveLogTap。 */
	private readonly rpcLiveTap = new RpcLiveLogTap((channel, payload) => this.emit(channel, payload));
	/** 手动请求的进程快照：接管探测与 RPC 等待都占位，避免 compaction_end 先到时重复提交。 */
	private readonly pendingCompactProcesses = new Map<string, PiProcess>();
	/** 正在执行手动压缩操作的 agent，用于区分手动压缩重启和异常崩溃 */
	private readonly compactingAgents = new Set<string>();

	/** 手动压缩等待超时过、后台结果尚未反馈的 agent：compaction_end 成功时补发
	 * 「压缩完成」系统消息（超时路径 RPC 已 reject，正常 toast 链不会再走，#303）。
	 * 失败/中止的 compaction_end 只清标记不补发（失败已有既有提示路径）。 */
	private readonly compactTimedOutAgents = new Set<string>();
	/**
	 * Pi 通过事件报告正在自动/手动压缩的 agent。
	 * 自动压缩发生在 agent_end 之后，桌面端若不单独追踪，会过早把会话置为 idle，
	 * 用户随后发送的新消息可能撞上 Pi 内部 compaction，表现为“会话中断”。
	 */
	private readonly rpcCompactingAgents = new Set<string>();
	/**
	 * 用户最近一次主动 abort 的时间戳（abort() 里写入）。
	 *
	 * `recentlyAborted` 会在 agent_start/settled 时被清掉，而压缩的取消结果要等
	 * RPC 返回才到；只靠那个集合会把「自己按停止打断的压缩」误判成扩展接管。
	 * 这里用时间戳 + 窗口判定（COMPACT_USER_ABORT_WINDOW_MS），不受事件清标影响。
	 */
	private readonly lastUserAbortAt = new Map<string, number>();
	/** 最近一次回合是否因上下文超限失败；错误态也要保留给圆环恢复入口。 */
	private readonly contextOverflowByAgent = new Map<string, boolean>();
	/**
	 * 每个 agent 最近一次 compaction 的观测（start/end 事件之间的耗时与结果）。
	 *
	 * 用途只有一个：手动压缩失败时判定取消来源。pi 的
	 * 「Compaction cancelled」在「扩展钩子拒绝」与「abort 打断」两条路径上是同一个
	 * 字符串，唯一的客观差别是——钩子拒绝发生在总结开始前（compaction_start→end
	 * 几乎无耗时、没有 LLM 调用）。没有这份观测就只能对用户说「取消了」而说不出谁。
	 */
	private readonly lastCompactionObservation = new Map<string, { aborted: boolean; reason?: string; elapsedMs?: number; at: number }>();
	/** compaction_start 的到达时间（end 到达时算耗时，随即删除）。 */
	private readonly compactionStartedAt = new Map<string, number>();
	/**
	 * pi 的逻辑模型回合边界（agent_start → true，agent_end → false）。
	 * 与 tab.status 分离：压缩/重试收尾时 runtime 仍 busy，但上一轮回答已经完成。
	 */
	private readonly agentTurnActiveById = new Map<string, boolean>();
	/**
	 * rewind 自动打点（回合计数/节流打点/裁剪/健康状态）收口在 RewindCheckpointCoordinator；
	 * rewindHostRoot 的 WSL 归一化与 listCheckpoints/restoreCheckpoint 等 RPC 入口仍在此。
	 */
	private readonly rewindCheckpoints = new RewindCheckpointCoordinator({
		getSessionInfo: (agentId) => {
			const runtime = this.agents.get(agentId);
			return runtime ? { cwd: runtime.tab.cwd, wslDistro: runtime.tab.wslDistro, sessionId: runtime.tab.sessionId } : undefined;
		},
		hostRoot: (cwd, distro) => this.rewindHostRoot(cwd, distro),
		listAgentSessions: () => [...this.agents.values()].map((runtime) => ({ cwd: runtime.tab.cwd, wslDistro: runtime.tab.wslDistro, sessionId: runtime.tab.sessionId })),
		logInfo: (message, meta) => void this.appLogger?.info("rewind", message, meta),
		logWarn: (message, meta) => void this.appLogger?.warn("rewind", message, meta),
	});
	/** 用户主动停止的 agent，用于退出处理器中跳过自动重连 */
	private readonly userInitiatedStop = new Set<string>();
	/** 已尝试过自动重连的 agent（防止无限循环），重连成功后清除 */
	private readonly autoRestartAttempted = new Set<string>();
	/**
	 * 启动握手中（start + 首次 get_state 完成前）：忽略 exit/error 的终态处理。
	 * 扩展加载失败时进程会先 exit 1，若此时把 tab 标 closed/清状态，
	 * 后续 --no-extensions 回退就没有 runtime 可接。
	 */
	private readonly startupHandshakeAgents = new Set<string>();
	/**
	 * 用户主动 abort 后正在等待 pi 确认的 agent。
	 * abort() 先加入该集合，再发送 abort RPC；在收到 agent_settled 或下一个 agent_start 之前，
	 * 用于抑制 auto-retry/compaction 等状态回写，避免把侧边栏重新标成 running。
	 * 流式事件拦截改走 streamGate（按 generation 封印），不再依赖本集合。
	 */
	private readonly recentlyAborted = new Set<string>();
	/**
	 * abort 流闸与升级（封印/兜底定时器/abort_bash 升级）收口在 AbortStreamGateController。
	 * recentlyAborted/thinkingEmitter/messageFlush 的跨域编排仍在 clearStreamGate。
	 */
	private readonly abortGate = new AbortStreamGateController({
		getRpcClient: (agentId) => this.agents.get(agentId)?.process.client,
		logInfo: (message, meta) => void this.appLogger?.info("agent", message, meta),
		logWarn: (message, meta) => void this.appLogger?.warn("agent", message, meta),
		emitAbortSlowNotice: (agentId) =>
			this.emit(agentEventTags.agentsNotice, {
				agentId,
				message: "停止响应较慢，可尝试重启会话",
				i18nKey: "app.abortSlow",
				kind: "warning",
				duration: 6000,
				// 僵死的 pi 只有重建进程才停得下来（子进程持管道场景 abort 永远不回包），
				// 给直达动作而不是让用户在菜单里找；渲染层按 action id 解析成重启。
				action: "restartSessionRuntime",
			}),
		noteStillStreamingAfterAbort: (agentId) => this.noteStillStreamingAfterAbort(agentId),
	});

	/** 连点退避窗口：覆盖上一次 abort 的 clear_queue(3s)+abort(10s) 链，窗口内只补发 abort RPC。 */
	private static readonly ABORT_REPEAT_COOLDOWN_MS = 2000;

	/** 流式性能计时（TTFT/总耗时/TPS，起点为请求发出时刻）收口在 MessagePerfTracker。 */
	private readonly messagePerf = new MessagePerfTracker();
	/** 最近一次完整 runtime 快照（按 agent）：流式结算拿不到 RPC，只能从这里取模型事实。 */
	private readonly lastRuntimeStateByAgent = new Map<string, AgentRuntimeState>();
	/**
	 * 最近一次流式状态补丁（按 agent）：正文通道每 100ms flush 都会补一条 patch，
	 * 但两个边沿之间内容不变。同值跳过，避免几百个会话把万级/秒的同值事件灌给渲染层
	 * （discussion #446）。签名与 emitStreamingStatePatch 的字段一一对应；
	 * 心跳间隔保证渲染层重载/丢帧后仍能在数秒内恢复状态指示，而不是永久缺失。
	 */
	private readonly lastStreamingPatchByAgent = new Map<string, { signature: string; at: number }>();
	/** 同值补丁心跳：5s 未发就重发一次当前状态（渲染层 reload 后自愈）。 */

	/**
	 * 最近一次用户 abort 的时刻（毫秒）。退出处理器用它识别「终止窗口内的进程退出」：
	 * pi 在处理 abort 时可能自行崩溃（上游 #2716 族：abort 期间 unhandled rejection
	 * 直接杀 Node 进程，WSL 慢链路下尤甚），此时应按会话文件重连一次保住会话，
	 * 而不是把会话打成 closed 终态。窗口覆盖 abort settled 之后的收尾期。
	 */
	private readonly lastAbortAtByAgent = new Map<string, number>();
	/** 终止窗口判定时长：覆盖 abort RPC ack（pi 等 idle 才响应）+ settled + 收尾清理。 */
	private static readonly ABORT_EXIT_REATTACH_WINDOW_MS = 15_000;
	private readonly abortedDuringAsk = new Set<string>();
	/** 扩展 UI 请求闸（提问分发/ANSI 净化/pending 跟踪/超时兜底）：见 extensionUiGate.ts（Wave 4B 迁出）。 */
	private readonly uiGate: ExtensionUiGate;
	/** 成功空闲（settled）回调：供 PetStateBridge 等主进程内部模块订阅，携带完成 Agent 身份。 */
	private readonly settledListeners = new Set<(info: { agentId: string; title: string }) => void>();
	/** 项目信任闸（trust.json 决策/弹窗/超时）：见 projectTrustGate.ts（Wave 4C 迁出）。 */
	private readonly projectTrust: ProjectTrustGate;
	/**
	 * PiDeck automatic-title callback. Generic pi runtime names never reach this
	 * callback: catalog titles are authoritative after initial discovery.
	 *
	 * 装配层据此写入 catalog；source 标记来源（#266）："auto" 可升级 "fallback"，
	 * 反向不可（否则首条消息会压住扩展模型标题）。
	 */
	private onAutomaticTitleChanged?: (agentId: string, title: string, source: AutomaticTitleSource) => void;
	/** 已发送 ask 系统通知的 agent；新一轮 run（agent_start）时清除，避免同一轮多次提问刷屏。 */
	private readonly notifiedAskAgents = new Set<string>();
	/** standby 池（单实例）：put 顶替/TTL 到期统一走 onExpire → stop 回收进程。 */
	private readonly standbyPool = new StandbyAgentPool({
		ttlMs: STANDBY_TTL_MS,
		onExpire: (agentId) => {
			void this.stop(agentId);
		},
	});
	/** 进行中的 standby 预热跟踪：ensure 去重、claim 等待、目标接力、取消（见 standbyWarmup.ts）。 */
	private readonly standbyWarmup = new StandbyWarmupTracker();
	private wslEnvironment: WslEnvironment | null = null;

	/**
	 * 用户配置的 RPC 超时（默认 600s，SettingsStore 另有「低于 600s 自动提升」保险）。
	 * 发送消息等用户可感知的长任务等待路径统一吃该配置，
	 * 与启动诊断卡里的指引（“Increase the RPC timeout in settings”）保持一致，
	 * 避免用户调大配置却只对 prompt 生效、启动仍按硬编码 30s 超时的误导。
	 */
	private get rpcTimeoutMs(): number {
		return this.settingsStore.get().rpcTimeout;
	}

	/**
	 * 启动握手（首次 get_state）的等待上限。
	 *
	 * 为什么不再直接吃 rpcTimeout：那是给长任务（长 bash、大模型调用）的配置，默认 600s。
	 * 启动路径沿用它，会让「进程起来了但永远不就绪」（扩展初始化卡死、会话文件异常巨大）
	 * 从确定性故障退化成 10 分钟静默——用户看到的就是「启动失败不报错、直接超时」，
	 * 而且超时前不会触发任何回退（扩展禁用重试）或诊断。
	 * 取 min 保留「用户把 rpcTimeout 调小就少等」的语义（设置项本身会被抬到 ≥600s，
	 * 因此实际生效值就是本常量）。
	 */
	private static readonly STARTUP_HANDSHAKE_TIMEOUT_MS = 90_000;

	/** 启动握手实际超时：rpcTimeout 与启动上限取小（见 STARTUP_HANDSHAKE_TIMEOUT_MS）。 */
	private get startupHandshakeTimeoutMs(): number {
		return Math.min(this.rpcTimeoutMs, AgentManager.STARTUP_HANDSHAKE_TIMEOUT_MS);
	}

	constructor(
		private readonly getProject: (id: string) => Project | undefined,
		private readonly getWindow: () => BrowserWindow | null,
		private readonly settingsStore: SettingsStore,
		private readonly configManager: ConfigManager,
		private readonly rpcLogger?: RpcLogger,
		private readonly appLogger?: AppLogger,
		sessionFileEditor?: SessionFileEditor,
		private readonly translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string = () => "Agent operation failed.",
		/** 每次 spawn pi 进程前回调（如刷新模型列表缓存）；异步但不等完成，避免阻塞 Agent 启动。 */
		private readonly onBeforeAgentSpawn?: () => void,
		/** 安全管理：Agent 启动前写策略快照 + 注入会话身份（缺省时不注入安全门）。 */
		private readonly securityStore?: SecurityStore,
		/**
		 * spawn pi 前对会话文件的预检/修复（剔除旧版 PiDeck 私有 sessionName 头行，
		 * 该行会让 pi 拒绝加载会话并 exit 1，见 #114）。由 main/index.ts 装配 SessionScanner 实现。
		 */
		private readonly repairSessionFile?: (sessionPath: string) => Promise<boolean>,
		/**
		 * 会话是否已绑定飞书（key = SessionRecord.id）。
		 * 由 main/index.ts 注入 FeishuBridge.hasSessionBinding 查询；
		 * 命中时 PiProcess 注入 PIDECK_FEISHU_LINKED，ask_question 扩展切换为禁用提示版。
		 */
		private readonly isFeishuSession?: (sessionKey: string | undefined) => boolean,
		/**
		 * agentId → SessionRecord.id 解析（由 main/index.ts 注入 coordinator.getSessionId）。
		 * 通知 toast 的 launch 必须携带 record.id：renderer 的 sessionRecordByIdAtomFamily
		 * 只索引 record.id，而 tab.sessionId 是 pi 侧会话 id（两套体系，见 index.ts attachRuntime），
		 * 用它跳转在 renderer 永远解析不到会话。
		 */
		private readonly resolveSessionId?: (agentId: string) => string | undefined,
		/**
		 * 会话 key（SessionRecord.id 或会话文件路径）→ 会话级代理覆盖模式（follow/on/off）。
		 * 由 main/index.ts 注入 catalog 查询；缺省/未命中 = 跟随全局。与 isFeishuSession 使用
		 * 同一 key（securitySessionKey ?? sessionPath），保证 create/reattach/临时会话行为一致。
		 */
		private readonly resolveSessionProxy?: (sessionKey: string | undefined) => import("../../shared/types/session").SessionProxyMode | undefined,
		/**
		 * provider/modelId 是否在 pi 的模型目录中（选择器展示的 pi --list-models 结果，
		 * 含 models.json + auth.json + 内置目录 + models-store.json 缓存）。
		 * 由 main/index.ts 注入 modelListCache 查询。
		 *
		 * set_model 被 pi 拒绝（快照无此模型）时，若模型在目录中但不在运行中 Agent 的
		 * 启动快照里，说明是「Agent 启动后目录才更新」——应引导用户重启 Agent 而非
		 * 误报「模型未在 models.json 配置」（如 auth.json 官方 provider 的目录模型：
		 * 选择器可见、TUI 可用，但 PiDeck 运行中的 Agent 快照没有）。
		 */
		private readonly resolveModelInCatalog?: (provider: string, modelId: string) => Promise<boolean>,
		/**
		 * 远端运行时端口（Phase 4 P4.2 产品路由）。
		 *
		 * **缺省 = 本机产品**：没有端口时远端项目仍然 `UNSUPPORTED_PROJECT_LOCATION`
		 * （fail-closed，绝不静默把远端 cwd 当本机路径去起 pi）。装配处只在开发实验门禁下
		 * 注入它，且端口本身还会在门禁关闭时以 `REMOTE_FEATURE_DISABLED` 拒绝。
		 */
		private readonly remoteRuntime?: RemoteRuntimePort,
		/**
		 * 第三方接管型 MCP 扩展列表（计划 M5b）。由 main/index.ts 注入 ExtensionManager.list()
		 * 的轻量查询（缓存优先）；缺省 = 不检测（测试/预览环境）。
		 */
		private readonly listThirdPartyMcpExtensions?: () => Promise<import("../../shared/mcpThirdParty").ThirdPartyMcpExtension[]>,
	) {
		// 「最近一次回复指标」的供应商/模型：结算（message_end）在流式热路径上不能等 get_state RPC，
		// 只读最近一次完整快照；快照缺失（刚启动/尚未轮询）时 settle 退回 assistant 消息自带的 model。
		this.messagePerf.bindRuntimeModelSource((agentId) => this.lastRuntimeStateByAgent.get(agentId));
		// resourceMigrationGate 由 index.ts 在迁移器装配后注入（构造早于迁移器）。
		this.messageEmit = new MessageEmitBatcher({
			getMessages: (agentId) => this.messages.get(agentId) ?? [],
			computeDisplayWindowStart: (messages) => this.computeDisplayWindowStart(messages),
			computeWindowStartFilePos: (agentId, messages, windowStart) => this.computeWindowStartFilePos(agentId, messages, windowStart),
			sessionFileVersion: (agentId) => this.sessionFileVersionByAgent.get(agentId),
			// 经计量口投递（Phase 0，PIDECK_PERF_LOG=1 时才记录）：pi 已有增量/窗口化，
			// 这一路作为 ACP 的对照基线。
			emitMessageFlush: (payload) => emitAgentMessageMeasured("pi", payload.agentId, payload, (measured) => this.emit(agentEventTags.agentsMessage, measured)),
			emitStreamingStatePatch: (agentId) => this.emitStreamingStatePatch(agentId),
		});
		// 启动期诊断队列（Wave 4A）：宿主回调只暴露时间线写入/toast/设置读取/warn 日志。
		this.startupDiagnostics = new StartupDiagnosticsQueue({
			addLocalizedMessage: (agentId, role, i18nKey, fallbackText, options) => this.addLocalizedMessage(agentId, role, i18nKey, fallbackText, options),
			emitNotice: (payload) => this.emit(agentEventTags.agentsNotice, payload),
			isNoExtensionsSetting: () => Boolean(this.settingsStore.get().piRpcNoExtensions),
		});
		// 项目信任闸（Wave 4C）：宿主回调只暴露配置读写/日志/WSL 环境/窗口获取。
		this.projectTrust = new ProjectTrustGate({
			getConfigStore: () => this.configManager,
			info: (message, data) => void this.appLogger?.info("agent", message, data),
			getWslEnvironment: () => this.wslEnvironment,
			getWindow: () => this.getWindow(),
		});
		// 扩展 UI 请求闸（Wave 4B）：宿主回调只暴露事件广播/runtime 访问/abort 标记。
		this.uiGate = new ExtensionUiGate({
			emitUiRequest: (payload) => this.emit(agentEventTags.agentsUiRequest, payload),
			getRuntimeTab: (agentId) => this.agents.get(agentId)?.tab,
			getClient: (agentId) => this.agents.get(agentId)?.process.client,
			markAbortedDuringAsk: (agentId) => this.abortedDuringAsk.add(agentId),
			warn: (message, data) => void this.appLogger?.warn("agent", message, data),
		});
		this.messageProjector = new AgentMessageProjector({
			translate: this.translate,
			isAskAborted: (agentId) => this.abortedDuringAsk.has(agentId),
		});
		this.sessionFileEditor =
			sessionFileEditor ??
			new SessionFileEditor({
				logger: appLogger
					? {
							warn: (message, details) => appLogger.warn("session-file", message, details),
						}
					: undefined,
			});
		this.trajectoryFacts = createTrajectoryFactsReader({
			source: {
				getSessionFactIndex: (sessionPath) => this.sessionHistoryReader.getSessionFactIndex(sessionPath),
				readSessionFactLines: (sessionPath, entries) => this.sessionHistoryReader.readSessionFactLines(sessionPath, entries),
			},
		});
		this.sessionHistoryReader = new SessionHistoryReader({
			toHostPath: (sessionPath) => this.toSessionHostPath(sessionPath),
			convertMessages: (agentId, rawMessages, activeEntryIds) => this.convertAgentMessages(agentId, rawMessages, activeEntryIds),
			trimMessages: (rawMessages, maxTurns) => trimHistoryMessages(rawMessages, maxTurns),
			translate: this.translate,
			logger: appLogger,
			// Wave 2：会话历史索引优先问 session-store sidecar。这里刻意用「延迟读字段」的
			// 闭包：AgentManager 构造早于 sidecar 服务创建，装配期再 setSessionStoreIndexReader。
			readIndexTable: (hostPath, version) => this.sessionStoreIndexReader?.(hostPath, version) ?? Promise.resolve(null),
		});
		this.toolMessages = new ToolMessageAssembler({
			messages: this.messages,
			toolMessageIds: this.toolMessageIds,
			messageProjector: this.messageProjector,
			findSameMessageIndex: (list, role, text, toolCallId) => this.findSamePiMessageIndex(list, role, text, toolCallId),
			markMessagesDirtyFrom: (agentId, index) => this.markMessagesDirtyFrom(agentId, index),
			scheduleMessageEmit: (agentId, immediate) => this.scheduleMessageEmit(agentId, immediate),
			activeAssistantMessageId: (agentId) => this.activeAssistantMessageIds.get(agentId),
			setActiveAssistantMessageId: (agentId, messageId) => {
				this.activeAssistantMessageIds.set(agentId, messageId);
			},
			consumeAskWaitMs: (agentId) => this.uiGate.consumeAskWaitMs(agentId),
			isAbortedDuringAsk: (agentId) => this.abortedDuringAsk.has(agentId),
			runtimeProjectId: (agentId) => this.agents.get(agentId)?.tab.projectId,
			isRemoteRuntime: (projectId) => this.isRemoteRuntime(projectId),
		});
		this.historyLoader = new RuntimeHistoryLoader({
			requireRuntime: (agentId) => this.requireRuntime(agentId),
			agents: this.agents,
			isRemoteRuntime: (projectId) => this.isRemoteRuntime(projectId),
			messages: this.messages,
			sessionHistoryReader: () => this.sessionHistoryReader,
			stoppedMessageIdentities: this.stoppedMessageIdentities,
			messageHeadOffsetByAgent: this.messageHeadOffsetByAgent,
			sessionFileVersionByAgent: this.sessionFileVersionByAgent,
			rpcTimeoutMs: this.rpcTimeoutMs,
			maxHistoryLoadTurns: AgentManager.MAX_HISTORY_LOAD_TURNS,
			appLogger: this.appLogger,
			translate: this.translate,
			readRecentMessagesFromSessionFile: (sessionPath, maxTurns) => this.readRecentMessagesFromSessionFile(sessionPath, maxTurns),
			scanCompactions: (sessionPath) => this.scanCompactions(sessionPath),
			buildActiveBranchEntryIds: (entries, leafId) => this.buildActiveBranchEntryIds(entries, leafId),
			convertAgentMessages: (agentId, rawMessages, activeEntryIds) => this.convertAgentMessages(agentId, rawMessages, activeEntryIds),
			computeDisplayWindowStart: (messages) => this.computeDisplayWindowStart(messages),
			rebindInFlightMessages: (agentId, nextMessages, projectedMessages) => this.rebindInFlightMessages(agentId, nextMessages, projectedMessages),
			setMessageEmitWindowStart: (agentId, start) => this.messageEmit.setWindowStart(agentId, start),
			scheduleMessageEmit: (agentId, immediate) => this.scheduleMessageEmit(agentId, immediate),
			refreshAutoTitle: (agentId) => this.refreshAutoTitle(agentId),
			emitState: () => this.emitState(),
			recordTiming: (name, startedAt, detail) => this.recordTiming(name, startedAt, detail),
			toSessionHostPath: (sessionPath) => this.toSessionHostPath(sessionPath),
			clearAbortedDuringAsk: (agentId) => {
				this.abortedDuringAsk.delete(agentId);
			},
		});
		// 手动压缩域（拆分第七刀）：压缩过程集合由本类持有（事件/状态查询/清理都直接读写），
		// 这里按引用注入；发布与读取入口全部走既有方法，协作者不新增状态。
		this.compaction = new CompactionRunner({
			requireRuntime: (agentId) => this.requireRuntime(agentId),
			agents: this.agents,
			appLogger: this.appLogger,
			settingsStore: this.settingsStore,
			rpcTimeout: () => this.rpcTimeoutMs,
			pendingCompactProcesses: this.pendingCompactProcesses,
			compactingAgents: this.compactingAgents,
			compactTimedOutAgents: this.compactTimedOutAgents,
			rpcCompactingAgents: this.rpcCompactingAgents,
			contextOverflowByAgent: this.contextOverflowByAgent,
			getProject: (id) => this.getProject(id),
			emitRuntimeState: (agentId) => this.emitRuntimeState(agentId),
			emitContextOverflowState: (agentId, contextOverflow) => this.emitContextOverflowState(agentId, contextOverflow),
			emitState: () => this.emitState(),
			getRuntimeState: (agentId) => this.getRuntimeState(agentId),
			loadMessages: (agentId, skipEntries, earlyMessagesPromise, options) => this.loadMessages(agentId, skipEntries, earlyMessagesPromise, options),
			reattachProcess: (agentId, sessionPath) => this.reattachProcess(agentId, sessionPath),
			addLocalizedMessage: (agentId, role, i18nKey, fallbackText, options) => this.addLocalizedMessage(agentId, role, i18nKey, fallbackText, options),
			listRegisteredCommands: (runtime) => this.listRegisteredCommands(runtime),
			resolveSessionCompactionOwnership: (runtime) => this.resolveSessionCompactionOwnership(runtime),
			resolveCompactCancelMessage: (agentId, errorMessage) => this.resolveCompactCancelMessage(agentId, errorMessage),
			compactionCancelEvidence: (agentId) => this.compactionCancelEvidence(agentId),
		});

		// 运行时状态读取域（拆分第八刀）：过程集合由本类持有（事件/清理路径直接读写），按引用注入；
		// getSessionCacheHitStats 走宿主同名薄包装，行为测试按实例属性替换读取器时仍然生效。
		this.runtimeState = new RuntimeStateReader({
			requireRuntime: (agentId) => this.requireRuntime(agentId),
			agents: this.agents,
			isRemoteRuntime: (projectId) => this.isRemoteRuntime(projectId),
			toSessionHostPath: (sessionPath) => this.toSessionHostPath(sessionPath),
			getSessionCacheHitStats: (sessionPath) => this.getSessionCacheHitStats(sessionPath),
			getRuntimeState: (agentId) => this.getRuntimeState(agentId),
			rpcTimeoutMs: this.rpcTimeoutMs,
			messagePerf: this.messagePerf,
			streamingAgents: this.streamingAgents,
			agentTurnActiveById: this.agentTurnActiveById,
			rpcCompactingAgents: this.rpcCompactingAgents,
			compactingAgents: this.compactingAgents,
			pendingCompactProcesses: this.pendingCompactProcesses,
			activeToolCallsByAgent: this.activeToolCallsByAgent,
			toolExecutingByAgent: this.toolExecutingByAgent,
			toolStateSequenceByAgent: this.toolStateSequenceByAgent,
			contextOverflowByAgent: this.contextOverflowByAgent,
			toolEdgeStateTimers: this.toolEdgeStateTimers,
			lastStreamingPatchByAgent: this.lastStreamingPatchByAgent,
			lastRuntimeStateByAgent: this.lastRuntimeStateByAgent,
			emit: (channel, payload) => this.emit(channel, payload),
		});
	}

	/**
	 * 已准备好的远端启动计划（agentId → 计划 + 配对启动器）。
	 *
	 * 为什么按 agentId 存在 AgentManager 而不是写进 tab：plan 带着 nonce 与远端路径，是**运行时事实**
	 * 而不是会话身份，而 tab 是 shared 契约（本批不改 shared）。`createRemoteUnlocked` 写入、
	 * `spawnAndGetState` 消费、`clearAgentState` 随生命周期清理（agentId 每次 spawn 都是新 UUID）。
	 */
	private readonly remoteLaunchByAgent = new Map<string, { plan: RemoteSshPiRuntimeLaunchPlan; launcher: PiRuntimeLauncher }>();

	/** Wave 2：注入 session-store 条目表读取器（未注入/返回 null 时读者回退 TS 逐行解析）。 */
	setSessionStoreIndexReader(reader: ((hostPath: string, version: { size: number; mtimeMs: number }) => Promise<unknown>) | null): void {
		this.sessionStoreIndexReader = reader ?? undefined;
	}

	private sessionStoreIndexReader?: (hostPath: string, version: { size: number; mtimeMs: number }) => Promise<unknown>;

	configureWsl(environment: WslEnvironment | null): void {
		this.wslEnvironment = environment;
	}

	/**
	 * 注入内置技能目录解析（PiDeck 自带技能只经 --skill 注入，不落 pi 的自动发现根）。
	 * 由 main/index.ts 在 SkillManager 装配后注入；未注入 = 不注入内置技能（测试/预览）。
	 */
	setBundledSkillResolver(resolve: (() => string[]) | null): void {
		this.bundledSkillResolver = resolve ?? undefined;
	}

	private bundledSkillResolver?: () => string[];

	/**
	 * 开发诊断埋点。未开启时 sink 为空，recordTiming 直接返回。
	 * 用来对照「点 pi 会话卡死」时 create / history.load 是否把主进程堵住。
	 */
	setDiagnosticsSink(sink: ((name: string, startedAt: number, detail?: Record<string, string | number | boolean | null>) => void) | undefined): void {
		this.diagnosticsSink = sink;
	}

	private diagnosticsSink?: (name: string, startedAt: number, detail?: Record<string, string | number | boolean | null>) => void;

	private recordTiming(name: string, startedAt: number, detail?: Record<string, string | number | boolean | null>): void {
		this.diagnosticsSink?.(name, startedAt, detail);
	}

	/**
	 * 统一构造 PiProcess：注入 PiDeck 内置扩展路径解析 + 安全管理快照/会话身份。
	 * 内置扩展以 -e 从 app resources 加载，不再依赖用户扩展目录副本。
	 * 安全管理：确保策略快照已落盘（小 JSON 写，等完成后启动，保证扩展首次拦截即可读到）。
	 * settingsOverride 仅用于本次 spawn（如扩展加载失败后强制 --no-extensions），不改持久设置。
	 *
	 * `agentId` 可选：提供时同时注册 GUI 扩展桥会话（§9.2）与模型快照会话，把
	 * `PIDECK_BRIDGE_URL` / `PIDECK_BRIDGE_TOKEN` / `PIDECK_MODEL_TRACE_URL` / `PIDECK_MODEL_TRACE_TOKEN`
	 * 注入 pi 子进程环境。不提供（如临时会话）则不注册 —— 桥与模型快照在该进程里静默不工作。
	 *
	 * `remoteLaunch` = 远端运行时（Phase 4 P4.2）：只带 plan + launcher，本地专属准备**一律不注入**。
	 * 自带一份而不复用下面这些选项，是因为它们全是本机语义：扩展/技能/提示词白名单要去项目目录里
	 * 扫文件、安全快照与 trust flag 要写/读本机 userData、会话文件预检要读本机 JSONL —— 而远端进程
	 * 跑在另一台机器上（`PiProcess.start` 的远端分支也不消费这些选项，参数与 cwd 全来自 plan）。
	 */
	private createPiProcess(
		cwd: string,
		sessionPath?: string,
		securitySessionKey?: string,
		settingsOverride?: Partial<Pick<AppSettings, "piRpcNoExtensions" | "piRpcNoSkills" | "removedBuiltInExtensions" | "wslEnabled" | "wslDistro" | "wslUser">>,
		agentId?: string,
		remoteLaunch?: { plan: RemoteSshPiRuntimeLaunchPlan; launcher: PiRuntimeLauncher },
	): PiProcess {
		const settings = settingsOverride ? { ...this.settingsStore.get(), ...settingsOverride } : this.settingsStore.get();
		if (remoteLaunch) {
			// cwd 只进诊断（远端诊断的 cwd 本来就来自 plan），本地读者看到的是远端项目根。
			return new PiProcess(cwd, settings, undefined, { runtimePlan: remoteLaunch.plan, runtimeLauncher: remoteLaunch.launcher });
		}
		if (this.securityStore) {
			void this.securityStore.ensureSnapshotWritten();
		}
		return new PiProcess(cwd, settings, undefined, {
			// 模型快照端点：注册本 agent 的会话，拿到注入用的 URL/token。
			// 端点未就绪时返回 undefined → 不注入 → 扩展静默不工作（fail-safe）。
			modelTraceEnv: agentId ? this.registerModelTraceSession(agentId) : undefined,
			// 关联会话端点（例外九）：同一套「每 agent 一份 token」生命周期，随模型快照一起注销。
			linkedSessionsEnv: agentId ? this.linkedSessionsHost?.registerAgent(agentId) : undefined,
			// 扩展解析器与模型能力缓存共用（piProcessExtensionResolvers）：
			// 保证「选择器能看到扩展贡献的模型」与「运行时实际加载的扩展」同源。
			// PiDeck 自带扩展用 -e 注入；普通资源的启停已交给 pi 原生 settings.json 过滤规则。
			...createPiProcessExtensionResolvers(cwd, settings),
			// 桌面端专用技能：从内置目录以 --skill 注入，TUI 不扫该目录。
			bundledSkillPaths: this.bundledSkillResolver?.() ?? [],
			// 会话身份 = PiDeck 会话 key（SessionRecord.id，UUID 或旧版文件路径），扩展按它解析等级覆盖；
			// 匿名会话（noSession）无 key，扩展仅用全局默认等级。
			securitySessionId: securitySessionKey ?? sessionPath,
			// 会话级代理覆盖：spawn 时按会话记录覆盖全局设置（on → 强制代理 / off → 强制直连）。
			// 与 securitySessionId 用同一 key，匿名会话（noSession）无 key → 跟随全局。
			proxyOverride: this.resolveSessionProxy?.(securitySessionKey ?? sessionPath),
			// 飞书绑定会话：ask_question 禁用（扩展读 PIDECK_FEISHU_LINKED）。
			// 查询用与 securitySessionId 相同的会话 key，保证与 FeishuBridge 的 sessionId 索引一致。
			feishuLinked: this.isFeishuSession?.(securitySessionKey ?? sessionPath) ?? false,
			securitySnapshotPath: this.securityStore?.getSnapshotPath(),
			// 预检修复：全部 spawn 路径（create/reattach/withTemporarySession）都在 start() 内生效。
			repairSessionFileBeforeStart: this.repairSessionFile,
		});
	}

	/**
	 * 注册模型快照会话，返回要注入 pi 子进程的环境变量。
	 *
	 * 端点未就绪（起不来）时返回 undefined，调用方不注入 → 扩展静默不工作，
	 * pi 与 PiDeck 都照常（fail-safe）。
	 */
	private registerModelTraceSession(agentId: string): Record<string, string> | undefined {
		try {
			const server = getModelTraceServer();
			if (!server.ready) return undefined;
			const { url, token } = server.registerAgent(agentId, (trace) => this.handleModelTrace(agentId, trace));
			return { PIDECK_MODEL_TRACE_URL: url, PIDECK_MODEL_TRACE_TOKEN: token };
		} catch (error) {
			void this.appLogger?.warn("agent", "Model trace session registration failed; tracing stays idle", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * 处理 pi 推来的一条模型请求快照（pi-deck-model-trace）。
	 *
	 * 与 RPC 日志**同一开关**：未开启记录的 agent 直接丢弃（不落盘、不广播）。
	 * 完整请求体写 model-traces 目录并在时间线里只留紧凑条目 —— 上百 KB 的
	 * 请求体进环形缓冲/IPC 批次会把主进程与渲染层都拖垮。
	 */
	private handleModelTrace(agentId: string, trace: ModelTraceInput): void {
		try {
			if (!this.rpcLiveTap.isLogging(agentId)) return;
			const entry = buildModelTraceLogEntry(agentId, trace);
			// 请求体只在 request 快照里；response 只有状态码与耗时（紧凑条目已含）
			if (trace.kind === "request") {
				void this.rpcLogger?.writeModelTrace(agentId, trace).catch((error) => {
					void this.appLogger?.warn("agent", "Model trace write failed", {
						agentId,
						traceId: trace.traceId,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
			this.rpcLiveTap.enqueue(this.rpcLogger?.push(entry) ?? entry);
		} catch (error) {
			// 日志功能任何故障都不影响会话
			void this.appLogger?.warn("agent", "model-trace handler failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * 注销某 agent 的快照会话（agent 停止 / 会话删除时调用）。
	 */
	unregisterModelTraceSession(agentId: string): void {
		try {
			getModelTraceServer().unregisterAgent(agentId);
		} catch {
			// 注销失败无副作用（token 会随端点关闭一起清掉）
		}
		try {
			this.linkedSessionsHost?.unregisterAgent(agentId);
		} catch {
			// 同上
		}
	}

	/** 关联会话端点（例外九）；index.ts 在端点就绪后注入，缺省时不给 pi 注入 env。 */
	private linkedSessionsHost?: { registerAgent(agentId: string): Record<string, string> | undefined; unregisterAgent(agentId: string): void };

	setLinkedSessionsHost(host: { registerAgent(agentId: string): Record<string, string> | undefined; unregisterAgent(agentId: string): void }): void {
		this.linkedSessionsHost = host;
	}

	/**
	 * 启动 pi 并等到首次 get_state：失败时按策略用 --no-extensions 再试一次。
	 * 握手期间 exit/error 不把 tab 标 closed，否则回退没有 runtime 可接。
	 */
	private async handshakePiProcess(
		agentId: string,
		options: {
			projectPath: string;
			sessionPath?: string;
			deckSessionId?: string;
			trustOverride?: "approve" | "no-approve";
			noSession?: boolean;
			onExit: (payload: { code: number | null; signal: string | null }) => void;
		},
	): Promise<{
		client: Awaited<ReturnType<PiProcess["start"]>>;
		process: PiProcess;
		state: RpcResponse;
		fallbackFromExtensions: boolean;
		fallbackDebug?: string;
	}> {
		this.startupHandshakeAgents.add(agentId);
		try {
			try {
				const first = await this.spawnAndGetState(agentId, options);
				return { ...first, fallbackFromExtensions: false };
			} catch (firstError) {
				const failed = this.agents.get(agentId)?.process;
				const diag = failed?.getDiagnostics();
				const rawMessage = firstError instanceof Error ? firstError.message : String(firstError);
				const alreadyNoExtensions = Boolean(this.settingsStore.get().piRpcNoExtensions);
				const fallbackInput = {
					alreadyNoExtensions,
					stderr: diag?.stderr.join("") ?? "",
					errorMessage: rawMessage,
					exitCode: diag?.exitCode,
					processStillRunning: failed?.isRunning() ?? false,
					// spawn 阶段失败（Node 只发 error、不发 exit）：一定与扩展无关，回退无意义。
					// 没有这个显式判据时，spawn 失败只能靠错误文本里的 ENOENT 兜底识别，容易被改写漏掉。
					spawnFailed: diag?.spawnFailed === true,
				};
				// 远端运行时没有「PiDeck 内置扩展注入」这件事：参数由 plan 决定（`buildRemotePiArgs` 只产出
				// 基础参数与 `--session`），`--no-extensions` 不在其中 —— 回退重拉会用同一套参数再失败一次，
				// 既丢了首次诊断，又把「远端启动失败」误报成扩展问题。远端扩展属 P4.4。
				const remoteRuntime = this.isRemoteRuntime(this.agents.get(agentId)?.tab.projectId ?? "");
				if (remoteRuntime || !shouldRetryWithoutExtensions(fallbackInput)) {
					// 不回退也要把原因写清楚，否则用户会以为「说好的自动禁用扩展」失效了。
					void this.appLogger?.warn("agent", "Pi start failed; extension fallback skipped", {
						agentId,
						error: rawMessage,
						exitCode: diag?.exitCode ?? null,
						spawnFailed: diag?.spawnFailed === true,
						cwdMissing: diag?.cwdMissing === true,
						processStillRunning: fallbackInput.processStillRunning,
						remote: remoteRuntime,
						reason: remoteRuntime ? "remote runtime: extension fallback is a local-only concept" : describeExtensionFallbackSkip(fallbackInput),
					});
					throw firstError;
				}

				void this.appLogger?.warn("agent", "Pi start failed; retrying without extensions", {
					agentId,
					error: rawMessage,
					exitCode: diag?.exitCode ?? null,
				});
				// 停掉已死/将死的带扩展进程，再换无扩展参数重拉。
				failed?.stop();

				// --no-extensions 只作用于本次运行时：settingsOverride 仅改本次 spawn（见 createPiProcess），
				// 绝不持久化到全局设置——否则用户修复扩展后，后续所有新 agent 仍沿用无扩展启动，
				// 必须手动改回设置才能恢复。每个新 agent 独立重试带扩展启动：修复后下次创建自动恢复正常。
				const second = await this.spawnAndGetState(agentId, options, { piRpcNoExtensions: true });
				return {
					...second,
					fallbackFromExtensions: true,
					fallbackDebug: formatExtensionFallbackDebug({
						rawMessage,
						stderr: diag?.stderr.join("") ?? "",
						exitCode: diag?.exitCode,
					}),
				};
			}
		} finally {
			this.startupHandshakeAgents.delete(agentId);
		}
	}

	/** spawn + 首次 get_state；成功才算握手完成。 */
	private async spawnAndGetState(
		agentId: string,
		options: {
			projectPath: string;
			sessionPath?: string;
			deckSessionId?: string;
			trustOverride?: "approve" | "no-approve";
			noSession?: boolean;
			onExit: (payload: { code: number | null; signal: string | null }) => void;
		},
		settingsOverride?: Partial<Pick<AppSettings, "piRpcNoExtensions">>,
	): Promise<{
		client: Awaited<ReturnType<PiProcess["start"]>>;
		process: PiProcess;
		state: RpcResponse;
	}> {
		const runtime = this.agents.get(agentId);
		const existing = runtime?.process;
		// 只复用 createUnlocked 预置、从未 start 的占位进程（diagnostics 仍为 null）。
		// 已退出的旧进程不能复用：再 attach 会叠监听，reattach 必须换新实例。
		// 远端运行时：计划与启动器是 createRemoteUnlocked 准备并经 remoteLaunchByAgent 登记的，
		// 这里只取出来交给 createPiProcess（它据此走 PiProcess 的远端分支）。
		const remoteLaunch = this.remoteLaunchByAgent.get(agentId);
		// 远端 runtime 没有计划 = 准备阶段就失败了（那种 tab 的进程只是错误卡宿主）：绝不让它掉进
		// 本地分支去用远端 cwd 起本机 pi（那是本批最不能出现的静默行为）。
		if (!remoteLaunch && this.isRemoteRuntime(runtime?.tab.projectId ?? "")) throw new Error(REMOTE_RUNTIME_CODES.unavailable);
		let process: PiProcess;
		if (!settingsOverride && existing && !existing.isRunning() && existing.getDiagnostics() === null) {
			process = existing;
		} else {
			process = this.createPiProcess(options.projectPath, options.sessionPath, options.deckSessionId, settingsOverride, agentId, remoteLaunch);
		}
		if (runtime) runtime.process = process;
		process.on("version-check", (payload) => {
			void this.appLogger?.info("agent", "Pi version check completed", {
				agentId,
				...(payload && typeof payload === "object" ? payload : {}),
			});
		});
		// 关键：监听器必须在 process.start() 之前挂上。
		this.attachPiProcessLifecycle(agentId, process, {
			projectPath: options.projectPath,
			onExit: options.onExit,
		});
		const client = await process.start(options.sessionPath, options.trustOverride, options.noSession);
		void this.appLogger?.info("agent", "Agent get_state request start", {
			agentId,
			timeoutMs: this.startupHandshakeTimeoutMs,
		});
		// 启动握手用专用超时（90s 上限），不吃用户给长任务配置的 rpcTimeout：
		// 否则「进程活着但不就绪」要静默等满 10 分钟才报错（见 startupHandshakeTimeoutMs）。
		// 真正的启动失败（spawn 失败 / 进程 exit）由 PiProcess 立即终结 client，毫秒级返回，不等超时。
		const state = await client.request({ type: "get_state" }, this.startupHandshakeTimeoutMs);
		return { client, process, state };
	}

	/** 启动期诊断队列（暂存/落盘/扩展禁用提示）：见 startupDiagnosticsQueue.ts（Wave 4A 迁出）。 */
	private readonly startupDiagnostics: StartupDiagnosticsQueue;
	/** 已 toast 过的「第三方 MCP 接管」扩展 source（本次运行内去重，见 notifyMcpThirdPartyTakeover）。 */
	private readonly mcpThirdPartyNoticesSent = new Set<string>();

	/**
	 * 第三方接管型 MCP 扩展提醒（计划 M3）：pi 0.99 内置 MCP 后，pi-mcp-adapter 等
	 * 注册 /mcp 的扩展会整体顶掉内置 MCP——会话里配置的 mcp.json 不被读取，属「静默能力
	 * 缺失」。双通道：① 首个 run 落时间线系统诊断；② sticky 全局 toast（带 MCP 页导航）。
	 * 仅 pi >= 0.99 提醒（旧版内置 MCP 不存在，adapter 反而是必需品）；DSH 无 pi 扩展不涉及。
	 */
	private async notifyMcpThirdPartyTakeover(agentId: string, piVersion: string | null): Promise<void> {
		if (!this.listThirdPartyMcpExtensions) return;
		if (!piVersionAtLeast(piVersion, "0.99.0")) return;
		const runtime = this.agents.get(agentId);
		let hits: import("../../shared/mcpThirdParty").ThirdPartyMcpExtension[];
		try {
			hits = await this.listThirdPartyMcpExtensions();
		} catch {
			return; // 扩展列表不可用：宁可漏提醒也不在启动链路报错
		}
		// 运行时事实优先：`/mcp` 命令的来源比安装列表更能代表当前会话。
		// 诊断无扩展（piRpcNoExtensions）或被配置停用时 get_commands 里就没有 mcp，
		// 这种情况不能发「当前被接管」的断言。
		const owner = runtime ? await this.resolveMcpCommandOwner(runtime) : null;
		if (runtime && owner && owner.builtin) return;
		const active = hits.filter((hit) => hit.enabled);
		if (active.length === 0) return;
		// mcp.json 里是否有启用的 server 决定文案分档（有 → 现在就受影响；无 → 暂无影响）。
		let hasEnabledServer = false;
		try {
			const snapshot = await this.configManager.getMcpConfig();
			hasEnabledServer = snapshot.servers.some((server) => server.definition.enabled !== false);
		} catch {
			// 配置读取失败按「无 server」分档，避免阻塞提醒
		}
		// 运行时确认了第三方 `/mcp` 时只谈那个来源；没有运行时结论（老版本/探测失败）时按安装列表逐条提醒。
		const confirmedSource = owner && !owner.builtin ? owner.sourcePath : undefined;
		const mentioned = confirmedSource ? active.filter((hit) => confirmedSource.includes(hit.source)) : active;
		if (mentioned.length === 0) return;
		for (const hit of mentioned) {
			const command = hit.isLocalFile ? "" : hit.uninstallCommand;
			// 时间线诊断：由队列决定暂存（首个 run 前）还是直接落盘。
			this.startupDiagnostics.deliver(agentId, {
				role: "system",
				i18nKey: hasEnabledServer ? "diagnostic.mcpThirdParty.takeoverActive" : "diagnostic.mcpThirdParty.takeoverIdle",
				fallbackText: hasEnabledServer
					? `已安装 ${hit.source}，会话中的 MCP 由它接管，PiDeck MCP 页配置的服务器不会被当前会话加载。${command ? `建议卸载：${command}` : ""}`
					: `已安装 ${hit.source}，它会接管 MCP 会话（当前未配置 MCP 服务器，暂无影响）；之后在 PiDeck 配置的 MCP 不会生效。${command ? `建议卸载：${command}` : ""}`,
				options: { params: { source: hit.source, ...(command ? { command } : {}) } },
			});
			// 全局 toast：本次运行每个扩展只弹一次（连续新建会话/进程重连不刷屏）。
			if (this.mcpThirdPartyNoticesSent.has(hit.source)) continue;
			this.mcpThirdPartyNoticesSent.add(hit.source);
			this.emit(agentEventTags.agentsNotice, {
				agentId,
				message: hasEnabledServer ? `你的 MCP 由 ${hit.source} 接管，PiDeck 里配置的服务器不会被本会话加载。` : `${hit.source} 会接管 MCP（当前未配置服务器，暂无影响）；之后在 PiDeck 配的 MCP 不会生效。`,
				i18nKey: hasEnabledServer ? "notice.mcpThirdParty.takeoverActive" : "notice.mcpThirdParty.takeoverIdle",
				i18nParams: { source: hit.source, ...(command ? { command } : {}) },
				kind: hasEnabledServer ? "warning" : "info",
				duration: Number.POSITIVE_INFINITY,
				// 渲染层解析成导航（主进程不持有 UI 路径）：去配置管理 → MCP 页。
				action: "openMcpSettings",
			});
		}
	}

	/**
	 * 某类白名单（扩展/技能/提示词）因超出启动参数预算被跳过：本次「禁用」不生效，必须显式说明。
	 * 与扩展回退同一条启动期诊断链路：首个 run 前暂存，首个 agent_start 后落到时间线正确位置。
	 */
	private notifyWhitelistSkipped(agentId: string, entries: readonly WhitelistSkip[]): void {
		for (const entry of entries) {
			const copy = resolveWhitelistSkipCopy(entry);
			void this.appLogger?.warn("agent", "Whitelist skipped: too many entries for launch args", {
				agentId,
				kind: entry.kind,
				count: entry.count,
				estimatedChars: entry.chars,
				budget: entry.budget,
			});
			this.startupDiagnostics.queueStartupDiagnostic(agentId, {
				role: "system",
				i18nKey: copy.i18nKey,
				fallbackText: copy.fallbackText,
				options: { params: { count: entry.count, budget: entry.budget } },
			});
		}
	}

	/** Windows 主进程文件操作必须使用可由 host 访问的路径。 */
	private toSessionHostPath(sessionPath: string, distro = this.wslEnvironment?.distro): string {
		return distro ? toWindowsHostPath(sessionPath, { distro }) : sessionPath;
	}

	/**
	 * Pi/RPC/session identity 在 WSL 模式下始终使用 Linux 逻辑路径。
	 * 第 12 步：distro 可由调用方显式传入（按项目/会话档案），缺省回退全局环境。
	 */
	private toSessionProtocolPath(sessionPath: string, distro = this.wslEnvironment?.distro): string {
		return distro ? toWslLinuxPath(sessionPath, { distro }) : sessionPath;
	}

	/**
	 * 会话模型目录分流用的窄接口：该 agent 是否跑在远端主机上。
	 * 与 isRemoteRuntime 同一判据（项目 locator），只是把「按 agentId 问」暴露给 IPC 层——
	 * 模型选择器只有 agentId，没有 projectId，不能自己推。
	 */
	isRemoteAgent(agentId: string): boolean {
		return this.isRemoteRuntime(this.agents.get(agentId)?.tab.projectId ?? "");
	}

	/**
	 * 同上，但按项目问：给「没有会话身份的入口」（小窗新建、自动化任务编辑器、引导页草稿）
	 * 判远端用。没有这个，这些入口的模型选择器会默默给出本机目录，而它们最终仍会落到远端会话上。
	 */
	isRemoteProject(projectId: string): boolean {
		return this.isRemoteRuntime(projectId);
	}

	/**
	 * 这条 runtime 是否跑在远端主机上。
	 *
	 * 判据只看项目 locator（远端项目的 cwd 与会话文件都在那台机器上），不另存标记：远端身份在
	 * AgentManager 里没有第二个来源，所有本机路径消费者都必须先问这一个问题。
	 */
	private isRemoteRuntime(projectId: string): boolean {
		const project = this.getProject(projectId);
		return project !== undefined && isRemoteProject(project);
	}

	/**
	 * 本地专属操作的守卫：远端 runtime 的 cwd / 会话文件都在那台机器上，本机 fs/git/终端拿到它们
	 * 只会得到「看起来能用、其实指到别的东西」的结果。
	 *
	 * 为什么抛稳定码而不是返回空：调用方（终端、git、会话文件读写）没有「远端」这一维，静默返回空
	 * 会把「不支持」伪装成「这里没有东西」——用户以为没有快照、没有历史。
	 */
	private assertLocalRuntimeOperation(runtime: AgentRuntime, operation: string): void {
		if (!this.isRemoteRuntime(runtime.tab.projectId)) return;
		void this.appLogger?.warn("agent", "Local-only operation refused for a remote runtime", {
			agentId: runtime.tab.id,
			projectId: runtime.tab.projectId,
			operation,
		});
		throw new Error(REMOTE_RUNTIME_CODES.localOperationUnsupported);
	}

	/**
	 * 会话身份默认值：远端会话**不套 WSL**。
	 *
	 * 远端路径不是 WSL 路径（没有 /mnt 映射，也不随本机 WSL 设置变化）。套上 wsl 身份会有两个后果：
	 * 同一远端会话在「本机 WSL 开/关」两种设置下得到两把 key（重复 runtime），且远端路径被交给
	 * WSL 路径转换（`\\wsl$\…`）后落进本机文件操作。
	 */
	private sessionIdentityDefaultsFor(project: Project | undefined): AgentSessionIdentityDefaults {
		return project && isRemoteProject(project) ? { environment: "native" } : this.getAgentSessionIdentityDefaults();
	}

	/**
	 * 会话身份 key（AgentManager 内部的运行时去重键）。
	 *
	 * 远端会话额外带上 hostId：`buildSessionOriginKey` 的身份是「路径 + 来源 + 本机环境」，而
	 * **同一路径在两台不同主机上是两个不同的会话**。没有 hostId，第二台主机的会话会直接顶掉
	 * 第一台的 runtime（`findRuntimeBySessionKey` 只比这个 key）。
	 */
	private sessionKeyFor(input: AgentSessionKeyInput, defaults: AgentSessionIdentityDefaults): string | undefined {
		const base = buildAgentSessionKey(input, defaults);
		if (!base) return undefined;
		const project = this.getProject(input.projectId);
		return project && isRemoteProject(project) ? `remote:${project.locator.hostId}:${base}` : base;
	}

	/**
	 * 登记远端会话的 catalog 身份（P4.2 收口）：把 pi 上报的远端会话文件交给端口，折成 ssh locator
	 * （hostId + 相对会话根的 remoteSessionId + remotePath）并写进 catalog。
	 *
	 * 为什么只能在这里登记：远端会话文件是 pi 自己选好并在握手 `get_state` 里上报的，PiDeck 创建之前
	 * 根本不知道它叫什么 —— **这是与本地流程的本质差别**（本地会话身份在创建之前就由 catalog 定好）。
	 * 会话根解析与 catalog 写入都只允许有一份实现（scanner / `SessionCatalog.ensureRemoteSession`）。
	 *
	 * 失败一律抛出，由调用方落进与「pi 起不来」同一条错误卡路径：端口没有这个能力（旧装配/替身）时给
	 * 既有稳定码 fail-closed，**绝不**写一条带本机 filePath 的伪记录，也绝不静默当成登记成功。
	 */
	private async registerRemoteSessionIdentity(project: RemoteProject, remotePath: string): Promise<RemoteSessionRegistration> {
		const port = this.remoteRuntime;
		if (!port || typeof port.registerRemoteSession !== "function") throw new Error(REMOTE_RUNTIME_CODES.catalogIdentityUnsupported);
		// 防御性归一化：所有调用点都该给绝对路径（见 reportSessionPathFromPi），但这里绝不允许
		// 「相对路径进了端口」——端口把路径折成身份时只认绝对 POSIX 形状，相对值会以
		// REMOTE_SESSION_LOCATOR_UNRESOLVED 失败，而那个码看不出真正原因是「少了一次归一化」。
		const absolute = isAbsoluteRemoteSessionPath(remotePath) ? remotePath : (resolveRemoteReportedSessionPath(remotePath, project.locator.remotePath) ?? remotePath);
		return port.registerRemoteSession({ hostId: project.locator.hostId, projectId: project.id, projectRemotePath: project.locator.remotePath, remotePath: absolute });
	}

	/** pi 上报的会话文件路径 → 写入 tab 的值（策略见 `agentReportedSessionPath.ts`）。 */
	private reportSessionPathFromPi(reported: string | undefined, projectId: string, environment: SessionEnvironment, fallbackBase: string): string | undefined {
		const project = this.getProject(projectId);
		const remote = this.isRemoteRuntime(projectId);
		return this.reportedSessionPaths.resolve({
			reported,
			remote,
			environment,
			projectPath: fallbackBase,
			// 远端：pi 的相对 sessionDir 按**它自己的 cwd** 解析，而 PiDeck 以项目根为 cwd 拉远端 pi。
			remoteCwd: remote && project !== undefined && isRemoteProject(project) ? project.locator.remotePath : fallbackBase,
		});
	}

	/** 相对 session 路径的归一化 + 日志去重（构造时固定 logger 的 warn 通道）。 */
	private readonly reportedSessionPaths = new ReportedSessionPathResolver((message, detail) => void this.appLogger?.warn("agent", message, detail));

	list() {
		// standby 池化进程对一切 list 消费者不可见（UI 状态、IdleAgentReleaser 等），
		// 否则闲置释放器会把预热进程当普通闲置 agent 释放掉；claim 转正后清标记即可见。
		return [...this.agents.values()]
			.map((runtime) => runtime.tab)
			.filter((tab) => !tab.standby)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	/**
	 * standby 池入口（会话链路在「用户可能马上要新建会话」的时机调用：草稿创建/激活完成、
	 * 启动期补热等）。幂等且「单飞」：池里已有同项目+同指纹条目直接返回；已有预热在跑时
	 * 不再并行 spawn——请求目标（项目/指纹）不同则记为「最新期望目标」，当前预热 settle
	 * （无论成败/取消）后接力补热（单槽池只留最新一个待命进程）。
	 */
	ensureStandbyAgent(projectId: string): void {
		if (!this.settingsStore.get().standbyRuntimeEnabled) return;
		const project = this.getProject(projectId);
		if (!project) return;
		// 远端项目走远端运行时，没有本机 cwd 可池化（与 createStandbyAgent 同一判据）；
		// 不在这里拦住的话，computeStandbyFingerprintFor 会拿到一个没有 path 的项目。
		if (!isLocalProject(project)) return;
		const fingerprint = this.computeStandbyFingerprintFor(project);
		const pooled = this.standbyPool.peek(projectId);
		if (pooled && pooled.fingerprint === fingerprint) return;
		if (this.standbyWarmup.hasPending()) {
			// 已有预热在跑：绝不再并行 spawn 第二个 pi（两次冷启动互相拖慢且双倍内存）。
			// 取消中的预热同样按「进行中」处理——等它 settle 再补热，避免取消/补热交错时漏掉最新请求。
			if (!this.standbyWarmup.matches(projectId, fingerprint) || this.standbyWarmup.isCancelled()) {
				this.standbyWarmup.requestProject(projectId, fingerprint);
				void this.appLogger?.info("agent", "Standby warmup target queued", { projectId, pendingCancelled: this.standbyWarmup.isCancelled() });
			}
			return;
		}
		this.startStandbyWarmup(projectId, fingerprint);
	}

	/** 登记并启动一次后台预热；begin 幂等，已有预热在跑时不重复 spawn。 */
	private startStandbyWarmup(projectId: string, fingerprint: string): void {
		if (!this.standbyWarmup.begin(projectId, fingerprint)) {
			// 竞态兜底：settle 与 finally 接力之间若有人先开始了新预热，把本次目标留在队列里，
			// 等那一次 settle 后再接力——不能静默丢掉「预热进行中又切项目」的最新请求。
			this.standbyWarmup.requestProject(projectId, fingerprint);
			return;
		}
		void this.createStandbyAgent(projectId, fingerprint)
			.catch(() => undefined) // createStandbyAgent 内部已兜底日志，这里只防未处理 rejection
			.finally(() => this.warmLatestRequestedStandby());
	}

	/** 接力：当前预热 settle（无论成败/取消）后，为等待期间记录的最新目标补热一次。 */
	private warmLatestRequestedStandby(): void {
		const requested = this.standbyWarmup.takeRequestedProject();
		if (!requested) return;
		const pooled = this.standbyPool.peek(requested.projectId);
		if (pooled && pooled.fingerprint === requested.fingerprint) return;
		void this.appLogger?.info("agent", "Standby warmup relayed to latest target", { projectId: requested.projectId });
		this.startStandbyWarmup(requested.projectId, requested.fingerprint);
	}

	/**
	 * 丢弃指定项目未被认领的 standby 进程（回收，不是消费）：草稿会话切到非 pi 后端
	 * （生图/生视频/DSH/ACP）时调用——该进程已经服务不了这个会话，继续挂着只能等
	 * 10min TTL 自然到期（用户反馈的「没用到的预加载进程占着内存」）。
	 * 进行中的预热同样取消：它完成时绝不入池，只会被 stop（否则 TTL 到期前泄漏一个不可见进程）。
	 * 只动项目匹配的条目/预热：池是单槽位，同项目另一个新草稿仍可能认领它。
	 * 返回是否真的有条目或预热被丢弃（调用方无需关心失败：没池子/项目不符都当无事发生）。
	 */
	releaseStandbyAgent(projectId: string): boolean {
		const cancelledWarmup = this.standbyWarmup.cancelPending(projectId);
		if (cancelledWarmup) void this.appLogger?.info("agent", "Standby warmup cancelled", { projectId });
		if (this.standbyPool.status()?.projectId !== projectId) return cancelledWarmup;
		const agentId = this.standbyPool.clear();
		if (!agentId) return cancelledWarmup;
		// 与 TTL 到期同一条回收路径（stop 会顺带从 agents map 移除，standby 标记进程对 UI 本就不可见）
		void this.stop(agentId);
		void this.appLogger?.info("agent", "Standby agent released", { agentId, projectId });
		return true;
	}

	/**
	 * 认领 standby：命中（项目一致 + spawn 指纹一致 + 进程仍 idle）则转正返回已握手 tab，
	 * 调用方跳过 createAgent 直接绑定会话；任何不满足都返回 null 回退正常创建。
	 * 会话级代理覆盖（on/off）与飞书绑定是 spawn 时注入的 env，池化进程按全局/未绑定 spawn，
	 * 服务不了这类会话，直接拒绝认领。
	 */
	async claimStandbyAgent(input: { projectId: string; sessionId?: string; noSession?: boolean }): Promise<AgentTab | null> {
		if (!this.settingsStore.get().standbyRuntimeEnabled || input.noSession) return null;
		const project = this.getProject(input.projectId);
		if (!project) return null;
		if (!isLocalProject(project)) return null;
		const proxyMode = this.resolveSessionProxy?.(input.sessionId);
		if (proxyMode === "on" || proxyMode === "off") return null;
		if (this.isFeishuSession?.(input.sessionId) === true) return null;
		if ((await this.projectTrust.resolveTrustWithoutPrompt(project)) === null) return null;
		const fingerprint = this.computeStandbyFingerprintFor(project);
		let entry = this.standbyPool.take(input.projectId, fingerprint);
		// 池里还没有条目，但后台正在为同一项目+同指纹预热：等它 settle 后直接认领，
		// 等待期间绝不再发起第二次 spawn（否则就是「真会话 spawn 与 standby spawn 并行」的原缺陷）。
		// 取消中的预热等不出结果（完成即 stop），直接回退普通 spawn。
		if (!entry && this.standbyWarmup.matches(input.projectId, fingerprint) && !this.standbyWarmup.isCancelled()) {
			void this.appLogger?.info("agent", "Standby claim waiting for in-flight warmup", { projectId: input.projectId, sessionId: input.sessionId, waitMs: STANDBY_CLAIM_WAIT_MS });
			// 记录真实等待时长：这一对事件（waiting → adopted / fell back）是「认领等待省掉了
			// 一次并行 spawn」的唯一直接证据，scripts/standbyWarmupReport.mjs 用它算收益。
			const waitStartedAt = Date.now();
			const settlement = await this.standbyWarmup.waitForClaim(input.projectId, fingerprint, STANDBY_CLAIM_WAIT_MS);
			const waitedMs = Date.now() - waitStartedAt;
			if (settlement?.ok) entry = this.standbyPool.take(input.projectId, fingerprint);
			void this.appLogger?.info("agent", entry ? "Standby claim adopted in-flight warmup" : "Standby claim wait fell back to regular spawn", {
				projectId: input.projectId,
				sessionId: input.sessionId,
				waitedMs,
				// 预热进程已经等了多久才被认领：区分「启动期预热早已就绪」（收益最大）
				// 与「草稿刚触发的预热」（等待时间短、收益小）。
				...(entry ? { warmAgeMs: Date.now() - entry.createdAt } : {}),
				timedOut: settlement === null,
				cancelled: settlement?.cancelled === true,
			});
		}
		if (!entry) return null;
		const runtime = this.agents.get(entry.agentId);
		if (!runtime || runtime.tab.status !== "idle") {
			// 池条目与 agents map 不一致（已崩/被并发停掉）：回收残留，回退正常创建。
			if (runtime) void this.stop(entry.agentId);
			return null;
		}
		runtime.tab.standby = undefined;
		// warmAgeMs = 进程从握手完成到被认领的闲置时长；启动期预热被首个新会话认领时通常最大。
		void this.appLogger?.info("agent", "Standby agent claimed", { agentId: entry.agentId, projectId: input.projectId, sessionId: input.sessionId, warmAgeMs: Date.now() - entry.createdAt });
		this.emitState();
		return runtime.tab;
	}

	/** 后台 spawn 一个 standby：完整走 createUnlocked（信任/扩展回退/握手），成功后登记进池。 */
	private async createStandbyAgent(projectId: string, fingerprint: string): Promise<void> {
		try {
			const project = this.getProject(projectId);
			if (!project) {
				this.standbyWarmup.settle(null);
				return;
			}
			// 池化 = 本机 spawn：远端项目的 pi 进程走远端运行时，没有本机 cwd 可传，也不该本机预热。
			// 与「项目不存在」同样要唤醒等待者，否则等 claim 的会话会白等到超时才回退。
			if (!isLocalProject(project)) {
				this.standbyWarmup.settle(null);
				return;
			}
			// 需要用户交互决策信任的项目不做后台池化（绝不后台弹窗）。
			if ((await this.projectTrust.resolveTrustWithoutPrompt(project)) === null) {
				this.standbyWarmup.settle(null);
				return;
			}
			const tab = await this.createUnlocked({ projectId, standby: true });
			if (this.standbyWarmup.isCancelled()) {
				// 取消路径时序：先 settle(null) 唤醒等待者（它们会回退普通 spawn），再 stop 进程；
				// 绝不 put 进池——否则 TTL 到期前会泄漏一个不可见、也不会被任何人认领的 pi 进程。
				this.standbyWarmup.settle(null);
				void this.stop(tab.id);
				void this.appLogger?.info("agent", "Standby warmup cancelled", { agentId: tab.id, projectId });
				return;
			}
			if (tab.status !== "idle") {
				// createUnlocked 握手失败会带着 error 状态返回 tab：不入池，按失败唤醒等待者。
				this.standbyWarmup.settle(null);
				void this.stop(tab.id);
				void this.appLogger?.warn("agent", "Standby agent spawn failed", { projectId, error: `handshake status: ${tab.status}` });
				return;
			}
			// 成功路径时序关键：先 put 再 settle——等待者被唤醒后会立刻 take，顺序反了就永远 miss。
			this.standbyPool.put({ projectId, fingerprint, agentId: tab.id });
			this.standbyWarmup.settle(tab.id);
			void this.appLogger?.info("agent", "Standby agent ready", { agentId: tab.id, projectId });
		} catch (error) {
			// 预热失败静默降级：下次 ensure 再试，绝不影响正常创建链路。
			this.standbyWarmup.settle(null);
			void this.appLogger?.warn("agent", "Standby agent spawn failed", { projectId, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * 草稿会话的斜杠命令预览（Issue #316）：draft 没有 pi 进程，本地发现只覆盖技能/提示词，
	 * 扩展注册的命令只有活进程的 get_commands 才知道。这里只读借用 standby 池里同项目的
	 * 已握手进程：项目一致 + 指纹仍是新鲜的（与 claim 同一判定）+ 进程 idle，
	 * 不认领、不消费池条目。池关闭/无条目/进程非 idle/RPC 失败一律返回 null，
	 * 渲染层回退本地技能/提示词发现；runtime 建立后仍以本会话 get_commands 为准。
	 */
	async draftCommands(projectId: string): Promise<PiCommand[] | null> {
		if (!this.settingsStore.get().standbyRuntimeEnabled) return null;
		const project = this.getProject(projectId);
		if (!project) return null;
		// standby 池服务的是一次本机 spawn 的 pi 进程：远端项目没有本机 cwd，也从不入池。
		if (!isLocalProject(project)) return null;
		const entry = this.standbyPool.peek(projectId);
		if (!entry || entry.fingerprint !== this.computeStandbyFingerprintFor(project)) return null;
		const runtime = this.agents.get(entry.agentId);
		if (!runtime || runtime.tab.status !== "idle") return null;
		try {
			// 元数据查询用固定短超时（与本文件 get_commands 启发式同约定），
			// 不继承 prompt 级 rpcTimeout（默认 600s）：卡死的 standby 进程不能把
			// 草稿斜杠菜单的预览拖十分钟——预览失败就回退本地发现。
			const response = await runtime.process.client.request({ type: "get_commands" }, 10_000);
			if (!response.success) return null;
			return (response.data as { commands?: PiCommand[] } | undefined)?.commands ?? [];
		} catch {
			return null;
		}
	}

	/**
	 * spawn 指纹：快照所有「只能 spawn 时注入」的输入（PiProcessSettings/扩展列表/模型快照端点/WSL/cwd）。
	 * claim 时不一致即废弃池化进程回退正常创建——这就是「改设置/扩展后何时生效」的答案：
	 * 已在跑的会话照旧（本来就是），下一个 spawn（含新预热）自动用新值。
	 */
	private computeStandbyFingerprintFor(project: LocalProject): string {
		const settings = this.settingsStore.get();
		const modelTrace = getModelTraceServer();
		return computeStandbyFingerprint({
			projectPath: project.path,
			trustMarker: "prompt-free",
			piCliPath: settings.customPiPath,
			offline: Boolean(settings.piRpcOffline),
			noExtensions: Boolean(settings.piRpcNoExtensions),
			noSkills: Boolean(settings.piRpcNoSkills),
			piProxyEnabled: Boolean(settings.piProxyEnabled),
			piProxyUrl: settings.piProxyUrl ?? "",
			piProxyBypass: settings.piProxyBypass ?? "",
			disabledExtensions: (settings.disabledExtensions ?? []).map((entry) => `${entry.scope}:${entry.source}`),
			disabledSkills: settings.disabledSkills ?? [],
			disabledPrompts: settings.disabledPrompts ?? [],
			extensionRoots: createPiProcessExtensionResolvers(project.path, settings).resolveBuiltInExtensionPaths(),
			// 内置技能开关变化只影响 --skill 注入，必须进指纹，否则池化进程会沿用旧技能集。
			bundledSkillPaths: this.bundledSkillResolver?.() ?? [],
			wsl: this.wslEnvironment ? { distro: this.wslEnvironment.distro, user: this.wslEnvironment.user, projectPath: this.toSessionProtocolPath(project.path) } : undefined,
			modelTraceAvailable: modelTrace.ready,
			modelTracePort: modelTrace.ready ? String(modelTrace.listeningPort) : "",
			autoSessionTitle: Boolean(settings.autoSessionTitle),
		});
	}

	/**
	 * 判断指定项目是否仍有运行中的 Agent（pi 子进程未退出）。
	 * 用于删除项目前拦截，避免删除后 pi 进程悬挂后台继续占用资源。
	 * 只看进程是否真的存活：进程退出后 runtime 仍留在 agents 里供 UI 重连（tab.status = closed），
	 * 不按存活判断会让它一直挡住项目删除（issue #360）。
	 * 预热进程（standby）对 UI 不可见且自带 TTL 回收，不算「会话 Agent」，不参与拦截。
	 */
	hasAgentForProject(projectId: string): boolean {
		for (const runtime of this.agents.values()) {
			if (runtime.tab.standby) continue;
			if (runtime.tab.projectId === projectId && runtime.process.isRunning()) return true;
		}
		return false;
	}

	/**
	 * 远端模型目录探测（Phase 5 row 819）的窄接口：只回答「这些远端项目里是否已有一台存活的远端 runtime」，
	 * 命中时只给 agentId。
	 *
	 * 为什么不直接把 runtime 暴露给探测服务：agentId 是本次进程内 RPC 的唯一句柄，探测服务只需要把它交给
	 * 已有 getAvailableModels；项目集合由 main 从 ProjectStore 解析，渲染层没有任何输入能选择 runtime。
	 * 判据与进程监控一致（process.isRunning），并且必须仍是远端项目，避免把本机 runtime 当成远端答案。
	 */
	findLiveRemoteAgentId(projectIds: readonly string[]): string | undefined {
		if (projectIds.length === 0) return undefined;
		const candidates = new Set(projectIds);
		for (const [agentId, runtime] of this.agents) {
			if (!candidates.has(runtime.tab.projectId)) continue;
			if (!runtime.process.isRunning()) continue;
			if (!this.isRemoteRuntime(runtime.tab.projectId)) continue;
			return agentId;
		}
		return undefined;
	}

	/**
	 * 删除项目后丢弃该项目的「进程已退出」runtime，避免内存里残留指向已删项目的幽灵会话。
	 * 存活 runtime 不动：删除前的 hasAgentForProject 已把它们拦下。
	 */
	discardStoppedAgentsForProject(projectId: string): number {
		let discarded = 0;
		for (const [agentId, runtime] of [...this.agents]) {
			if (runtime.tab.projectId !== projectId || runtime.process.isRunning()) continue;
			void this.stop(agentId);
			discarded += 1;
		}
		return discarded;
	}

	getMessages(agentId: string) {
		return this.messages.get(agentId) ?? [];
	}

	/**
	 * 枚举正在运行的 pi agent 子进程（agentId → pid）。
	 * 供进程监控面板使用：仅返回存活进程，退出/未启动的不计入。
	 */
	listAgentPids(): Array<{ agentId: string; pid: number }> {
		const result: Array<{ agentId: string; pid: number }> = [];
		for (const [agentId, runtime] of this.agents) {
			const pid = runtime.process.pid;
			if (pid != null && runtime.process.isRunning()) {
				result.push({ agentId, pid });
			}
		}
		return result;
	}

	/**
	 * 窗口首条消息在会话文件消息下标空间中的位置（无 entryId 窗口的数值游标）。
	 * 消息数组头部可能存在系统摘要卡片（compaction/branchSummary，文件消息空间无对应条目），
	 * 因此用「headOffset + (windowStart - 卡片数)」换算；窗口完全落在卡片区时返回 undefined。
	 */
	private computeWindowStartFilePos(agentId: string, all: ChatMessage[], windowStart: number): number | undefined {
		const headOffset = this.messageHeadOffsetByAgent.get(agentId);
		if (headOffset === undefined || headOffset < 0) return undefined;
		const cardCount = leadingSummaryCards(all, all.length).length;
		const offset = windowStart - cardCount;
		if (offset < 0) return undefined;
		return headOffset + offset;
	}

	/**
	 * 显示窗口视图（2026-08 激活分页）：替换/激活路径的下发与 flush 保持同一协议——
	 * 窗口段消息 + windowStart + totalLength + fileVersion。
	 */
	getMessageWindow(agentId: string): {
		messages: ChatMessage[];
		windowStart?: number;
		totalLength: number;
		fileVersion?: string;
		windowStartFilePos?: number;
	} {
		const all = this.messages.get(agentId) ?? [];
		const windowStart = Math.min(Math.max(0, this.messageEmit.windowStart(agentId)), all.length);
		const fileVersion = this.sessionFileVersionByAgent.get(agentId);
		// 窗口前若存在系统摘要卡片（压缩/分支），prepend 回来——压缩卡片插在数组最前，
		// 不 prepend 会被窗口 slice 切掉（与 buildMessageFlushPayload 全量分支同一约定）。
		const summaryCards = leadingSummaryCards(all, windowStart);
		const windowStartFilePos = this.computeWindowStartFilePos(agentId, all, windowStart);
		return {
			messages: stripToolResultForDelivery([...summaryCards, ...all.slice(windowStart)]),
			totalLength: all.length,
			...(windowStart > 0 ? { windowStart } : {}),
			...(fileVersion ? { fileVersion } : {}),
			...(windowStartFilePos !== undefined ? { windowStartFilePos } : {}),
		};
	}

	/**
	 * 按需读取消息完整文本（「查看完整输出」）：优先运行期工具结果缓存
	 * （ToolMessageAssembler 内的 full text LRU，仅截断下发后的完整文本），回退会话文件定位读取
	 * （SessionHistoryReader 内部有 LRU）。找不到或读取失败抛错，由 IPC 层转结构化错误。
	 */
	async readMessageFullText(agentId: string, messageId: string, entryId?: string): Promise<{ text: string }> {
		const cached = this.toolMessages.readFullText(messageId);
		if (cached !== undefined) return { text: cached };
		const runtime = this.agents.get(agentId);
		const sessionPath = runtime?.tab.sessionPath;
		if (!sessionPath) {
			throw new Error(`Message full text unavailable: session path missing for agent ${agentId}`);
		}
		return this.sessionHistoryReader.readMessageFullText(sessionPath, messageId, entryId);
	}

	/**
	 * 按会话文件路径直接读取单条消息完整文本（不依赖运行期绑定）。
	 * 历史会话浏览（_viewer 投影，无 runtime）的「查看完整输出」走此路径。
	 */
	async readMessageFullTextFromFile(sessionPath: string, messageId: string, entryId?: string): Promise<{ text: string }> {
		return this.sessionHistoryReader.readMessageFullText(sessionPath, messageId, entryId);
	}

	/**
	 * The reader owns persisted JSONL parsing and paging. This facade keeps the
	 * Session-first public contract on AgentManager while runtime remains inactive.
	 */
	async readSessionDisplayMessages(sessionPath: string, agentId = "_viewer", sessionContent?: string, options?: { projectId?: string }): Promise<ChatMessage[]> {
		return stripToolResultForDelivery(await this.sessionHistoryReader.readSessionDisplayMessages(sessionPath, agentId, sessionContent, { entryRendererTypes: this.resolveEntryRendererTypesForProject(options?.projectId) }));
	}

	/**
	 * 「加载窗口」内的历史消息（有界）+ total/windowStart。
	 *
	 * 供 Web 的整量读入口使用：与桌面启动/重载时的窗口口径一致（9 轮 + 条目预算），
	 * 而不是把整份历史一次吐出——大会话全量下发会同时顶爆主进程与渲染层（#213）。
	 * 需要更早历史走轮次分页（readSessionDisplayTurnPage / Web 的 /messages/page）。
	 */
	async readSessionLoadWindow(sessionPath: string, agentId = "_viewer", options?: { projectId?: string }): Promise<{ messages: ChatMessage[]; total: number; windowStart: number }> {
		const window = await this.sessionHistoryReader.readLoadWindow(sessionPath, agentId, AgentManager.DISPLAY_WINDOW_TURNS, AgentManager.MAX_DISPLAY_WINDOW_ENTRIES, { entryRendererTypes: this.resolveEntryRendererTypesForProject(options?.projectId) });
		return { ...window, messages: stripToolResultForDelivery(window.messages) };
	}
	/**
	 * 读取会话文件中的子代理记录（subagents:record custom 条目），并合并
	 * 工具调用推导条目（acp_delegate：billion-context；subagent 工具：nicobailon
	 * pi-subagents）；同 id 时 record 优先（见 mergeSubagentSources 的例外规则）。
	 * options.liveRuntimeStartedAt 透传给读取侧做 start 锚点对账（#300：本代
	 * runtime 派发的锚点合成 running，否则运行中子代理误显「已停止」）。
	 */
	async readSessionSubagentRecords(sessionPath: string, options?: { liveRuntimeStartedAt?: number }) {
		const records = await this.sessionHistoryReader.readSubagentRecords(sessionPath, options);
		const derived = await this.sessionHistoryReader.readDerivedSubagentEntries(sessionPath);
		if (derived.length === 0) return records;
		return mergeSubagentSources(records, derived);
	}

	/**
	 * 会话级 todo 快照：读会话分支上最新 pi-deck-todo custom 条目（历史会话重建任务 tab）。
	 */
	async readSessionTodo(sessionPath: string): Promise<SessionTodoSnapshot | undefined> {
		return this.sessionHistoryReader.readTodoSnapshot(sessionPath);
	}

	/**
	 * 轨迹事实（提示词装载 + 过程事件）：索引选候选 + 小批读正文 + 内容版本缓存。
	 * 文件未变时正文读取为 0；普通消息追加但事实未变时 version 不变。
	 */
	async readSessionFacts(sessionPath: string): Promise<SessionFactsResult> {
		return this.trajectoryFacts.read(sessionPath);
	}

	/** 用户检查点目录（导轨）：活动消息索引派生，超预算裁剪并标记。 */
	async readSessionOutline(sessionPath: string, limit?: number): Promise<SessionOutlineSnapshot> {
		return this.sessionHistoryReader.readSessionOutline(sessionPath, limit);
	}

	/** 轮次维度显示分页：pageSize 复用为轮次数（readSessionDisplayTurnPage 内部夹紧上限） */
	async readSessionDisplayTurnPage(sessionPath: string, agentId = "_viewer", before?: number, turnCount?: number, beforeEntryId?: string, options?: { projectId?: string }): Promise<SessionMessagePage> {
		const page = await this.sessionHistoryReader.readSessionDisplayTurnPage(sessionPath, agentId, before, turnCount, beforeEntryId, { entryRendererTypes: this.resolveEntryRendererTypesForProject(options?.projectId) });
		return { ...page, messages: stripToolResultForDelivery(page.messages) };
	}

	/** 从同一份历史显示索引读取模型/思考元数据，避免再次走 SessionScanner 摘要读取。 */
	async readSessionDisplayMetadata(sessionPath: string): Promise<Pick<SessionMessagePage, "model" | "thinkingLevel">> {
		return this.sessionHistoryReader.readSessionMetadata(sessionPath);
	}

	/** 会话分支树（右侧抽屉「分支」面板）：文件索引读取，不走 get_tree RPC（冻窗风险）。 */
	async readSessionBranchTree(sessionPath: string): Promise<SessionBranchTree> {
		return this.sessionHistoryReader.readBranchTree(sessionPath);
	}

	/** 缓存优先的历史翻页收口在 RuntimeHistoryLoader（游标/锚点规则随域迁出）；薄包装保持调用点不变。 */
	async tryReadRuntimeTurnPage(sessionPath: string, agentId: string, options: { beforeEntryId?: string; before?: number; turnCount?: number }): Promise<SessionMessagePage | null> {
		return this.historyLoader.tryReadRuntimeTurnPage(sessionPath, agentId, options);
	}

	recordHostExchange(agentId: string, userText: string, assistantText: string) {
		this.addMessage(agentId, "user", userText);
		this.addMessage(agentId, "assistant", assistantText);
	}

	/**
	 * Agent 的工作目录。
	 *
	 * 消费方全是本机实现（终端 node-pty 的 cwd、飞书文件发送的路径解析）：远端会话必须在此
	 * fail-closed，绝不把远端项目根交给本机 shell。
	 */
	getCwd(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "cwd");
		return runtime.tab.cwd;
	}

	/** 历史窗口加载收口在 RuntimeHistoryLoader（读盘/裁剪/投影/entryId 对齐随域迁出）。 */
	async loadMessages(agentId: string, skipEntries = false, earlyMessagesPromise?: Promise<RpcResponse>, options?: { preserveMessagesAfter?: number }) {
		return this.historyLoader.loadMessages(agentId, skipEntries, earlyMessagesPromise, options);
	}

	/**
	 * 计算激活显示窗口起点：尾部 DISPLAY_WINDOW_TURNS 轮，且总条目数不超 MAX_DISPLAY_WINDOW_ENTRIES。
	 *
	 * 统一入口：loadMessages / flushMessageEmit / trimRuntimeCache 三处口径必须一致，
	 * 否则窗口坐标与 windowStartFilePos（渲染层「加载更多」的数值游标）会错位。
	 * 页边界永远对齐完整轮次（单轮再大也整轮保留，至少保最后一轮）。
	 */
	private computeDisplayWindowStart(messages: ReadonlyArray<{ role?: string }>): number {
		return boundTurnWindowStart(
			messages.map((message) => ({ role: message.role, byteLength: 0 })),
			messages.length,
			AgentManager.DISPLAY_WINDOW_TURNS,
			AgentManager.MAX_DISPLAY_WINDOW_ENTRIES,
		);
	}

	/** 压缩后重载的单飞锁随域迁入 RuntimeHistoryLoader。 */
	private reloadMessagesAfterCompaction(agentId: string) {
		this.historyLoader.reloadMessagesAfterCompaction(agentId);
	}

	async create(rawInput: CreateAgentInput) {
		const project = this.getProject(rawInput.projectId);
		const remote = project !== undefined && isRemoteProject(project);
		// 远端会话身份不套 WSL（理由见 sessionIdentityDefaultsFor）：在这里归一化，让
		// 「身份 key / creatingSessionAgents 去重 / tab 字段」三处从同一个输入出发。
		let input = remote ? { ...rawInput, environment: "native" as const, wslDistro: undefined, wslUser: undefined } : rawInput;
		// 第 12 步：按输入身份转换路径，不固定使用全局环境（缺字段时仍回退全局）。
		const createWslDistro = input.environment === "wsl" ? (input.wslDistro ?? this.wslEnvironment?.distro) : undefined;
		if (rawInput.sessionLocator) {
			const sessionPath = this.sessionLocatorRouter.resolveFilePath(rawInput.sessionLocator);
			if (!sessionPath) throw new Error("SESSION_LOCATOR_FILE_REQUIRED");
			input = { ...input, sessionPath: remote ? sessionPath : this.toSessionProtocolPath(sessionPath, createWslDistro) };
		} else if (rawInput.sessionPath) {
			// 远端会话文件是那台机器上的绝对 POSIX 路径：不得过本机 WSL 转换（\\wsl$ 形状不是远端路径）。
			input = { ...input, sessionPath: remote ? rawInput.sessionPath : this.toSessionProtocolPath(rawInput.sessionPath, createWslDistro) };
		}
		const sessionKey = this.sessionKeyFor(input, this.sessionIdentityDefaultsFor(project));
		if (!sessionKey) return this.createUnlocked(input);

		const existingForSession = this.findRuntimeBySessionKey(sessionKey);
		if (existingForSession) return existingForSession.tab;

		const pendingCreate = this.creatingSessionAgents.get(sessionKey);
		if (pendingCreate) return pendingCreate;

		// 历史会话激活属于“一个 sessionPath 只能对应一个 Agent”的业务规则；
		// 先登记 in-flight Promise，再启动真实创建，防止第二次点击绕过 agents map 检查。
		const createPromise = this.createUnlocked(input).finally(() => {
			this.creatingSessionAgents.delete(sessionKey);
		});
		this.creatingSessionAgents.set(sessionKey, createPromise);
		return createPromise;
	}

	private getAgentSessionIdentityDefaults(): AgentSessionIdentityDefaults {
		return this.wslEnvironment
			? {
					environment: "wsl",
					wslDistro: this.wslEnvironment.distro,
					wslUser: this.wslEnvironment.user,
				}
			: { environment: "native" };
	}

	private getHistoryAutoLoadDecision(sessionPath?: string): { shouldLoad: boolean; sizeBytes?: number } {
		if (!sessionPath) return { shouldLoad: true };
		try {
			const sizeBytes = statSync(this.toSessionHostPath(sessionPath)).size;
			return {
				shouldLoad: sizeBytes <= AgentManager.MAX_AUTO_HISTORY_LOAD_BYTES,
				sizeBytes,
			};
		} catch {
			// 无法读取大小时保留旧行为尝试加载，避免临时文件/权限异常直接导致历史不可见。
			return { shouldLoad: true };
		}
	}

	private async readRecentMessagesFromSessionFile(sessionPath: string, maxTurns: number): Promise<RpcResponse> {
		return this.sessionHistoryReader.readRecentMessages(sessionPath, maxTurns);
	}

	private async scanCompactions(sessionPath: string, sessionContent?: string) {
		return this.sessionHistoryReader.scanCompactions(sessionPath, sessionContent);
	}

	private findRuntimeBySessionKey(sessionKey: string) {
		const defaults = this.getAgentSessionIdentityDefaults();
		return [...this.agents.values()].find(
			(runtime) =>
				// standby 只能经 claimStandbyAgent 转正；普通 create 复用它会在绑定后仍被 list/getAgentId 忽略。
				!runtime.tab.standby &&
				this.sessionKeyFor(
					{
						projectId: runtime.tab.projectId,
						sessionPath: runtime.tab.sessionPath,
						environment: runtime.tab.sessionEnvironment,
						source: runtime.tab.sessionSource,
						wslDistro: runtime.tab.wslDistro,
						wslUser: runtime.tab.wslUser,
						importedSourceId: runtime.tab.importedSourceId,
					},
					defaults,
				) === sessionKey,
		);
	}

	/**
	 * 远端项目的会话创建（Phase 4 P4.2 产品路由）。
	 *
	 * 与 `createUnlocked` 走**同一条**流水线（会话身份 key、既有 runtime 复用、tab、事件桥、
	 * agents.set、emitState、握手），分叉只有两处：
	 * 1. 「进程从哪里起来」：plan + launcher 全部来自装配注入的远端运行时端口；
	 * 2. 「哪些本机步骤不参与」：项目 trust 预检、会话文件修复、会话路径归一化、本地历史读取。
	 *
	 * 为什么第 2 条是硬要求：`locator.remotePath` 与 pi 报回来的会话文件都在那台机器上。把它们
	 * 当本机路径处理**不会报错**（stat 到本机同名路径，或 ENOENT 被吞掉），只会静默落到完全
	 * 不同的东西上 —— 这是 Phase 4 最贵的失败形态。
	 */
	private async createRemoteUnlocked(input: CreateAgentInput, project: RemoteProject): Promise<AgentTab> {
		const t0 = Date.now();
		// 端口缺省 = 正式包 / 未注入：远端项目在这里**没有**本机回退。用既有稳定码拒绝
		// （与「非本地项目不得当本机路径」同一个码：语义都是「这个位置在这里跑不了」）。
		if (!this.remoteRuntime) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		// 远端会话的 catalog 身份（P4.2 收口）：身份就在端口上（见 registerRemoteSession：scanner 的
		// 会话根解析 + `SessionCatalog.ensureRemoteSession` 这一条正门）。端口没有这个能力（旧装配 /
		// 测试替身）时与以前同一个稳定码 fail-closed——这条判据刻意留在 prepare 之前：能拒绝就不要
		// 先拉起一个远端进程，更不写一条带本机 filePath 的伪记录。
		if (input.deckSessionId && typeof this.remoteRuntime.registerRemoteSession !== "function") throw new Error(REMOTE_RUNTIME_CODES.catalogIdentityUnsupported);

		const hostId = project.locator.hostId;
		const remoteCwd = project.locator.remotePath;
		// 远端会话身份**不套 WSL**（见 sessionIdentityDefaultsFor）；create() 已对远端输入归一化，
		// 这里再钉一次，保证 tab 字段与身份 key 同源。
		const sessionIdentityDefaults: AgentSessionIdentityDefaults = { environment: "native" };
		const sessionEnvironment: SessionEnvironment = "native";
		const id = randomUUID();
		void this.appLogger?.info("agent", "Agent create requested", {
			agentId: id,
			projectId: input.projectId,
			hostId,
			remoteCwd,
			sessionPath: input.sessionPath,
			title: input.title,
			location: "remote",
		});
		const existingForSessionKey = this.sessionKeyFor({ ...input, environment: sessionEnvironment, wslDistro: undefined, wslUser: undefined }, sessionIdentityDefaults);
		const existingForSession = existingForSessionKey ? this.findRuntimeBySessionKey(existingForSessionKey) : undefined;
		if (existingForSession) {
			void this.appLogger?.info("agent", "Agent create reused existing session", {
				agentId: existingForSession.tab.id,
				hostId,
				sessionPath: input.sessionPath,
			});
			return existingForSession.tab;
		}

		const tab: AgentTab = {
			id,
			projectId: project.id,
			// 远端项目根：任何本机消费者（git/终端/会话文件读写）必须先过 isRemoteRuntime/isLocalProject。
			cwd: remoteCwd,
			title: input.title || `${project.name} agent`,
			status: "starting",
			deckSessionId: input.deckSessionId,
			sessionPath: input.sessionPath,
			sessionEnvironment,
			sessionSource: input.source ?? "pi",
			// 这条路径的 runtimePlan.kind 恒为 "remote-ssh"（launch.plan 由 buildRemotePiRuntimePlan 构造）。
			// 本字段（P4.2 起的字段名）现在只表示「这条会话的远端项目 trust 由 PiDeck 的决策表管理」，
			// 因此是渲染层「要不要显示 trust 条」的判据；四种展示态由决策表合成。
			// 具体传什么 flag 不在这里决定：远端运行时端口每次 prepare 现读决策（P4.4b），未决策就一个都不传。
			// 本机/WSL 分支不写这个字段。
			remoteTrustUnhandled: true,
			// 不写 wslDistro/wslUser/importedSourceId：它们是本机（WSL/导入器）身份，远端会话没有这些维度。
			noSession: input.noSession,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		let launch: { plan: RemoteSshPiRuntimeLaunchPlan; launcher: PiRuntimeLauncher };
		try {
			// 远端安全门读的是快照文件：先把本机快照落盘（幂等），否则首次 spawn 会因「读不到字节」
			// 把安全门从注入面拿掉（安全等级随后失效，但 UI 会如实隐藏）。
			await this.securityStore?.ensureSnapshotWritten();
			// 远端事实（解释器 / pi 入口 / runner 路径）先取，再在构造点验 plan 形状：
			// 门禁关闭/服务没建起来 → REMOTE_RUNTIME_UNAVAILABLE；主机没就绪 → SSH_HOST_NOT_READY；
			// pi 探测失败 → REMOTE_PI_*；本机路径混进 plan → REMOTE_RUNTIME_PATH_INVALID。
			const prepared = await this.remoteRuntime.prepare({
				hostId,
				remoteCwd,
				...(input.sessionPath === undefined ? {} : { sessionFile: input.sessionPath }),
				...(input.noSession ? { noSession: true } : {}),
				// 与本地 `securitySessionId: securitySessionKey ?? sessionPath` 同一取值：扩展只用它查
				// sessionLevels 字典，从不 fs 打开；远端历史会话没有 deckSessionId 时用远端会话文件路径。
				...(input.deckSessionId === undefined && input.sessionPath === undefined ? {} : { sessionId: input.deckSessionId ?? input.sessionPath }),
			});
			const { plan } = prepared;
			// 注入面跟着 tab 走（agents:state → 渲染层能力门）：UI 只认“实际注入了什么”，不认“应该能”。
			tab.remoteExtensions = prepared.extensions;
			launch = { plan, launcher: this.remoteRuntime.createLauncher() };
			// 远端 plan 的 args 是「这次到底用什么会话文件起的 pi」的唯一权威记录（runner 的 plan 走 stdin，
			// lease 里也没有 argv）——排「重启后是否真的接回同一会话」这类问题时，只看 app 日志就能定案。
			void this.appLogger?.info("agent", "Remote pi runtime plan prepared", { agentId: id, hostId, args: plan.args.join(" "), extensions: prepared.extensions.applied.join(",") || prepared.extensions.reason || "none" });
		} catch (error) {
			// 准备失败走**与本地「pi 起不来」同一条**错误卡路径：调用方（协调器/渲染层）看到的是会话
			// 启动失败 + 稳定码，而不是「会话正常起来了但什么都没发生」——更绝不允许回退本机 pi。
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Remote agent prepare failed", {
				agentId: id,
				projectId: project.id,
				hostId,
				remoteCwd,
				error: rawMessage,
			});
			// 诊断占位进程：这一步没有任何可运行的远端计划（这正是失败原因），所以它只是一个**错误卡宿主**
			// ——不注入任何本地专属准备、从未也绝不会被 start()（见 spawnAndGetState 的远端守卫）。
			this.agents.set(id, { tab, process: new PiProcess(remoteCwd, this.settingsStore.get()) });
			this.messages.set(id, []);
			// 远端环境没准备好（pi/node/shell PATH 三类）时说清具体原因与下一步，而不是只丢一个稳定码。
			const discoveryKey = remotePiDiscoveryCopyKey(rawMessage) ?? remoteSessionCodeCopyKey(rawMessage);
			this.addLocalizedMessage(id, "error", discoveryKey ?? "diagnostic.agentStartFailed", discoveryKey ? this.translate(discoveryKey) : "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, null),
			});
			this.emitState();
			return tab;
		}
		this.remoteLaunchByAgent.set(id, launch);
		const t2 = Date.now();

		void this.appLogger?.info("agent", "Agent pi process start", { agentId: id, location: "remote", hostId });
		// 与本地一致：spawn 前异步刷新模型列表缓存。它是本机 pi 目录的刷新，不吃本次的远端 cwd；
		// 远端 pi 自己的模型目录属 P4.3。
		this.onBeforeAgentSpawn?.();
		this.agents.set(id, { tab, process: this.createPiProcess(remoteCwd, input.sessionPath, undefined, undefined, id, launch) });
		this.messages.set(id, []);
		this.emitState();

		let handshake: Awaited<ReturnType<AgentManager["handshakePiProcess"]>>;
		try {
			handshake = await this.handshakePiProcess(id, {
				// 远端项目根：`projectPath` 的消费者只有日志与生命周期事件归属，不是本机文件路径。
				projectPath: remoteCwd,
				sessionPath: input.sessionPath,
				deckSessionId: input.deckSessionId,
				// 远端 trust 不在这里传（也不再需要本机那套 override 参数）：决策由远端运行时端口在
				// prepare 时按 trust key 现读，未决策 ⇒ plan 里不出现任何 trust flag。
				noSession: input.noSession,
				onExit: (payload) => this.handleCreateProcessExit(id, tab, payload),
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent pi process start threw", {
				agentId: id,
				projectId: project.id,
				hostId,
				remoteCwd,
				error: rawMessage,
				diagnostics: failedProcess?.getDiagnostics(),
			});
			this.addLocalizedMessage(id, "error", "diagnostic.agentStartFailed", "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, failedProcess?.getDiagnostics() ?? null),
			});
			this.emitState();
			return tab;
		}
		const { process, fallbackFromExtensions } = handshake;
		const t3 = Date.now();
		const diag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process spawned", {
			agentId: id,
			location: "remote",
			hostId,
			prepareMs: t1 - t0,
			launchPrepareMs: t2 - t1,
			spawnCallMs: t3 - t2,
			command: diag?.command,
			args: diag?.args?.join(" "),
			cwd: diag?.cwd,
			fallbackFromExtensions,
		});
		// 白名单因条数过多被跳过：远端 plan 不带白名单注入，所以这里只做形状对齐（当前恒空）。
		if (diag?.whitelistSkipped && diag.whitelistSkipped.length > 0) {
			this.notifyWhitelistSkipped(id, diag.whitelistSkipped);
		}

		try {
			void this.appLogger?.info("agent", "Agent get_state request completed", { agentId: id, location: "remote" });
			const state = handshake.state;
			const t4 = Date.now();
			void this.appLogger?.info("agent", "Agent get_state completed", {
				agentId: id,
				stateMs: t4 - t3,
				totalSinceCreateMs: t4 - t0,
			});
			const data = state.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
			tab.sessionId = data?.sessionId;
			// pi 报回来的会话文件在远端：只做 POSIX 归一化（相对 sessionDir 会被 pi 报成相对 cwd），
			// 绝不用本机规则。它既是下一次 spawn（restart）的 `--session <远端路径>`，也是 catalog
			// 身份的 remotePath —— 两种用途都要求绝对形状。
			tab.sessionPath = this.reportSessionPathFromPi(data?.sessionFile ?? input.sessionPath, tab.projectId, sessionEnvironment, remoteCwd);
			// catalog 身份登记（P4.2 收口）：会话文件是 pi 自己选好并在握手 `get_state` 里上报的，
			// PiDeck 创建之前根本不知道它叫什么 —— 所以登记必然晚于 runtime 起来，**这是与本地流程的
			// 本质差别**（本地会话身份在创建之前就由 catalog 定好）。
			if (input.deckSessionId && tab.sessionPath) {
				const registration = await this.registerRemoteSessionIdentity(project, tab.sessionPath);
				const locator = registration.record.locator;
				// record 就是这条远端会话的 catalog 身份；tab 仍说「远端路径」这一种语言
				// （ssh locator 的 remotePath），不因登记退化成一条本机 filePath。
				if (locator?.kind === "ssh") tab.sessionPath = locator.remotePath;
			}
			const piSessionName = data?.sessionName && !looksLikePiSessionFileStem(data.sessionName) ? data.sessionName : undefined;
			tab.title = input.title || piSessionName || (input.sessionPath ? this.translate("session.historyTitle", { project: project.name }) : `${project.name} agent`);
			tab.status = "idle";
			// 远端历史不在本机（本批）：**不加载**。本机 reader 读不到远端文件；pi 的 get_messages
			// 会把整段历史打成单行 JSON 冻住主进程（见 loadMessages 的注释），也不是退路。
			// 远端历史窗口读取属下一批（`RemoteWorkspaceReader` 有界窗口）。
			this.recordTiming("agent.create", t0, {
				agentId: id,
				location: "remote",
				historyLoading: "unsupported",
				fallbackFromExtensions,
			});
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				hostId,
				totalMs: Date.now() - t0,
				historyLoading: "unsupported",
				fallbackFromExtensions,
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				hostId,
				sessionPath: input.sessionPath,
				error: rawMessage,
			});
			// 身份登记失败（REMOTE_SESSION_LOCATOR_UNRESOLVED 等）也是「远端起不来」：给可读文案，
			// 否则用户只能看到稳定码，根本不知道是远端 pi 的会话目录配置问题。
			const createKey = remoteSessionCodeCopyKey(rawMessage);
			this.addLocalizedMessage(id, "error", createKey ?? "diagnostic.agentStartFailed", createKey ? this.translate(createKey) : "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, failedProcess?.getDiagnostics() ?? null),
			});
		}

		this.emitState();
		return tab;
	}

	/**
	 * Agent spawn 前的资源配置迁移保证（index.ts 注入；幂等）。
	 * 为什么必须在 spawn 前：旧禁用记录一旦退出白名单就再无生效途径，未迁移就启动
	 * 等于把用户停用的资源重新加载（见执行计划 A5）。
	 */
	private resourceMigrationGate?: (projectId?: string) => Promise<void>;

	configureResourceMigrationGate(gate: (projectId?: string) => Promise<void>): void {
		this.resourceMigrationGate = gate;
	}

	private async createUnlocked(input: CreateAgentInput) {
		const t0 = Date.now();
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		// 远端项目（Phase 4 P4.2）：cwd 在远端，走独立的远端分支；没有注入远端运行时端口时
		// 分支内直接 fail-closed（UNSUPPORTED_PROJECT_LOCATION），绝不拿远端 cwd 去起本机 pi。
		// 放在资源迁移之前：迁移读的是本机项目目录上的旧禁用记录，远端项目没有本机目录。
		if (isRemoteProject(project)) return this.createRemoteUnlocked(input, project);
		// 走到这里 project 已窄化为 LocalProject（远端已在上一行分工，其它位置类型由编译器点名）。
		// 先迁移该项目作用域的旧禁用记录；失败不阻塞启动（迁移内部已记录，且旧记录会被保留）。
		await this.resourceMigrationGate?.(project.id).catch(() => undefined);

		const sessionIdentityDefaults = this.getAgentSessionIdentityDefaults();
		const sessionEnvironment = input.environment ?? sessionIdentityDefaults.environment;
		const id = randomUUID();
		void this.appLogger?.info("agent", "Agent create requested", {
			agentId: id,
			projectId: input.projectId,
			projectPath: project.path,
			sessionPath: input.sessionPath,
			title: input.title,
		});
		const existingForSessionKey = this.sessionKeyFor(input, sessionIdentityDefaults);
		const existingForSession = existingForSessionKey ? this.findRuntimeBySessionKey(existingForSessionKey) : undefined;
		if (existingForSession) {
			void this.appLogger?.info("agent", "Agent create reused existing session", {
				agentId: existingForSession.tab.id,
				sessionPath: input.sessionPath,
			});
			return existingForSession.tab;
		}

		const tab: AgentTab = {
			id,
			projectId: project.id,
			cwd: project.path,
			title: input.title || `${project.name} agent`,
			status: "starting",
			deckSessionId: input.deckSessionId,
			sessionPath: input.sessionPath,
			sessionEnvironment,
			sessionSource: input.source ?? "pi",
			wslDistro: input.wslDistro ?? (sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslDistro : undefined),
			wslUser: input.wslUser ?? (sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslUser : undefined),
			importedSourceId: input.importedSourceId,
			noSession: input.noSession,
			standby: input.standby ? true : undefined,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		const trustOverride = await this.projectTrust.ensureProjectTrust(project);
		const t2 = Date.now();

		void this.appLogger?.info("agent", "Agent pi process start", { agentId: id });
		// 每次 spawn 前异步刷新模型列表缓存（不等完成，避免阻塞 Agent 启动）：
		// 用户直接编辑 models.json/auth.json 后，下一次启动的 Agent 即能看到新模型。
		this.onBeforeAgentSpawn?.();
		// 第 12 步：WSL 会话把档案里的 distro/user 作为本次 spawn 的覆盖值，
		// 让 PiProcess 用正确发行版解析命令与路径；缺字段才回退全局设置。
		const wslSpawnOverride = sessionEnvironment === "wsl" && tab.wslDistro !== undefined && tab.wslUser !== undefined ? { wslEnabled: true, wslDistro: tab.wslDistro, wslUser: tab.wslUser } : undefined;
		this.agents.set(id, { tab, process: this.createPiProcess(project.path, input.sessionPath, input.deckSessionId, wslSpawnOverride, id) });
		this.messages.set(id, []);
		this.emitState();

		let handshake: Awaited<ReturnType<AgentManager["handshakePiProcess"]>>;
		try {
			handshake = await this.handshakePiProcess(id, {
				projectPath: project.path,
				sessionPath: input.sessionPath,
				deckSessionId: input.deckSessionId,
				trustOverride,
				noSession: input.noSession,
				onExit: (payload) => this.handleCreateProcessExit(id, tab, payload),
			});
		} catch (error) {
			// start() 同步失败（非法 cwd、spawn 抛错等）也要落到会话错误卡，而不是 IPC 裸抛。
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent pi process start threw", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
				diagnostics: failedProcess?.getDiagnostics(),
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			this.addLocalizedMessage(id, "error", "diagnostic.agentStartFailed", "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, failedProcess?.getDiagnostics() ?? null),
			});
			this.emitState();
			return tab;
		}
		const { process, fallbackFromExtensions } = handshake;
		const t3 = Date.now();
		const diag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process spawned", {
			agentId: id,
			prepareMs: t1 - t0,
			trustMs: t2 - t1,
			spawnCallMs: t3 - t2,
			command: diag?.command,
			args: diag?.args?.join(" "),
			cwd: diag?.cwd,
			fallbackFromExtensions,
		});

		try {
			void this.appLogger?.info("agent", "Agent get_state request completed", { agentId: id });
			const state = handshake.state;
			const t4 = Date.now();
			void this.appLogger?.info("agent", "Agent get_state completed", {
				agentId: id,
				stateMs: t4 - t3,
				totalSinceCreateMs: t4 - t0,
			});
			const data = state.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
			tab.sessionId = data?.sessionId;
			tab.sessionPath = this.reportSessionPathFromPi(data?.sessionFile ?? input.sessionPath, project.id, sessionEnvironment, project.path);
			const piSessionName = data?.sessionName && !looksLikePiSessionFileStem(data.sessionName) ? data.sessionName : undefined;
			tab.title = input.title || piSessionName || (input.sessionPath ? this.translate("session.historyTitle", { project: project.name }) : `${project.name} agent`);
			tab.status = "idle";
			// 历史一律从 JSONL 尾部读最近 N 轮，禁止 get_messages：
			// pi 会把整段历史打成单行 JSON，主进程 JSON.parse 会冻住窗口按钮。
			// Agent 可用只依赖 get_state；历史后台加载，加载期间新消息由 preserveMessagesAfter 保护。
			const historyLoadDecision = this.getHistoryAutoLoadDecision(tab.sessionPath);
			const preserveMessagesAfter = Date.now();
			this.startupDiagnostics.notifyExtensionsDisabled(id, {
				fallbackFromExtensions,
				debugDetails: handshake.fallbackDebug,
			});
			// 第三方接管型 MCP 扩展提醒（M5b）：异步、不 await，绝不阻塞 Agent 就绪。
			void this.notifyMcpThirdPartyTakeover(id, diag?.piVersion ?? null);
			// standby 的 sessionPath 是 pi 预分配的新文件（尚未落盘），当历史加载只会报假错误。
			if (tab.sessionPath && !tab.standby) {
				void this.loadMessages(id, true, this.readRecentMessagesFromSessionFile(tab.sessionPath, AgentManager.MAX_HISTORY_LOAD_TURNS), { preserveMessagesAfter })
					.then(() => {
						void this.appLogger?.info("agent", "Agent recent history loaded from file", {
							agentId: id,
							sessionPath: tab.sessionPath,
							sizeBytes: historyLoadDecision.sizeBytes,
							totalMs: Date.now() - preserveMessagesAfter,
						});
					})
					.catch((error) => {
						const list = this.messages.get(id) ?? [];
						const loadingMessage = list.find((message) => message.meta?.historyLoading === true);
						if (loadingMessage) {
							loadingMessage.role = "error";
							loadingMessage.text = "历史会话加载失败，可继续使用当前 Agent 或重新打开会话重试。";
							loadingMessage.meta = {
								historyLoading: "failed",
								i18nKey: "diagnostic.historyLoadFailed",
								debugDetails: error instanceof Error ? error.message : String(error),
							};
							loadingMessage.timestamp = Date.now();
							this.scheduleMessageEmit(id, true);
						}
						void this.appLogger?.warn("agent", "Agent recent history file load failed", {
							agentId: id,
							sessionPath: tab.sessionPath,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
			this.recordTiming("agent.create", t0, {
				agentId: id,
				historyLoading: "background",
				fallbackFromExtensions,
			});
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				totalMs: Date.now() - t0,
				historyLoading: "background",
				fallbackFromExtensions,
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
			});
			this.addLocalizedMessage(id, "error", "diagnostic.agentStartFailed", "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, failedProcess?.getDiagnostics() ?? null),
			});
		}

		this.emitState();
		return tab;
	}

	async rename(agentId: string, name: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmed = name.replace(/\s+/g, " ").trim();
		if (!trimmed) throw new Error(this.translate("mainAgent.nameRequired"));

		// 会话名属于 pi 原生 session 元数据；通过 RPC 修改，避免 desktop 手写 JSONL 后与 pi 格式演进脱节。
		const response = await runtime.process.client.request({ type: "set_session_name", name: trimmed }, 20_000);
		if (!response.success) {
			void this.appLogger?.warn("agent", "Session rename failed", {
				agentId,
				error: response.error,
			});
			throw new Error(this.translate("mainAgent.renameFailed"));
		}

		this.applyRuntimeTitle(agentId, trimmed, false);
		const state = await runtime.process.client.request({ type: "get_state" }, 10_000).catch(() => ({ data: undefined }));
		const data = state.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
		runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
		runtime.tab.sessionPath = this.reportSessionPathFromPi(data?.sessionFile ?? runtime.tab.sessionPath, runtime.tab.projectId, runtime.tab.sessionEnvironment ?? "native", this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd);
		this.applyRuntimeTitle(agentId, data?.sessionName || runtime.tab.title, false);
		this.emitState();
		return runtime.tab;
	}

	/**
	 * 发送边界的隐藏标记守卫（P4.4 扩展面）。
	 *
	 * plan/goal 的实现载体是 `agentMessage` 里的隐藏标记：远端没注入对应扩展时没人识别它，
	 * 标记会**原样进 prompt** 且只读工具集不生效——比“入口消失”更糟（用户以为模式生效了）。
	 * 所以这里做一道与 UI 无关的兜底：`applied` 里没有该扩展 ⇒ 退回用户可见原文。
	 *
	 * 只对“已上报注入面”的会话生效（远端）；本机/DSH 的 `remoteExtensions` 是 undefined，行为不变。
	 */
	/**
	 * 解析实际发给 pi 的 prompt 文本（远端扩展降级 / 智能体隐藏通道 / 纯图片发送共用的唯一入口）。
	 *
	 * 优先级：智能体隐藏通道 agentMessage > 用户输入；两者都空时（纯图片发送，Issue #404）
	 * 保持空串——禁止注入 "Describe this image." 之类的兜底文案，那是用户没写过的指令。
	 */
	private resolveSendAgentMessage(runtime: AgentRuntime, input: SendPromptInput): string {
		const fallback = input.message.trim();
		const raw = input.agentMessage?.trim() || fallback;
		const extensions = runtime.tab.remoteExtensions;
		if (extensions === undefined) return raw;
		const applied = new Set(extensions.applied);
		for (const entry of PI_DECK_MODE_MARKER_EXTENSIONS) {
			if (!raw.includes(entry.marker) || applied.has(entry.extension)) continue;
			void this.appLogger?.warn("agent", "Dropped composer mode marker: extension not injected", {
				agentId: runtime.tab.id,
				mode: entry.mode,
				extension: entry.extension,
				applied: extensions.applied,
			});
			return fallback || raw;
		}
		return raw;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		const trimmed = input.message.trim();
		const hasImages = input.images && input.images.length > 0;
		// 纯图片发送（无文字）时 message 就是空字符串：pi 会把空文本与图片一起写进用户
		// 消息，各 provider 自行丢弃空 text block（anthropic / openai 均按 text.trim()
		// 过滤），模型只看到图片。禁止注入 "Describe this image." 之类的兜底文案
		// （Issue #404）——那是用户没写过的指令，会让模型改按「描述图片」回答。
		const agentMessage = this.resolveSendAgentMessage(runtime, input);
		// 允许只有图片没有文字的情况发送
		if (!trimmed && !hasImages) {
			return {
				accepted: false,
				error: "消息不能为空",
				i18nKey: "diagnostic.messageRequired",
			};
		}

		// 解析 !/!! 前缀：与 pi 终端行为一致
		// !command  → 执行命令并将输出发送给 LLM（excludeFromContext: false）
		// !!command → 执行命令但不将输出发送给 LLM（excludeFromContext: true）
		const isBashExcluded = trimmed.startsWith("!!");
		const isBashNormal = !isBashExcluded && trimmed.startsWith("!");

		if (isBashExcluded || isBashNormal) {
			const command = isBashExcluded ? trimmed.slice(2).trim() : trimmed.slice(1).trim();
			if (command) {
				return this.executeBashCommand(input.agentId, command, isBashExcluded);
			}
		}

		// 判断 agent 是否已在忙碌中；运行中继续发送时必须带 streamingBehavior，
		// 否则 pi RPC 会拒绝请求。该值也用于给用户消息打上投递语义标记。
		// 除本地 tab 状态外并入 pi 侧权威信号（Issue #371）：abort RPC 超时后本地已被
		// 复位 idle，而 pi 仍在流式，只信本地状态会漏传 streamingBehavior 被直接拒收。
		const alreadyBusy = runtime.tab.status === "running" || this.piMightStillBeStreaming(input.agentId);

		const statusBeforePrompt = runtime.tab.status;
		const promptDeliveryBehavior = input.streamingBehavior ?? (alreadyBusy ? "steer" : undefined);

		// 在设置状态为 running 之前检查进程是否还活着，避免进程崩溃后状态不一致
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addLocalizedMessage(input.agentId, "error", "diagnostic.agentStopped", errorMessage);
			// 进程已退出但 tab 仍是旧状态：用户发送被拒是「状态非正常」的触发点之一。
			// 进程 exit 事件另有「Pi process exit」日志，这里补记录发送动作被拒时的
			// 状态快照与退出码，便于确认置 error 的确切时机与原因。
			const diag = runtime.process.getDiagnostics() ?? null;
			void this.appLogger?.warn("agent", "Prompt rejected: process not running", {
				agentId: input.agentId,
				statusBeforeReject: runtime.tab.status,
				exitCode: diag?.exitCode ?? null,
				exitSignal: diag?.exitSignal ?? null,
			});
			this.emitState();
			return { accepted: false, error: errorMessage, i18nKey: "diagnostic.agentStopped" };
		}

		runtime.tab.status = "running";
		this.emitState();

		// 用户未回答挂起的 Ask 提问却直接发送新消息：先取消所有挂起 UI 请求（见
		// cancelPendingUIRequests）。否则 pi 事件循环仍阻塞在 extension_ui_response 上，
		// 新 prompt 进入 steer 队列也永远不会被消费，悬浮 Ask 卡片也不会消失。
		this.uiGate.cancelPendingUIRequests(input.agentId);

		// 乐观更新：在等待 RPC 返回前先把用户消息写入会话，让用户立即看到自己的消息。
		// 只展示用户原文；agentMessage 里的宿主指令不进 UI 气泡。
		// 如果后续 RPC 失败，再追加错误消息；用户消息本身仍保留在聊天中（用户确已发送）。
		const optimisticMeta = {
			...(promptDeliveryBehavior ? { streamingBehavior: promptDeliveryBehavior } : {}),
			// 与渲染层乐观气泡共用 requestId：发送完成立刻中断再删时，
			// 删除按钮仍拿着乐观 id，不能再另起 UUID 导致 Message not found。
			...(input.requestId ? { requestId: input.requestId } : {}),
		};
		this.addMessage(input.agentId, "user", trimmed || this.translate("session.imagePlaceholder"), Object.keys(optimisticMeta).length > 0 ? optimisticMeta : undefined, input.images);

		// streamingBehavior 只在 agent 忙碌时需要；UI 可以显式传 steer/followUp 以复用 pi 队列语义。
		// 当前端排队 flush 连续发送多条消息时，第一条会触发 agent_start 使 agent 变忙碌，
		// 后续消息必须带 streamingBehavior 否则 pi 直接返回 error。这里自动兜底。
		// images 用于传递粘贴/拖拽的图片，pi 会将 base64 图片直接传给支持视觉的模型。
		try {
			// prompt 前不再发 get_commands 预检：pi 0.99 起 prompt 成功响应自带
			// data.disposition（CHANGELOG 0.99.0 #9098），"handled" 即「被扩展命令 /
			// input handler 消费、没有启动运行」的权威信号，且省掉一次 RPC 往返。
			// 老版本 pi 没有该字段 → 回退到 get_commands 启发式（见下方 undefined 分支）。
			const requestPayload: Record<string, unknown> = {
				type: "prompt",
				message: agentMessage,
				...(input.description ? { description: input.description } : {}),
				...(hasImages ? { images: input.images } : {}),
			};
			// 如果 agent 已经忙碌且调用方没指定 streamingBehavior，默认用 steer；
			// 与上方用户消息 meta 保持同一个计算结果，避免 UI 标记和实际 RPC 语义不一致。
			if (promptDeliveryBehavior) {
				requestPayload.streamingBehavior = promptDeliveryBehavior;
			}
			// 使用用户配置的 RPC 超时时间，因为用户提示词可能触发长时间运行的命令或复杂操作
			const rpcStartedAt = Date.now();
			// 空闲会话首轮从 RPC 发出计时；运行中提交的 steer/follow-up 到实际
			// turn_start 才起表，避免队列等待或上一轮工具耗时污染下一次模型调用。
			if (!alreadyBusy) this.messagePerf.notePromptRequested(input.agentId, rpcStartedAt);
			void this.appLogger?.info("session-perf", "Prompt RPC request started", {
				agentId: input.agentId,
				requestId: input.requestId,
			});
			const response = await runtime.process.client.request(requestPayload, this.settingsStore.get().rpcTimeout);
			void this.appLogger?.info("session-perf", "Prompt RPC response received", {
				agentId: input.agentId,
				requestId: input.requestId,
				success: response.success,
				rpcMs: Date.now() - rpcStartedAt,
			});
			if (!response.success) {
				const rejectionText = response.error ?? "图片消息发送失败";
				// 兜底重发（Issue #371）：本地判定空闲但 pi 实际仍在流式时，prompt 被
				// "Agent is already processing" 拒收。用户点的是发送，不该收到 SDK 原文
				// toast——按设置项 busySendDelivery 补一次带语义的 prompt（默认 steer）。
				const busyRetryBehavior = !promptDeliveryBehavior && isPiBusyRejection(rejectionText) ? parseBusySendDelivery(this.settingsStore.get().busySendDelivery) : undefined;
				let busyRetryResponse: RpcResponse | undefined;
				if (busyRetryBehavior) {
					const retryPayload = { ...requestPayload, streamingBehavior: busyRetryBehavior };
					void this.appLogger?.warn("agent", "Prompt rejected as busy; retrying with streamingBehavior", {
						agentId: input.agentId,
						requestId: input.requestId,
						streamingBehavior: busyRetryBehavior,
					});
					const retry = await runtime.process.client.request(retryPayload, this.settingsStore.get().rpcTimeout);
					busyRetryResponse = retry;
					if (retry.success) {
						// 重发成功：用户消息已按队列语义投递，走与正常发送相同的收尾。
						await this.settleAcceptedPrompt(input.agentId, runtime, agentMessage, retry.data, alreadyBusy);
						return { accepted: true };
					}
				}
				if (!alreadyBusy) this.messagePerf.discardInFlight(input.agentId);
				// pi RPC 会把不支持图片、忙碌队列参数缺失等前置错误作为 success:false 返回；
				// 必须显式显示出来，否则 UI 会停在"已发送但无响应"的状态。
				// 忙碌拒收的重发也失败时，用重发的错误原文（更能反映 pi 当前状态）。
				const errorMessage = busyRetryBehavior ? (busyRetryResponse?.error ?? rejectionText) : rejectionText;
				runtime.tab.status = statusBeforePrompt === "running" ? "running" : "idle";
				this.addLocalizedMessage(input.agentId, "error", "diagnostic.promptRejected", "消息发送失败。", { debugDetails: errorMessage });
				// pi 侧前置校验拒绝（模型不支持图片/队列参数缺失等）：气泡只展示给用户，
				// 记一条 warn 便于核对「同一消息反复被拒」是否与 RPC 参数/模型能力相关。
				void this.appLogger?.warn("agent", "Prompt rejected by pi RPC", {
					agentId: input.agentId,
					requestId: input.requestId,
					error: errorMessage,
				});
				this.emitState();
				return {
					accepted: false,
					error: errorMessage,
					i18nKey: "diagnostic.promptRejected",
					debugDetails: errorMessage,
				};
			}

			await this.settleAcceptedPrompt(input.agentId, runtime, agentMessage, response.data, alreadyBusy);
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// prompt RPC 调用前已通过同步 write() 写入 pi stdin；此处所有异常都只说明
			// preflight 响应未到达，无法证明 pi 没有接收。返回 unknown，renderer 会永久禁用
			// 该快照的重试/编辑/取消，防止用户把同一条消息提交两次。
			runtime.tab.status = statusBeforePrompt === "running" ? "running" : "error";
			this.addLocalizedMessage(input.agentId, "error", "diagnostic.promptDeliveryUnknown", "消息接收结果未知。请先检查当前会话，避免重复发送；必要时重启 Agent。", { debugDetails: errorMessage });
			// prompt RPC 抛异常（超时/连接断开/响应丢失）：状态可能被置 error，必须留痕，
			// 与 session-perf 的 request started 配对才能还原「请求发出→无响应」链路。
			void this.appLogger?.error("agent", "Prompt RPC threw", {
				agentId: input.agentId,
				requestId: input.requestId,
				error: errorMessage,
			});
			this.emitState();
			return {
				accepted: false,
				error: errorMessage,
				delivery: "unknown",
				i18nKey: "diagnostic.promptDeliveryUnknown",
				debugDetails: errorMessage,
			};
		}
	}

	/**
	 * 执行 bash 命令并通过 tool 消息展示输出，行为与 pi 终端的 !/!! 前缀一致。
	 * excludeFromContext 控制输出是否作为上下文发送给 LLM。
	 */
	private async executeBashCommand(agentId: string, command: string, excludeFromContext: boolean): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(agentId);
		const statusBeforeCommand = runtime.tab.status;

		// 检查进程是否还活着
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addLocalizedMessage(agentId, "error", "diagnostic.agentStopped", errorMessage);
			// 与 sendPrompt 同款留痕：!/!! 命令被拒时记下进程诊断快照，
			// 避免「终端命令无效」在 applog 里无迹可寻。
			const diag = runtime.process.getDiagnostics() ?? null;
			void this.appLogger?.warn("agent", "Command rejected: process not running", {
				agentId,
				command,
				statusBeforeReject: runtime.tab.status,
				exitCode: diag?.exitCode ?? null,
				exitSignal: diag?.exitSignal ?? null,
			});
			this.emitState();
			return { accepted: false, error: errorMessage, i18nKey: "diagnostic.agentStopped" };
		}

		runtime.tab.status = "running";
		this.emitState();

		try {
			const response = await runtime.process.client.request(
				{
					type: "bash",
					command,
					excludeFromContext,
				},
				60_000,
			);

			if (!response.success) {
				const errorMessage = response.error ?? "命令执行失败";
				this.addLocalizedMessage(agentId, "error", "diagnostic.commandFailed", "命令执行失败。", { debugDetails: errorMessage });
				return {
					accepted: false,
					error: errorMessage,
					i18nKey: "diagnostic.commandFailed",
					debugDetails: errorMessage,
				};
			}

			this.addMessage(agentId, "user", `${excludeFromContext ? "!!" : "!"}${command}`);
			const data = response.data as
				| {
						output?: string;
						exitCode?: number;
						cancelled?: boolean;
						truncated?: boolean;
				  }
				| undefined;

			const output = data?.output ?? "";
			const exitCode = data?.exitCode ?? 0;
			const cancelled = data?.cancelled ?? false;

			if (cancelled) {
				this.addLocalizedMessage(agentId, "system", "diagnostic.commandCancelled", "命令已取消");
			} else {
				// 以 tool 消息展示命令输出，与 pi 终端的 bash 结果展示保持一致
				const toolMessage = formatBashToolMessage({
					command,
					output,
					exitCode,
					excludeFromContext,
					translate: (key, params) => this.translate(key, params),
				});
				this.addMessage(agentId, "tool", toolMessage.text, toolMessage.meta);
			}
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// bash 请求也在计时前写入 stdin；异常只能判定响应未知。对于可能有副作用的命令，
			// 把它标成可重试失败会比保守阻止重试更危险。
			runtime.tab.status = statusBeforeCommand === "running" ? "running" : "error";
			this.addLocalizedMessage(agentId, "error", "diagnostic.commandDeliveryUnknown", "命令接收结果未知。请先检查命令输出或工作区状态，避免重复执行。", { debugDetails: errorMessage });
			return {
				accepted: false,
				error: errorMessage,
				delivery: "unknown",
				i18nKey: "diagnostic.commandDeliveryUnknown",
				debugDetails: errorMessage,
			};
		} finally {
			if (runtime.tab.status !== "error") {
				runtime.tab.status = statusBeforeCommand === "running" ? "running" : "idle";
			}
			this.emitState();
		}
	}

	/** 中止当前回合并撤回队列；await 后核对原 runtime/回合，不能误停下一轮。 */
	async abort(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const runtimeProcess = runtime.process;
		const runtimeIdentity = this.streamRuntimeTriple(agentId);

		// 连点退避：上一次 abort 的 RPC 链（clear_queue 3s + abort 10s）仍在窗口内时不再重跑。
		// 每次点击都完整重跑会把 RPC 管道堆满，pi 本来就收不到 stdin，重发只是雪上加霜；
		// 但用户「再点一次」的意图要保留，所以只补发一条 abort RPC（幂等）并直接返回。
		const previousAbortAt = this.lastAbortAtByAgent.get(agentId);
		// 只在「上一次 abort 还没 settled」时退避：已 settled 后的点击属于新一轮，照常走完整链。
		if (previousAbortAt !== undefined && this.abortGate.hasSettledFallback(agentId) && Date.now() - previousAbortAt < AgentManager.ABORT_REPEAT_COOLDOWN_MS) {
			this.lastAbortAtByAgent.set(agentId, Date.now());
			this.lastUserAbortAt.set(agentId, Date.now());
			runtime.process.client.request({ type: "abort" }, 10_000).catch((error: unknown) => {
				void this.appLogger?.warn("agent", "Repeat abort RPC failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return;
		}

		// pi 在等待 extension_ui_response 时（如 ask_question），不发 abort 也能处理，
		// 但必须解除 pending 请求的阻塞，否则 pi 不会继续读取 stdin 中的后续命令。
		// 取消语义（value:null 解阻塞 + 广播 completed）见 cancelPendingUIRequests，
		// abort 与「未作答直接发送新消息」两条路径共用同一实现。
		this.uiGate.cancelPendingUIRequests(agentId);

		// 标记最近中止的 agent，用于抑制 auto-retry/compaction 把状态重新标为 running。
		// 必须在发送 abort RPC 之前加入集合，避免事件处理函数在 RPC 发出后、
		// handlePiEvent 返回前收到管道中的旧事件并重建 assistant 消息。
		this.recentlyAborted.add(agentId);
		// 两个时间戳语义不同、都要记：
		// - lastAbortAtByAgent：退出处理器识别「终止窗口内的进程退出」，按会话文件重连而非打成 closed
		// - lastUserAbortAt：压缩取消时区分「自己打断」与「扩展接管」（resolveCompactCancelMessage）
		this.lastAbortAtByAgent.set(agentId, Date.now());
		// pi 的 abort() 内部会 abortCompaction()，故用户打断与压缩取消共用这个时刻。
		this.lastUserAbortAt.set(agentId, Date.now());
		this.setAgentTurnActive(agentId, false);
		// 封印当前 stream generation：比 recentlyAborted 更硬，不依赖 activeAssistantMessageIds 例外条件，
		// 残留 thinking/text/tool 事件在 abort settled 前一律丢弃。
		this.sealAgentStream(agentId);
		this.messagePerf.discardInFlight(agentId);
		this.scheduleAbortSettledFallback(agentId);

		// abort 升级上下文：记录 abort 时是否有工具在执行 + RPC ack 状态。
		// pi 的 abort RPC 要等会话 idle 才响应，ack 迟到 ≠ 卡死；升级逻辑据此避免补刀。
		const hadActiveTool = Boolean(this.toolExecutingByAgent.get(agentId) || (this.activeToolCallsByAgent.get(agentId)?.size ?? 0) > 0);
		const escalation = this.abortGate.beginEscalation(agentId, hadActiveTool);

		// pi 的交互 Esc 语义（pi docs/rpc-commands.md「clear_queue」段）：先 clear_queue 再 abort。
		// abort 只停当前 run，队列里剩余的 steering/followUp 消息会被继续投递并另起
		// run——只发 abort 的现象是「用户点了停止，排队的消息还在跑」。
		// clear_queue 自 pi 0.85.1 提供；更低版本回 unknown-command error，静默降级为
		// abort-only 的旧行为（见 clearQueueBeforeAbort），停止主路径不受影响。
		const clearedQueue = await this.clearQueueBeforeAbort(runtime, agentId);
		// clear_queue 的响应可能晚于关闭/重建/换绑，不得为旧 runtime 外发状态或发 abort。
		if (this.agents.get(agentId) !== runtime || runtime.process !== runtimeProcess || runtime.tab.deckSessionId !== runtimeIdentity.sessionId || runtime.tab.runtimeGeneration !== runtimeIdentity.runtimeGeneration) return;
		if (clearedQueue) {
			// 同一会话即使已开始新回合，撤回文本也须回填；agentId 是宿主桥路由的必要身份。
			this.emit("agents:queue-cleared", { agentId, ...runtimeIdentity, ...clearedQueue });
		}
		if (!this.abortGate.isCurrentEscalation(agentId, escalation)) return;

		runtime.process.client
			.request({ type: "abort" }, 10_000)
			.then(() => {
				this.abortGate.markAbortAcked(agentId, escalation);
			})
			.catch((error) => {
				this.abortGate.markAbortFailed(agentId, escalation);
				// abort 超时或失败不影响前端状态切换，但必须留痕：abort 失败后
				// pi 可能仍在流式输出而 UI 已显示停止，是排查状态错位的关键线索。
				void this.appLogger?.warn("agent", "Abort RPC failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			});

		// Pending dialogs are runtime-only, so clearing their request map is enough
		// （cancelPendingUIRequests 内部已清除）。abort 后续的清流式状态不受影响。
		// abort 时必须清除所有流式状态，防止后续 pi 的延迟事件（text_delta、thinking_delta、tool_execution_* 等）
		// 修改上次会话的旧消息，导致新会话消息混入被中止的旧输出。
		// 先把已累积思考落入当前 assistant 骨架（保留中断轮的推理），再清 live 通道。
		this.finalizeThinkingIntoMessage(agentId);
		this.flushMessageEmit(agentId);
		this.liveStream.finishThinkingChannel(agentId);
		this.activeAssistantMessageIds.delete(agentId);
		this.streamingAgents.delete(agentId);
		this.liveStream.clearTextChannel(agentId);
		this.toolMessageIds.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.set(agentId, null);
		// abort 直接清本地工具状态时必须同步发送 false 边沿，
		// 否则 renderer 可能只收到 idle，却继续保留旧的工具 spinner。
		if (hadActiveTool) this.emitToolRuntimeTransition(agentId, false);
		// 同步清除 streaming 标志，避免停止后“正在工具调用/正在回应”延迟到 settled 才消失。
		this.emitStreamingStatePatch(agentId);
		// 取消节流中的 message 推送，避免 abort 后还有 pending flush 把旧内容刷回 UI。
		this.cancelMessageEmit(agentId);

		runtime.tab.status = "idle";
		// 停止反馈改 toast，不再写入会话时间线：
		// 1) 系统状态卡片太抢眼；2) 插在 assistant 中间会打断 agent-run 分组，放大“消息串台”体感。
		this.emit(agentEventTags.agentsNotice, {
			agentId,
			message: "已请求停止当前响应",
			i18nKey: "app.abortRequested",
			kind: "info",
			duration: 2500,
		});
		this.emitState();
	}

	/**
	 * abort 前撤回 pi 的排队消息（steering / followUp）——pi 交互 Esc 语义的 RPC 复刻。
	 *
	 * pi docs/rpc-commands.md「clear_queue」：Esc = clear_queue + abort。abort 只停当前
	 * run，队列里剩余的消息会被继续投递并另起 run，故 busy 时用户点停止必须先把队列撤干净。
	 * 返回值非 null 时调用方广播 agents:queue-cleared，由渲染层写回输入框。
	 *
	 * 容错：clear_queue 自 pi 0.85.1 提供，更低版本回 unknown-command error——此时静默
	 * 降级为 abort-only 的旧行为（队列残留），不阻断停止主路径。超时取 3s：本地 RPC 正常
	 * 毫秒级返回；僵死进程下 abort 至多迟 3s，且 abort 本身仍会发出。
	 */
	private async clearQueueBeforeAbort(runtime: AgentRuntime, agentId: string): Promise<{ steering: string[]; followUp: string[] } | null> {
		try {
			const response = await runtime.process.client.request({ type: "clear_queue" }, 3_000);
			const data = response.data;
			if (!isRecord(data)) return null;
			const readTexts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []);
			const steering = readTexts(data.steering);
			const followUp = readTexts(data.followUp);
			if (steering.length === 0 && followUp.length === 0) return null;
			return { steering, followUp };
		} catch (error) {
			// <0.85.1 的 pi 不认识 clear_queue；abort 是停止核心路径，不能因它失败/超时被拖住。
			void this.appLogger?.warn("agent", "clear_queue before abort failed; falling back to abort-only", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * 手动触发上下文压缩。pi 会将历史消息摘要化以释放 context 空间，
	 * 适用于长时间对话后 context 占比过高、但不想丢失关键信息的场景。
	 *
	 * 实现与失败语义（含「等待超时≠压缩失败」与进程退出自动重连）在 pi/compactionRunner.ts；
	 * 这里只保留同名包装，调用方签名与返回契约不变。
	 */
	async compact(agentId: string, prompt?: string): Promise<AgentRuntimeState> {
		return this.compaction.compact(agentId, prompt);
	}

	/**
	 * 判定「手动压缩被取消」的来源，返回 shared/compactFeedback 里的稳定标记文案；
	 * 判不出来时返回 undefined（原样抛 pi 错误，渲染层归到 cancelled 仍会提示）。
	 *
	 * pi 侧同一个 `Compaction cancelled` 有两个来源（agent-session.js）：扩展钩子
	 * `session_before_compact` 返回 `{cancel:true}`（1507 行）、以及压缩期间被
	 * `session.abort()` 打断（1537 行）。可用的客观差别只有两个：
	 *
	 * 1. 我们自己发过 abort（PiDeck 的停止按钮）→ 是用户自己打断的；
	 * 2. 钩子拒绝发生在生成摘要**之前**：compaction_start → compaction_end 几乎无耗时
	 *    （扩展在钩子里直接 return，不会走 LLM 调用）。真正的压缩必然是秒级起步。
	 *
	 * 判不出的情况（例如 compaction_end 事件丢了、或别的路径 abort）不硬猜，
	 * 让渲染层给中性提示，日志里仍有 compactionCancelEvidence 供排查。
	 */
	private resolveCompactCancelMessage(agentId: string, errorMessage: string): string | undefined {
		if (!/cancel/i.test(errorMessage)) return undefined;
		const observation = this.lastCompactionObservation.get(agentId);
		// 观测过期（上次压缩是很久以前）不能用来解释这次取消。
		const fresh = observation && Date.now() - observation.at <= COMPACT_OBSERVATION_MAX_AGE_MS ? observation : undefined;
		const abortedAt = this.lastUserAbortAt.get(agentId) ?? 0;
		const referenceAt = fresh?.at ?? Date.now();
		if (abortedAt > 0 && referenceAt - abortedAt <= COMPACT_USER_ABORT_WINDOW_MS) {
			return COMPACT_CANCELLED_BY_USER_ABORT;
		}
		if (fresh?.aborted === true && typeof fresh.elapsedMs === "number" && fresh.elapsedMs <= COMPACT_HOOK_REJECT_MAX_MS) {
			return COMPACT_CANCELLED_BY_OWNER;
		}
		return undefined;
	}

	/** 压缩取消的排查证据（写进 applog；不改任何状态）。 */
	private compactionCancelEvidence(agentId: string): Record<string, unknown> {
		const observation = this.lastCompactionObservation.get(agentId);
		const abortedAt = this.lastUserAbortAt.get(agentId);
		return {
			lastCompactionReason: observation?.reason,
			lastCompactionAborted: observation?.aborted,
			lastCompactionElapsedMs: observation?.elapsedMs,
			userAbortAgoMs: abortedAt ? Date.now() - abortedAt : undefined,
		};
	}

	/** 空注册集合：项目未知/扫描失败时退回「全部 custom 条目默认隐藏」（与 pi 口径一致）。 */
	private static readonly NO_ENTRY_RENDERER_TYPES: readonly string[] = [];

	/**
	 * 会话时间线扩展输出卡的可见性集合：本次会话加载的扩展里 registerEntryRenderer 注册的 customType。
	 * 读取路径不持有 runtime，只能按项目磁盘配置推导——与 spawn 同源的 resolveLoadableExtensionPaths
	 * （原生过滤 + PiDeck 禁用记录），再对入口文件做 registerEntryRenderer 静态扫描（见
	 * extensionEntryRendererScan.ts）。扫描/解析失败按空集合处理（默认隐藏），不影响读历史本身。
	 */
	private resolveEntryRendererTypesForProject(projectId?: string): readonly string[] {
		try {
			const project = projectId ? this.getProject(projectId) : undefined;
			if (!project?.path) return AgentManager.NO_ENTRY_RENDERER_TYPES;
			return collectEntryRendererTypes(
				resolveLoadableExtensionPaths({
					cwd: project.path,
					includeProjectResources: true,
					disabled: this.settingsStore.get().disabledExtensions ?? [],
					removedBuiltInExtensions: this.settingsStore.get().removedBuiltInExtensions ?? [],
					builtInRoots: {
						appPath: app.getAppPath(),
						resourcesPath: process.resourcesPath,
						isDev: !app.isPackaged,
						overlayDir: resolveBuiltInExtensionsOverlayDir(app.getPath("userData")),
					},
				}),
			);
		} catch (error) {
			this.appLogger?.warn("agent", "Failed to scan entry renderer types, custom entries default hidden", { projectId, error: String(error) });
			return AgentManager.NO_ENTRY_RENDERER_TYPES;
		}
	}

	/**
	 * 接管探测的宿主编排点（实现见 pi/compactionRunner.ts）：保留同名方法，
	 * 压缩链路经宿主回调调用它，因此实例可替换（装配与测试都按此形态注入）。
	 */
	private async resolveSessionCompactionOwnership(runtime: AgentRuntime): Promise<PiCompactionOwnership | undefined> {
		return this.compaction.probeSessionCompactionOwnership(runtime);
	}

	/** `get_commands` 原始条目（带 source/sourceInfo）；失败返回 undefined。 */
	private async listRegisteredCommands(runtime: AgentRuntime): Promise<Array<{ name: string; source?: string; sourcePath?: string }> | undefined> {
		const response = await runtime.process.client.request({ type: "get_commands" }, 10_000).catch(() => undefined);
		const commands = (response?.data as { commands?: unknown[] } | undefined)?.commands;
		if (!Array.isArray(commands)) return undefined;
		return commands
			.filter((command): command is Record<string, unknown> => typeof command === "object" && command !== null)
			.map((command) => {
				const sourceInfo = typeof command.sourceInfo === "object" && command.sourceInfo !== null ? (command.sourceInfo as { path?: unknown }) : undefined;
				return {
					name: typeof command.name === "string" ? command.name : "",
					source: typeof command.source === "string" ? command.source : undefined,
					sourcePath: typeof sourceInfo?.path === "string" ? sourceInfo.path : undefined,
				};
			})
			.filter((command) => command.name.length > 0);
	}

	/**
	 * 当前会话的 `/mcp` 命令是否来自 pi 内置扩展。
	 * `get_commands` 的 `sourceInfo.path` 对内置扩展是 `builtin:mcp`，第三方接管是扩展文件路径。
	 * 返回 null = 无法确认（老版本/探测失败），调用方应降级而不是断言。
	 */
	private async resolveMcpCommandOwner(runtime: AgentRuntime): Promise<{ builtin: boolean; sourcePath?: string } | null> {
		const commands = await this.listRegisteredCommands(runtime);
		if (!commands) return null;
		const mcp = commands.find((command) => command.name === "mcp");
		if (!mcp) return null;
		const path = mcp.sourcePath ?? "";
		return { builtin: path === "builtin:mcp", ...(path ? { sourcePath: path } : {}) };
	}

	/**
	 * 进程退出后重新附加到同一会话：创建新的 PiProcess 并替换旧的进程引用。
	 * 在压缩导致 pi 进程自动重启后调用，保持同一 agentId 可继续对话。
	 *
	 * 与 create() 中创建过程的区别：不重新分配 agentId、不解绑项目，
	 * 只替换底层的 pi 进程和 RPC 客户端，保留所有消息和 tab 状态。
	 */
	private async reattachProcess(agentId: string, sessionPath: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error("Agent not found: " + agentId);

		const project = this.getProject(runtime.tab.projectId);
		if (!project) throw new Error("Project not found");
		// 远端会话同样支持自动重连：launch 计划在 create 时就登记进了 `remoteLaunchByAgent`，握手直接复用它
		// （远端没有计划时 `handshakePiProcess` 会抛 `REMOTE_RUNTIME_UNAVAILABLE`——绝不会掉进本机 pi）。
		// 与本地只差两处语义，见下方 `isRemote` 分叉：路径不归一化、历史不加载。
		const isRemote = !isLocalProject(project);
		// 远端重连必须**用当前会话文件重新 prepare 计划**：create 时那份计划没有 `--session`（那时 pi 还没
		// 报出会话文件），直接拿 map 里的旧计划重拉会开出**新会话**而不是接回原会话。`restart` 同样走这条。
		if (isRemote) {
			const hostId = isRemoteProject(project) ? project.locator.hostId : undefined;
			const remoteRuntime = this.remoteRuntime;
			if (!hostId || !remoteRuntime) throw new Error(REMOTE_RUNTIME_CODES.unavailable);
			const prepared = await remoteRuntime.prepare({
				hostId,
				remoteCwd: runtime.tab.cwd,
				sessionFile: sessionPath,
				// 与 create 同一取值顺序（与本地 securitySessionId 同源）；重连也可能拿到新的会话文件。
				...(runtime.tab.deckSessionId === undefined && sessionPath.length === 0 ? {} : { sessionId: runtime.tab.deckSessionId ?? sessionPath }),
			});
			// 重连可能换主机环境（版本/快照），注入面随之更新；UI 必须跟着变，不能留旧的能力门。
			runtime.tab.remoteExtensions = prepared.extensions;
			this.remoteLaunchByAgent.set(agentId, { plan: prepared.plan, launcher: remoteRuntime.createLauncher() });
		}

		void this.appLogger?.info("agent", "Reattaching process", {
			agentId,
			sessionPath,
			location: isRemote ? "remote" : "local",
		});
		const { deckSessionId, runtimeGeneration } = runtime.tab;
		const assertCurrentRuntime = (process: PiProcess) => {
			// 握手也会等待：关闭或另一次重连后，不得发布旧历史/诊断或恢复已关闭的 tab。
			if (this.agents.get(agentId) !== runtime || runtime.process !== process) {
				process.stop();
				throw new Error("Compaction cancelled: runtime changed");
			}
			if (runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Compaction cancelled: runtime changed");
		};

		const handshake = await this.handshakePiProcess(agentId, {
			// 远端：`projectPath` 的消费者只有日志与生命周期事件归属，不是本机文件路径——create 同样
			// 传远端 cwd（`project.path` 在远端项目上不存在，也不再能靠 `isLocalProject` 收窄）。
			projectPath: isRemote ? runtime.tab.cwd : project.path,
			sessionPath,
			deckSessionId: runtime.tab.deckSessionId,
			onExit: (payload) => this.handleReattachProcessExit(agentId, runtime, payload),
		});
		const process = handshake.process;
		assertCurrentRuntime(process);
		const restartDiag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process restarted", {
			agentId,
			command: restartDiag?.command,
			args: restartDiag?.args?.join(" "),
			cwd: restartDiag?.cwd,
			fallbackFromExtensions: handshake.fallbackFromExtensions,
		});

		try {
			const stateResponse = handshake.state;
			const data = stateResponse.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			// 远端与本地走同一个归一化入口：远端只做 POSIX 归一化（相对 sessionDir 会报相对路径），
			// 本地走平台规则。原样采用远端值会让下一次 spawn 的 `--session` 与 catalog 身份对不上。
			runtime.tab.sessionPath = this.reportSessionPathFromPi(data?.sessionFile ?? sessionPath, runtime.tab.projectId, runtime.tab.sessionEnvironment ?? "native", runtime.tab.cwd);
			runtime.tab.status = "idle";
			// 进程退出型压缩可能来不及发 compaction_end；重连成功即表示 Pi 已可继续接收消息。
			this.rpcCompactingAgents.delete(agentId);

			// 重连成功后清除自动重连标记，允许下一次再触发
			this.autoRestartAttempted.delete(agentId);

			// 如果有旧的 pending abort 标记，清理掉
			this.abortedDuringAsk.delete(agentId);

			// 重连期间用户可能已发送消息（乐观上屏）：必须保护，否则替换投影时未落盘消息丢失。
			// 远端跳过：本批不加载远端历史（create 同标 `historyLoading: "unsupported"`），且本机 reader
			// 读不到远端文件——拉一次只会白跑并可能把空页写进缓存。
			if (!isRemote) await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
			assertCurrentRuntime(process);
			this.startupDiagnostics.notifyExtensionsDisabled(agentId, {
				fallbackFromExtensions: handshake.fallbackFromExtensions,
				debugDetails: handshake.fallbackDebug,
			});

			void this.appLogger?.info("agent", "Process reattached successfully", {
				agentId,
			});
		} catch (error) {
			void this.appLogger?.error("agent", "Process reattach failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/** 会话缓存命中率读取（流式扫描 + (size, mtimeMs) 增量缓存）收口在 RuntimeStateReader。 */
	private getSessionCacheHitStats(sessionPath: string): Promise<CacheHitStats> {
		return this.runtimeState.readCacheHitStats(sessionPath);
	}

	/** 读取同一运行时的 RPC/文件统计快照；等待期间退役或换绑时拒绝旧结果。 */
	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		return this.runtimeState.readRuntimeState(agentId);
	}

	/**
	 * 同步某 agent 的子任务（如 subagent）记录到性能追踪器中（消解并发区间重叠）。
	 * options.emit=false：只刷新快照不推事件，供只读列举路径使用（读接口不该产生状态推送）。
	 */
	syncSubagentPerfSpans(
		agentId: string,
		records: ReadonlyArray<{
			id: string;
			startedAt?: number;
			completedAt?: number;
			tokens?: number;
			streamingTokens?: number;
			streamingStartedAt?: number;
		}>,
		options?: { emit?: boolean },
	): void {
		const tasks = records
			.filter((r): r is typeof r & { startedAt: number } => typeof r.startedAt === "number")
			.map((r) => ({
				id: r.id,
				startedAt: r.startedAt,
				completedAt: r.completedAt,
				tokens: r.tokens,
			}));
		const emit = options?.emit === false ? undefined : (channel: string, payload: unknown) => this.emit(channel, payload);
		this.messagePerf.syncSubagentTasks(agentId, tasks, emit);
	}

	// 工具调用状态合成与运行态发布（轻补丁 + 去抖全量）收口在 RuntimeStateReader；
	// 过程集合由本类持有（handlePiEvent/clearAgentState 直接读写），按引用注入。

	private applyActiveToolCallState(agentId: string, state: ActiveToolCallState) {
		this.runtimeState.applyActiveToolCallState(agentId, state);
	}

	private emitToolRuntimeTransition(agentId: string, isExecutingTool: boolean, executingToolName?: string) {
		this.runtimeState.emitToolRuntimeTransition(agentId, isExecutingTool, executingToolName);
	}

	private scheduleToolEdgeRuntimeState(agentId: string): void {
		this.runtimeState.scheduleToolEdgeRuntimeState(agentId);
	}

	private async emitRuntimeState(agentId: string) {
		await this.runtimeState.emitRuntimeState(agentId);
	}

	/** 主动推送一次完整 runtime state（懒启动/重启链路的 applyPreferences 之后调用）。 */
	async publishRuntimeState(agentId: string): Promise<void> {
		await this.runtimeState.publishRuntimeState(agentId);
	}

	async cycleModel(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request({ type: "cycle_model" }, 60_000);
		return this.getRuntimeState(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "get_available_models" }, 60_000);
		// RPC 边界信任点：pi 返回的 models 数组元素结构由 pi 版本保证，这里只收窄外层。
		const models = asRecord(response.data)?.models;
		return (Array.isArray(models) ? models : []) as AvailableModel[];
	}

	/**
	 * Ask the running Pi process for levels supported by its current model.
	 * TODO(remove-compat): once PiDeck's minimum Pi version is >= 0.81 and the
	 * migration window is over, make an unavailable RPC a hard error instead of
	 * falling back to the renderer's legacy static list.
	 */
	async getAvailableThinkingLevels(agentId: string): Promise<string[] | undefined> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "get_available_thinking_levels" }, 60_000);
		return parseAvailableThinkingLevelsResponse(response);
	}

	/**
	 * 切换运行中 Agent 的模型。Coordinator 在 set_model 成功后读取 get_state，
	 * 用 Pi 实际生效的模型名称与 thinkingLevel 更新会话记录；这里不重发旧档位。
	 */
	async setModel(agentId: string, provider: string, modelId: string): Promise<void> {
		const runtime = this.requireRuntime(agentId);
		const process = runtime.process;
		const { deckSessionId, runtimeGeneration, sessionPath } = runtime.tab;
		const assertCurrentRuntime = () => {
			// 自动重连可保留 agentId/代次；旧进程的确认不能授权当前会话写回偏好或重启。
			if (this.agents.get(agentId) !== runtime || runtime.process !== process || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Model selection cancelled: runtime changed");
		};
		// Pi RPC 没有运行中 busy 门禁：set_model 立即更新 Agent state；已经发出的
		// provider request 不可改写，后续同一 turn step/下一次 request 会读取新模型。
		const response = await process.client.request({ type: "set_model", provider, modelId }, 60_000);
		assertCurrentRuntime();
		if (!response.success) {
			// pi 对 set_model 用启动时加载的模型快照校验；模型不在快照中返回
			// "Model not found: provider/model"。此时分两种情况：
			// 1. 本地 models.json 确实有该模型 → 运行中 Agent 未加载新配置，抛带
			//    needsRestart 标记的错误，渲染层据此引导用户重启 Agent；
			// 2. 模型不在 models.json 但 pi 目录（--list-models，含 auth.json 官方
			//    provider 目录模型与 models-store.json 缓存）能识别 → 同样是
			//    「Agent 启动后目录才更新」，快照过期而非模型不存在，也应 needsRestart
			//    （否则用户看到误导性的「模型未在 models.json 配置」，重启 Agent 即可用）。
			const errorText = response.error ?? "";
			if (/model not found/i.test(errorText)) {
				const [localHasModel, catalogHasModel] = await Promise.all([this.localModelsContains(provider, modelId), this.resolveModelInCatalog?.(provider, modelId) ?? Promise.resolve(false)]);
				assertCurrentRuntime();
				if (localHasModel || catalogHasModel) {
					const err = new Error(errorText) as Error & { needsRestart?: boolean };
					err.needsRestart = true;
					throw err;
				}
			}
			throw new Error(errorText || "set_model failed");
		}
		this.emitState();
	}

	/** 读取选择命令实际生效的模型/档位；进程退役时不能降级成可持久化的偏好。 */
	async getRuntimeModelThinkingState(agentId: string): Promise<SessionRuntimeModelSelection | undefined> {
		const runtime = this.requireRuntime(agentId);
		const process = runtime.process;
		const { deckSessionId, runtimeGeneration, sessionPath } = runtime.tab;
		let response: RpcResponse | undefined;
		try {
			response = await process.client.request({ type: "get_state" }, this.rpcTimeoutMs);
		} catch (error) {
			void this.appLogger?.warn("agent", "Runtime model state read failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// 必须在 RPC catch 外校验：undefined 只表示当前进程查询不可用，不表示旧进程有效。
		if (this.agents.get(agentId) !== runtime || runtime.process !== process || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Runtime model state cancelled: runtime changed");
		if (!response?.success || !isRecord(response.data) || !isRecord(response.data.model)) return undefined;
		const model = response.data.model;
		const provider = normalizedRuntimeName(model.provider);
		const modelId = normalizedRuntimeName(model.id);
		if (!provider || !modelId) return undefined;
		const modelName = normalizedRuntimeName(model.name) ?? modelId;
		return {
			provider,
			modelId,
			modelName,
			...(typeof response.data.thinkingLevel === "string" ? { thinkingLevel: response.data.thinkingLevel } : {}),
		};
	}

	/** 本地 models.json 是否包含指定 provider/modelId；仅用于判断运行时模型快照是否过期。 */
	private async localModelsContains(provider: string, modelId: string): Promise<boolean> {
		try {
			const result = await this.configManager.getModelsConfig();
			const config = result.parsed;
			return Boolean(config?.providers?.[provider]?.models?.some((model) => model.id === modelId));
		} catch {
			return false;
		}
	}

	/**
	 * 会话内系统提示：catalog 保存的模型偏好已失效被跳过（模型被重命名/删除，
	 * 不在本地 models.json 也不在 pi 模型目录）。不阻断发送，沿用 runtime 当前
	 * 模型；由 SessionRuntimeCoordinator.applyPreferences 在降级时调用。
	 */
	notifyModelPreferenceIgnored(agentId: string, provider: string, modelId: string): void {
		if (!this.agents.has(agentId)) return;
		this.addLocalizedMessage(agentId, "system", "diagnostic.modelPreferenceIgnored", `会话保存的模型偏好 ${provider}/${modelId} 已不存在（可能已被重命名或删除），本次发送沿用当前模型。请打开模型选择器重新选择。`, { params: { provider, model: modelId } });
	}

	/**
	 * 刷新模型配置：让运行中的 agent 重新加载 models.json。
	 *
	 * 现状（pi 1.0.0 核对）：RPC 命令表没有 reload_config（提案
	 * https://github.com/earendil-works/pi/issues/6890 已以 not_planned 关闭），
	 * 轻量级热重载不可用；进程重启方案会打断对话/工具执行且有 exit 竞态，不值得
	 * 为此牺牲稳定性。因此本方法只返回当前状态，模型配置变更由 agent 重启（stop/start）生效。
	 * 若未来 pi 新增 reload 类命令，在这里接入即可。
	 */
	async refreshModels(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		void this.appLogger?.info("agent", "Model refresh requested; hot reload unsupported by pi, restart agent to apply models.json changes", {
			agentId,
		});
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	async cycleThinking(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request({ type: "cycle_thinking_level" }, 60_000);
		return this.getRuntimeState(agentId);
	}

	async setThinking(agentId: string, level: string): Promise<void> {
		const runtime = this.requireRuntime(agentId);
		const process = runtime.process;
		const { deckSessionId, runtimeGeneration, sessionPath } = runtime.tab;
		// 与 set_model 相同：选择链路只确认命令是否接受，不额外读取 get_state。
		const response = await process.client.request({ type: "set_thinking_level", level }, 60_000);
		// 档位确认属于发送命令的进程，不能把自动重连前的成功写回当前会话。
		if (this.agents.get(agentId) !== runtime || runtime.process !== process || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Thinking selection cancelled: runtime changed");
		if (!response.success) throw new Error(response.error ?? "set_thinking_level failed");
		this.emitState();
	}

	/** Build one physical/logical file reference for the isolated JSONL transaction. */
	private createSessionFileRef(runtime: AgentRuntime, sessionPath: string): SessionFileRef {
		const environment = runtime.tab.sessionEnvironment ?? (this.wslEnvironment ? "wsl" : "native");
		return {
			protocolPath: this.toSessionProtocolPath(sessionPath),
			hostPath: this.toSessionHostPath(sessionPath),
			environment,
			wslDistro: runtime.tab.wslDistro ?? (environment === "wsl" ? this.wslEnvironment?.distro : undefined),
		};
	}

	/**
	 * 定位编辑/删除/重发时用的活动分支 leaf。
	 * 有会话文件时与 loadMessages 一致走 JSONL 索引：历史会话展示的就是文件活动分支，
	 * get_entries 的 leaf 可能跟文件不一致（陌生 leaf 会让 SessionFileEditor 报
	 * 「分支不在文件里」，用户只看到泛化「会话操作失败」），
	 * 且大会话会把整棵 entry 树打成单行 JSON 冻窗。
	 * 无文件时才回退 RPC；RPC 失败则让 SessionFileEditor 用文件末条 leaf。
	 */
	private async getActiveSessionLeafId(agentId: string, runtime: AgentRuntime): Promise<string | undefined> {
		const sessionPath = runtime.tab.sessionPath;
		if (sessionPath) {
			try {
				const leafId = await this.sessionHistoryReader.getActiveLeafId(sessionPath);
				return typeof leafId === "string" && leafId ? leafId : undefined;
			} catch (error) {
				void this.appLogger?.warn("agent", "Session file leaf lookup failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
		}
		try {
			const response = await runtime.process.client.request({ type: "get_entries" }, 15_000);
			if (!response.success) return undefined;
			const leafId = (response.data as { leafId?: unknown } | undefined)?.leafId;
			return typeof leafId === "string" && leafId ? leafId : undefined;
		} catch (error) {
			void this.appLogger?.warn("agent", "Session entry leaf lookup failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private createSessionEntryTarget(message: ChatMessage, activeLeafId?: string): SessionEntryTarget {
		if (message.role !== "user" && message.role !== "assistant") {
			throw new Error("SESSION_ENTRY_ROLE_INVALID");
		}
		const entryId = typeof message.meta?.entryId === "string" ? message.meta.entryId : undefined;
		return {
			entryId,
			legacyMessageId: message.id,
			legacyAgentId: message.agentId,
			role: message.role,
			text: message.text,
			activeLeafId,
		};
	}

	private async requestSessionReload(runtime: AgentRuntime, file: SessionFileRef): Promise<void> {
		const response = await runtime.process.client.request(
			{
				type: "switch_session",
				sessionPath: file.protocolPath,
			},
			30_000,
		);
		if (!response.success) {
			throw new Error(response.error ?? "switch_session failed");
		}
	}

	/**
	 * File mutations are only valid while Pi is idle. The editor owns file-level
	 * serialization; this check protects the runtime protocol boundary.
	 */
	private async ensureAgentIdle(agentId: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		if (runtime.tab.status === "running") {
			try {
				const state = await this.getRuntimeState(agentId);
				if (state.isStreaming || state.isCompacting) {
					throw new Error("BUSY_STREAMING: Agent is streaming, please wait");
				}
				if (state.isExecutingTool) {
					throw new Error("BUSY_TOOL: Agent is executing a tool, please wait");
				}
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("BUSY_")) {
					throw error;
				}
				throw new Error("BUSY_GENERIC: Agent is currently busy, please try again later");
			}
		}
	}

	/**
	 * 编辑/删除/重发定位消息条目：优先运行时缓存（最近 12 轮窗口，O(1)），
	 * 缓存未命中时按 messageId 从文件索引定位 —— 使这些操作不再依赖缓存轮数
	 * （此前 40 轮缓存的一部分意义是保证操作按钮可用，12 轮窗口外也能操作）。
	 * 文件定位返回 entryId 精确锚点（SessionFileEditor.locateEntry 优先 entryId 匹配）。
	 */
	private async locateMessageTarget(agentId: string, sessionPath: string, messageId: string, activeLeafId?: string): Promise<{ target: SessionEntryTarget; resend?: { text: string; images?: ImageContent[] } }> {
		const cached = this.messages.get(agentId) ?? [];
		const message = cached.find((candidate) => candidate.id === messageId) ?? cached.find((candidate) => candidate.meta?.requestId === messageId);
		if (message) {
			return { target: this.createSessionEntryTarget(message, activeLeafId) };
		}
		const located = await this.sessionHistoryReader.readMessageByMessageId(sessionPath, messageId);
		if (!located) throw new Error("Message not found");
		void this.appLogger?.info("agent", "Message located from session file (runtime cache miss)", {
			agentId,
			messageId,
			entryId: located.entryId,
		});
		const role: "user" | "assistant" = located.role === "user" ? "user" : "assistant";
		return {
			target: {
				entryId: located.entryId,
				legacyMessageId: messageId,
				legacyAgentId: agentId,
				role,
				text: located.text,
				activeLeafId,
			},
			// 缓存未命中分支必须恒带回 draft：prepareResendFromMessage 先截断会话再返回草稿，
			// 若只在有图片时附 resend，纯文本重发会先截断历史再返回空文本（数据不可恢复）。
			resend: {
				text: located.text,
				...(located.images?.length ? { images: located.images } : {}),
			},
		};
	}

	async editMessage(agentId: string, messageId: string, newText: string) {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		// 编辑/删除/重发/重载都直接改本机会话文件（SessionFileEditor）：远端会话的会话文件不在本机。
		this.assertLocalRuntimeOperation(runtime, "editMessage");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		await this.sessionFileEditor.editMessage({
			file,
			target,
			newText,
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Edit message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	async deleteMessage(agentId: string, messageId: string) {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "deleteMessage");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		try {
			await this.sessionFileEditor.deleteMessage({
				file,
				target,
				reload: () => this.requestSessionReload(runtime, file),
			});
		} catch (error) {
			// 发送后立刻中断：缓存里有气泡，JSONL 可能还没落盘。此时按未持久化轮次从内存删掉，
			// 避免把 SESSION_ENTRY_NOT_FOUND 误报成「消息未找到，可能已被删除或上下文压缩」。
			if (this.removeUnpersistedRuntimeTurn(agentId, messageId, target, error)) {
				void this.appLogger?.info("agent", "Deleted unpersisted runtime message", {
					agentId,
					messageId,
					elapsedMs: Date.now() - startTime,
				});
				return;
			}
			throw error;
		}
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Delete message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	/**
	 * 发送后立刻中断再删：缓存命中、JSONL 还没这条时，按本轮从内存摘掉，不当成定位失败。
	 * 只处理「无 entryId」的未落盘气泡；已有 entryId 说明文件里该有记录，继续抛原错。
	 */
	private removeUnpersistedRuntimeTurn(agentId: string, messageId: string, target: SessionEntryTarget, error: unknown): boolean {
		if (!this.isSessionEntryMissing(error)) return false;
		if (typeof target.entryId === "string" && target.entryId.trim()) return false;
		const list = this.messages.get(agentId);
		if (!list?.length) return false;
		const index = list.findIndex((candidate) => candidate.id === messageId || candidate.meta?.requestId === messageId || (candidate.role === target.role && candidate.text === target.text));
		if (index < 0) return false;
		const next = list.slice(0, index);
		this.messages.set(agentId, next);
		this.scheduleMessageEmit(agentId, true);
		return true;
	}

	private isSessionEntryMissing(error: unknown): boolean {
		// 按 code / 文案识别，不依赖 instanceof：部分测试夹具只注入 editor 方法，没有真实 Error 子类。
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
		if (code === "SESSION_ENTRY_NOT_FOUND") return true;
		const message = error instanceof Error ? error.message : String(error);
		const lower = message.toLowerCase();
		return lower.includes("message not found") || lower.includes("not found on the active session branch");
	}

	async prepareResendFromMessage(agentId: string, messageId: string): Promise<{ text: string; images?: ImageContent[] }> {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "prepareResendFromMessage");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");
		// 缓存命中时先校验角色（重发仅限用户消息）；缓存未命中时由 SessionFileEditor 的 inputRole 校验兜底
		const cached = this.messages.get(agentId)?.find((candidate) => candidate.id === messageId);
		if (cached && cached.role !== "user") throw new Error("Only user messages can be resent");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target, resend } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		await this.sessionFileEditor.truncateForResend({
			file,
			target,
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Prepare resend completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
		return (
			resend ?? {
				text: cached?.text ?? "",
				...(cached?.images?.length ? { images: cached.images } : {}),
			}
		);
	}

	async reload(agentId: string) {
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "reload");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");
		const file = this.createSessionFileRef(runtime, sessionPath);
		await this.sessionFileEditor.reload({
			file,
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
	}

	/**
	 * 追加 PiDeck 本地产物的消息条目到 pi 会话文件（生图等不走 pi RPC 的记录落盘）。
	 * - 会话有活跃 runtime 时：写文件后 switch_session 让 pi 重读，内存与文件保持一致；
	 * - 无 runtime（生图不依赖 Agent）时：直接落盘，下次激活由 pi 读文件自然吸收。
	 * reload 失败不阻断落盘（文件已原子写成功），仅记日志——pi 重读失败不影响磁盘记录。
	 */
	/**
	 * 无 runtime 时改 pi 会话 JSONL（编辑 / 删除 / 重发截断）。
	 * 有运行中 Agent 时禁止走这里：内存树和文件会分叉，必须先停再改。
	 * reload 空操作，下次发送激活时由 pi 读文件吸收。
	 */
	async mutatePersistedSessionMessage(
		sessionPath: string,
		messageId: string,
		operation: "edit" | "delete" | "resend" | "remove-image",
		options?: {
			newText?: string;
			environment?: SessionEnvironment;
			wslDistro?: string;
			/** 渲染层消息携带的文件条目 id（meta.entryId）：live randomUUID 无法在文件里定位，
			 * 必须用该锚点（见 SessionHistoryReader.readMessageByMessageId）。 */
			entryId?: string;
			imageTarget?: SessionMessageImageTarget;
		},
	): Promise<{ text: string; images?: ImageContent[] } | undefined> {
		const hostPath = this.toSessionHostPath(sessionPath);
		const live = [...this.agents.values()].find((candidate) => candidate.tab.sessionPath && this.toSessionHostPath(candidate.tab.sessionPath) === hostPath);
		// 边界防御：协调器已要求先停；这里再拦一次，避免漏调 stop 时静默写文件。
		if (live && live.tab.status !== "closed" && live.tab.status !== "error") {
			throw new Error("BUSY_GENERIC: Stop the running agent before mutating the session file");
		}
		const environment = options?.environment === "wsl" || this.wslEnvironment ? ("wsl" as const) : ("native" as const);
		const file: SessionFileRef = {
			protocolPath: this.toSessionProtocolPath(sessionPath),
			hostPath,
			environment,
			wslDistro: options?.wslDistro ?? (environment === "wsl" ? this.wslEnvironment?.distro : undefined),
		};
		const activeLeafId = await this.sessionHistoryReader.getActiveLeafId(sessionPath).catch(() => undefined);
		const located = await this.sessionHistoryReader.readMessageByMessageId(sessionPath, messageId, options?.entryId, this.stoppedMessageIdentities.get(hostPath, messageId));
		if (!located) {
			// 未落盘删除兜底：发送中/刚结束即中断，再删该轮消息时 JSONL 还没有这条记录——
			// 渲染层流程是先停 agent 再走 catalog 删除，stop 已清空内存消息缓存，
			// deleteMessage 的 removeUnpersistedRuntimeTurn（内存定位）在此路径不可用。
			// 删除的目标就是让消息从会话消失：文件里本来就没有，无需写盘，
			// 返回成功让渲染层重载时间线，未落盘气泡自然消失（与删后刷新结果一致）。
			// 仅 delete 放宽：edit/resend 依赖文件正文，找不到条目则无法执行，必须保留报错。
			if (operation === "delete") {
				void this.appLogger?.info("agent", "Delete no-op: message not in session file (unpersisted turn)", {
					sessionPath,
					messageId,
				});
				return undefined;
			}
			throw new Error("Message not found");
		}
		const role: "user" | "assistant" = located.role === "user" ? "user" : "assistant";
		if ((operation === "resend" || operation === "remove-image") && role !== "user") {
			throw new Error(operation === "resend" ? "Only user messages can be resent" : "Only user message images can be removed");
		}
		const target: SessionEntryTarget = {
			entryId: located.entryId,
			legacyMessageId: messageId,
			legacyAgentId: "_viewer",
			role,
			text: located.text,
			activeLeafId,
		};
		const reload = async () => undefined;
		if (operation === "edit") {
			await this.sessionFileEditor.editMessage({
				file,
				target,
				newText: options?.newText ?? "",
				reload,
			});
		} else if (operation === "delete") {
			await this.sessionFileEditor.deleteMessage({ file, target, reload });
		} else if (operation === "remove-image") {
			if (!options?.imageTarget) throw new Error("Image target is required");
			await this.sessionFileEditor.removeImage({ file, target, reload, imageTarget: options.imageTarget });
		} else {
			await this.sessionFileEditor.truncateForResend({ file, target, reload });
		}
		void this.appLogger?.info("agent", "Persisted session message mutated", {
			sessionPath,
			messageId,
			operation,
		});
		return operation === "resend"
			? {
					text: located.text,
					...(located.images?.length ? { images: located.images } : {}),
				}
			: undefined;
	}

	async appendLocalMessagesToSession(sessionPath: string, entries: import("./SessionFileEditor").AppendMessageEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const hostPath = this.toSessionHostPath(sessionPath);
		const runtime = [...this.agents.values()].find((candidate) => candidate.tab.sessionPath && this.toSessionHostPath(candidate.tab.sessionPath) === hostPath);
		try {
			if (runtime) {
				const agentId = runtime.tab.id;
				await this.ensureAgentIdle(agentId);
				const file = this.createSessionFileRef(runtime, sessionPath);
				await this.sessionFileEditor.appendMessages({
					file,
					reload: () => this.requestSessionReload(runtime, file),
					entries,
				});
				await this.loadMessages(agentId);
			} else {
				// 无 runtime：按环境默认值构造文件引用（WSL 走 Linux 协议路径 + Windows 宿主路径）。
				const file: SessionFileRef = {
					protocolPath: this.toSessionProtocolPath(sessionPath),
					hostPath,
					environment: this.wslEnvironment ? "wsl" : "native",
					wslDistro: this.wslEnvironment?.distro,
				};
				await this.sessionFileEditor.appendMessages({
					file,
					reload: async () => undefined,
					entries,
				});
			}
			void this.appLogger?.info("agent", "Local messages appended to session", {
				sessionPath,
				entryCount: entries.length,
				hadRuntime: Boolean(runtime),
			});
		} catch (error) {
			void this.appLogger?.warn("agent", "Local messages append failed", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * 重启 agent 进程：停止当前 pi RPC 子进程，用同一个 session 重新启动。
	 * 适用场景：修改了 provider 配置、切换了 API key、更新了 pi 版本后，
	 * /reload 只重载 extension，不会重新读取配置文件，restart 才能生效。
	 */
	/**
	 * 统一清理某 agent 的全部运行态键（2026-10 泄漏修复）。
	 *
	 * agentId 每次 spawn 都是 randomUUID，而各状态 Map/Set 若只在事件驱动路径清理，
	 * 用户高频 stop/restart/崩溃退出时键会永久残留（慢泄漏）。
	 * 在 agent 生命周期终止点（stop/restart/最终 closed/stopAll）统一调用。
	 *
	 * 不清的键（各自语义）：agents/messages（调用方处理）、userInitiatedStop
	 * （stop 后由退出处理器消费删除）、pendingTrustRequests（启动流程 await 中，删键会挂死 create）。
	 */
	private clearAgentState(agentId: string) {
		// 双通道缓冲/基准/思考段随生命周期整体清理（stop/restart/closed 等非 done 终止路径，防键残留慢泄漏）
		this.liveStream.clearAll(agentId);
		// 工具边沿去抖在途定时器随生命周期取消（迟到触发会打到已清空的 runtime，虽然
		// emitRuntimeState 内部有 requireRuntime 兜底，取消更干净）
		const toolEdgeTimer = this.toolEdgeStateTimers.get(agentId);
		if (toolEdgeTimer) {
			clearTimeout(toolEdgeTimer);
			this.toolEdgeStateTimers.delete(agentId);
		}
		this.streamingAgents.delete(agentId);
		this.activeAssistantMessageIds.delete(agentId);
		this.toolMessageIds.delete(agentId);
		this.retryStatusMessageIds.delete(agentId);
		this.pendingCompactProcesses.delete(agentId);
		this.compactingAgents.delete(agentId);
		this.compactTimedOutAgents.delete(agentId);
		this.rpcCompactingAgents.delete(agentId);
		// 取消来源判定用的运行期观测随生命周期清理（agentId 每次 spawn 都是新 UUID）
		this.lastUserAbortAt.delete(agentId);
		this.contextOverflowByAgent.delete(agentId);
		this.lastCompactionObservation.delete(agentId);
		this.compactionStartedAt.delete(agentId);
		this.agentTurnActiveById.delete(agentId);
		this.autoRestartAttempted.delete(agentId);
		this.messagePerf.clearAgent(agentId);
		this.lastRuntimeStateByAgent.delete(agentId);
		this.lastStreamingPatchByAgent.delete(agentId);
		this.notifiedAskAgents.delete(agentId);
		this.abortedDuringAsk.delete(agentId);
		this.abortGate.clearEscalation(agentId);
		this.lastAbortAtByAgent.delete(agentId);
		this.uiGate.clearAgent(agentId);
		this.startupHandshakeAgents.delete(agentId);
		// 远端启动计划（含 nonce/远端路径）随生命周期释放：它是本次 spawn 的运行时事实，
		// 留下来只会在下次同 agentId（不会发生）或内存排查时误导。
		this.remoteLaunchByAgent.delete(agentId);
		// 启动期诊断与首 run 标记随生命周期清理：重启/关闭后新 runtime 重新队列
		this.startupDiagnostics.clear(agentId);
		this.clearStreamGate(agentId);
		// 数值游标与回合计数随生命周期清理（2026 内存排查补漏）：
		// agentId 每次 spawn 都是 randomUUID，漏删 = 每次 stop/restart 永久留一个键（慢泄漏）。
		this.messageHeadOffsetByAgent.delete(agentId);
		// rewind 打点域（回合计数/节流状态/悬挂 timer）统一清理
		this.rewindCheckpoints.clearAgent(agentId);
		// 工具完整结果缓存是运行期性能优化（回退读文件等价），agent 停止时整体释放
		this.toolMessages.clearFullTextCache();
	}

	/**
	 * runtime 消息缓存即将释放（stop / restart）时留存身份摘要。
	 *
	 * 编辑确认框与重发入口可能捕获了投影前的 live ID；缓存一旦清空，主进程就只剩
	 * 「按 ID 找文件条目」这一条路，而 live 随机 ID 在 JSONL 里不存在。摘要交给
	 * SessionHistoryReader 在活动分支上按角色 + 时间窗 + 内容指纹唯一定位，
	 * 不能凭 UI 的过期 ID 盲改正文（歧义/未落盘一律拒绝）。
	 */
	private captureRuntimeMessageIdentities(agentId: string): void {
		const runtime = this.agents.get(agentId);
		const sessionPath = runtime?.tab.sessionPath;
		if (!sessionPath) return;
		// 远端会话不参与：这份摘要是给「按本机会话文件定位消息」用的，而远端会话不读本机文件
		// （loadMessages 对远端直接返回内存消息），留着只会拿一堆用不上的键。
		if (runtime && this.isRemoteRuntime(runtime.tab.projectId)) return;
		this.stoppedMessageIdentities.capture(this.toSessionHostPath(sessionPath), this.messages.get(agentId) ?? []);
	}

	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
		void this.appLogger?.info("agent", "Agent restart requested", {
			agentId,
			projectId: runtime.tab.projectId,
			sessionPath: runtime.tab.sessionPath,
		});
		const { projectId, title, sessionEnvironment: environment, sessionSource: source, wslDistro, wslUser, importedSourceId, noSession, deckSessionId } = runtime.tab;

		// 优先从 pi 获取最新 sessionFile，兜底用 tab 上缓存的值；
		// 避免首次创建时未指定 session 路径、restart 后丢失历史的情况。
		let sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) {
			try {
				const state = await runtime.process.client.request(
					{
						type: "get_state",
					},
					this.rpcTimeoutMs,
				);
				sessionPath = this.reportSessionPathFromPi((state.data as { sessionFile?: string } | undefined)?.sessionFile ?? undefined, runtime.tab.projectId, environment ?? "native", this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd);
			} catch {
				// 获取失败时继续用 undefined，create 会启动新 session
			}
		}

		// 停止旧进程并清理状态。
		// restart 与 stop 同属「runtime 消息缓存被释放」：UI 手中的 live ID 此时只存于文件，
		// 清缓存前必须留存身份摘要，否则重启后编辑/删除/重发会报 Message not found
		// （2026-09 用户反馈：开启代理重启会话后重发失败）。
		this.captureRuntimeMessageIdentities(agentId);
		runtime.process.stop();
		this.agents.delete(agentId);
		// restart 会换一个 agentId：旧 agentId 的模型快照会话必须在这里注销，
		// 否则每重启一次就多留一条永不回收的记录。
		this.unregisterModelTraceSession(agentId);
		this.messages.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		// 消息 flush 域（脏标记/窗口游标/待发滑出/节流定时器）统一清理
		this.messageEmit.clearAll(agentId);
		this.clearAgentState(agentId);
		this.emitState();

		// 用相同的 session 重新创建 agent，新进程会重新加载所有配置
		// deckSessionId 必须随 restart 带入：安全门扩展靠它（PIDECK_SESSION_ID）解析
		// 以 catalog 会话 ID 存储的 sessionOverrides，丢了会回退全局默认等级（issue #302）。
		return this.create({
			projectId,
			sessionPath: noSession ? undefined : sessionPath,
			title,
			environment,
			source,
			wslDistro,
			wslUser,
			importedSourceId,
			noSession,
			deckSessionId,
		});
	}

	async exportHtml(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "export_html" }, 120_000);
		return response.data;
	}

	/**
	 * 对未打开的历史会话执行官方 RPC 导出。
	 * 使用临时 pi 进程可以复用官方 export_html 样式，同时不切换当前桌面 Agent。
	 */
	async exportSessionHtml(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request({ type: "export_html" }, 120_000);
			return response.data;
		});
	}

	/**
	 * 对未打开的历史会话执行官方 clone。
	 * clone 会复制 active branch 到新 session；随后读取 get_state 拿到新 sessionFile 供历史列表刷新。
	 */
	async cloneSessionFile(projectId: string, sessionPath: string, environment: SessionEnvironment = "native") {
		const project = this.getProject(projectId);
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request({ type: "clone" }, 120_000);
			const state = await process.client.request({ type: "get_state" }, this.rpcTimeoutMs);
			return {
				...((response.data as object | undefined) ?? {}),
				sessionPath: this.reportSessionPathFromPi((state.data as { sessionFile?: string } | undefined)?.sessionFile, projectId, environment, project?.path ?? ""),
			};
		});
	}

	private async withTemporarySession<T>(projectId: string, sessionPath: string, run: (process: PiProcess) => Promise<T>): Promise<T> {
		const project = this.getProject(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const trustOverride = await this.projectTrust.ensureProjectTrust(project);
		const process = this.createPiProcess(project.path, sessionPath);
		await process.start(sessionPath, trustOverride);
		try {
			return await run(process);
		} finally {
			process.stop();
		}
	}

	async getForkMessages(agentId: string): Promise<ForkMessage[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_fork_messages",
		});
		return (response.data as { messages?: ForkMessage[] } | undefined)?.messages ?? [];
	}

	async forkSession(agentId: string, entryId: string) {
		return this.replaceLiveSession(agentId, { type: "fork", entryId });
	}

	async cloneSession(agentId: string) {
		return this.replaceLiveSession(agentId, { type: "clone" });
	}

	/** pi owns the new file; only a successful, non-cancelled RPC may replace identity. */
	private async replaceLiveSession(agentId: string, command: { type: "fork"; entryId: string } | { type: "clone" }) {
		const runtime = this.requireRuntime(agentId);
		const remote = this.isRemoteRuntime(runtime.tab.projectId);
		if (remote && typeof this.remoteRuntime?.registerRemoteSession !== "function") throw new Error(REMOTE_RUNTIME_CODES.catalogIdentityUnsupported);
		const originPath = runtime.tab.sessionPath;
		const originPiId = runtime.tab.sessionId;
		if (remote) {
			// A lost response can follow a completed fork. Until pi confirms rejection
			// or cancellation, the cached origin path cannot prove runtime identity.
			runtime.tab.sessionPath = undefined;
			runtime.tab.sessionId = undefined;
		}
		// 远端 fork 走 SSH helper 通道：RPC 卡住时只会静静等到 120s 超时再抛，中间零日志，
		// 现场表现为「点了 Fork 没反应」（2026-10 真机复现，渲染层 240s 后才发现）。
		// 这里把耗时与失败原因记下来，才能区分「RPC 从未返回」与「返回了但不是成功帧」。
		const rpcStartedAt = Date.now();
		let response: RpcResponse;
		try {
			response = await runtime.process.client.request(command, 120_000);
		} catch (error) {
			void this.appLogger?.warn("agent", "Session replacement RPC failed", {
				agentId,
				remote,
				command: command.type,
				elapsedMs: Date.now() - rpcStartedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		const rpcMs = Date.now() - rpcStartedAt;
		const data: unknown = response.data;
		const cancelled = data && typeof data === "object" && "cancelled" in data && data.cancelled === true;
		if (response.success === false) {
			if (remote) {
				// A negative response can also follow a failed post-fork rebind. Restore
				// only if a fresh state read proves origin; never trust the cached path.
				const fresh = await runtime.process.client.request({ type: "get_state" }, this.rpcTimeoutMs).catch(() => undefined);
				const state: unknown = fresh?.data;
				if (state && typeof state === "object" && "sessionFile" in state && typeof state.sessionFile === "string") {
					runtime.tab.sessionPath = this.reportSessionPathFromPi(state.sessionFile, runtime.tab.projectId, runtime.tab.sessionEnvironment ?? "native", runtime.tab.cwd);
					if ("sessionId" in state && typeof state.sessionId === "string") runtime.tab.sessionId = state.sessionId;
				}
				if (runtime.tab.sessionPath !== originPath) this.clearReplacedMessageWindow(agentId);
			}
			void this.appLogger?.warn("agent", "Session replacement rejected by pi", { agentId, remote, command: command.type, rpcMs, error: response.error ?? null });
			throw new Error(remote ? "REMOTE_SESSION_REPLACEMENT_RPC_FAILED" : (response.error ?? "Session replacement RPC failed"));
		}
		if (cancelled) {
			if (remote) {
				runtime.tab.sessionPath = originPath;
				runtime.tab.sessionId = originPiId;
			}
			return data;
		}
		const targetSessionId = await this.refreshRuntimeAfterSessionReplacement(agentId, remote);
		if (remote) {
			// 远端 fork 的会话文件是**懒创建**的：pi 立刻把 `get_state.sessionFile` 换成新路径，但文件要等这条会话
			// 首次追加消息才落盘（2026-10-12 协议级真机探针：fork 成功后 `ls` 无新文件，连 `set_session_name` 成功也不落盘）。
			// 所以「换绑后远端还没有这份文件」是**正常语义**、不是失败。这条布尔判据让真机排查一眼分清两种情形：
			// true ⇒ pi 报的仍是原文件（那才是 PiDeck 身份推导的问题）；false ⇒ pi 报了新路径（符合懒创建语义）。
			// 只记布尔、不记路径（脱敏纪律）。
			void this.appLogger?.info("agent", "Remote session replacement reported file", { agentId, sameFileAsBefore: runtime.tab.sessionPath === originPath, rpcMs });
		}
		return targetSessionId ? { ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}), targetSessionId } : data;
	}

	async switchSession(agentId: string, sessionPath: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "switch_session", sessionPath: this.toSessionProtocolPath(sessionPath) }, 120_000);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	/** Discard origin's projection/version before exposing a different remote file. */
	private clearReplacedMessageWindow(agentId: string): void {
		this.messages.set(agentId, []);
		// 消息 flush 域（脏标记/窗口游标/待发滑出/节流定时器）在 dev 侧已迁到 MessageEmitBatcher：
		// 换绑会话文件后必须整域丢弃，否则待发的旧文件轮次会随下一帧发给渲染层。
		this.messageEmit.clearAll(agentId);
		this.messageHeadOffsetByAgent.delete(agentId);
		this.sessionFileVersionByAgent.delete(agentId);
	}

	private async refreshRuntimeAfterSessionReplacement(agentId: string, registerRemoteReplacement = false): Promise<string | undefined> {
		// The marker and message window belong to the old file, not the RPC result.
		// A status marker belongs to the pre-replacement session/runtime and must not
		// authorize a delayed session_info event for the newly bound catalog record.
		this.uiGate.clearAutomaticTitle(agentId);
		const runtime = this.requireRuntime(agentId);
		if (registerRemoteReplacement) {
			// RPC has already switched pi. If get_state fails, the old cached path is
			// NOT evidence that pi still owns origin: leave identity unknown/fail-closed.
			runtime.tab.sessionPath = undefined;
			runtime.tab.sessionId = undefined;
			this.clearReplacedMessageWindow(agentId);
			const response = await runtime.process.client.request({ type: "get_state" }, this.rpcTimeoutMs);
			const state: unknown = response.data;
			if (!state || typeof state !== "object" || !("sessionFile" in state) || typeof state.sessionFile !== "string" || !state.sessionFile) throw new Error(REMOTE_RUNTIME_CODES.locatorUnresolved);
			const project = this.getProject(runtime.tab.projectId);
			if (!project || !isRemoteProject(project)) throw new Error(REMOTE_RUNTIME_CODES.locatorUnresolved);
			// 换绑比较与登记都只认绝对形状：pi 对相对 sessionDir 会回相对路径，原样比较必然失配。
			const remotePath = this.reportSessionPathFromPi(state.sessionFile, runtime.tab.projectId, runtime.tab.sessionEnvironment ?? "native", project.locator.remotePath);
			if (remotePath === undefined) throw new Error(REMOTE_RUNTIME_CODES.locatorUnresolved);
			runtime.tab.sessionPath = remotePath;
			if ("sessionId" in state && typeof state.sessionId === "string") runtime.tab.sessionId = state.sessionId;
			const registration = await this.registerRemoteSessionIdentity(project, remotePath);
			const locator = registration.record.locator;
			if (locator?.kind !== "ssh" || locator.hostId !== project.locator.hostId || locator.remotePath !== remotePath) throw new Error(REMOTE_RUNTIME_CODES.locatorUnresolved);
			// Remote history is read by the existing bounded reader, never local fs or
			// unbounded get_messages. Do not relabel origin's runtime tail as the fork.
			this.emitState();
			return registration.record.id;
		}
		const stateResponse = await runtime.process.client.request({ type: "get_state" }, this.rpcTimeoutMs).catch(() => ({ data: undefined }));
		const state = stateResponse.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
		if (state?.sessionFile) {
			runtime.tab.sessionPath = this.reportSessionPathFromPi(state.sessionFile, runtime.tab.projectId, runtime.tab.sessionEnvironment ?? "native", this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd) ?? runtime.tab.sessionPath;
		}
		if (state?.sessionId) runtime.tab.sessionId = state.sessionId;
		// Preserve optimistic/in-flight messages during the local history projection.
		await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
		this.emitState();
		return undefined;
	}

	async getCommands(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		// 元数据查询用固定短超时（与本文件其他 get_commands 调用点同一约定）：
		// 卡死的 pi 进程不能把活会话的斜杠菜单拖到 rpcTimeout（默认 600s）；
		// 超时 reject → Coordinator 转 SESSION_COMMAND_FAILED → 渲染层回退静态建议。
		const response = await runtime.process.client.request({ type: "get_commands" }, 10_000);
		return (response.data as { commands?: unknown[] } | undefined)?.commands ?? [];
	}

	/**
	 * 热重载 pi 资源（扩展/技能/提示词/主题/上下文文件）。
	 *
	 * 为什么直接发 RPC prompt：pi 的 builtin `/reload` 只在 TUI 中执行，RPC 没有原生
	 * reload 命令；PiDeck 内部扩展 `pi-deck-runtime.ts` 把它注册成扩展命令。这里直接
	 * 走 `prompt`，不能复用 `sendPrompt`——后者会先写一条乐观用户消息，`/reload` 会
	 * 污染会话时间线。
	 *
	 * 为什么先查命令表：若扩展未加载（`piRpcNoExtensions`、旧覆盖层、异常回退），把
	 * `/reload` 当普通 prompt 发下去会让模型把命令文本当问题回答。按 `sourceInfo.path`
	 * 的 basename 确认命令来自本扩展，并用 pi 实际分配的 invocationName 发送（重名时
	 * pi 会给后缀，避免误执行用户扩展的同名命令）。
	 */
	async reloadResources(agentId: string): Promise<PiCommand[]> {
		const runtime = this.requireRuntime(agentId);
		if (!runtime.process.isRunning()) throw new Error("Agent process is not running");
		if (runtime.tab.status !== "idle") throw new Error("Wait for the current response to finish before reloading.");
		// 挂起的 Ask/UI 请求正在等用户回答；reload 会拆掉扩展 runtime，先让用户处理完。
		if (this.uiGate.hasPendingUIRequests(agentId)) throw new Error("Answer or dismiss the pending question before reloading.");
		const stateResponse = await runtime.process.client.request({ type: "get_state" }, 10_000).catch(() => undefined);
		if (!stateResponse?.success) throw new Error("Unable to verify that the session is idle before reloading.");
		const state = stateResponse.data as { isStreaming?: boolean; isCompacting?: boolean } | undefined;
		if (state?.isStreaming || state?.isCompacting) throw new Error("Wait for the current response to finish before reloading.");

		const registered = await this.listRegisteredCommands(runtime);
		const reloadCommand = registered?.find((command) => basename(command.sourcePath ?? "") === "pi-deck-runtime.ts");
		if (!reloadCommand) throw new Error("The reload extension is not loaded in this session");

		const response = await runtime.process.client.request({ type: "prompt", message: `/${reloadCommand.name}` }, 120_000);
		if (this.agents.get(agentId) !== runtime || !runtime.process.isRunning()) throw new Error("Session runtime changed during reload");
		if (!response.success) throw new Error(response.error ?? "reload failed");
		// pi 0.99+ 的权威信号；老版本没有该字段时按「扩展命令已注册」接受（上面已校验来源）。
		const disposition = readPromptDisposition(response.data);
		if (disposition !== undefined && disposition !== "handled") throw new Error("The reload command was not handled by pi");
		return (await this.getCommands(agentId)) as PiCommand[];
	}

	/**
	 * rewind/git 快照的根目录必须是宿主路径。
	 *
	 * 背景：WSL 项目在 ProjectStore 里存 UNC（\\wsl.localhost\<distro>\...）或 /mnt/...，
	 * 而 git 执行层按 cwd 分流（UNC → 发行版内 git；盘符 → Windows git，见 gitWsl.planGitSpawn）。
	 * /mnt/<盘> 与 C:\ 指向同一份 Windows 盘文件，转宿主形态后交给 Windows git，
	 * 与 Git 面板（gitIpc 的 projectHostPath）口径一致；WSL 内部项目保持 UNC 走发行版内 git。
	 * 转换失败（跨发行版 UNC 等）退回原值，由执行层自行判断，不能让打点整体抛错。
	 */
	private rewindHostRoot(cwd: string, distro?: string): string {
		const activeDistro = distro ?? this.wslEnvironment?.distro;
		if (process.platform !== "win32" || !activeDistro) return cwd;
		try {
			return toWindowsHostPath(cwd, { distro: activeDistro });
		} catch {
			return cwd;
		}
	}

	/**
	 * rewind checkpoint 列表（refs/pi-checkpoints）。
	 * root 取 agent 工作目录：纯 git 实现不依赖 pi 进程，即使 pi 没装 pi-rewind
	 * 扩展，也能读到/回退同仓库里已存在的 checkpoint。过滤用 pi 的 sessionId
	 * （与 pi-rewind 的 ref 命名一致）；无 session 时列出仓库全部。
	 *
	 * 分页：按 timestamp 倒序（新→旧），beforeTimestamp 为游标。
	 * limit 默认 10、上限 100；不传 beforeTimestamp 时返回最早一页。
	 */
	async listCheckpoints(agentId: string, params?: RewindCheckpointPageParams): Promise<RewindCheckpointPage> {
		const runtime = this.requireRuntime(agentId);
		// checkpoint 是本机仓库里的 git ref（refs/pi-checkpoints）：远端 cwd 不能交给本机 git。
		this.assertLocalRuntimeOperation(runtime, "listCheckpoints");
		const root = this.rewindHostRoot(runtime.tab.cwd, runtime.tab.wslDistro);
		const checkpoints = await loadAllCheckpoints(root, runtime.tab.sessionId);
		const all = checkpoints.map(toCheckpointSummary).sort((a, b) => b.timestamp - a.timestamp);
		// 渲染层入参不可信：limit 钳制在 [1, 100]，beforeTimestamp 非有限数按未传处理。
		const limit = Math.min(Math.max(1, Math.floor(params?.limit ?? 10)), 100);
		const before = Number.isFinite(params?.beforeTimestamp) ? (params!.beforeTimestamp as number) : Number.POSITIVE_INFINITY;
		const filtered = all.filter((cp) => cp.timestamp < before);
		// 附带自动打点健康状态：失败态渲染层显示警示条（此前失败完全静默，
		// 用户以为有快照、真要回滚才发现列表是空的）。
		const health = this.rewindCheckpoints.healthForRoot(root);
		// 未传 limit（如 rewind-to-message 需要全量最近检查点）时返回全部；
		// 否则按 limit 截取一页，并据此判断是否还有更早的检查点。
		if (params?.limit === undefined) {
			return { items: filtered, hasMore: false, health };
		}
		return {
			items: filtered.slice(0, limit),
			hasMore: filtered.length > limit,
			health,
		};
	}

	/** checkpoint 与当前 index 树的 diff 摘要（回退预览：「回到这里会改哪些文件」）。 */
	async getCheckpointDiff(agentId: string, checkpointId: string): Promise<string> {
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "getCheckpointDiff");
		const root = this.rewindHostRoot(runtime.tab.cwd, runtime.tab.wslDistro);
		const cp = await loadCheckpointFromRef(root, checkpointId);
		if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);
		const indexTree = await currentIndexTree(root);
		return diffCheckpoints(root, cp.worktreeTreeSha, indexTree);
	}

	/**
	 * 回退工作区/会话到 checkpoint。
	 * - files：仅回退文件（reset + safeClean + index 恢复），跨后端可用；
	 * - conversation：fork 出新会话（在检查点时刻前最近的带 entryId 消息处裁剪），
	 *   原会话保留、工作区文件不动；
	 * - all：文件回退 + 会话 fork。
	 * fork 走 pi fork RPC（AgentManager.forkSession 内部完成 runtime 换绑）。
	 */
	async restoreCheckpoint(agentId: string, checkpointId: string, scope: RewindRestoreScope): Promise<RewindRestoreResult> {
		const runtime = this.requireRuntime(agentId);
		// 回退会**写文件**（reset + safeClean）：远端路径绝不能进本机 git。
		this.assertLocalRuntimeOperation(runtime, "restoreCheckpoint");
		const root = this.rewindHostRoot(runtime.tab.cwd, runtime.tab.wslDistro);
		const cp = await loadCheckpointFromRef(root, checkpointId);
		if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);

		const wantFiles = scope === "files" || scope === "all";
		const wantConversation = scope === "conversation" || scope === "all";
		// 会话回退先解析 fork 锚点（失败或找不到都整体拒绝，避免「文件已回退但会话没 fork」
		// 的半成功态）。找不到锚点（检查点早于任何已落盘消息）也必须拒绝：静默跳过
		// 会让 UI 报成功但什么都没发生（2026-10 假成功事故）。
		const forkEntryId = wantConversation ? await this.resolveForkEntryBeforeCheckpoint(agentId, cp.timestamp) : undefined;
		if (wantConversation && !forkEntryId) {
			throw new Error("Cannot locate a conversation anchor before this checkpoint (no persisted message found)");
		}
		if (wantFiles) await applyCheckpointRestore(root, cp);
		let forkedSessionId: string | undefined;
		if (wantConversation && forkEntryId) {
			const data = (await this.forkSession(agentId, forkEntryId)) as { targetSessionId?: string; [key: string]: unknown } | undefined;
			forkedSessionId = data?.targetSessionId;
		}
		return { filesRestored: wantFiles, forkedSessionId };
	}

	/**
	 * 找检查点时刻前最近的、带 entryId 的消息作为会话回退的 fork 锚点。
	 * live 消息（本轮未 settle）没有 entryId，回退到最近一条已落盘消息是合理近似：
	 * 即「该检查点之后的对话内容从 fork 会话里去掉」。
	 */
	private async resolveForkEntryBeforeCheckpoint(agentId: string, beforeTimestamp: number): Promise<string | undefined> {
		const pick = (messages: ChatMessage[]): string | undefined =>
			messages
				.map((m) => ({
					ts: m.timestamp,
					// entryId 在 meta 里（live 消息未落盘投影时缺失），见 loadMessages 的定位逻辑。
					entryId: typeof m.meta?.entryId === "string" ? m.meta.entryId : undefined,
				}))
				.filter((m): m is { ts: number; entryId: string } => m.ts <= beforeTimestamp && Boolean(m.entryId))
				.sort((a, b) => b.ts - a.ts)[0]?.entryId;
		const direct = pick(this.messages.get(agentId) ?? []);
		if (direct) return direct;
		// 内存投影缺失（如 agent 重启后未读历史）：文件级重投影后再找。
		await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: 0 });
		return pick(this.messages.get(agentId) ?? []);
	}

	/**
	 * get_commands 启发式：判断这条 prompt 是否是扩展命令（会被 AgentSession
	 * _tryExecuteExtensionCommand 消费、不进入 agent run）。
	 *
	 * **仅作为 pi 0.99 以下版本的回退路径**：0.99 起 prompt 响应自带
	 * data.disposition === "handled"（见 readPromptDisposition），权威且零额外往返；
	 * 只有老版本 pi（disposition 缺失）才在这里补一次 get_commands。启发式本身的
	 * 判据沿袭 pi dist/core/agent-session.js 的行为：命中后 AgentSession.prompt()
	 * 直接 return，不再调用 _runAgentPrompt()。
	 */
	private async promptMatchesRegisteredExtensionCommand(runtime: AgentRuntime, message: string): Promise<boolean> {
		const trimmed = message.trim();
		if (!trimmed.startsWith("/")) return false;

		const commandName = trimmed.slice(1).split(/\s+/, 1)[0];
		if (!commandName) return false;

		const response = await runtime.process.client.request({ type: "get_commands" }, 10_000).catch(() => undefined);
		const commands = (response?.data as { commands?: unknown[] } | undefined)?.commands ?? [];
		return commands.some((command) => {
			if (!command || typeof command !== "object") return false;
			const typed = command as { name?: unknown; source?: unknown };
			return typed.name === commandName && typed.source === "extension";
		});
	}

	/** 设置某 agent 的 RPC 日志记录开关（收口在 RpcLiveLogTap） */
	setRpcLogging(agentId: string, enabled: boolean) {
		this.rpcLiveTap.setLogging(agentId, enabled);
	}

	/** 查询某 agent 是否开启了 RPC 日志记录 */
	isRpcLogging(agentId: string): boolean {
		return this.rpcLiveTap.isLogging(agentId);
	}

	/**
	 * 登记「某 agent 的实时日志面板是否在看」。
	 * 由渲染层面板挂载/卸载成对调用；只影响广播，不影响记录与落盘。
	 */
	setRpcLogWatching(agentId: string, watching: boolean) {
		this.rpcLiveTap.setWatching(agentId, watching);
	}

	/**
	 * error 终态但 pi 进程仍存活时的原进程复活（Issue #218）。
	 * 回复级错误（API 400/模型报错/prompt 投递未知）只结束本轮回复，进程本身没死；
	 * 此前被标成终态 error 后，下次激活要么抛「启动失败」、要么停掉活进程重建——
	 * 重建在扩展有问题时还会触发无插件回退，用户体感是「出错后会话被自动关闭」。
	 * 复活只翻状态（error → idle），错误卡片保留在时间线里，进程与内存消息原样复用。
	 */
	reviveIfProcessAlive(agentId: string): boolean {
		const runtime = this.agents.get(agentId);
		if (!runtime) return false;
		if (runtime.tab.status !== "error") return false;
		if (!runtime.process.isRunning()) return false;
		runtime.tab.status = "idle";
		this.emitState();
		void this.appLogger?.info("agent", "Error-state agent revived with live process", {
			agentId,
			sessionPath: runtime.tab.sessionPath,
		});
		return true;
	}

	async stop(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		void this.appLogger?.info("agent", "Agent stopped (user initiated)", {
			agentId,
			projectId: runtime.tab.projectId,
			sessionPath: runtime.tab.sessionPath,
		});
		// 标记用户主动停止，退出处理器将跳过自动重连
		this.userInitiatedStop.add(agentId);
		const process = runtime.process;
		this.captureRuntimeMessageIdentities(agentId);
		this.agents.delete(agentId);
		// 快照会话与 agent 生命周期配对：stop / 会话删除路径都走这里。
		this.unregisterModelTraceSession(agentId);
		this.messages.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		this.clearStreamGate(agentId);
		// agent 关闭时自动关闭 RPC 日志记录，并丢弃未广播的实时日志缓冲
		this.rpcLiveTap.clearAgent(agentId);
		this.messageEmit.clearAll(agentId);
		this.sessionFileVersionByAgent.delete(agentId);
		this.clearAgentState(agentId);
		process.stop();
		this.emitState();
	}

	/**
	 * 停止 agent 并等待进程真正退出（最多 timeoutMs）。
	 *
	 * 删除会话必须先等 pi 退出：Windows 上进程还持有会话 JSONL 的写句柄时，
	 * shell.trashItem 只会报通用的「Failed to perform delete operation」（issue #364）。
	 * 进程已经不在时立即返回 true；超时返回 false，由调用方决定是否继续删除。
	 */
	async stopAndWaitForExit(agentId: string, timeoutMs = 3000): Promise<boolean> {
		const piProcess = this.agents.get(agentId)?.process;
		// stop 本身同步清空 agents 与运行时状态，这里只补「等进程真的退出」这一步。
		void this.stop(agentId).catch(() => undefined);
		if (!piProcess || !piProcess.isRunning()) return true;
		const deadline = Date.now() + timeoutMs;
		const pollMs = 50;
		while (piProcess.isRunning()) {
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		return true;
	}

	/** 注册本地事件监听器（供 FeishuBridge 等主进程内部模块使用） */
	addLocalEventListener(listener: (agentId: string, event: unknown) => void): () => void {
		this.localEventListeners.add(listener);
		return () => {
			this.localEventListeners.delete(listener);
		};
	}

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	/** 注册状态变更监听器（供 PetStateBridge 等主进程内部模块使用）；每次 emitState 后同步回调最新 AgentTab[] */
	addStateListener(listener: (tabs: AgentTab[]) => void): () => void {
		this.stateListeners.add(listener);
		return () => {
			this.stateListeners.delete(listener);
		};
	}

	/**
	 * 注册「Agent 成功空闲」监听器（供 PetStateBridge 等主进程内部模块使用）。
	 * 仅在 agent_settled 成功路径或 get_state 兜底确认无工作后触发，
	 * abort / 自动重试 / 压缩 / agent_end 都不会触发 —— 这些都不是可靠的完成点。
	 */
	onAgentSettled(listener: (info: { agentId: string; title: string }) => void): () => void {
		this.settledListeners.add(listener);
		return () => {
			this.settledListeners.delete(listener);
		};
	}

	/** 装配层注入：仅 PiDeck 自动命名经已验证 marker 写回 catalog；source 标记来源（#266）。 */
	setAutomaticTitleChangedHandler(handler: (agentId: string, title: string, source: AutomaticTitleSource) => void): void {
		this.onAutomaticTitleChanged = handler;
	}

	/** 更新运行时 tab.title；pi JSONL/TUI 名称不能反向覆盖 catalog。 */
	private applyRuntimeTitle(agentId: string, title: string, emit = true, source?: AutomaticTitleSource): boolean {
		const runtime = this.agents.get(agentId);
		const next = title.replace(/\s+/g, " ").trim();
		if (!runtime || !next) return false;
		// pi 未改名时 sessionName = JSONL 文件名（时间戳）。写进 tab/catalog 会：
		// 1) 侧栏标题变成时间；2) 不再是占位名，refreshAutoTitle 再也不会用首条消息改名。
		if (looksLikePiSessionFileStem(next)) return false;
		const changed = next !== runtime.tab.title;
		if (changed) {
			runtime.tab.title = next;
			if (emit) this.emitState();
		}
		// 自动命名可能在运行时 tab 已预先更新后才到达；即使 changed=false 也必须尝试
		// 领取 catalog 的未确认占位标题（fallback → auto 的来源升级同样如此）。
		if (source) this.onAutomaticTitleChanged?.(agentId, next, source);
		return changed;
	}

	private notifyAgentSettled(agentId: string, title: string) {
		for (const listener of this.settledListeners) {
			try {
				listener({ agentId, title });
			} catch {}
		}
	}

	private notifyStateListeners(tabs: AgentTab[]) {
		for (const listener of this.stateListeners) {
			try {
				listener(tabs);
			} catch {}
		}
	}

	stopAll() {
		// 应用退出时统一清理所有 pi 子进程，避免后台 agent 残留占用模型或文件句柄。
		// 进行中的预热先标取消：它完成时必须直接 stop、绝不 put 回池；接力目标一并丢弃，
		// 否则退出流程结束后还会补热出一个无人认领的进程。
		this.standbyWarmup.cancelPending();
		this.standbyWarmup.clearRequestedProject();
		// standby 也在 agents map 里会被下面循环停掉；清池只为防 TTL 到期后再重复 stop。
		this.standbyPool.clear();
		for (const runtime of this.agents.values()) {
			this.userInitiatedStop.add(runtime.tab.id);
			this.clearAgentState(runtime.tab.id);
			// 快照会话同步注销（quit 时 stopModelTraceServer 会兜底，但按 agent 配对清理更早释放）
			this.unregisterModelTraceSession(runtime.tab.id);
			runtime.process.stop();
		}
		this.agents.clear();
		this.messages.clear();
		this.stoppedMessageIdentities.clear();
		// 退出时统一清理所有 gate / abort 兜底定时器，避免泄漏到下一次生命周期。
		for (const agentId of this.abortGate.gateAgentIds()) this.clearStreamGate(agentId);
		this.recentlyAborted.clear();
		// 实时日志广播的节流定时器与聚合缓冲同步清理
		this.rpcLiveTap.dispose();
		// 终态不走节流（trailing 可能迟到）：flush 后的清单就是退出时的权威快照
		this.flushStateEmit();
	}

	/**
	 * 统一挂接 PiProcess 生命周期监听。
	 * 必须在 start() 之前调用，避免 spawn error 在无 listener 窗口升级成未捕获异常。
	 */
	private attachPiProcessLifecycle(
		agentId: string,
		piProcess: PiProcess,
		options: {
			projectPath?: string;
			onExit: (payload: { code: number | null; signal: string | null }) => void;
		},
	) {
		piProcess.on("event", (event) => {
			try {
				this.handlePiEvent(agentId, event);
			} catch (error) {
				// 单条 pi 事件处理失败不能拖垮主进程；记录后继续接收后续事件。
				void this.appLogger?.error("agent", "handlePiEvent failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					eventType: event && typeof event === "object" ? String((event as { type?: unknown }).type ?? "unknown") : typeof event,
				});
			}
		});
		piProcess.on("stderr", (text) =>
			this.emit(agentEventTags.agentsLog, {
				agentId,
				...this.streamRuntimeTriple(agentId),
				text,
			}),
		);
		piProcess.on("protocol-error", (line) => {
			this.emit(agentEventTags.agentsLog, {
				agentId,
				...this.streamRuntimeTriple(agentId),
				text: `Protocol error: ${line}`,
			});
			void this.appLogger?.error("agent", `Protocol error: ${(line as string)?.slice(0, 200)}`, {
				agentId,
				project: options.projectPath,
			});
		});
		// 转发 RPC 日志到前端，用于调试面板展示请求/响应/事件
		piProcess.on("rpc-log", (entry: { direction: string; data: unknown }) => {
			try {
				// data 可能是任意 RPC 形状（含字符串污染），isRecord 收窄后逐字段判型
				const data = isRecord(entry.data) ? entry.data : undefined;
				let summary: string;
				if (!data) {
					summary = `${entry.direction === "send" ? "→" : "←"} ${String(entry.data).slice(0, 60)}`;
				} else if (entry.direction === "send") {
					const type = typeof data.type === "string" ? data.type : "?";
					if (type === "prompt") {
						const message = typeof data.message === "string" ? data.message : "";
						const desc = typeof data.description === "string" ? ` [${data.description}]` : "";
						summary = `→ prompt${desc}: ${message.slice(0, 60)}`;
					} else if (type === "set_model") summary = `→ set_model: ${data.provider}/${data.modelId}`;
					else if (type === "set_thinking_level") summary = `→ set_thinking: ${data.level}`;
					else if (type === "bash") {
						const command = typeof data.command === "string" ? data.command : "";
						summary = `→ bash: ${command.slice(0, 60)}`;
					} else summary = `→ ${type}`;
				} else {
					const type = typeof data.type === "string" ? data.type : "?";
					if (type === "response") summary = `← ${data.command ?? "?"} ${data.success ? "✓" : "✗"}${data.error ? ` ${data.error}` : ""}`;
					else if (type === "message_update") {
						const assistantEvent = isRecord(data.assistantMessageEvent) ? data.assistantMessageEvent : undefined;
						const evt = assistantEvent && typeof assistantEvent.type === "string" ? assistantEvent.type : "?";
						summary = `← message_update.${evt}`;
					} else summary = `← ${type}`;
				}
				const logEntry: RpcLogEntry = {
					id: randomUUID(),
					agentId,
					direction: entry.direction,
					summary,
					data,
					time: Date.now(),
				};
				// 只有用户手动开启 RPC 日志记录的 agent 才产生日志流量（落盘 + 实时广播）。
				// 未开启的 agent 不发射任何事件，避免每一条 RPC 通信都白白过一遍 IPC。
				if (this.rpcLiveTap.isLogging(agentId)) {
					this.rpcLiveTap.enqueue(this.rpcLogger?.push(logEntry) ?? logEntry);
				}
			} catch (error) {
				void this.appLogger?.warn("agent", "rpc-log handler failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		piProcess.on("exit", (payload: { code: number | null; signal: string | null }) => {
			try {
				void this.appLogger?.info("agent", "Pi process exit", {
					agentId,
					code: payload.code,
					signal: payload.signal,
					handshake: this.startupHandshakeAgents.has(agentId),
					stale: this.agents.get(agentId)?.process !== piProcess,
					diagnostics: piProcess.getDiagnostics(),
				});
				// 握手中的 exit 交给 handshakePiProcess 决定是否 --no-extensions 回退。
				// 回退后旧进程的迟到 exit 不能把新 runtime 标 closed。
				if (this.startupHandshakeAgents.has(agentId)) {
					// 握手期间 runtime 已注册，stop() 可达并已添加 userInitiatedStop 标记；
					// 此分支 return 后不会再走 handleCreateProcessExit 的标记清理，必须在此补删，
					// 否则泄漏。非 stop 场景标记本就不存在，删除是 no-op。
					this.userInitiatedStop.delete(agentId);
					return;
				}
				if (this.agents.get(agentId)?.process !== piProcess) {
					// stop() 先把 runtime 从 agents 删除再 process.stop()：迟到的 exit 走到这里，
					// 而清理标记的 handleCreateProcessExit 不会执行——不补删则每次 stop 泄漏一个
					// entry；agentId 复用（重启同一会话）时会把意外退出误判为用户主动停止，
					// 跳过自动重连（Issue 回归）。
					this.userInitiatedStop.delete(agentId);
					return;
				}
				options.onExit(payload);
			} catch (error) {
				void this.appLogger?.error("agent", "Pi process exit handler failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		piProcess.on("error", (error: Error) => {
			if (this.startupHandshakeAgents.has(agentId) || this.agents.get(agentId)?.process !== piProcess) {
				void this.appLogger?.error("agent", "Pi process error ignored (handshake or stale process)", {
					agentId,
					handshake: this.startupHandshakeAgents.has(agentId),
					stale: this.agents.get(agentId)?.process !== piProcess,
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			const runtime = this.agents.get(agentId);
			if (runtime) runtime.tab.status = "error";
			const message = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Pi process error", {
				agentId,
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
				diagnostics: piProcess.getDiagnostics(),
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			// 启动期 error 多半意味着进程没起来：卡片文案走 i18n，
			// 可复制的诊断详情放 debugDetails（含排查步骤），而不是静默闪退。
			this.addLocalizedMessage(agentId, "error", "diagnostic.runtimeError", "Agent 运行时发生错误。", {
				debugDetails: this.buildStartupFailureMessage(message, piProcess.getDiagnostics()),
			});
			this.emitState();
		});
	}

	/** createUnlocked 路径的进程 exit：支持压缩后自动重连，其余标 closed。 */
	private handleCreateProcessExit(agentId: string, tab: AgentTab, payload: { code: number | null; signal: string | null }) {
		if (this.startupHandshakeAgents.has(agentId)) return;
		// standby 进程在绑定前退出：立即从池剔除，避免 claim 到死进程（TTL 会兜其他泄漏路径）。
		if (this.standbyPool.status()?.agentId === agentId) this.standbyPool.clear();
		// 用户主动停止 → 不自动重连
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: user-initiated stop", {
				agentId,
				code: payload.code,
				signal: payload.signal,
			});
			return;
		}
		// 手动压缩期间退出 → compact() 的 catch 块会负责重连
		if (this.compactingAgents.has(agentId)) {
			tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: compaction in progress", {
				agentId,
				code: payload.code,
			});
			return;
		}
		// 终止窗口内的意外退出（Issue #218 WSL）：pi 在处理 abort 时可能自行崩溃
		// （上游 #2716 族：abort 期间 unhandled rejection 直接杀 Node 进程），且任何
		// 退出码都可能。此时不把会话打成 closed 终态，而是按会话文件重连一次，
		// 保住会话可用性——用户只是终止了一条回复，不该丢掉整个会话。
		const lastAbortAt = this.lastAbortAtByAgent.get(agentId);
		const withinAbortWindow = lastAbortAt !== undefined && Date.now() - lastAbortAt < AgentManager.ABORT_EXIT_REATTACH_WINDOW_MS;
		if (withinAbortWindow && !this.autoRestartAttempted.has(agentId) && tab.sessionPath) {
			this.autoRestartAttempted.add(agentId);
			tab.status = "starting";
			this.emitState();
			void this.appLogger?.warn("agent", "Agent exited during abort window; reattaching session", {
				agentId,
				code: payload.code,
				signal: payload.signal,
				sessionPath: tab.sessionPath,
			});
			this.reattachProcess(agentId, tab.sessionPath)
				.then(() => {
					tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.abortReconnected", "终止后进程异常退出，会话已自动恢复");
					this.emitState();
				})
				.catch(() => {
					tab.status = "closed";
					void this.appLogger?.error("agent", "Agent reattach after abort-window exit failed", {
						agentId,
						code: payload.code,
						sessionPath: tab.sessionPath,
					});
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		// 自动压缩 / 进程干净退出（exit code 0）且有会话路径 → 尝试一次自动重连
		if (!this.autoRestartAttempted.has(agentId) && tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			tab.status = "starting";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exited cleanly; auto-restarting", {
				agentId,
				code: payload.code,
				sessionPath: tab.sessionPath,
			});
			this.reattachProcess(agentId, tab.sessionPath)
				.then(() => {
					tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.compactReconnected", "会话压缩完成，Agent 已自动重连");
					this.emitState();
				})
				.catch(() => {
					tab.status = "closed";
					void this.appLogger?.error("agent", "Agent auto-restart failed", {
						agentId,
						code: payload.code,
						sessionPath: tab.sessionPath,
					});
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		tab.status = "closed";
		// 非 0 退出且还没写过错误卡时，补一条可排查信息（避免用户只看到 closed）。
		if (payload.code !== 0 && payload.code !== null) {
			const runtime = this.agents.get(agentId);
			const diag = runtime?.process.getDiagnostics() ?? null;
			this.addMessage(agentId, "error", this.buildStartupFailureMessage(`pi 进程退出 code=${payload.code}${payload.signal ? ` signal=${payload.signal}` : ""}`, diag));
		}
		// 最终停止（无重连路径）：统一清理该 agent 的运行态键，避免慢泄漏
		this.clearAgentState(agentId);
		this.emitState();
	}

	/** reattach 路径的进程 exit：同样做单次自动重连保护。 */
	private handleReattachProcessExit(agentId: string, runtime: AgentRuntime, payload: { code: number | null; signal: string | null }) {
		if (this.startupHandshakeAgents.has(agentId)) return;
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			runtime.tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: user-initiated stop (reattach)", {
				agentId,
				code: payload.code,
				signal: payload.signal,
			});
			return;
		}
		// 终止窗口内的意外退出（Issue #218 WSL）：与 create 路径同款处理，
		// pi 在 abort 处理中崩溃时按会话文件重连一次，而不是把会话打成 closed。
		const lastAbortAt = this.lastAbortAtByAgent.get(agentId);
		const withinAbortWindow = lastAbortAt !== undefined && Date.now() - lastAbortAt < AgentManager.ABORT_EXIT_REATTACH_WINDOW_MS;
		if (withinAbortWindow && !this.autoRestartAttempted.has(agentId) && runtime.tab.sessionPath) {
			this.autoRestartAttempted.add(agentId);
			runtime.tab.status = "starting";
			this.emitState();
			void this.appLogger?.warn("agent", "Agent exited during abort window; reattaching session (reattach path)", {
				agentId,
				code: payload.code,
				signal: payload.signal,
				sessionPath: runtime.tab.sessionPath,
			});
			this.reattachProcess(agentId, runtime.tab.sessionPath)
				.then(() => {
					runtime.tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.abortReconnected", "终止后进程异常退出，会话已自动恢复");
					this.emitState();
				})
				.catch(() => {
					runtime.tab.status = "closed";
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					void this.appLogger?.error("agent", "Agent reattach after abort-window exit failed (reattach path)", {
						agentId,
						code: payload.code,
						signal: payload.signal,
						sessionPath: runtime.tab.sessionPath,
					});
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		// 自动压缩也可能发生在重连后的进程中；继续复用同一会话文件重附加，
		// 但仍用 autoRestartAttempted 做单次保护，避免真正异常退出时无限重启。
		if (!this.autoRestartAttempted.has(agentId) && runtime.tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			runtime.tab.status = "starting";
			this.emitState();
			this.reattachProcess(agentId, runtime.tab.sessionPath)
				.then(() => {
					runtime.tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.compactReconnected", "会话压缩完成，Agent 已自动重连");
					void this.appLogger?.info("agent", "Agent reattach auto-restart succeeded", {
						agentId,
						code: payload.code,
						sessionPath: runtime.tab.sessionPath,
					});
					this.emitState();
				})
				.catch(() => {
					runtime.tab.status = "closed";
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					void this.appLogger?.error("agent", "Agent reattach auto-restart failed", {
						agentId,
						code: payload.code,
						signal: payload.signal,
						sessionPath: runtime.tab.sessionPath,
					});
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		runtime.tab.status = "closed";
		// 最终停止（无重连路径）：统一清理该 agent 的运行态键。
		// 异常退出（非 0 码）与正常退出在此汇合，warn 记录退出码便于与 exit 事件区分。
		void this.appLogger?.warn("agent", "Agent process exited; no reconnect (reattach path)", {
			agentId,
			code: payload.code,
			signal: payload.signal,
			sessionPath: runtime.tab.sessionPath,
		});
		this.clearAgentState(agentId);
		this.emitState();
	}

	/**
	 * 把 pi 启动/退出失败整理成可复制的诊断文案。
	 * 目标：用户不至于只看到闪退或空白，Issue 也能直接贴日志。
	 */
	private buildStartupFailureMessage(rawMessage: string, diag: ReturnType<PiProcess["getDiagnostics"]>): string {
		if (!diag) {
			return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\nplatform=${globalThis.process.platform} arch=${globalThis.process.arch}`;
		}
		const lines: string[] = [];
		if (diag.spawnFailed) {
			// spawn 阶段失败：结论先行。否则用户被 "spawn C:\Windows\system32\cmd.exe ENOENT"
			// 引去查 cmd.exe/PATH/杀毒软件，而真实原因往往在工作目录或 pi 路径。
			lines.push("失败阶段: 进程未启动（spawn 失败；此时扩展根本没被加载，与扩展无关）");
		}
		if (diag.exitCode !== null) {
			lines.push(`退出码: ${diag.exitCode}${diag.exitSignal ? ` (signal: ${diag.exitSignal})` : ""}`);
		}
		const stderrText = diag.stderr.join("").trim();
		if (stderrText) {
			const snippet = stderrText.length > 600 ? "…" + stderrText.slice(-600) : stderrText;
			lines.push(`进程错误输出:\n${snippet}`);
		}
		lines.push(`pi 路径: ${diag.command}`);
		if (diag.customPiPath) lines.push(`自定义路径: ${diag.customPiPath}`);
		lines.push(`工作目录: ${diag.cwd}`);
		if (diag.cwdMissing) {
			lines.push("工作目录状态: ✗ 不存在 —— 这才是上面 spawn ENOENT 的真实原因" + "（Windows 会把「工作目录无效」误报成 cmd.exe 找不到，pi/cmd.exe 本身没问题）");
		}
		// 「✗ 失败」只在真的探过 pi --version 时才成立；没探过就说没探过，
		// 否则用户会被引去重装 pi（现场：真正原因其实是工作目录没了）。
		const versionCheckFailed = diag.versionCheckProbed !== false && !diag.versionCheck;
		lines.push(`版本检测: ${diag.versionCheckProbed === false ? "未完成（未拿到 pi --version 结果，不代表失败）" : diag.versionCheck ? "✓ 通过" : "✗ 失败"}`);
		lines.push(`运行环境: ${globalThis.process.platform}/${globalThis.process.arch}`);
		if (diag.launch && diag.launch.channel === "cmd-shim") {
			// 「pi 不是改成 node 启动了吗」——把通道与回退原因写进卡片，免得命令行里的 cmd.exe 被当成回归。
			lines.push(`启动通道: cmd.exe 回退${diag.launch.reason ? `（原因：${diag.launch.reason}）` : ""}` + "（node 直启需要 npm 生成的 pi.cmd 垫片与其中的 JS 入口都存在）");
		} else if (diag.launch?.channel === "node-direct") {
			lines.push("启动通道: node 直启（已还原 JS 入口，无 cmd.exe 中间层）");
		}
		if (diag.blockedExtensions && diag.blockedExtensions.length > 0) {
			// 桌面端已自动隔离的扩展（如 codeisland），方便用户对照「为何 RPC 没加载该扩展」。
			lines.push(`已自动隔离扩展: ${diag.blockedExtensions.join(", ")}`);
		}
		lines.push("");
		lines.push("━━━ 排查步骤 ━━━");
		if (diag.cwdMissing) {
			lines.push("1. 确认上面的工作目录是否真的存在（被移动/重命名/删除，或所在磁盘/网络盘未挂载）");
			lines.push("2. 目录不存在时 pi 无法以该目录为工作目录启动，与 pi 是否安装无关");
			lines.push("3. 在 PiDeck 中重新指定该项目的目录后重启会话");
		} else if (versionCheckFailed) {
			lines.push("1. 在终端执行 pi --version，确认 pi 是否已安装且路径正确");
			lines.push("2. 如未安装，执行 npm install -g @earendil-works/pi-coding-agent");
			lines.push("3. macOS 若从 Dock 启动，可在设置中填写完整 pi 路径（Homebrew 常见 /opt/homebrew/bin/pi）");
		} else if (diag.exitCode !== 0 && diag.exitCode !== null) {
			lines.push("1. 在终端执行 pi --mode rpc 看是否能正常启动");
			lines.push("2. 注意终端中的错误信息（架构不匹配/权限/扩展崩溃都会体现在这里）");
		} else if (!stderrText && diag.exitCode === null) {
			// 进程还活着但不响应握手：与「进程没起来」是两类问题，别让用户反复重装 pi。
			lines.push(`1. pi 进程已启动，但 ${Math.round(this.startupHandshakeTimeoutMs / 1000)} 秒内未响应 get_state（进程仍存活，不是崩溃）。`);
			lines.push("2. 常见原因：某个扩展在初始化阶段卡住、会话文件异常巨大、pi 在等待网络。");
			lines.push("3. 在终端执行 pi --mode rpc 看是否能正常启动，注意终端中的错误信息");
		} else {
			lines.push("1. 在终端执行 pi --mode rpc 确认 pi 能否正常启动");
			lines.push("2. 检查设置中的 pi 路径是否正确");
		}
		const startFlags = this.settingsStore.get();
		const noExt = Boolean(startFlags.piRpcNoExtensions);
		const noSkills = Boolean(startFlags.piRpcNoSkills);
		lines.push("");
		lines.push("━━━ 扩展 / 技能排查 ━━━");
		if (noExt || noSkills) {
			lines.push(`当前启动已禁用：${[noExt ? "扩展 (--no-extensions)" : null, noSkills ? "技能 (--no-skills)" : null].filter(Boolean).join("、")}`);
			lines.push("若仍失败，更可能是 pi 本体/路径/会话文件问题，而不是扩展加载。");
		} else if (diag.spawnFailed) {
			// 进程都没起来，扩展压根没被加载：让用户去关扩展只是白跑一趟。
			lines.push("本次失败发生在 pi 进程启动之前（扩展尚未加载），不需要在这里排查扩展/技能。");
		} else {
			lines.push("若怀疑某个扩展或技能导致启动失败：");
			lines.push("1. 打开 设置 → 开发设置");
			lines.push("2. 临时开启「禁用扩展启动」和/或「禁用技能启动」");
			lines.push("3. 保存后重新启动 Agent 验证");
			lines.push("若禁用后能启动，再逐个排查 ~/.pi/agent/extensions 与 skills。");
		}
		// 解释「为什么这次没有自动用 --no-extensions 重试」：用户预期启动失败会自动回退，
		// 缺了这句就会被当成回退功能没生效（现场反馈即如此）。
		const fallbackSkip = describeExtensionFallbackSkip({
			alreadyNoExtensions: noExt,
			stderr: stderrText,
			errorMessage: rawMessage,
			exitCode: diag.exitCode,
			spawnFailed: diag.spawnFailed === true,
			// 能走到诊断卡且未被判定为 spawn 失败、也没有退出码 ⇒ 进程当时仍存活（握手超时）
			processStillRunning: diag.spawnFailed !== true && diag.exitCode === null,
		});
		if (fallbackSkip) {
			lines.push("");
			lines.push("━━━ 扩展回退 ━━━");
			lines.push(`本次未自动用 --no-extensions 重试：${fallbackSkip}`);
		}
		lines.push("");
		lines.push("如问题持续，可在 GitHub 提交 Issue 并附上以上信息与应用日志。");
		return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\n${lines.join("\n")}`;
	}

	private handlePiEvent(agentId: string, event: unknown) {
		// 通知本地监听器（FeishuBridge、WebEventStream SSE 等主进程内部订阅）
		for (const listener of this.localEventListeners) {
			try {
				listener(agentId, event);
			} catch {}
		}
		// 2026-08 治理：agents:event 不再转发渲染进程。桌面 UI 没有任何消费者，
		// 而每 token 100+/s 的原始事件转发会让渲染端 applySessionRuntimeEventAtom
		// 无条件写 sessionRuntimeByIdAtom → timeline 等订阅者 100/s 全量重渲染
		// （O(消息数) + V8 committed 只涨不缩，GB 级内存爬升的核心驱动）。
		// web SSE/飞书等内部订阅走上方 localEventListeners，不受影响。

		if (!isRecord(event)) return;
		const typed = event;
		const runtime = this.agents.get(agentId);

		// pi/TUI /name 会发 session_info_changed，但 PiDeck 不兼容其反向标题同步：
		// 未验证的事件不能改 catalog 或 runtime 展示标题。自动标题扩展会先发专用
		// setStatus marker，只有 marker 与紧随的名称和 runtime 身份完全匹配才可领取占位标题。
		if (typed.type === "session_info_changed" && runtime) {
			const name = typeof typed.name === "string" ? typed.name.replace(/\s+/g, " ").trim() : "";
			const automaticMarker = this.uiGate.takeAutomaticTitle(agentId);
			const automaticTitle = automaticMarker?.title === name && automaticMarker.sessionId === runtime.tab.sessionId && automaticMarker.runtimeGeneration === runtime.tab.runtimeGeneration;
			if (automaticTitle) this.applyRuntimeTitle(agentId, name, true, "auto");
		}

		if (typed.type === "agent_start" && runtime) {
			// 阶段归因：agent_start = pi 已接单开跑（此前间隔是 pi 内部排队/扩展钩子耗时）。
			this.messagePerf.noteAgentStart(agentId);
			// 首个 run 开始：此刻用户的触发消息已落盘，把启动期诊断（扩展回退/启动扩展报错）
			// 按序写入时间线——位于用户消息之后、回答之前，避免插进历史轮次中间。
			this.startupDiagnostics.markFirstRun(agentId);
			// agent_start 表示一轮新的 agent run 开始：
			// 1) 清理 recentlyAborted，允许状态机恢复 running
			// 2) 推进 stream generation，解封流式闸门（唯一合法解封点）
			this.recentlyAborted.delete(agentId);
			// 上一轮的 abort 升级上下文随之作废（新一轮 run 与上次终止无关）
			this.abortGate.clearEscalation(agentId);
			this.notifiedAskAgents.delete(agentId);
			this.openAgentStream(agentId);
			this.setAgentTurnActive(agentId, true);
			// rewind 回合计数：每轮 run 递增一次，供文件自动打点标记 turnIndex。
			this.rewindCheckpoints.bumpTurn(agentId);
			// 首轮 run 顺带清理非活跃会话的 checkpoint（fire-and-forget，
			// keep 集合含当前会话，并发会话不误删；节流见方法内注释）。
			// 远端 cwd：本机 git 清理不参与（root 是远端路径，本机不存在这个仓库）。
			if (runtime.tab.cwd && runtime.tab.sessionId && !this.isRemoteRuntime(runtime.tab.projectId)) {
				this.rewindCheckpoints.pruneOldSessionsFor(this.rewindHostRoot(runtime.tab.cwd, runtime.tab.wslDistro), runtime.tab.sessionId);
			}
			runtime.tab.status = "running";
			this.activeAssistantMessageIds.delete(agentId);
			this.toolMessageIds.delete(agentId);
			this.activeToolCallsByAgent.delete(agentId);
			// 新一轮必须立刻清渲染层工具/流式态：只 emitState 不会推 runtime-state，
			// 上一轮「工具调用中 / 回复中」会粘到本轮开头。
			this.toolExecutingByAgent.set(agentId, null);
			this.streamingAgents.delete(agentId);
			this.emitState();
			this.emitToolRuntimeTransition(agentId, false);
			this.emitStreamingStatePatch(agentId);
			// 新一轮丢掉上一轮 held live 槽，避免旧正文串到本轮。
			this.emit(agentEventTags.agentsTextStream, {
				agentId,
				...this.streamRuntimeTriple(agentId),
				text: "",
				done: true,
				reset: true,
			});
		}

		if (typed.type === "turn_start" && runtime && !this.isAgentStreamSealed(agentId)) {
			// Pi 在工具执行后、准备下一次模型调用前发 turn_start；message_start
			// 可能等到 provider 首个事件才到，无法覆盖工具续答的首 token 等待。
			this.messagePerf.ensureTimer(agentId);
			this.messagePerf.noteTurnStart(agentId);
		}

		const startMessage = isRecord(typed.message) ? typed.message : undefined;
		if (typed.type === "message_start" && startMessage?.role === "user" && typeof startMessage.timestamp === "number" && Number.isFinite(startMessage.timestamp) && runtime && this.isRemoteRuntime(runtime.tab.projectId)) {
			const messages = this.messages.get(agentId) ?? [];
			const index = bindRemoteUserMessageTimestamp(messages, this.messageProjector.convert("_viewer", [startMessage])[0]);
			if (index !== undefined) {
				this.markMessagesDirtyFrom(agentId, index);
				this.scheduleMessageEmit(agentId);
			}
		}
		if (typed.type === "message_start" && startMessage?.role === "assistant") {
			// abort 封印后的残留 assistant 事件应丢弃，防止误重新激活流式状态。
			// stop()/关闭路径已 agents.delete + clearStreamGate（封印随之删除），
			// 死 agentId 的封印恒为「未封」；runtime 缺失即拒绝——迟到 delta 不得
			// 为死 agentId 重建 messages/streamingText 键并外发死 agent 事件。
			if (!runtime || this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.beginAssistantMessage(agentId);
			this.streamingAgents.add(agentId);
			// 性能计时起表（幂等：message_update start 先到则不重置）。
			// 顶层 message_start 是 mock/pi 均走的确定路径，不能只依赖 delta 事件。
			this.messagePerf.ensureTimer(agentId);
			this.messagePerf.noteMessageStart(agentId);
			// 顶层 message_start（mock/pi 均走此路径）：必须允许空骨架，否则
			// text_delta 不再 upsert 时 History 无挂载点，Live 正文无处渲染。
			this.upsertAssistantMessage(agentId, startMessage, "", { allowEmpty: true });
			this.flushMessageEmit(agentId);
		}

		if (typed.type === "auto_retry_start") {
			this.upsertRetryStatusMessage(agentId, typed, "running");
			// 用户已主动中止时不重新激活 running 状态，避免 abort 后 auto-retry 事件误覆盖 state
			if (runtime && !this.recentlyAborted.has(agentId)) {
				// pi 在等待指数退避期间可能短暂结束一轮 agent run；桌面端保持 running，
				// 让用户明确知道当前不是最终失败，而是在等待下一次自动重试。
				runtime.tab.status = "running";
				this.emitState();
			}
		}

		if (typed.type === "auto_retry_end") {
			this.upsertRetryStatusMessage(agentId, typed, typed.success ? "success" : "error");
			// 自动重试最终失败：如果用户没有主动中止，则保持 agent 的 error 状态
			// 不被后续 agent_settled 覆盖，确保侧边栏状态显示失败标记。
			if (!typed.success && runtime && !this.recentlyAborted.has(agentId)) {
				runtime.tab.status = "error";
				const reason = typed.finalError ?? typed.errorMessage ?? "API 请求失败";
				this.addMessage(agentId, "error", `请求失败：${String(reason)}`);
				// 自动重试最终失败：原因只写会话气泡无法离线排查，这里同步留痕 applog。
				// 记录剩余重试次数与最终错误原文，供 Issue 排查 API 可用性/配额问题。
				void this.appLogger?.error("agent", "Auto retry exhausted", {
					agentId,
					attempt: typed.attempt,
					maxAttempts: typed.maxAttempts,
					reason: String(reason),
				});
				this.emitState();
			}
		}

		// 自动/手动压缩事件（pi 在自动或手动压缩完成后会发出这些事件），
		// 用于记录压缩耗时和结果，便于排查压缩性能问题。
		if (typed.type === "compaction_start") {
			this.rpcCompactingAgents.add(agentId);
			// 记开始时间：结束后算耗时，用于判定「钩子在总结前拒绝」（见
			// resolveCompactCancelMessage）。start 可能连发（自动重试多段压缩），
			// 以最后一次为准。
			this.compactionStartedAt.set(agentId, Date.now());
			// 用户已主动中止或出错时不重新激活 running 状态
			if (runtime && !this.recentlyAborted.has(agentId) && runtime.tab.status !== "error") {
				// 自动压缩在 agent_end 之后触发：Pi 仍在改写上下文，但不会再发 agent_start。
				// 因此桌面端必须主动保持 running，阻止用户误以为空闲并继续发送消息。
				runtime.tab.status = "running";
				this.emitState();
				void this.emitRuntimeState(agentId);
			}
			void this.appLogger?.info("agent", "Compaction started", {
				agentId,
				reason: typed.reason,
			});
		}
		if (typed.type === "compaction_end") {
			this.rpcCompactingAgents.delete(agentId);
			// compact() 等待超时分支故意不删 compactingAgents（保持 isCompacting 让按钮
			// 禁用直到后台压缩结束），在这里统一收尾；正常路径 RPC 成功时已删过，重复 delete 无害。
			this.compactingAgents.delete(agentId);
			// 手动压缩超时后的后台结果：成功则补发完成消息让「仍在后台进行」有确定结局；
			// 失败/中止只清标记不补发（失败已有下方既有提示路径，残留标记会让后续
			// 自动压缩成功误报「后台压缩完成」）。自动压缩从未入集合，不受影响。
			const compactTimedOut = this.compactTimedOutAgents.delete(agentId);
			if (typed.result === true && compactTimedOut && runtime) {
				this.addLocalizedMessage(agentId, "system", "diagnostic.compactDoneAfterTimeout", "后台压缩完成，上下文已更新");
			}
			// 观测留给 compact() 的失败分支做来源判定：同一个 "Compaction cancelled"
			// 到底是「扩展钩子拒绝」还是「abort 打断」，唯一客观线索就是这段耗时。
			const startedAt = this.compactionStartedAt.get(agentId);
			this.compactionStartedAt.delete(agentId);
			const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
			this.lastCompactionObservation.set(agentId, {
				aborted: typed.aborted === true,
				reason: typeof typed.reason === "string" ? typed.reason : undefined,
				elapsedMs,
				at: Date.now(),
			});
			// 压缩失败且不会自动重试时给用户可见提示（否则只进日志，用户会误以为一切正常，
			// 直到下一轮上下文溢出）。aborted 是用户主动取消、willRetry 是 pi 自动重试中，都不提示。
			if (typed.result === false && typed.aborted !== true && typed.willRetry !== true && runtime) {
				this.addLocalizedMessage(agentId, "error", "diagnostic.compactionFailed", "会话压缩失败，上下文可能已接近上限；可稍后手动重试压缩，或重启会话。", {
					debugDetails: typeof typed.errorMessage === "string" && typed.errorMessage ? typed.errorMessage : undefined,
				});
			}
			if (runtime) {
				// compaction 成功时才会向 session JSONL 写入新的边界记录；只有此时才需要重载，
				// 否则前端仍展示压缩前分支，下一轮继续对话时看起来像“断在旧会话”。
				// 失败/中止的压缩不改写文件（见 shouldReloadMessagesAfterCompaction），
				// 重载只会把同一份巨型 JSONL 再读一遍并全量下发一次（#213 渲染进程 OOM 主因）。
				if (shouldReloadMessagesAfterCompaction(typed)) {
					this.reloadMessagesAfterCompaction(agentId);
				}
				// 用户已主动中止或出错时不重新激活 running 状态
				if (!this.recentlyAborted.has(agentId) && runtime.tab.status !== "error") {
					// compaction_end 之后 Pi 仍可能因 overflow retry 或 queued follow-up 自动继续。
					// 只有 agent_settled 才表示不会再自动发起下一轮，不能在这里提前 idle。
					runtime.tab.status = "running";
				}
				this.emitState();
				void this.emitRuntimeState(agentId);
				// 压缩结束不保证会来 agent_settled（pi 版本差异）：主动确认 pi 是否还有
				// 工作（overflow retry / queued follow-up），无工作即恢复 idle。否则状态
				// 永远 stuck 在 running——最后回复耗时继续走（LiveDuration）、加载动画
				// 常驻、思考/工具折叠保持展开（2026-08 用户反馈）。
				// 延迟 300ms 让 pi 完成压缩收尾（文件写入/状态刷新），避免误判忙碌。
				const idleTimer = setTimeout(() => {
					void this.markIdleIfPiReportsNoWork(agentId);
				}, 300);
				idleTimer.unref?.();
			}
			void this.appLogger?.info("agent", "Compaction ended", {
				agentId,
				reason: typed.reason,
				result: typed.result ? "success" : "failed",
				aborted: typed.aborted,
				willRetry: typed.willRetry,
				errorMessage: typed.errorMessage,
				// 耗时是区分「扩展钩子拒绝」（毫秒级）与「真实压缩」的关键字段。
				elapsedMs,
			});
		}

		if (typed.type === "agent_end") {
			// 未结算的起点（turn_start 后没等到消息）不能留给下一次回复；willRetry 同理，见 discardInFlight。
			this.messagePerf.discardInFlight(agentId);
			// agent_end closes the logical response turn even when Pi continues with
			// compaction/retry bookkeeping and keeps the runtime busy.
			this.setAgentTurnActive(agentId, false);
			// agent_end 只表示一次底层 run 结束；Pi 之后仍可能执行自动重试、自动压缩，
			// 或压缩后继续 queued follow-up。最终空闲必须等 agent_settled，避免中途误判 idle。
			if (runtime) {
				this.activeAssistantMessageIds.delete(agentId);
				this.streamingAgents.delete(agentId);
				this.toolMessageIds.delete(agentId);
				this.liveStream.clearTextChannel(agentId);
			}
			// agent 异常结束时（如 API 返回 400、模型报错等），将错误提示写入会话，避免用户看到空白。
			// 错误信息的存放位置因 pi 版本和错误类型不同而有多种可能：
			//   1. agent_end 顶层 errorMessage
			//   2. messages 数组中 stopReason=error 的消息的 errorMessage
			//   3. messages 数组中 assistant 消息的 content 里包含 error 片段
			//   4. agent_end 顶层 stopReason=error 但无 messages
			const agentMessages = (Array.isArray(typed.messages) ? typed.messages : []) as AgentEndMessage[];
			const errorMessages = agentMessages.filter((m) => m.stopReason === "error");
			// 逐级查找错误文本：顶层 → 错误消息列表 → 仅检查最后一轮对话中 type=error 的 content 块
			const topMsg = errorMessages[errorMessages.length - 1];
			// 只从最后一条 assistant 消息中查找显式 type=error 的 content 块，
			// 避免扫描全部历史消息导致工具成功输出被误判为错误。
			const lastAssistant = agentMessages.filter((m) => m.role === "assistant").pop();
			const contentError = Array.isArray(lastAssistant?.content) ? lastAssistant.content.find((c) => c?.type === "error") : undefined;
			const errorMsg = (typed.errorMessage as string | undefined) ?? topMsg?.errorMessage ?? (typed.error as string | undefined) ?? (typeof contentError?.text === "string" ? contentError.text : undefined) ?? (typeof contentError?.message === "string" ? contentError.message : undefined);
			// 用户主动 abort 的回合偶发携带错误文本（工具被 abort_bash 杀掉、abort 与
			// 工具事件交错等）：终止不应该把仍存活的进程标成终态 error，否则下次激活
			// 会被当成启动失败或杀掉重建（Issue #218「终止恢复有些特殊情况进程被杀掉」）。
			// 错误卡片照常保留，状态交给 agent_settled 收敛回 idle。
			const abortedTurn = typed.stopReason === "aborted" || this.recentlyAborted.has(agentId);
			if (typed.willRetry === true) {
				// agent_end.willRetry 表示 pi 已判定本次错误会进入自动重试；
				// 此时不写入最终错误，避免用户误以为会话已经失败。
				if (errorMsg && !this.activeRetryStatusMessageId(agentId)) {
					this.upsertRetryStatusMessage(
						agentId,
						{
							attempt: 0,
							maxAttempts: 0,
							delayMs: 0,
							errorMessage: String(errorMsg),
						},
						"running",
					);
				}
				// 重试中保持 running，不能误置为 idle/error，否则宠物聚合状态会提前转 done/failed
				if (runtime) runtime.tab.status = "running";
			} else if (errorMsg) {
				const contextOverflow = isContextOverflowError(errorMsg);
				this.contextOverflowByAgent.set(agentId, contextOverflow);
				this.emitContextOverflowState(agentId, contextOverflow);
				this.addDetailedErrorMessage(agentId, String(errorMsg));
				// 有错误且不会重试 → Agent 进入 error 态，宠物聚合为 failed（行5），
				// 否则会被误置为 idle 触发"所有任务完成"通知。
				// 例外：用户主动 abort 的回合不置终态（进程还活着，见上方 abortedTurn 注释）。
				if (runtime && !abortedTurn) runtime.tab.status = "error";
				// agent_end 携带错误且不重试：错误原文（API 400/模型报错等）必须进 applog，
				// 会话气泡只面向用户，排查时依赖这里的结构化记录。
				void this.appLogger?.error("agent", "Agent run ended with error", {
					agentId,
					error: String(errorMsg),
					stopReason: typed.stopReason,
				});
			} else if (typed.stopReason === "error" || errorMessages.length > 0) {
				const contextOverflow = isContextOverflowError(errorMsg ?? topMsg?.errorMessage ?? typed.error ?? typed.stopReason);
				this.contextOverflowByAgent.set(agentId, contextOverflow);
				this.emitContextOverflowState(agentId, contextOverflow);
				// 无显式 errorMsg 时不停止把线索落进气泡：stopReason/末条 error 消息的
				// errorMessage 至少能让用户点开看到「原因未知在哪未知」。
				this.addDetailedErrorMessage(agentId, typeof topMsg?.errorMessage === "string" ? topMsg.errorMessage : typeof typed.error === "string" ? typed.error : undefined);
				// 与上一分支同款 abort 例外：终止回合不把活进程标成终态。
				if (runtime && !abortedTurn) runtime.tab.status = "error";
				// 与上一分支同款留痕：无显式错误文本时也记下 stopReason 与最后一条
				// error 消息的 errorMessage，避免「会话失败但原因未知」完全不可追溯。
				void this.appLogger?.error("agent", "Agent run ended with error", {
					agentId,
					error: topMsg?.errorMessage ?? typed.error ?? typed.stopReason,
					stopReason: typed.stopReason,
				});
			}
			if (runtime) this.emitState();
			// agent_end 后 runtimeState 可能暂时仍显示后续 compaction/retry；立即同步一次，
			// 但不要把它当作最终空闲信号，最终状态由 agent_settled 处理。
			void this.emitRuntimeState(agentId);

			// 兜底：如果 Pi 由于某些边缘情况未发送 agent_settled，
			// 定时查询 get_state 确认是否已无工作可做，避免 UI 动画永久卡住。
			// agent_settled 正常触发时 markIdleIfPiReportsNoWork 会因 status!=="running" 提前返回。
			const settledTimer = setTimeout(() => {
				void this.markIdleIfPiReportsNoWork(agentId);
			}, AgentManager.AGENT_SETTLED_TIMEOUT_MS);
			settledTimer.unref?.();
		}

		if (typed.type === "agent_settled") {
			// agent_settled 是 Pi 的最终稳定点。
			// 通知 stream gate：abort 对应的 settled 已到。
			// 若 settled 前已有 agent_start（用户立刻重发），此处才真正解封；
			// 若还没有新 start，则保持封印，防止 settled 后残留 delta 复活旧气泡。
			// abort 的 settled（或 abort 后重发时迟到的旧 settled）不算成功完成：
			// pi 1.1+ 的 aborted 标记也覆盖扩展发起的取消；旧版或迟到事件仍由本地状态兜底。
			// recentlyAborted 被 agent_start 清除，但 settled 兜底定时器保留到 settled，
			// 任一取消信号命中都不得触发「已完成」提醒。
			const isAbortSettled = typed.aborted === true || this.recentlyAborted.has(agentId) || this.abortGate.hasSettledFallback(agentId);
			this.noteAgentAbortSettled(agentId);
			this.recentlyAborted.delete(agentId);
			if (runtime && runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
				// agent_settled 是 Pi 的最终稳定点：没有自动重试、自动压缩、压缩 retry
				// 或 queued follow-up 会继续执行，此时才允许恢复 idle 并通知用户完成。
				runtime.tab.status = "idle";
				// 若 message_end 未到（边缘路径），仍先落盘再清 live；settled 同时
				// 重算 renderer 的尾部 9 轮窗口，并在必要时裁剪主进程缓存。
				this.finalizeThinkingIntoMessage(agentId);
				this.flushMessageEmit(agentId);
				this.trimRuntimeCache(agentId);
				this.liveStream.finishThinkingChannel(agentId);
				this.activeAssistantMessageIds.delete(agentId);
				this.streamingAgents.delete(agentId);
				this.toolMessageIds.delete(agentId);
				this.liveStream.clearTextChannel(agentId);
				this.activeToolCallsByAgent.delete(agentId);
				this.toolExecutingByAgent.set(agentId, null);
				this.rpcCompactingAgents.delete(agentId);
				this.emitState();
				void this.emitRuntimeState(agentId);

				// 终态重投影（2026-11）：本轮消息流式期间是 live 身份（randomUUID、无 entryId），
				// 编辑/删除/重发需要 meta.entryId 才能在 JSONL 里定位（live id 无法匹配文件条目，
				// 删除会 no-op、编辑/重发报 Message not found）。settled 是最终稳定点，重读一次
				// 文件把消息绑定到 entryId 并 flush（loadMessages 尾部 immediate flush 覆盖上面的
				// 手动 flush）；preserveMessagesAfter 保住附加期间新轮次的乐观消息。
				// 不阻塞事件循环：新 turn 事件到达时旧投影可能未完成，由 preserve 路径兜底。
				void this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);

				const messages = this.messages.get(agentId) ?? [];
				const lastMessage = messages[messages.length - 1];
				// 手动停止（abort）不算正常完成：与下方 notifyAgentSettled 同一判断，
				// 停止会话后不弹「已完成」系统通知（用户主动中止，无需提醒）
				if (lastMessage?.role === "assistant" && !isAbortSettled) {
					this.notifySessionEnd(agentId, runtime.tab.title);
				}
				// 成功空闲（settled）后才算完成：通知宠物等内部模块携带标题，供「{title} 已完成」气泡使用。
				if (!isAbortSettled) this.notifyAgentSettled(agentId, runtime.tab.title);
			}
		}

		if (typed.type === "message_update" && typed.assistantMessageEvent) {
			// abort 封印后的延迟 text/thinking delta 一律丢弃，避免重建气泡或串台。
			if (!runtime || this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.handleAssistantMessageEvent(agentId, typed);
		}

		const messageEnd = isRecord(typed.message) ? typed.message : undefined;
		if (typed.type === "message_end" && messageEnd?.role === "assistant") {
			// stop() 后 runtime 已删：迟到 message_end 不得为死 agentId 重建状态。
			if (!runtime || this.isAgentStreamSealed(agentId)) {
				return;
			}
			if (this.activeAssistantMessageIds.has(agentId)) {
				// 先写入 History thinking 并 flush，再发 done 清 live（顺序写进测试）。
				this.finalizeThinkingIntoMessage(agentId);
				this.upsertAssistantMessage(agentId, messageEnd);
				this.flushMessageEmit(agentId);
				this.liveStream.finishThinkingChannel(agentId);
				this.activeAssistantMessageIds.delete(agentId);
			}
			// 结算性能指标（幂等：message_update done 先结算则 map 已删，直接返回）
			this.messagePerf.settle(
				agentId,
				(channel, payload) => this.emit(channel, payload),
				messageEnd,
				(message, detail) => void this.appLogger?.info("session-perf", message, detail),
			);
			// 终结 Live 正文通道（顶层 message_end 不经 handleAssistantMessageEvent）
			this.streamingAgents.delete(agentId);
			this.liveStream.finalizeText(agentId);
			this.emitStreamingStatePatch(agentId);
		}

		if (typed.type === "tool_execution_start") {
			// abort 封印后的延迟工具事件应丢弃，避免重新激活流式状态。
			if (!runtime || this.isAgentStreamSealed(agentId)) {
				return;
			}
			// 新工具轮次开始：上一个 ask 的等待累计若未被其 end 事件消耗（如 abort 封印），
			// 在此清空，防止把旧等待算进后续工具耗时。
			this.uiGate.clearAskWait(agentId);
			this.upsertToolMessage(agentId, typed, "running");
			// 并行工具会先连续发多个 start；按 toolCallId 追踪，只有最后一个 end 才能表示工具阶段完成。
			const toolName = typeof typed.toolName === "string" ? typed.toolName : "tool";
			const toolCallId = String(typed.toolCallId ?? `${toolName}-${Date.now()}`);
			const toolState = updateActiveToolCalls(this.activeToolCallsByAgent.get(agentId) ?? new Map<string, string>(), { type: "start", toolCallId, toolName });
			this.applyActiveToolCallState(agentId, toolState);
			// 工具调用开始时确保 agent 状态为 running
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 完整 runtime 信息异步补发；工具边沿已经同步推送，不依赖此请求的完成顺序。
			// 300ms 尾沿去抖：并行工具批的连发 start 合并为一次 get_state。
			this.scheduleToolEdgeRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_end") {
			// abort 封印后的延迟工具事件应丢弃。
			if (!runtime || this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.upsertToolMessage(agentId, typed, typed.isError ? "error" : "done");
			// 文件类工具执行完成 → 异步自动打点（快照包含该工具改动后的状态）。
			// 检查点创建不阻塞工具结果推送（fire-and-forget，失败只记日志）。
			const endedToolName = typeof typed.toolName === "string" ? typed.toolName : "";
			// 远端 cwd：checkpoint ref 在本机仓库里，远端会话的打点必须跳过（本机 git 只会
			// stat 到同名路径，远端 rewind 属后续批次）。
			if (MUTATING_TOOLS.has(endedToolName) && !this.isRemoteRuntime(runtime.tab.projectId)) {
				this.rewindCheckpoints.scheduleToolCheckpoint(agentId, endedToolName, this.rewindCheckpoints.turnCounter(agentId));
			}
			if (endedToolName === "Agent" || endedToolName === "subagent" || endedToolName === "acp_delegate") {
				const sessionPath = runtime?.tab.sessionPath;
				if (sessionPath) {
					void this.readSessionSubagentRecords(sessionPath, { liveRuntimeStartedAt: runtime.tab.createdAt })
						.then((records) => {
							this.syncSubagentPerfSpans(agentId, records);
						})
						.catch(() => {});
				}
			}
			// 工具执行结束是终态，立即 flush 把最终结果推给渲染进程，避免节流窗口内用户看不到完成状态。
			this.flushMessageEmit(agentId);
			// 清除本次 toolCall；并行批次仅在最后一个工具结束时发布 false，
			// 否则 steer 会在其他工具仍运行时过早进入 pi 队列。
			const activeToolCalls = this.activeToolCallsByAgent.get(agentId) ?? new Map<string, string>();
			const toolState = updateActiveToolCalls(activeToolCalls, {
				type: "end",
				toolCallId: String(typed.toolCallId ?? ""),
				// end 可能不带 toolCallId（此时上面是空串），把 toolName 一并交给归并逻辑：
				// start 缺 id 时用的是 `${toolName}-${timestamp}` 兜底 key，只按空串删会永远删不掉。
				toolName: endedToolName || undefined,
			});
			this.applyActiveToolCallState(agentId, toolState);
			// 工具调用完成后保持 agent 状态为 running，等待后续的 agent_end 事件
			// 这样在工具完成到 agent 生成回复之间，thinking bubble 仍然会显示
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 完整 runtime 信息异步补发；序号保证它不会倒灌旧工具状态。
			// 与 start 同一去抖：工具批全部结束后 300ms 补一次即可。
			this.scheduleToolEdgeRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_update") {
			// abort 封印后的延迟工具事件应丢弃。
			if (!runtime || this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.upsertToolMessage(agentId, typed, "running");
		}

		if (typed.type === "extension_ui_request") {
			this.uiGate.handleUIRequest(agentId, typed);
		}

		if (typed.type === "extension_error") {
			// 扩展报错不等于会话失败：不改 tab.status，只记诊断。
			// reason 给 toast / 诊断卡展示，避免 String(object) 变成 [object Object]。
			const reason = formatExtensionErrorReason(typed);
			const diagnostic: QueuedStartupDiagnostic = {
				role: "error",
				i18nKey: "diagnostic.extensionError",
				fallbackText: "扩展执行错误。",
				options: { debugDetails: reason },
			};
			// 首个 agent_start 之前到达 = 启动期扩展报错：按启动诊断暂存（见 startupDiagnosticsQueue），
			// 首个 run 落盘到用户消息之后；否则是运行期间的报错，直接写时间线。
			this.startupDiagnostics.deliver(agentId, diagnostic);
		}
	}

	/** 渲染层信任决策回传（IPC 入口，systemIpc 调用）：转发给信任闸唤醒等待中的创建流程。 */
	respondTrustRequest(requestId: string, choice: ProjectTrustChoice): void {
		this.projectTrust.respondTrustRequest(requestId, choice);
	}

	/** 渲染层提问回答（IPC 入口）：转发给 UI 请求闸直写 pi stdin 并结算等待时长。 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) {
		this.uiGate.sendUIResponse(agentId, requestId, response);
	}

	private handleAssistantMessageEvent(agentId: string, event: unknown) {
		// 双保险：即使调用方漏判，也在这里拦截封印 generation 的残留 delta。
		if (this.isAgentStreamSealed(agentId)) return;
		if (!isRecord(event)) return;
		const assistantEventRaw = event.assistantMessageEvent;
		if (!isRecord(assistantEventRaw)) return;
		const assistantEvent = assistantEventRaw;
		const eventType = typeof assistantEvent.type === "string" ? assistantEvent.type : undefined;
		const partialMessage = event.message ?? assistantEvent.message ?? assistantEvent.partial ?? assistantEvent.partialMessage;

		if (eventType === "start" || eventType === "message_start") {
			this.beginAssistantMessage(agentId);
			this.streamingAgents.add(agentId);
			// 性能计时起表（幂等：顶层 message_start 先到则不重置）
			this.messagePerf.ensureTimer(agentId);
			// 允许空正文骨架：Live 正文走独立通道，TurnRow 需要 History 挂载点。
			this.upsertAssistantMessage(agentId, partialMessage, "", { allowEmpty: true });
			this.flushMessageEmit(agentId);
			return;
		}

		if (eventType === "text_start" || eventType === "text_end") {
			this.streamingAgents.add(agentId);
			// 仅在已有骨架上同步 partial；空文本不新建、不刷 timeline。
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "text_delta") {
			this.streamingAgents.add(agentId);
			const delta = String(assistantEvent.delta ?? "");
			if (delta.length > 0) {
				this.messagePerf.markFirstDelta(agentId);
				this.messagePerf.markFirstText(agentId);
			}
			// Live 正文唯一热路径：累积后经 textEmitter（100ms）推送，不增长 messages。
			const prevText = this.liveStream.getText(agentId) ?? "";
			const nextText = this.extractStreamingText(agentId, partialMessage) ?? prevText + delta;
			this.liveStream.accumulateText(agentId, nextText);
			// 思考切正文：只标 endedAt，不落盘、不清 live（message_end/abort 才写入）。
			if (this.liveStream.hasSegment(agentId)) {
				this.liveStream.markThinkingSegmentEnded(agentId);
			}
			return;
		}

		if (eventType === "thinking_delta") {
			this.liveStream.ensureThinkingSegment(agentId);
			const delta = String(assistantEvent.delta ?? "");
			if (delta.length > 0) this.messagePerf.markFirstDelta(agentId);
			this.liveStream.pushThinkingDelta(agentId, delta);
			this.streamingAgents.add(agentId);
			// Live 思考唯一热路径：不 upsert messages，避免 50ms timeline 重组。
			return;
		}

		if (eventType === "thinking_end") {
			const finalThinking = String(assistantEvent.content ?? this.liveStream.getThinking(agentId) ?? "");
			if (finalThinking) {
				this.liveStream.ensureThinkingSegment(agentId);
				this.liveStream.setThinking(agentId, finalThinking);
			}
			// 阶段性终态：只标 endedAt + flush live；不落盘（message_end/abort 才写 messages）。
			this.liveStream.markThinkingSegmentEnded(agentId);
			return;
		}

		if (eventType === "message_end" || eventType === "done" || eventType === "error") {
			// 结算性能指标（TTFT/总耗时/TPS）并边沿推送渲染层
			this.messagePerf.settle(
				agentId,
				(channel, payload) => this.emit(channel, payload),
				partialMessage,
				(message, detail) => void this.appLogger?.info("session-perf", message, detail),
			);
			// 先写入 History thinking 并 flush，再发 done 清 live。
			this.finalizeThinkingIntoMessage(agentId, partialMessage);
			this.upsertAssistantMessage(agentId, partialMessage);
			// message_end/done/error 是本轮回答的最终状态，立即 flush 确保完整消息及时可见。
			this.flushMessageEmit(agentId);
			this.liveStream.finishThinkingChannel(agentId);
			this.activeAssistantMessageIds.delete(agentId);
			this.streamingAgents.delete(agentId);
			// 独立流式正文通道终止：推一次最终累积文本后清缓冲（渲染层由历史消息接管）
			this.liveStream.finalizeText(agentId);
		}
	}

	private beginAssistantMessage(agentId: string) {
		if (!this.activeAssistantMessageIds.has(agentId)) {
			this.activeAssistantMessageIds.set(agentId, randomUUID());
		}
	}

	// 流式性能计时（markFirstDelta/markFirstText/ensureTimer/settle）收口在 MessagePerfTracker。

	/** 首 thinking_delta 的 History 挂载点（LiveStreamChannel.ensureThinkingSegment 的 host 回调）：
	 *  建立 assistant 身份、保证骨架 upsert + flush，并返回 assistantMessageId 供段 id 铸造。 */
	private mountThinkingSegment(agentId: string): string | undefined {
		this.beginAssistantMessage(agentId);
		const assistantMessageId = this.activeAssistantMessageIds.get(agentId);
		if (!assistantMessageId) {
			throw new Error(`ensureThinkingSegment: missing assistant message id for ${agentId}`);
		}
		// 保证 History 有同 id 骨架，buildTurnDisplay 才能用 liveThinkingId 挂思考步。
		this.upsertAssistantMessage(agentId, undefined, "", { allowEmpty: true });
		this.flushMessageEmit(agentId);
		return assistantMessageId;
	}

	/**
	 * 终态：把累积思考写入当前 assistant 骨架一次。
	 * 必须在 finishThinkingChannel（done）之前调用，并先 flush messages。
	 */
	private finalizeThinkingIntoMessage(agentId: string, partialMessage?: unknown) {
		const segment = this.liveStream.getSegment(agentId);
		const fromStream = this.liveStream.getThinking(agentId) ?? "";
		const fromMessage = partialMessage && typeof partialMessage === "object" ? this.messageProjector.extractThinking(asRecord(partialMessage)?.content) : "";
		const nextThinking = reasoningText(stripAnsi(fromStream || fromMessage || ""));
		if (!nextThinking.trim()) return;

		this.beginAssistantMessage(agentId);
		const messageIdBase = segment?.assistantMessageId ?? this.activeAssistantMessageIds.get(agentId);
		if (!messageIdBase) return;
		let messageId = messageIdBase;

		const list = this.messages.get(agentId) ?? [];
		let existingIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：运行期 id 已不在列表（被投影身份替换）。若列表里已有同一条
		// pi 消息（正文一致）则更新它并重定向身份，避免 append 造出双份。
		if (existingIndex < 0) {
			const textForMatch = partialMessage && typeof partialMessage === "object" ? this.messageProjector.extractText(asRecord(partialMessage)?.content) : "";
			const rebindIndex = this.findSamePiMessageIndex(list, "assistant", textForMatch);
			if (rebindIndex >= 0) {
				existingIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				this.liveStream.rebindSegmentTo(agentId, messageId);
				this.activeAssistantMessageIds.set(agentId, messageId);
			}
		}
		const startedAt = segment?.startedAt ?? Date.now();
		const endedAt = segment?.endedAt && segment.endedAt > 0 ? segment.endedAt : Date.now();
		if (existingIndex >= 0) {
			list[existingIndex].thinking = nextThinking;
			list[existingIndex].thinkingStartedAt = startedAt;
			list[existingIndex].thinkingEndedAt = endedAt;
			this.markMessagesDirtyFrom(agentId, existingIndex);
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text: "",
				timestamp: Date.now(),
				thinking: nextThinking,
				thinkingStartedAt: startedAt,
				thinkingEndedAt: endedAt,
			});
			this.markMessagesDirtyFrom(agentId, list.length - 1);
		}
		this.messages.set(agentId, list);
	}

	/** assistant 消息装配收口在 ToolMessageAssembler；薄包装保持调用点与事件顺序不变。 */
	private upsertAssistantMessage(agentId: string, partialMessage?: unknown, fallbackDelta = "", options?: { allowEmpty?: boolean }) {
		this.toolMessages.upsertAssistantMessage(agentId, partialMessage, fallbackDelta, options);
	}

	/**
	 * 在消息列表中查找「同一条 pi 消息」的既有副本（重载后事件迟到的身份重定向）。
	 *
	 * 运行期事件消息（id=randomUUID）与文件投影消息（id=agentId-history-entryId）
	 * 的 ChatMessage.id 永不相同，只能按内容匹配：
	 * - tool：meta.toolCallId 两通道同源（pi 的 toolCallId），精确匹配；
	 * - assistant/user：正文文本（stripAnsi 后）一致视为同一消息，从后往前匹配
	 *   （同文本多条时取最近一条——重载后迟到的终态事件对应最新落盘的副本）。
	 * 空文本不参与匹配（骨架无内容可证同一性，且骨架场景 id 映射仍有效）。
	 */
	private findSamePiMessageIndex(list: ChatMessage[], role: ChatMessage["role"], text: string, toolCallId?: string): number {
		const normalized = stripAnsi(text ?? "").trim();
		if (role === "tool" && toolCallId) {
			for (let index = list.length - 1; index >= 0; index -= 1) {
				const message = list[index];
				if (message.role === "tool" && (message.meta as Record<string, unknown> | undefined)?.toolCallId === toolCallId) {
					return index;
				}
			}
			return -1;
		}
		if (!normalized) return -1;
		for (let index = list.length - 1; index >= 0; index -= 1) {
			const message = list[index];
			if (message.role !== role) continue;
			if (stripAnsi(message.text ?? "").trim() !== normalized) continue;
			return index;
		}
		return -1;
	}

	/**
	 * 重载（loadMessages 替换列表）后，把「进行中的消息身份」从运行期副本重定向到投影版。
	 *
	 * 场景：重载快照捕捉到流式中间态——投影含未完成 assistant（无 stopReason、部分文本），
	 * 运行期含同一条的骨架（text 恒空，preserved 保护保留在列表尾部）。若只靠
	 * upsert 指纹匹配：骨架与投影 partial 文本不同（空 vs 部分）匹配不上，message_end
	 * 更新骨架后列表里仍残留投影 partial → 双份。
	 *
	 * 规则：activeAssistantMessageIds 登记的运行期骨架（空文本、无 stopReason）仍在
	 * nextMessages 中时，若投影里存在「未完成的 assistant」（无 stopReason、有部分文本
	 * ——同一时刻只有一条流式消息，从后往前取最后一条），把身份映射重定向到投影版并
	 * 移除骨架：后续事件继续更新投影版，位置正确、单份。tool 同理按 toolCallId。
	 */
	private rebindInFlightMessages(agentId: string, nextMessages: ChatMessage[], projectedMessages: ChatMessage[]): void {
		const runningAssistantId = this.activeAssistantMessageIds.get(agentId);
		const runningInNext = runningAssistantId ? nextMessages.find((message) => message.id === runningAssistantId) : undefined;
		// 运行期骨架被 preserved 保护保留在尾部（merge 未匹配到同指纹投影）：
		// 若投影里恰好有它的「未完成版」（无 stopReason、有部分文本——重载快照
		// 捕捉到的流式中间态），说明同一条消息将以两种身份并存（partial 投影版 +
		// 骨架，后续 message_end 会把骨架更新为完整版 → 双份）。把身份重定向到
		// 投影版并移除骨架：后续事件继续更新投影版，位置正确、单份。
		if (runningInNext && runningInNext.role === "assistant" && !runningInNext.stopReason && !runningInNext.text.trim()) {
			let projectedIncomplete: ChatMessage | undefined;
			for (let index = projectedMessages.length - 1; index >= 0; index -= 1) {
				const message = projectedMessages[index];
				if (message.role === "assistant" && !message.stopReason && Boolean(message.text.trim())) {
					projectedIncomplete = message;
					break;
				}
			}
			if (projectedIncomplete) {
				const skeletonIndex = nextMessages.findIndex((message) => message.id === runningAssistantId);
				if (skeletonIndex >= 0) nextMessages.splice(skeletonIndex, 1);
				this.activeAssistantMessageIds.set(agentId, projectedIncomplete.id);
				this.liveStream.rebindSegmentFrom(agentId, runningAssistantId, projectedIncomplete.id);
			}
		}
		const runningTool = this.toolMessageIds.get(agentId);
		if (runningTool) {
			for (const [toolCallId, runningToolId] of runningTool) {
				if (nextMessages.some((message) => message.id === runningToolId)) continue;
				const projectedIndex = nextMessages.findIndex((message) => message.role === "tool" && (message.meta as Record<string, unknown> | undefined)?.toolCallId === toolCallId);
				if (projectedIndex >= 0) {
					runningTool.set(toolCallId, nextMessages[projectedIndex].id);
				}
			}
		}
	}

	/** 工具消息装配收口在 ToolMessageAssembler（含工具完整文本 LRU）；薄包装保持调用点与事件顺序不变。 */
	private upsertToolMessage(agentId: string, event: Record<string, unknown>, status: "running" | "done" | "error") {
		this.toolMessages.upsertToolMessage(agentId, event, status);
	}

	private addMessage(agentId: string, role: ChatMessage["role"], text: string, meta?: Record<string, unknown>, images?: ImageContent[]) {
		const list = this.messages.get(agentId) ?? [];
		const requestId = typeof meta?.requestId === "string" ? meta.requestId.trim() : "";
		list.push({
			// 有上层 requestId 时复用，让乐观气泡 / 编辑删除 / 主进程缓存对上同一条
			id: requestId || randomUUID(),
			agentId,
			role,
			text,
			timestamp: Date.now(),
			meta,
			...(images && images.length > 0 ? { images } : {}),
		});
		this.messages.set(agentId, list);
		if (role === "user" || role === "assistant") this.refreshAutoTitle(agentId);
		this.scheduleMessageEmit(agentId, true);
	}

	private addLocalizedMessage(
		agentId: string,
		role: ChatMessage["role"],
		i18nKey: string,
		fallbackText: string,
		options: {
			params?: I18nParams;
			debugDetails?: string;
			meta?: Record<string, unknown>;
		} = {},
	) {
		this.addMessage(agentId, role, fallbackText, {
			...options.meta,
			i18nKey,
			...(options.params ? { i18nParams: options.params } : {}),
			...(options.debugDetails ? { debugDetails: options.debugDetails } : {}),
		});
	}

	private refreshAutoTitle(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return false;
		const project = this.getProject(runtime.tab.projectId);
		if (!project) return false;
		if (!isDefaultAgentTitle(runtime.tab.title, project, this.translate as (key: string, params?: Record<string, string | number>) => string)) return false;
		const nextTitle = inferTitleFromMessages(this.messages.get(agentId) ?? []);
		if (!nextTitle) return false;
		// 只覆盖默认/占位标题，避免打开/重命名过的历史会话被第一条消息反向改掉。
		// 来源标记为 fallback：它只是内容派生兜底，扩展模型标题（auto）到得更晚也能升级（#266）。
		return this.applyRuntimeTitle(agentId, nextTitle, true, "fallback");
	}

	private addDetailedErrorMessage(agentId: string, errorMessage?: string) {
		const retryMessageId = this.retryStatusMessageIds.get(agentId);
		const retryMessage = retryMessageId ? this.messages.get(agentId)?.find((message) => message.id === retryMessageId) : undefined;
		const attempt = Number(retryMessage?.meta?.attempt ?? 0);
		const maxAttempts = Number(retryMessage?.meta?.maxAttempts ?? 0);
		const hasRetries = maxAttempts > 0;
		const fallback = errorMessage ? `请求失败。${hasRetries ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : ""}` : `请求失败。${hasRetries ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : ""}\n\n请稍后重试。`;
		const i18nKey = errorMessage ? (hasRetries ? "diagnostic.requestFailedAfterRetries" : "diagnostic.requestFailed") : hasRetries ? "diagnostic.requestFailedUnknownAfterRetries" : "diagnostic.requestFailedUnknown";
		this.addLocalizedMessage(agentId, "error", i18nKey, fallback, {
			params: {
				attempt,
				maxAttempts,
			},
			debugDetails: errorMessage,
		});
	}

	/**
	 * 当前「进行中」的重试状态卡 id（仅 status=running 算数）。
	 * 一次重试周期一张卡：已收敛成 success/error 的卡片不允许再被下一轮重试改写，
	 * 否则时间线上永远只剩最后一条「正在自动重试」，用户看不出到底重试过几次（用户反馈）。
	 * 同一周期内的后续事件（延迟变化等）仍会复用这张运行中卡片。
	 */
	private activeRetryStatusMessageId(agentId: string): string | undefined {
		const messageId = this.retryStatusMessageIds.get(agentId);
		if (!messageId) return undefined;
		const message = this.messages.get(agentId)?.find((item) => item.id === messageId);
		return message?.meta?.status === "running" ? messageId : undefined;
	}

	private upsertRetryStatusMessage(agentId: string, event: Record<string, unknown>, status: "running" | "success" | "error") {
		const list = this.messages.get(agentId) ?? [];
		// 只复用仍在推进的卡片；已收敛（成功/失败）的卡片保持原样，本轮新建一张。
		let messageId = this.activeRetryStatusMessageId(agentId);
		let message = messageId ? list.find((item) => item.id === messageId) : undefined;
		if (!message) {
			messageId = randomUUID();
			message = {
				id: messageId,
				agentId,
				role: "system",
				text: "",
				timestamp: Date.now(),
			};
			list.push(message);
			this.retryStatusMessageIds.set(agentId, messageId);
		}

		const attempt = Number(event.attempt ?? message.meta?.attempt ?? 0);
		const maxAttempts = Number(event.maxAttempts ?? message.meta?.maxAttempts ?? 0);
		const delayMs = Number(event.delayMs ?? 0);
		const reasonValue = event.errorMessage ?? event.finalError ?? message.meta?.errorMessage;
		const reason = reasonValue == null ? "" : String(reasonValue);
		const delaySeconds = Math.ceil(delayMs / 1000);
		const delayText = delayMs > 0 ? `，${delaySeconds} 秒后重试` : "";
		const countText = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : String(attempt || 1);
		const params = {
			attempt,
			count: countText,
			delaySeconds,
		};
		let i18nKey: string;

		if (status === "running") {
			i18nKey = delayMs > 0 ? "diagnostic.retryScheduledAfterDelay" : "diagnostic.retryScheduled";
			message.text = `正在自动重试 ${countText}${delayText}`;
		} else if (status === "success") {
			i18nKey = "diagnostic.retrySucceeded";
			message.text = `自动重试成功，共重试 ${attempt} 次`;
		} else {
			i18nKey = "diagnostic.retryFailed";
			message.text = `自动重试失败，已重试 ${countText} 次`;
		}
		message.timestamp = Date.now();
		message.meta = {
			status,
			attempt,
			maxAttempts,
			delayMs,
			errorMessage: reason,
			i18nKey,
			i18nParams: params,
			...(reason && status !== "success" ? { debugDetails: reason } : {}),
		};

		this.messages.set(agentId, list);
		this.scheduleMessageEmit(agentId, true);
	}

	/**
	 * 从 get_entries 响应构建 active branch 的 entryId 有序列表。
	 * 从 leafId 沿 parentId 回溯至 root 得到有序列表。
	 * 这个列表的顺序与 get_messages 返回的消息顺序一致，
	 * 用于在 convertAgentMessages 中按位置匹配 entryId 到 message。
	 * 只保留 type=message 的 entryId（即 user/assistant/toolResult 角色消息），
	 * 剔除 session、model_change、thinking_level_change、custom 等非消息条目，
	 * 使返回的 id 列表与 get_messages 返回的 rawMessages 一一对齐。
	 */
	private buildActiveBranchEntryIds(entries: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>, leafId: string): string[] {
		return buildActiveBranchEntryIdsForDisplay(entries, leafId);
	}

	private convertAgentMessages(agentId: string, rawMessages: unknown[], activeEntryIds?: string[]): ChatMessage[] {
		return this.messageProjector.convert(agentId, rawMessages, activeEntryIds);
	}

	/**
	 * 远端历史消息投影（远端分页读到的原始 pi 消息 → 渲染层消息）。
	 *
	 * 必须走与本地历史**同一条**投影管线：远端会话若自建一份投影，工具卡/thinking/生图元数据/停止态
	 * 的形状迟早与本地漂移，渲染层就成了「两条渲染链」。agentId 用 `_viewer`，与本地磁盘历史页一致
	 * （历史页没有运行时身份）。
	 */
	projectRemoteHistoryMessages(rawMessages: unknown[], activeEntryIds?: string[]): ChatMessage[] {
		return this.convertAgentMessages("_viewer", rawMessages, activeEntryIds);
	}

	/**
	 * The bundled ask_question extension wraps batch questions in one input request
	 * because Pi RPC dialogs are otherwise strictly sequential. Validate the shape
	 * before forwarding it so malformed extension data falls back to normal input.
	 */
	private scheduleIdleCheckAfterExtensionCommand(agentId: string) {
		const timer = setTimeout(() => {
			void this.markIdleIfPiReportsNoWork(agentId);
		}, 100);
		timer.unref?.();
	}

	private async markIdleIfPiReportsNoWork(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime || runtime.tab.status !== "running") return;
		if (this.uiGate.hasPendingUIRequests(agentId)) return;
		if (this.rpcCompactingAgents.has(agentId) || this.compactingAgents.has(agentId)) return;
		if (this.activeAssistantMessageIds.has(agentId)) return;
		// 这里刻意不再用本地 toolExecutingByAgent 做否决：pi 的 isStreaming 就是
		// `_isAgentRunActive`（见 pi dist/core/agent-session.js 的 getter 注释
		// "processing an agent run or post-run continuation"），工具执行期间为 true，
		// 因此下面的 get_state 已经覆盖「工具还在跑」这一情形。本地标志一旦因为丢事件而
		// 卡在 true（例如 tool_execution_end 缺 toolCallId 时按空串删不掉），
		// 用它否决就会让本函数永远提前返回——兜底判空闲失效、会话永久 running，
		// 正是本函数要修的那个 bug。分歧只记录不改判，便于事后定位丢事件。
		const staleToolFlag = this.toolExecutingByAgent.get(agentId);

		const response = await runtime.process.client.request({ type: "get_state" }, 10_000).catch(() => undefined);
		if (!response?.success || !response.data) return;

		const state = response.data as {
			isStreaming?: boolean;
			isCompacting?: boolean;
			pendingMessageCount?: number;
		};
		if (state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0) return;

		// pi 权威判定无工作，但本地仍认为有工具在跑 → 本地标志已过期（工具 end 事件丢了）。
		// 这正是「会话卡在 running / 底栏一直显示工具名」的信号，记 warn 并清掉过期状态。
		if (staleToolFlag) {
			void this.appLogger?.warn("agent", "Recovered idle while local tool flag was still set", {
				agentId,
				staleToolName: staleToolFlag,
				activeToolCalls: Array.from(this.activeToolCallsByAgent.get(agentId)?.entries() ?? []),
			});
			// 清掉过期工具状态，否则底栏会一直显示一个早已结束的工具名
			this.applyActiveToolCallState(agentId, { calls: new Map<string, string>(), isExecutingTool: false, completedBatch: false });
		}

		this.setAgentTurnActive(agentId, false);
		runtime.tab.status = "idle";
		this.finalizeThinkingIntoMessage(agentId);
		this.flushMessageEmit(agentId);
		// 兜底确认空闲同样视为一轮结束：重算尾部 9 轮窗口并裁剪运行期缓存。
		this.trimRuntimeCache(agentId);
		this.liveStream.finishThinkingChannel(agentId);
		this.liveStream.clearTextChannel(agentId);
		this.emitState();
		void this.emitRuntimeState(agentId);
		// 兜底确认无工作也算成功空闲：与 agent_settled 一样通知完成（PetStateBridge 侧有去重冷却）。
		this.notifyAgentSettled(agentId, runtime.tab.title);
	}

	private requireRuntime(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error(`Agent not found: ${agentId}`);
		return runtime;
	}

	/**
	 * 会话收到 Ask 类 UI 请求时的桌面通知（SessionRuntimeCoordinator 调用，
	 * 不再区分该会话是否聚焦：只要 Agent 在提问就提醒）。
	 * 独立于 notifySessionEnd：由 askNotificationEnabled 单独门控（默认关闭），
	 * 即使用户关闭通用会话结束通知，仍可单独开启提问提醒，反之亦然。
	 * 每轮 run 只通知一次（去重标记在 agent_start 时清除），避免同一轮多次提问刷屏。
	 */
	notifyAskPending(agentId: string, sessionId: string, sessionTitle: string, question: string): void {
		try {
			const settings = this.settingsStore.get();
			if (!settings.askNotificationEnabled) return;
			// 仅失焦提醒：窗口在前台时用户就在看，不再弹系统通知（设置默认关闭时不生效）
			if (!shouldAlertNow(settings.alertOnlyWhenUnfocused, isMainWindowFocused(this.getWindow()))) return;
			if (!Notification.isSupported()) return;
			if (this.notifiedAskAgents.has(agentId)) return;
			this.notifiedAskAgents.add(agentId);

			const appName = APP_DISPLAY_NAME;
			const title = sessionTitle || appName;
			// 有具体提问内容时展示问题，否则退回通用文案（批量提问等无 title 场景）
			const questionText = question.length > 60 ? `${question.slice(0, 60)}…` : question;
			const body = questionText ? this.translate("mainNotification.askQuestion", { title, question: questionText }) : this.translate("mainNotification.askPending", { title });
			showAgentToast(this.notificationDeps, { agentId, kind: "ask", body, sessionId });
		} catch {
			// 通知失败不影响主流程，静默处理
		}
	}

	/**
	 * 会话结束时发送系统通知。
	 * 仅在设置中启用通知且 Electron Notification 可用时触发，
	 * 通知用户 agent 已完成响应，可以查看结果或继续对话；
	 * 点击通知会聚焦主窗口并切换到对应会话。
	 */
	private notifySessionEnd(agentId: string, sessionTitle: string) {
		try {
			const settings = this.settingsStore.get();
			if (!settings.enableNotifications) return;
			// 仅失焦提醒：窗口在前台时不弹系统通知（设置默认关闭时不生效）
			if (!shouldAlertNow(settings.alertOnlyWhenUnfocused, isMainWindowFocused(this.getWindow()))) return;
			if (!Notification.isSupported()) return;

			const body = this.translate("mainNotification.sessionDone", { title: sessionTitle });
			// 会话结束时 runtime 一定已绑定会话；跳转目标用 record.id（renderer 按它索引会话），
			// tab.sessionId 是 pi 侧会话 id 只能兜底（见 resolveNotificationSessionId 注释）。
			const resolveSessionId = this.resolveSessionId;
			const sessionId = resolveNotificationSessionId(resolveSessionId ? () => resolveSessionId(agentId) : undefined, this.agents.get(agentId)?.tab.sessionId);
			showAgentToast(this.notificationDeps, { agentId, kind: "done", body, sessionId });
		} catch {
			// 通知失败不影响主流程，静默处理
		}
	}

	/**
	 * 聚焦主窗口并让渲染进程切换到指定会话。
	 * 复用 pet:focus-agent-target 通道（renderer 的 workspace chrome 监听后切到对应 project + session tab）；
	 * sessionId 缺省（运行时尚未绑定会话）时只聚焦窗口，不做跳转。
	 */
	private focusMainWindowForSession(sessionId?: string) {
		try {
			const win = this.getWindow();
			if (!win || win.isDestroyed()) {
				void this.appLogger?.warn("agent", "Notification focus skipped: no main window", { sessionId });
				return;
			}
			if (win.isMinimized()) win.restore();
			if (!win.isVisible()) win.show();
			win.focus();
			if (sessionId) {
				win.webContents.send(ipcChannels.petFocusAgentTarget, { sessionId });
			}
		} catch (error) {
			// 聚焦失败不影响主流程，静默处理
			void this.appLogger?.warn("agent", "Notification focus failed", { sessionId, error });
		}
	}

	/**
	 * 通知字标（透明底品牌字标）的 file:// URI；资源缺失时为 null（通知退回系统默认图标）。
	 * Windows toast XML 见 notifications/notificationToast.ts（branding 与 launch 收口在那里）。
	 */
	private notificationLogoUri(): string | null {
		return resolveNotificationLogoUri({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
	}

	/** 统一通知出口的依赖（构造/点击/失败日志在 notifications/agentToast.ts）。 */
	private get notificationDeps(): AgentToastDeps {
		return {
			settings: () => this.settingsStore.get(),
			getWindow: () => this.getWindow(),
			logoUri: () => this.notificationLogoUri(),
			translate: (key, params) => this.translate(key, params),
			activate: (sessionId) => this.focusMainWindowForSession(sessionId),
			logger: this.appLogger,
		};
	}

	// abort 流闸与升级收口在 AbortStreamGateController；以下薄包装保持事件路径调用点与契约测试形态。

	/** abort 时封印当前 generation。 */
	private sealAgentStream(agentId: string) {
		this.abortGate.seal(agentId);
	}

	/** agent_start 时尝试推进 generation；若仍在等 abort settled，则只记 pending。 */
	private openAgentStream(agentId: string) {
		this.abortGate.openForNewRun(agentId);
	}

	/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
	private noteAgentAbortSettled(agentId: string) {
		this.abortGate.noteAbortSettled(agentId);
	}

	/** abort settled 兜底（pi 漏发 settled 时超时解封并触发升级检查）。 */
	private scheduleAbortSettledFallback(agentId: string) {
		this.abortGate.scheduleSettledFallback(agentId);
	}

	/** 当前 generation 是否已封印，封印期间所有流式事件应丢弃。 */
	private isAgentStreamSealed(agentId: string): boolean {
		return this.abortGate.isSealed(agentId);
	}

	/**
	 * prompt 被 pi 接受后的统一收尾（正常发送与忙碌拒收重发共用，Issue #371）。
	 *
	 * 扩展命令 / input handler 消费掉 prompt（没有启动 agent run）时必须另找恢复 idle 的
	 * 时机：永远不会等到 agent_end。pi 0.99+ 直接读 disposition；老版本无此字段，退回发一次
	 * get_commands 预检（历史上 prompt 之前发的就是它，此处只是搬到 prompt 之后、按需执行）。
	 */
	private async settleAcceptedPrompt(agentId: string, runtime: AgentRuntime, agentMessage: string, responseData: unknown, alreadyBusy: boolean): Promise<void> {
		const disposition = readPromptDisposition(responseData);
		const consumedWithoutRun = disposition === "handled" ? true : disposition === undefined ? await this.promptMatchesRegisteredExtensionCommand(runtime, agentMessage) : false;
		if (!consumedWithoutRun) return;
		if (!alreadyBusy) this.messagePerf.discardInFlight(agentId);
		// 机制：Pi 扩展命令可在 prompt 阶段直接执行并返回，不进入 agent run。
		// 证据：@earendil-works/pi-coding-agent/dist/core/agent-session.js 中 AgentSession.prompt()
		//      先调用 _tryExecuteExtensionCommand()；命中后 return，不再调用 _runAgentPrompt()。
		// 推导：不能等 agent_end；只有 Pi get_state 明确报告无剩余工作时才恢复 idle。
		this.scheduleIdleCheckAfterExtensionCommand(agentId);
	}

	/**
	 * pi 侧「可能仍在流式」的本地证据（Issue #371）。
	 *
	 * 本地 tab.status 是乐观状态：abort RPC 超时/升级未收敛时它已被复位 idle，而 pi 的
	 * isStreaming 仍为 true。此时发 prompt 不带 streamingBehavior 会被 pi 直接拒收
	 * （"Agent is already processing..."）。这里汇总同步可取的权威信号：
	 * - streamingAgents：本地收到的流式事件仍在进行；
	 * - recentlyAborted：abort 已发出但还未等来 agent_settled；
	 * - abortGate.isEscalationPending：升级链已确认 pi 仍未停稳。
	 * 宁可多带一次 streamingBehavior（pi 侧空闲时 steer 与直发等价），也不要被拒收。
	 */
	private piMightStillBeStreaming(agentId: string): boolean {
		return this.streamingAgents.has(agentId) || this.recentlyAborted.has(agentId) || this.abortGate.isEscalationPending(agentId);
	}

	/**
	 * abort 升级拿到 pi 权威回复「仍在流式」时调用（Issue #371）。
	 * abort RPC 超时后 tab 已被乐观复位 idle，pi 却还在跑——把状态纠正回 running，
	 * 让用户看得见忙碌（也能重新点停止），后续发送会自动带上 streamingBehavior。
	 * 真正停下来时 agent_settled / markIdleIfPiReportsNoWork 会把它复位 idle。
	 */
	private noteStillStreamingAfterAbort(agentId: string): void {
		const runtime = this.agents.get(agentId);
		if (!runtime || runtime.tab.status === "closed" || runtime.tab.status === "error") return;
		if (runtime.tab.status === "running") return;
		runtime.tab.status = "running";
		this.emitState();
	}

	/** agent 关闭/重建时清理 gate，避免泄漏到新生命周期。 */
	private clearStreamGate(agentId: string) {
		// 流闸/兜底定时器/升级上下文统一清；thinkingEmitter 与消息 flush 属跨域编排，仍在此清
		this.abortGate.clearAgent(agentId);
		this.recentlyAborted.delete(agentId);
		this.liveStream.cancelThinkingPush(agentId);
		this.cancelMessageEmit(agentId);
	}

	/** 轻量 runtime 状态补丁：只同步本地流式标志与工具执行状态，不发 RPC。 */
	private emitStreamingStatePatch(agentId: string) {
		this.runtimeState.emitStreamingStatePatch(agentId);
	}

	/**
	 * 可见性补帧：会话从后台变为可见时，把当前还在流式输出的正文/思考整段补发一次。
	 * 后台期间主进程不发 live 增量（见 sessions/visibleSessionRegistry.ts），渲染层手里
	 * 没有内容；直接等下一次增量会先显示半截，因此这里强制全量。
	 * 后台期间已经结束的输出不需要补：历史消息（agents:message）照常全量下发。
	 */
	emitLiveSnapshot(agentId: string): void {
		const runtime = this.agents.get(agentId);
		if (!runtime || runtime.tab.status === "closed" || runtime.tab.status === "error") return;
		this.liveStream.emitTextSnapshot(agentId);
		this.liveStream.emitThinkingSnapshot(agentId);
	}

	/**
	 * 上下文超限是失败回合里唯一仍需保留的恢复信号：完整 runtime-state 可能因
	 * error 终态被清理，先发轻量 patch 让 renderer 在清理前记住它，圆环才能继续提供压缩入口。
	 */
	private emitContextOverflowState(agentId: string, contextOverflow: boolean) {
		this.emit(agentEventTags.agentsRuntimeState, {
			agentId,
			state: { contextOverflow },
		});
	}

	private setAgentTurnActive(agentId: string, isTurnActive: boolean) {
		this.runtimeState.setAgentTurnActive(agentId, isTurnActive);
	}

	// agents:message 的节流批处理/增量标记收口在 MessageEmitBatcher；以下薄包装保持调用点与契约测试形态。

	/** 取消节流中的消息推送（不触发 emit），用于 abort/关闭时丢弃 pending 的旧内容。 */
	private cancelMessageEmit(agentId: string) {
		this.messageEmit.cancel(agentId);
	}

	/**
	 * 安排一次消息 emit。流式高频事件走节流合并（同一 agent 50ms 内多次调用只 emit 一次最新数组）；
	 * immediate=true 时跳过节流立即 flush，用于 message_end/tool_execution_end 等终态事件，确保最终状态不丢。
	 */
	private scheduleMessageEmit(agentId: string, immediate = false) {
		this.messageEmit.schedule(agentId, immediate);
	}

	private flushMessageEmit(agentId: string) {
		this.messageEmit.flush(agentId);
	}

	/** 标记 agent 消息数组自 index 起变脏（多次标记取最小值），供增量 flush 使用。 */
	private markMessagesDirtyFrom(agentId: string, index: number) {
		this.messageEmit.markDirtyFrom(agentId, index);
	}

	/**
	 * 运行期缓存裁剪：agent 一轮结束后把主进程消息数组裁到最近 N 轮。
	 * 现状 40 轮 trim 只在 loadMessages 时执行，长会话运行中消息会持续追加、数组无界增长；
	 * 这里在 agent_settled（及 get_state 兜底确认空闲）后统一裁剪，使 12 轮成为硬上限。
	 * 裁剪后重算激活显示窗口（尾部 3 轮）并全量 flush——头部整轮被裁，增量下标空间失效，
	 * 渲染层以窗口化全量校准（与 loadMessages 后的窗口协议一致）。
	 * 头部系统摘要卡片（compaction/branchSummary）不属于 user 轮次，会被 trim 切掉，
	 * 裁剪前先取出、裁剪后重新 prepend，保证「已压缩 N 次」卡片持续可见。
	 */
	private trimRuntimeCache(agentId: string) {
		const list = this.messages.get(agentId);
		if (!list || list.length === 0) return;
		const summaryCards = leadingSummaryCards(list, list.length);
		const trimmedStart = boundTurnWindowStart(
			list.map((m) => ({ role: m.role, byteLength: 0 })),
			list.length,
			AgentManager.MAX_RUNTIME_CACHE_TURNS,
			AgentManager.MAX_RUNTIME_CACHE_ENTRIES,
		);
		const trimmed = list.slice(trimmedStart);
		const didTrim = trimmed.length !== list.length;
		const currentWindowStart = this.messageEmit.windowStart(agentId);
		const nextWindowStartInList = this.computeDisplayWindowStart(list);
		// 不超过 12 轮时也要校准尾部 9 轮窗口。通常 settled 前的 flush 已经做过这步，
		// 这里保留独立调用时的兜底，避免新会话在 12 轮以内把全部消息留在 atom。
		if (!didTrim) {
			if (nextWindowStartInList > currentWindowStart) {
				this.messageEmit.enqueueSlideOut(agentId, list.slice(currentWindowStart, nextWindowStartInList));
				this.messageEmit.setWindowStart(agentId, nextWindowStartInList);
				this.markMessagesDirtyFrom(agentId, 0);
				this.flushMessageEmit(agentId);
			}
			return;
		}
		// 卡片恒在数组最前（index 0），trim 保留尾部时必然被整体丢弃，重新 prepend 不会重复。
		const next = summaryCards.length > 0 ? [...summaryCards, ...trimmed] : trimmed;
		// 缓存头部在文件消息空间前移 = 被裁「角色消息」数（卡片/系统消息不计入文件消息空间，
		// 若按总长度递增会把 windowStartFilePos 数值游标整体推偏）。
		// headOffset=-1 表示匿名会话等无文件场景，数值游标不可用——保持 -1，不能递增成伪造游标。
		const prevHeadOffset = this.messageHeadOffsetByAgent.get(agentId) ?? 0;
		if (prevHeadOffset >= 0) {
			this.messageHeadOffsetByAgent.set(agentId, prevHeadOffset + countRoleMessagesBefore(list, trimmedStart));
		}
		this.messages.set(agentId, next);
		// 裁剪后数组下标空间前移，尾部 9 轮的身份不变但数值起点改变；
		// 先重置坐标，再用全量 flush 校准 renderer。
		this.messageEmit.setWindowStart(agentId, this.computeDisplayWindowStart(next));
		this.markMessagesDirtyFrom(agentId, 0);
		this.flushMessageEmit(agentId);
	}

	/**
	 * 从 message_update 的 partialMessage 提取累积正文；无法提取时返回 undefined，
	 * 调用方回退到「旧累积 + delta」拼接（兼容仅带 delta 的事件格式）。
	 */
	private extractStreamingText(agentId: string, partialMessage?: unknown): string | undefined {
		if (partialMessage && typeof partialMessage === "object") {
			const text = this.messageProjector.extractText(asRecord(partialMessage)?.content);
			if (text) return text;
		}
		return undefined;
	}

	/**
	 * emitState 节流（2027-02 性能审计，leading+trailing 250ms）：调用点 50+ 个，
	 * 含每个工具 start/end（每工具 2 次）——无节流时并行工具批每秒数十次全量
	 * AgentTab[] 构建排序 + 渲染层 N 个 per-tab 信封 structured-clone 下发。
	 * leading 保证状态翻转即时可见；突发合并为一次 trailing（≤250ms 迟到，
	 * 对状态圆点/侧栏无感）。dispose 终态走 flushStateEmit 立即推。
	 */
	private static readonly STATE_EMIT_THROTTLE_MS = 250;
	private stateEmitTimer: NodeJS.Timeout | null = null;
	private stateEmitLastAt = 0;

	private emitState() {
		const now = Date.now();
		const elapsed = now - this.stateEmitLastAt;
		if (elapsed >= AgentManager.STATE_EMIT_THROTTLE_MS) {
			this.stateEmitLastAt = now;
			this.emitStateNow();
			return;
		}
		if (this.stateEmitTimer !== null) return;
		this.stateEmitTimer = setTimeout(() => {
			this.stateEmitTimer = null;
			this.stateEmitLastAt = Date.now();
			this.emitStateNow();
		}, AgentManager.STATE_EMIT_THROTTLE_MS - elapsed);
		this.stateEmitTimer.unref?.();
	}

	/** 取消在途 trailing 并立即推一次终态（dispose 用：退出路径不等节流窗口）。 */
	private flushStateEmit() {
		if (this.stateEmitTimer !== null) {
			clearTimeout(this.stateEmitTimer);
			this.stateEmitTimer = null;
		}
		this.stateEmitLastAt = Date.now();
		this.emitStateNow();
	}

	private emitStateNow() {
		const tabs = this.list();
		this.emit(agentEventTags.agentsState, tabs);
		// 同步通知主进程内部状态订阅者（PetStateBridge），使宠物窗能拿到聚合状态。
		// 设计文档原拟用 ipcMain.on("agents:state") 桥接是错的：webContents.send 是
		// 主进程→渲染层单向通道，ipcMain 收不到主进程自己发出的消息，故改用本钩子。
		this.notifyStateListeners(tabs);
	}

	/** AGENTS 硬约束：所有 runtime 事件必须携带 sessionId + agentId + runtimeGeneration，
	 *  迟到 runtime 的结果由消费端按三元组丢弃。取自 AgentTab 当前绑定。 */
	private streamRuntimeTriple(agentId: string): {
		sessionId?: string;
		runtimeGeneration?: number;
	} {
		const runtime = this.agents.get(agentId);
		return {
			sessionId: runtime?.tab.deckSessionId,
			runtimeGeneration: runtime?.tab.runtimeGeneration,
		};
	}

	private emit(channel: string, payload: unknown) {
		// 白名单外只通知主进程内部订阅（index.ts 桥、FeishuBridge、WebEventStream 等）
		for (const listener of this.outputListeners) listener(channel, payload);
		if (!DIRECT_EMIT_CHANNELS.has(channel)) return;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		window.webContents.send(channel, payload);
	}
}

/** 直发渲染层（webContents.send）的通道白名单：preload 只订阅 agentsRpcLog
 *  （src/preload/index.ts），其余 agents:* 通道渲染层经 sessions:runtime-envelope
 *  （index.ts 桥）消费，直发只是无人接收的死流量（每 token 级事件 × 跨进程序列化）。
 *  preload 新增订阅时必须同步此白名单（tests/agentManagerDirectEmitChannels.test.mjs 锁死一致性）。 */
export const DIRECT_EMIT_CHANNELS: ReadonlySet<string> = new Set([ipcChannels.agentsRpcLog]);

/** unknown → Record 收窄谓词（与 AnnouncementService.ts 同型）：
 *  RPC 事件负载形状不可信，统一经此谓词后再逐字段判型。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** agent_end 携带消息的最小结构（pi 版本间字段不稳定，仅声明实际消费的字段）。 */
interface AgentEndMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type?: string; text?: unknown; message?: unknown }>;
}

type AgentRuntime = {
	tab: AgentTab;
	process: PiProcess;
};
