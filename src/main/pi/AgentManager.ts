import { app, type BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
	I18nParams,
	ImageContent,
	Project,
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	SendPromptInput,
	SendPromptResult,
	SessionEnvironment,
	SessionMessagePage,
	ThinkingUpdate,
	SessionFileChange,
	SessionTodoSnapshot,
} from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { collectSessionFileChanges } from "../../shared/fileChanges";
import { PiProcess } from "./PiProcess";
import { createCompactRpcRequest } from "./compactRpc";
import { mergeSubagentSources } from "./derivedSubagents";
import { parseAvailableThinkingLevelsResponse } from "./thinkingLevels";
import { listActiveBuiltInExtensionPaths } from "../extensions/builtInExtensions";
import { createPiProcessExtensionResolvers } from "../extensions/piProcessExtensionResolvers";
import {
	formatExtensionFallbackDebug,
	shouldRetryWithoutExtensions,
} from "./extensionStartupFallback";
import { formatExtensionErrorReason } from "./extensionError";
import type { RpcResponse } from "./PiRpcClient";
import { formatBashToolMessage } from "./bashResult";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { mergeHistoryWithPreservedMessages, stabilizeReloadedMessageIds } from "./historyMessages";
import {
	buildAgentSessionKey,
	toAbsoluteSessionPath,
	type AgentSessionIdentityDefaults,
} from "./agentSessionIdentity";
import {
	SessionFileEditor,
	type SessionEntryTarget,
	type SessionFileRef,
} from "./SessionFileEditor";
import { SessionHistoryReader, findTurnPageStart } from "./SessionHistoryReader";
import {
	currentIndexTree,
	createCheckpoint,
	diffCheckpoints,
	loadAllCheckpoints,
	loadCheckpointFromRef,
	MUTATING_TOOLS,
	restoreCheckpoint as applyCheckpointRestore,
	toCheckpointSummary,
} from "../rewind/index.ts";
import {
	AgentMessageProjector,
	buildActiveBranchEntryIds as buildActiveBranchEntryIdsForDisplay,
} from "./AgentMessageProjector";
import { LatestByKeyEmitter } from "./LatestByKeyEmitter";
import { resolveNotificationSessionId } from "./agentUtils";
import {
	createStreamGateState,
	isStreamGateSealed,
	noteAbortSettled,
	openStreamGateForNewRun,
	sealStreamGate,
	type StreamGateState,
} from "./streamGate";
import { createCacheHitStatsReader, type CacheHitStats, type CacheHitStatsReader } from "./cacheHitStats";
import {
	stripAnsi,
	pickNumber,
	clampPercent,
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
} from "./agentUtils";
import {
  updateActiveToolCalls,
  type ActiveToolCallState,
} from "../../shared/toolRuntimeState";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SecurityStore } from "../security/SecurityStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RpcLogger } from "../logging/RpcLogger";
import type { RpcLogBatch, RpcLogEntry } from "../../shared/types/rpcLog";
import type { AppLogger } from "../logging/AppLogger";
import {
	toWindowsHostPath,
	toWslLinuxPath,
	type WslEnvironment,
} from "../wsl/WslPaths";

/** 项目信任确认弹窗的用户选择 */
export type ProjectTrustChoice = "trust-remember" | "trust-session" | "deny";

/** 从 RPC 返回的未知 ask 记录中安全读取字段，避免批量答案转换扩散 any 强转。 */
function readAskField(input: unknown, key: string): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	return Reflect.get(input, key);
}

/**
 * 暂存中的启动期诊断（扩展回退说明 / 首个 run 前的 extension_error）。
 * 首个 agent_start 到达前不写时间线，避免插进历史轮次与当前消息之间。
 * 见 AgentManager.pendingStartupDiagnostics / flushStartupDiagnostics。
 */
export type QueuedStartupDiagnostic = {
	role: "system" | "error";
	i18nKey: string;
	fallbackText: string;
	options?: {
		params?: I18nParams;
		debugDetails?: string;
		meta?: Record<string, unknown>;
	};
};

export class AgentManager {
	/** 本网关的运行时后端身份：pi。 */
	readonly backend: AgentBackend = "pi";
	/** pi 后端支持全部可选能力。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set([
		"compact",
		"fork",
		"getForkMessages",
		"editMessage",
		"deleteMessage",
		"getCommands",
		"exportHtml",
	]);
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly messages = new Map<string, ChatMessage[]>();
	/** 工具完整结果 LRU 缓存：截断下发后完整文本仅存于此（运行期「查看完整输出」走内存，
	 *  历史会话回退读会话文件）。键为 pi message id，agent 停止时随 clearAgentState 释放。 */
	private readonly toolFullTextByMessageId = new Map<string, string>();

	/** 当前流式思考的累积文本，用于实时推送给前端展示 */
	private readonly streamingThinking = new Map<string, string>();
	/**
	 * 当前思考段身份：id = msg-thinking-${assistantMessageId}，与 History 一致。
	 * 首 thinking_delta 铸造；message_end/abort 写入 messages 后清掉。
	 */
	private readonly thinkingSegmentByAgent = new Map<
		string,
		{ id: string; assistantMessageId: string; startedAt: number; endedAt: number }
	>();
	/** 当前正在流式更新文本的 agent（message_start/text_delta/thinking_delta 置位，
	 *  message_end/done/error/agent_end/agent_settled/abort 清除）。
	 *  isStreaming 不再只依赖 pi get_state 轮询：轮询在 text_delta 期间不触发，
	 *  前端 streamingMessageId → MarkdownStream 逐字渐显依赖它，缺失会“整段蹦出”。 */
	private readonly streamingAgents = new Set<string>();

	/** 当前是否有任何 agent 正在流式输出（内存采样探针用，避免直接暴露内部 Set）。 */
	hasActiveStreaming(): boolean {
		return this.streamingAgents.size > 0;
	}
	/** 当前正在流式更新的 assistant 消息；tool 事件插入时仍要继续更新同一个回答块。 */
	private readonly activeAssistantMessageIds = new Map<string, string>();
	/** pi 的 toolCallId 贯穿 start/update/end，用它把同一次工具调用合并成一条 UI 记录。 */
	private readonly toolMessageIds = new Map<string, Map<string, string>>();
	/** 每个 agent 只保留一条自动重试状态消息，避免短暂 5xx/网络错误把会话刷屏。 */
	private readonly retryStatusMessageIds = new Map<string, string>();
	/** 同一历史会话正在创建 Agent 时共享同一个 Promise，避免快速重复点击/IPC 竞态创建多个进程。 */
	private readonly creatingSessionAgents = new Map<string, Promise<AgentTab>>();
	/** 工具 start/end 事件的单调序号，renderer 用它忽略迟到的异步完整状态。 */
	private readonly toolStateSequenceByAgent = new Map<string, number>();
	/** 每个 agent 当前仍在执行的 toolCall；并行工具必须等最后一个结束才发 false 边沿。 */
	private readonly activeToolCallsByAgent = new Map<string, Map<string, string>>();
	/** 记录每个 agent 当前执行的工具名称，无工具时为 null */
	private readonly toolExecutingByAgent = new Map<string, string | null>();
	private readonly sessionFileEditor: SessionFileEditor;
	private readonly sessionHistoryReader: SessionHistoryReader;
	private readonly messageProjector: AgentMessageProjector;
	/** 流式消息 emit 节流状态。 */
	private readonly messageFlushTimers = new Map<string, NodeJS.Timeout>();
	private readonly pendingMessageAgents = new Set<string>();
	/** 增量消息 flush 的脏下标：自上次 flush 以来最早的变化位置（取多次标记的最小值）。
	 *  只在流式 upsert/append 高频路径显式标记；编辑/删除/截断/重载不标记 → flush 回退全量。 */
	private readonly messageDirtyFromByAgent = new Map<string, number>();
	/**
	 * 激活显示窗口起点（2026-08 激活分页）：loadMessages 后以「尾部 N 轮」算出，
	 * flush 只下发窗口段；窗口前历史由渲染层走 disk 轮次分页 prepend。
	 */
	private readonly displayWindowStartByAgent = new Map<string, number>();
	/**
	 * displayWindowStartByAgent 最近一次重算时的数组长度。
	 * 流式期 assistant/tool 更新不改变轮次边界，flush 若长度未变可跳过 findTurnPageStart 的
	 * O(n) map/scan；只有 append/截断/重载等长度变化才重算，降低 50ms flush 的分配频率。
	 */
	private readonly displayWindowComputedLengthByAgent = new Map<string, number>();
	/**
	 * 运行期消息缓存头部在会话文件消息下标空间中的偏移（entryId 缺失时的数值游标换算）。
	 * loadMessages / trimRuntimeCache 维护；-1 表示未知（匿名会话等无文件场景）。
	 */
	private readonly messageHeadOffsetByAgent = new Map<string, number>();
	/**
	 * trim 窗口右移滑出显示区的旧窗口头部轮次（待下次全量 flush 下发，渲染层并入历史前缀）。
	 * 防止「翻历史 → 新轮 settle → 窗口前移」时锚点轮从视口消失且无法翻回。
	 */
	private readonly pendingSlideOutByAgent = new Map<string, ChatMessage[]>();
	/** 会话文件版本（mtime:size）：随消息载荷下发，渲染层据此检测压缩改写并丢弃 disk 前缀。 */
	private readonly sessionFileVersionByAgent = new Map<string, string>();
	private readonly thinkingEmitter = new LatestByKeyEmitter<string, string>(
		100,
		(agentId, thinking) => this.emitThinkingNow(agentId, thinking),
	);
	/** 当前流式正文的累积文本，独立于 messages 数组推送（阶段1：学 Proma 独立存储）。
	 *  100ms 合并窗口（2026-08 占用治理）：渲染层每次到达都要做 O(n) 累积拼接、
	 *  MarkdownStream 重渲染与 GC 回收，50ms→100ms 让流式期这些 churn 减半
	 *  （实测流式期 RSS 增长率随之减半），打字机（useSmoothStream）负责逐字
	 *  平滑，100ms 的到达粒度肉眼不可感知；窗口越大 burst 时单帧步进越大，
	 *  100ms 是平滑度与占用之间的折中。 */
	private readonly textEmitter = new LatestByKeyEmitter<string, string>(
		100,
		(agentId, text) => this.emitTextStreamNow(agentId, text),
	);
	/** 流式正文累积缓冲：text_delta 时累加，message_end/agent_end/settled/abort 清除。 */
	private readonly streamingText = new Map<string, string>();
	/**
	 * 已推送正文快照（delta 基准，2026-08 IPC 治理）：流式期间只推增量，
	 * 避免每 50ms 全量重推（100K+ 文本 ≈ 4MB/s 瞬时 IPC 流量，主/渲染两侧
	 * 分配器把 RSS 抬到流量峰值且不归还 → GB 级爬升）。见 emitTextStreamNow。
	 */
	private readonly lastSentTextByAgent = new Map<string, string>();
	/** 距上次全量快照的增量推送次数（每 50 次 ≈ 5s 补一次全量自愈，兜底渲染层丢增量）。 */
	private readonly textPushCountByAgent = new Map<string, number>();
	/** 已推送思考快照（delta 基准，同正文通道治理，见 emitThinkingNow）。 */
	private readonly lastSentThinkingByAgent = new Map<string, string>();
	private readonly thinkingPushCountByAgent = new Map<string, number>();
	/** 流式 emit 合并窗口（毫秒）。50ms 兼顾流畅度与传输量，肉眼几乎无延迟。 */
	private static readonly MESSAGE_FLUSH_INTERVAL_MS = 50;
	/** 激活显示窗口轮数：renderer atom 常驻最近 9 轮，DOM 仍按 3 轮窗口渐进挂载；更早历史走轮次分页。 */
	private static readonly DISPLAY_WINDOW_TURNS = 9;
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
	/** 工具完整结果 LRU 上限（见 toolFullTextByMessageId）。 */
	private static readonly TOOL_FULL_TEXT_LRU_LIMIT = 200;
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
	/** 开启了 RPC 日志记录的 agent id 集合 */
	private readonly rpcLoggingAgents = new Set<string>();
	/**
	 * 实时 RPC 日志广播缓冲：按 agent 聚合待发条目，节流刷出。
	 * 流式阶段 RPC 事件可能非常高频，逐条 IPC 会把渲染进程打爆，必须批量推送。
	 */
	private readonly pendingLiveRpcLogs = new Map<string, RpcLogEntry[]>();
	private liveRpcLogFlushTimer: NodeJS.Timeout | null = null;
	/** 实时日志广播节流间隔：聚合 ~80ms 的条目一次性推送 */
	private static readonly LIVE_RPC_LOG_FLUSH_MS = 80;
	/** 单次广播批次的条数上限，防止单条 IPC 负载过大 */
	private static readonly LIVE_RPC_LOG_MAX_BATCH = 100;
	/** 聚合缓冲的条数上限，极端高频时丢弃最旧条目，防止内存失控 */
	private static readonly LIVE_RPC_LOG_MAX_PENDING = 1000;
	/** 正在执行手动压缩操作的 agent，用于区分手动压缩重启和异常崩溃 */
	private readonly compactingAgents = new Set<string>();
	/**
	 * Pi 通过事件报告正在自动/手动压缩的 agent。
	 * 自动压缩发生在 agent_end 之后，桌面端若不单独追踪，会过早把会话置为 idle，
	 * 用户随后发送的新消息可能撞上 Pi 内部 compaction，表现为“会话中断”。
	 */
	private readonly rpcCompactingAgents = new Set<string>();
	/**
	 * pi 的逻辑模型回合边界（agent_start → true，agent_end → false）。
	 * 与 tab.status 分离：压缩/重试收尾时 runtime 仍 busy，但上一轮回答已经完成。
	 */
	private readonly agentTurnActiveById = new Map<string, boolean>();
	/**
	 * rewind 自动打点的回合计数（agent_start 递增一次 = 一轮 run）。
	 * pi 事件流没有 turnIndex 概念，用本地计数近似 pi-rewind 的 turn 语义。
	 */
	private readonly rewindTurnCounters = new Map<string, number>();
	/** 正在执行模型配置刷新的 agent，用于退出处理器中忽略进程退出事件 */
	private readonly modelRefreshingAgents = new Set<string>();
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
	 * 每个 agent 的流式 generation 闸门。
	 * abort 封印当前 generation；须等 abort settled（或超时兜底）后，
	 * 再由 agent_start 推进 generation 放行，防止残留 thinking/text delta 串台。
	 */
	private readonly streamGates = new Map<string, StreamGateState>();

	/**
	 * 流式性能计时：以 sendPrompt 发出的请求时刻为起点（而非收到 message_start），
	 * 首个 thinking/text delta 记 firstDeltaAt，正文首 delta 记 firstTextAt，
	 * message_end/done/error 结算。用于计算首 token 延迟（TTFT）、总耗时与生成速度（TPS）。
	 * pi 不暴露耗时字段，只能由本地事件时间戳推算。
	 */
	private readonly messagePerfByAgent = new Map<
		string,
		{ startedAt: number; firstDeltaAt: number; firstTextAt: number }
	>();

	/** sendPrompt 发出的请求时刻（毫秒），供首个 message_start 起表时优先使用（含排队时间）。 */
	private readonly promptRequestedAtByAgent = new Map<string, number>();

	/** 最近一次 assistant 回复的性能指标（结算后保留，供 getRuntimeState 合并展示）。 */
	private readonly lastPerfByAgent = new Map<
		string,
		{ ttftMs?: number; totalMs: number; tps?: number; at: number }
	>();
	/** abort 后等待 agent_settled 的超时定时器；避免 pi 漏发 settled 导致永久封印。 */
	private readonly abortSettledFallbackTimers = new Map<string, NodeJS.Timeout>();
	/** abort settled 兜底超时：覆盖多数管道残留，同时不让“立刻重发”永久卡死。 */
	private static readonly ABORT_SETTLED_FALLBACK_MS = 1500;
	/** abort 升级验证窗口：abort_bash + 二次 abort 后仍 running 则提示用户。 */
	private static readonly ABORT_ESCALATION_VERIFY_MS = 4000;

	/**
	 * 待处理的 Extension UI 请求。key 为 agentId，value 为 Map<requestId, { method, title, raisedAt }>。
	 * 用于在 abort 时及时发送 cancellation 防止 pi 等待超时；raisedAt 记录提问弹起时刻，
	 * 供 ask_question 工具耗时扣除用户等待时间（exclude_wait）使用。
	 */
	private readonly pendingUIRequests = new Map<string, Map<string, { method: string; title: string; raisedAt: number }>>();
	/**
	 * 各 agent 已累计的 ask 用户等待毫秒数（raisedAt→回答时刻）。
	 * 工具耗时（durationMs）应只算 agent 实际处理时长，不含用户盯着问卷思考的时间；
	 * ask_question 工具结束时从中扣除并清零，工具开始新一轮时也清零防泄漏到后续工具。
	 */
	private readonly askWaitMsByAgent = new Map<string, number>();
	/** abort 时正在等待 ask_question 响应的 agent，用于在工具结果中覆写 answer 为 null。 */
	private readonly abortedDuringAsk = new Set<string>();
	/** 成功空闲（settled）回调：供 PetStateBridge 等主进程内部模块订阅，携带完成 Agent 身份。 */
	private readonly settledListeners = new Set<(info: { agentId: string; title: string }) => void>();
	/**
	 * 运行时标题变化回调（refreshAutoTitle / session_info_changed / rename）。
	 * 装配层据此写回 SessionCatalog：侧栏/Tab 读的是 catalog.title，不是 AgentTab.title；
	 * 只 emitState 时 UI 仍会停在「新会话」占位名。用 setter 注入，避免再拉长构造参数。
	 */
	private onTitleChanged?: (agentId: string, title: string) => void;
	/** 已发送 ask 系统通知的 agent；新一轮 run（agent_start）时清除，避免同一轮多次提问刷屏。 */
	private readonly notifiedAskAgents = new Set<string>();
	/** 待处理的项目信任确认请求。key 为 requestId，用于在 Agent 启动前等待用户的信任决策。 */
	private readonly pendingTrustRequests = new Map<string, { resolve: (choice: ProjectTrustChoice) => void }>();
	private wslEnvironment: WslEnvironment | null = null;

	/**
	 * 用户配置的 RPC 超时（默认 600s，SettingsStore 另有「低于 600s 自动提升」保险）。
	 * 发送消息与启动/重连等用户可感知的等待路径统一吃该配置，
	 * 与启动诊断卡里的指引（“Increase the RPC timeout in settings”）保持一致，
	 * 避免用户调大配置却只对 prompt 生效、启动仍按硬编码 30s 超时的误导。
	 */
	private get rpcTimeoutMs(): number {
		return this.settingsStore.get().rpcTimeout;
	}

	constructor(
		private readonly getProject: (id: string) => Project | undefined,
		private readonly getWindow: () => BrowserWindow | null,
		private readonly settingsStore: SettingsStore,
		private readonly configManager: ConfigManager,
		private readonly rpcLogger?: RpcLogger,
		private readonly appLogger?: AppLogger,
		sessionFileEditor?: SessionFileEditor,
		private readonly translate: (
			key: MainProcessTranslationKey,
			params?: Record<string, string | number>,
		) => string = () => "Agent operation failed.",
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
	) {
		this.messageProjector = new AgentMessageProjector({
			translate: this.translate,
			isAskAborted: (agentId) => this.abortedDuringAsk.has(agentId),
		});
		this.sessionFileEditor = sessionFileEditor ?? new SessionFileEditor({
			logger: appLogger
				? {
					warn: (message, details) => appLogger.warn("session-file", message, details),
				}
				: undefined,
		});
		this.sessionHistoryReader = new SessionHistoryReader({
			toHostPath: (sessionPath) => this.toSessionHostPath(sessionPath),
			convertMessages: (agentId, rawMessages, activeEntryIds) =>
				this.convertAgentMessages(agentId, rawMessages, activeEntryIds),
			trimMessages: (rawMessages, maxTurns) => trimHistoryMessages(rawMessages, maxTurns),
			translate: this.translate,
			logger: appLogger,
		});
	}

	configureWsl(environment: WslEnvironment | null): void {
		this.wslEnvironment = environment;
	}

	/**
	 * 开发诊断埋点。未开启时 sink 为空，recordTiming 直接返回。
	 * 用来对照「点 pi 会话卡死」时 create / history.load 是否把主进程堵住。
	 */
	setDiagnosticsSink(
		sink: ((name: string, startedAt: number, detail?: Record<string, string | number | boolean | null>) => void) | undefined,
	): void {
		this.diagnosticsSink = sink;
	}

	private diagnosticsSink?: (
		name: string,
		startedAt: number,
		detail?: Record<string, string | number | boolean | null>,
	) => void;

	private recordTiming(
		name: string,
		startedAt: number,
		detail?: Record<string, string | number | boolean | null>,
	): void {
		this.diagnosticsSink?.(name, startedAt, detail);
	}

	/**
	 * 统一构造 PiProcess：注入 PiDeck 内置扩展路径解析 + 安全管理快照/会话身份。
	 * 内置扩展以 -e 从 app resources 加载，不再依赖用户扩展目录副本。
	 * 安全管理：确保策略快照已落盘（小 JSON 写，等完成后启动，保证扩展首次拦截即可读到）。
	 * settingsOverride 仅用于本次 spawn（如扩展加载失败后强制 --no-extensions），不改持久设置。
	 */
	private createPiProcess(
		cwd: string,
		sessionPath?: string,
		securitySessionKey?: string,
		settingsOverride?: Partial<Pick<AppSettings, "piRpcNoExtensions" | "piRpcNoSkills" | "removedBuiltInExtensions">>,
	): PiProcess {
		const settings = settingsOverride
			? { ...this.settingsStore.get(), ...settingsOverride }
			: this.settingsStore.get();
		if (this.securityStore) {
			void this.securityStore.ensureSnapshotWritten();
		}
		return new PiProcess(cwd, settings, undefined, {
			// 扩展解析器与模型能力缓存共用（piProcessExtensionResolvers）：
			// 保证「选择器能看到扩展贡献的模型」与「运行时实际加载的扩展」同源。
			...createPiProcessExtensionResolvers(cwd, settings),
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
				if (
					!shouldRetryWithoutExtensions({
						alreadyNoExtensions,
						stderr: diag?.stderr.join("") ?? "",
						errorMessage: rawMessage,
						exitCode: diag?.exitCode,
						processStillRunning: failed?.isRunning() ?? false,
					})
				) {
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
		let process: PiProcess;
		if (
			!settingsOverride &&
			existing &&
			!existing.isRunning() &&
			existing.getDiagnostics() === null
		) {
			process = existing;
		} else {
			process = this.createPiProcess(
				options.projectPath,
				options.sessionPath,
				options.deckSessionId,
				settingsOverride,
			);
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
		void this.appLogger?.info("agent", "Agent get_state request start", { agentId });
		const state = await client.request({ type: "get_state" }, this.rpcTimeoutMs);
		return { client, process, state };
	}

	/**
	 * 暂存中的启动期诊断（扩展回退说明 / 首个 run 前的 extension_error）。
	 * 在首个 agent_start 前收到时先不写时间线——用户的触发消息还没落盘，
	 * 直接 append 会插进历史轮次与当前消息之间（用户体感「错误提示跑上旧卡片」）。
	 * 首个 run 开始时按序落盘：位于用户消息之后、回答之前，正好在当前活动点上。
	 */
	private readonly pendingStartupDiagnostics = new Map<string, QueuedStartupDiagnostic[]>();
	/** 已发生过首个 agent_start 的 agent：此后的 extension_error 属于运行期间，直接落盘。 */
	private readonly agentStartedFirstRun = new Set<string>();

	/** 暂存一条启动期诊断，等首个 agent_start 统一落盘（见 pendingStartupDiagnostics）。 */
	private queueStartupDiagnostic(agentId: string, diagnostic: QueuedStartupDiagnostic): void {
		const list = this.pendingStartupDiagnostics.get(agentId) ?? [];
		list.push(diagnostic);
		this.pendingStartupDiagnostics.set(agentId, list);
	}

	/** 首个 run 开始：把启动期诊断按序写入时间线（此刻用户消息已就位，位置正确）。 */
	private flushStartupDiagnostics(agentId: string): void {
		const list = this.pendingStartupDiagnostics.get(agentId);
		if (!list || list.length === 0) return;
		this.pendingStartupDiagnostics.delete(agentId);
		for (const diagnostic of list) {
			this.addLocalizedMessage(
				agentId,
				diagnostic.role,
				diagnostic.i18nKey,
				diagnostic.fallbackText,
				diagnostic.options,
			);
		}
	}

	/** 回退成功后的系统说明：已禁用扩展，附上可粘贴给 AI 的 stderr。
	 *  不立即写时间线，等首个 run（用户消息之后）落盘，避免插进历史轮次中间。 */
	private notifyExtensionFallback(agentId: string, debugDetails?: string): void {
		this.queueStartupDiagnostic(agentId, {
			role: "system",
			i18nKey: "diagnostic.extensionsDisabledFallback",
			fallbackText: "扩展加载失败，已禁用扩展运行。可在本会话把下面的错误信息发给 AI，协助排查扩展问题。",
			options: { debugDetails },
		});
	}

	/** Windows 主进程文件操作必须使用可由 host 访问的路径。 */
	private toSessionHostPath(sessionPath: string): string {
		return this.wslEnvironment
			? toWindowsHostPath(sessionPath, this.wslEnvironment)
			: sessionPath;
	}

	/** Pi/RPC/session identity 在 WSL 模式下始终使用 Linux 逻辑路径。 */
	private toSessionProtocolPath(sessionPath: string): string {
		return this.wslEnvironment
			? toWslLinuxPath(sessionPath, this.wslEnvironment)
			: sessionPath;
	}

	/**
	 * 归一化 pi 上报/传入的会话路径为绝对路径（含日志）。
	 * pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，get_state 返回的
	 * sessionFile 是相对 cwd 的；若原样写入 catalog，会与扫描器发现的绝对路径
	 * 构成同文件双记录（侧栏重复显示），且文件操作会落到错误位置。
	 */
	private normalizeSessionPathFromPi(
		sessionPath: string | undefined,
		projectPath: string,
		environment: SessionEnvironment,
	): string | undefined {
		if (!sessionPath) return undefined;
		const resolved = toAbsoluteSessionPath(sessionPath, projectPath, environment);
		if (resolved !== sessionPath) {
			void this.appLogger?.warn("agent", "Session file path was relative; resolved to absolute", {
				sessionPath,
				resolved,
			});
		}
		return resolved;
	}

	list() {
		return [...this.agents.values()]
			.map((runtime) => runtime.tab)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	/**
	 * 判断指定项目是否仍有运行中的 Agent（pi 子进程未退出）。
	 * 用于删除项目前拦截，避免删除后 pi 进程悬挂后台继续占用资源。
	 */
	hasAgentForProject(projectId: string): boolean {
		for (const runtime of this.agents.values()) {
			if (runtime.tab.projectId === projectId) return true;
		}
		return false;
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
	private computeWindowStartFilePos(
		agentId: string,
		all: ChatMessage[],
		windowStart: number,
	): number | undefined {
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
		const windowStart = Math.min(
			Math.max(0, this.displayWindowStartByAgent.get(agentId) ?? 0),
			all.length,
		);
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
	 * （toolFullTextByMessageId，仅截断下发后的完整文本），回退会话文件定位读取
	 * （SessionHistoryReader 内部有 LRU）。找不到或读取失败抛错，由 IPC 层转结构化错误。
	 */
	async readMessageFullText(
		agentId: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		const cached = this.toolFullTextByMessageId.get(messageId);
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
	async readMessageFullTextFromFile(
		sessionPath: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		return this.sessionHistoryReader.readMessageFullText(sessionPath, messageId, entryId);
	}

	/**
	 * The reader owns persisted JSONL parsing and paging. This facade keeps the
	 * Session-first public contract on AgentManager while runtime remains inactive.
	 */
	async readSessionDisplayMessages(
		sessionPath: string,
		agentId = "_viewer",
		sessionContent?: string,
	): Promise<ChatMessage[]> {
		return stripToolResultForDelivery(
			await this.sessionHistoryReader.readSessionDisplayMessages(sessionPath, agentId, sessionContent),
		);
	}
	/**
	 * 读取会话文件中的子代理记录（subagents:record custom 条目），并合并
	 * 工具调用推导条目（acp_delegate：billion-context；subagent 工具：nicobailon
	 * pi-subagents）；同 id 时 record 优先（见 mergeSubagentSources 的例外规则）。
	 */
	async readSessionSubagentRecords(sessionPath: string) {
		const records = await this.sessionHistoryReader.readSubagentRecords(sessionPath);
		const derived = await this.sessionHistoryReader.readDerivedSubagentEntries(sessionPath);
		if (derived.length === 0) return records;
		return mergeSubagentSources(records, derived);
	}


	/**
	 * 会话级文件修改汇总：从会话显示消息全量聚合 write/edit/create/patch。
	 * 与渲染层 TimelineFormat 共用 shared/fileChanges 解析，历史/活会话通用。
	 */
	async readSessionFileChanges(sessionPath: string): Promise<SessionFileChange[]> {
		return collectSessionFileChanges(await this.readSessionDisplayMessages(sessionPath, "_viewer"));
	}

	/**
	 * 会话级 todo 快照：读会话分支上最新 pi-deck-todo custom 条目（历史会话重建任务 tab）。
	 */
	async readSessionTodo(sessionPath: string): Promise<SessionTodoSnapshot | undefined> {
		return this.sessionHistoryReader.readTodoSnapshot(sessionPath);
	}


	/** 轮次维度显示分页：pageSize 复用为轮次数（readSessionDisplayTurnPage 内部夹紧上限） */
	async readSessionDisplayTurnPage(
		sessionPath: string,
		agentId = "_viewer",
		before?: number,
		turnCount?: number,
		beforeEntryId?: string,
	): Promise<SessionMessagePage> {
		const page = await this.sessionHistoryReader.readSessionDisplayTurnPage(
			sessionPath,
			agentId,
			before,
			turnCount,
			beforeEntryId,
		);
		return { ...page, messages: stripToolResultForDelivery(page.messages) };
	}

	/** 从同一份历史显示索引读取模型/思考元数据，避免再次走 SessionScanner 摘要读取。 */
	async readSessionDisplayMetadata(
		sessionPath: string,
	): Promise<Pick<SessionMessagePage, "model" | "thinkingLevel">> {
		return this.sessionHistoryReader.readSessionMetadata(sessionPath);
	}

	/**
	 * 缓存优先的历史翻页：运行中会话的「加载更早对话」先在主进程内存缓存（最近 12 轮）里切片，
	 * 命中则零文件 IO；未命中返回 null，调用方回退 SessionHistoryReader 读文件。
	 *
	 * 游标：beforeEntryId 优先（跨下标空间稳定）；before 为文件绝对下标时先解析成 entryId 再查缓存。
	 * 命中边界：锚点条目必须在缓存中且不是缓存第一条（第一条之前没有缓存内容，交给文件路径）。
	 * 返回页的 nextBefore/nextBeforeEntryId 统一换算回文件下标空间，渲染层续页协议不变。
	 */
	async tryReadRuntimeTurnPage(
		sessionPath: string,
		agentId: string,
		options: { beforeEntryId?: string; before?: number; turnCount?: number },
	): Promise<SessionMessagePage | null> {
		const runtime = this.agents.get(agentId);
		const list = this.messages.get(agentId);
		if (!runtime || !list || list.length === 0) return null;
		// 防御：运行时已切到别的会话（替换/重绑）时禁止用其缓存应答本会话的翻页，
		// 交给文件路径（调用方以稳定 sessionId 经 coordinator 解析，此处兜底双保险）。
		if (
			runtime.tab.sessionPath &&
			this.toSessionHostPath(runtime.tab.sessionPath) !== this.toSessionHostPath(sessionPath)
		) {
			return null;
		}

		let pos = -1;
		if (options.beforeEntryId) {
			pos = list.findIndex((m) => m.meta?.entryId === options.beforeEntryId);
		} else if (options.before !== undefined) {
			const entryId = await this.sessionHistoryReader.resolveEntryIdAtPosition(sessionPath, options.before);
			if (!entryId) return null;
			pos = list.findIndex((m) => m.meta?.entryId === entryId);
			// 锚点是缓存最旧条目：缓存里没有比它更早的内容，交给文件路径
			if (pos === 0) return null;
		}
		if (pos < 0) return null;

		const turnCount = Math.min(
			Math.max(1, Math.floor(options.turnCount ?? 3)),
			SessionHistoryReader.maxTurnPageSize(),
		);
		const roles = list.map((m) => ({ role: m.role, byteLength: 0 }));
		const start = findTurnPageStart(roles, pos, turnCount);
		if (start >= pos) return null;
		const page = list.slice(start, pos);
		const oldest = page[0] ?? list[0];
		const oldestEntryId = typeof oldest?.meta?.entryId === "string" ? oldest.meta.entryId : undefined;
		const nextBefore = oldestEntryId
			? (await this.sessionHistoryReader.resolveEntryPosition(sessionPath, oldestEntryId)) ?? null
			: null;
		const total = await this.sessionHistoryReader.getActiveEntryCount(sessionPath);
		// 与文件路径同口径的会话文件版本：渲染层据此检测压缩/外部改写并丢弃已缓存的历史前缀
		// （indexVersion 缺失会让 cache 页沿用旧版本，压缩后前缀失效不可见）。
		const indexVersion = await this.sessionHistoryReader.getSessionIndexVersion(sessionPath);
		void this.appLogger?.info("agent", "Runtime history cache hit", {
			agentId,
			start,
			pos,
			pageCount: page.length,
		});
		return {
			// 与文件路径/全量 flush 同口径瘦身：缓存页也必须剥离 meta.result，
			// 否则一次缓存命中会把主进程保留的完整工具结果带回渲染层，
			// 历史前缀的内存会随翻页快速膨胀。
			messages: stripToolResultForDelivery(page),
			total,
			nextBefore,
			...(oldestEntryId ? { nextBeforeEntryId: oldestEntryId } : {}),
			indexVersion,
		};
	}

	recordHostExchange(agentId: string, userText: string, assistantText: string) {
		this.addMessage(agentId, "user", userText);
		this.addMessage(agentId, "assistant", assistantText);
	}

	getCwd(agentId: string) {
		return this.requireRuntime(agentId).tab.cwd;
	}

	async loadMessages(
		agentId: string,
		skipEntries = false,
		earlyMessagesPromise?: Promise<RpcResponse>,
		options?: { preserveMessagesAfter?: number },
	) {
		const t0 = Date.now();
		const runtime = this.requireRuntime(agentId);

		// 有会话文件时禁止再发 get_messages：pi 会把整段历史打成单行 JSON，
		// PiRpcClient 在 stdout data 回调里同步 JSON.parse，主进程事件循环被堵住，
		// 窗口关闭/最小化/设置都点不了。earlyPromise / JSONL 尾部读取才是安全路径。
		const sessionPath = runtime.tab.sessionPath;
		const messagesPromise = earlyMessagesPromise
			?? (sessionPath
				? this.readRecentMessagesFromSessionFile(
					sessionPath,
					AgentManager.MAX_HISTORY_LOAD_TURNS,
				)
				: runtime.process.client.request({ type: "get_messages" }, this.rpcTimeoutMs));

		// 有会话文件时禁止 get_entries：pi 把整棵 entry 树打成单行 JSON，
		// PiRpcClient 同步 JSON.parse 会再冻一次窗口。entryId 从 JSONL 索引取，
		// 与尾部窗口消息一一对应。skipEntries 仍保留给无文件/显式跳过路径。
		let entriesPromise: Promise<any> | undefined;
		const useFileEntryIds = Boolean(sessionPath);
		if (!skipEntries && !useFileEntryIds) {
			entriesPromise = runtime.process.client.request({
				type: "get_entries",
			}, 15_000).catch(() => {
				// get_entries 失败时不阻塞消息加载；编辑/删除走 fallback（_piDeckMsgSeq 计数）
				void this.appLogger?.warn("agent", "Failed to get_entries for entryId mapping", { agentId });
				return undefined;
			});
		}

		const [response, entriesResult] = await Promise.all([
			messagesPromise,
			entriesPromise ?? Promise.resolve(undefined),
		]);
		const t1 = Date.now();

		const rawMessages = (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];

		// 解析 entryId 列表（需要先于 convertAgentMessages，用于把消息关联到 pi 的会话分支）。
		let activeEntryIds: string[] | undefined;
		if (useFileEntryIds && sessionPath) {
			const roleCount = rawMessages.reduce<number>((count, message) => {
				const role = (message as { role?: unknown } | undefined)?.role;
				return count + (role === "user" || role === "assistant" || role === "toolResult" ? 1 : 0);
			}, 0);
			activeEntryIds = await this.sessionHistoryReader
				.getRecentActiveEntryIds(sessionPath, roleCount)
				.catch(() => undefined);
		} else if (entriesResult) {
			const entriesData = entriesResult.data as
				| { entries?: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>; leafId?: string }
				| undefined;
			if (entriesData?.entries && entriesData?.leafId) {
				activeEntryIds = this.buildActiveBranchEntryIds(entriesData.entries, entriesData.leafId);
			}
		}

		// 按对话轮次截断（保留最近若干轮 user 消息）。压缩摘要不是 user 消息，会被此逻辑保留在尾部，
		// 因此下方会单独把它插到最前面，确保不被按 user 轮次切掉。
		const trimmed = trimHistoryMessages(rawMessages);
		const trimmedStart = turnTrimStartIndex(rawMessages);

		// 身份向量必须与保留消息同步裁剪：activeEntryIds 按「消费槽位的角色消息」与 rawMessages
		// 一一对应，trim 丢弃头部整轮后，若仍把完整 activeEntryIds 交给 projector，保留消息会被
		// 绑定到会话最早的 entry——编辑/删除/重发将落到错误轮次（曾因 15 轮裁剪复现 q4→u1）。
		// compactionSummary/branchSummary 不消费槽位，prepend 到最前不影响对齐。
		let droppedRoleCount = 0;
		if (activeEntryIds && trimmedStart > 0) {
			droppedRoleCount = countRoleMessagesBefore(rawMessages, trimmedStart);
			activeEntryIds = activeEntryIds.slice(droppedRoleCount);
		}
		// 记录缓存头部在文件消息下标空间中的位置：无 entryId 的窗口（skipEntries 大历史路径）
		// 需要用它作为首次补历史的数值游标（渲染层 before=windowStartFilePos）。
		let headOffset: number;
		if (useFileEntryIds && sessionPath && activeEntryIds) {
			// 文件 entryId 已是尾部窗口，不是全量分支：headOffset 必须用
			// 文件总数 - 窗口条数，否则「加载更多」会以为已经在文件头。
			const activeFileCount = await this.sessionHistoryReader
				.getActiveEntryCount(sessionPath)
				.catch(() => activeEntryIds.length);
			headOffset = Math.max(0, activeFileCount - activeEntryIds.length);
		} else if (activeEntryIds) {
			headOffset = droppedRoleCount;
		} else if (runtime.tab.sessionPath) {
			// get_entries 失败/未启用（skipEntries）时同样尽力提供数值游标：
			// 否则渲染层「加载更多对话」因 entryId 锚点与 windowStartFilePos 双缺失而静默放弃，
			// 表现为点击无反应（2026-02 修复，此前仅 skipEntries 路径走此兑底）。
			const roleCount = trimmed.reduce<number>((count, message) => {
				const role = (message as { role?: unknown } | undefined)?.role;
				return count + (role === "user" || role === "assistant" || role === "toolResult" ? 1 : 0);
			}, 0);
			// 最佳努力：文件活动消息数 - 缓存内角色消息数 ≈ 被裁头部长度。
			// 文件里非角色 message 条目（system 等）会让该值偏大，属极端边角；
			// entryId 锚点仍是首选路径，此值只作为无 entryId 时的兜底游标。
			const activeFileCount = await this.sessionHistoryReader
				.getActiveEntryCount(runtime.tab.sessionPath)
				.catch(() => 0);
			headOffset = Math.max(0, activeFileCount - roleCount);
		} else {
			headOffset = -1; // 未知：不提供 windowStartFilePos，渲染层回退 entryId 锚点
		}
		this.messageHeadOffsetByAgent.set(agentId, headOffset);

		// 解析会话文件里的压缩记录：拿到所有压缩段摘要 + 归档消息。
		// pi 的 get_messages 对压缩会话只返回压缩后的消息，通常不带压缩摘要；
		// 这里从原始会话文件补回：压缩摘要卡片 + 归档消息（支持展开查看压缩前内容）。
		// 若 RPC 已经返回了压缩/分支摘要，则不再重复补，避免时间线出现两张摘要卡片。
		let compactionSummaryRaw: unknown | null = null;
		const rpcAlreadyHasSummary = rawMessages.some(
			(m) => (m as { role?: unknown })?.role === "compactionSummary"
				|| (m as { role?: unknown })?.role === "branchSummary",
		);
		void this.appLogger?.info("agent", "Compaction check", {
			agentId,
			hasSessionPath: !!runtime.tab.sessionPath,
			rpcAlreadyHasSummary,
			rawMessageCount: rawMessages.length,
		});
		if (runtime.tab.sessionPath) {
			const archiveData = await this.scanCompactions(runtime.tab.sessionPath).catch((err) => {
			void this.appLogger?.warn("agent", "Failed to parse session archives", {
				agentId,
				sessionPath: runtime.tab.sessionPath,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		});
			if (archiveData && archiveData.compactions.length > 0) {
				void this.appLogger?.info("agent", "Session archives parsed", {
					agentId,
					compactionCount: archiveData.compactions.length,
					rpcAlreadyHasSummary,
				});

				const last = archiveData.compactions[archiveData.compactions.length - 1];

				if (!rpcAlreadyHasSummary) {
					// RPC 未返回摘要 → 我们自己创建压缩卡片（只带元信息，归档消息按需读取）
					compactionSummaryRaw = {
						role: "compactionSummary",
						summary: last.summary || this.translate("session.summaryPlaceholder"),
						timestamp: last.timestamp ? Date.parse(last.timestamp) : Date.now(),
						meta: {
							compactionId: last.id || null,
							compactionCount: archiveData.compactions.length,
							firstKeptEntryId: last.firstKeptEntryId,
							tokensBefore: last.tokensBefore,
						},
					};
				}
				// 把压缩次数写回 tab，供前端（会话头/标签）展示"已压缩 N 次"。
				if (runtime.tab.compactionCount !== archiveData.compactions.length) {
					runtime.tab.compactionCount = archiveData.compactions.length;
					this.emitState();
				}
			}
		}

		// 将压缩摘要插到消息最前面（在 trim 之后，避免被按 user 轮次切掉）。
		const finalRaw = compactionSummaryRaw ? [compactionSummaryRaw, ...trimmed] : trimmed;

		const messages = this.convertAgentMessages(agentId, finalRaw, activeEntryIds);
		const t2 = Date.now();
		this.recordTiming("session.history.load", t0, {
			agentId,
			skipEntries,
			rawMessages: rawMessages.length,
		});
		void this.appLogger?.info("agent", "Agent messages loaded", {
			agentId,
			skipEntries,
			rawMessages: rawMessages.length,
			trimmedMessages: trimmed.length,
			requestMs: t1 - t0,
			convertMs: t2 - t1,
			totalMs: t2 - t0,
		});
		// abort 时 ask_question 的 answer 已被覆写为 null，不再需要跟踪
		this.abortedDuringAsk.delete(agentId);
		const nextMessages = stabilizeReloadedMessageIds(
			this.messages.get(agentId) ?? [],
			mergeHistoryWithPreservedMessages(
				messages,
				this.messages.get(agentId) ?? [],
				options?.preserveMessagesAfter,
			),
		);
		// 重载后把进行中的消息身份（activeAssistantMessageIds/toolMessageIds）从
		// 运行期副本重定向到投影版：后续事件继续更新投影版（位置正确、单份），
		// 避免「投影 partial + 运行期完整版」双份或事件 append 到错误轮次。
		this.rebindInFlightMessages(agentId, nextMessages, messages);
		this.messages.set(agentId, nextMessages);
		// 显示窗口 = 尾部 9 轮（DOM 3 / atom 9 / main 12 模型；轮次起点对齐 user 消息，
		// 与 disk 轮次分页同一约定；单轮再大也整轮显示，折叠完整性优先）
		this.displayWindowStartByAgent.set(
			agentId,
			findTurnPageStart(
				nextMessages.map((m) => ({ role: m.role, byteLength: 0 })),
				nextMessages.length,
				AgentManager.DISPLAY_WINDOW_TURNS,
			),
		);
		// 文件版本随本次加载快照：压缩/外部改写会改变 mtime:size，渲染层据此丢弃 disk 前缀
		if (runtime.tab.sessionPath) {
			try {
				const version = await stat(this.toSessionHostPath(runtime.tab.sessionPath));
				this.sessionFileVersionByAgent.set(agentId, `${version.mtimeMs}:${version.size}`);
			} catch {
				this.sessionFileVersionByAgent.delete(agentId);
			}
		}
		this.refreshAutoTitle(agentId);
		this.scheduleMessageEmit(agentId, true);
		return nextMessages;
	}

	async create(rawInput: CreateAgentInput) {
		const input = rawInput.sessionPath
			? { ...rawInput, sessionPath: this.toSessionProtocolPath(rawInput.sessionPath) }
			: rawInput;
		const sessionKey = buildAgentSessionKey(input, this.getAgentSessionIdentityDefaults());
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

	private async readRecentMessagesFromSessionFile(
		sessionPath: string,
		maxTurns: number,
	): Promise<RpcResponse> {
		return this.sessionHistoryReader.readRecentMessages(sessionPath, maxTurns);
	}

	private async scanCompactions(
		sessionPath: string,
		sessionContent?: string,
	) {
		return this.sessionHistoryReader.scanCompactions(
			sessionPath,
			sessionContent,
		);
	}

	private findRuntimeBySessionKey(sessionKey: string) {
		const defaults = this.getAgentSessionIdentityDefaults();
		return [...this.agents.values()].find(
			(runtime) => buildAgentSessionKey({
				projectId: runtime.tab.projectId,
				sessionPath: runtime.tab.sessionPath,
				environment: runtime.tab.sessionEnvironment,
				source: runtime.tab.sessionSource,
				wslDistro: runtime.tab.wslDistro,
				wslUser: runtime.tab.wslUser,
				importedSourceId: runtime.tab.importedSourceId,
			}, defaults) === sessionKey,
		);
	}

	private async createUnlocked(input: CreateAgentInput) {
		const t0 = Date.now();
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);

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
		const existingForSessionKey = buildAgentSessionKey(input, sessionIdentityDefaults);
		const existingForSession = existingForSessionKey
			? this.findRuntimeBySessionKey(existingForSessionKey)
			: undefined;
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
			wslDistro: input.wslDistro ?? (
				sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslDistro : undefined
			),
			wslUser: input.wslUser ?? (
				sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslUser : undefined
			),
			importedSourceId: input.importedSourceId,
			noSession: input.noSession,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		const trustOverride = await this.ensureProjectTrust(project);
		const t2 = Date.now();

		void this.appLogger?.info("agent", "Agent pi process start", { agentId: id });
		// 每次 spawn 前异步刷新模型列表缓存（不等完成，避免阻塞 Agent 启动）：
		// 用户直接编辑 models.json/auth.json 后，下一次启动的 Agent 即能看到新模型。
		this.onBeforeAgentSpawn?.();
		this.agents.set(id, { tab, process: this.createPiProcess(project.path, input.sessionPath, input.deckSessionId) });
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
			args: diag?.args?.join(' '),
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
			const data = state.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			tab.sessionId = data?.sessionId;
			tab.sessionPath = this.normalizeSessionPathFromPi(
				data?.sessionFile ?? input.sessionPath,
				project.path,
				sessionEnvironment,
			);
			const piSessionName =
				data?.sessionName && !looksLikePiSessionFileStem(data.sessionName)
					? data.sessionName
					: undefined;
			tab.title =
				input.title ||
				piSessionName ||
				(input.sessionPath
					? this.translate("session.historyTitle", { project: project.name })
					: `${project.name} agent`);
			tab.status = "idle";
			// 打开即同步权威标题（2026-09 现场）：catalog 可能被扫描器弱回退（首条消息文本）
			// 覆盖过（session_info 落在头/尾窗口盲区），而 input.title 优先会造成打开后
			// 侧栏一直停在污染值；pi get_state 的 sessionName 是 JSONL 末尾 session_info 的
			// 权威值，两者不一致时以 pi 为准回写 catalog，顺带覆盖 pi-tui 外部改名漏同步的场景。
			if (piSessionName && piSessionName !== input.title && piSessionName !== tab.title) {
				this.onTitleChanged?.(id, piSessionName);
			}
			// 历史一律从 JSONL 尾部读最近 N 轮，禁止 get_messages：
			// pi 会把整段历史打成单行 JSON，主进程 JSON.parse 会冻住窗口按钮。
			// Agent 可用只依赖 get_state；历史后台加载，加载期间新消息由 preserveMessagesAfter 保护。
			const historyLoadDecision = this.getHistoryAutoLoadDecision(tab.sessionPath);
			const preserveMessagesAfter = Date.now();
			if (fallbackFromExtensions) {
				this.notifyExtensionFallback(id, handshake.fallbackDebug);
			}
			if (tab.sessionPath) {
				void this.loadMessages(
					id,
					true,
					this.readRecentMessagesFromSessionFile(
						tab.sessionPath,
						AgentManager.MAX_HISTORY_LOAD_TURNS,
					),
					{ preserveMessagesAfter },
				)
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
		const response = await runtime.process.client.request(
			{ type: "set_session_name", name: trimmed },
			20_000,
		);
		if (!response.success) {
			void this.appLogger?.warn("agent", "Session rename failed", {
				agentId,
				error: response.error,
			});
			throw new Error(this.translate("mainAgent.renameFailed"));
		}

		this.applyRuntimeTitle(agentId, trimmed, false);
		const state = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => ({ data: undefined }));
		const data = state.data as
			| { sessionId?: string; sessionFile?: string; sessionName?: string }
			| undefined;
		runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
		runtime.tab.sessionPath = this.normalizeSessionPathFromPi(
			data?.sessionFile ?? runtime.tab.sessionPath,
			this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd,
			runtime.tab.sessionEnvironment ?? "native",
		);
		this.applyRuntimeTitle(agentId, data?.sessionName || runtime.tab.title, false);
		this.emitState();
		return runtime.tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		const trimmed = input.message.trim();
		const hasImages = input.images && input.images.length > 0;
		const agentMessage = input.agentMessage?.trim() || trimmed || "Describe this image.";
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
			const command = isBashExcluded
				? trimmed.slice(2).trim()
				: trimmed.slice(1).trim();
			if (command) {
				return this.executeBashCommand(input.agentId, command, isBashExcluded);
			}
		}

		// 判断 agent 是否已在忙碌中；运行中继续发送时必须带 streamingBehavior，
		// 否则 pi RPC 会拒绝请求。该值也用于给用户消息打上投递语义标记。
		const alreadyBusy = runtime.tab.status === "running";
		const statusBeforePrompt = runtime.tab.status;
		const promptDeliveryBehavior = input.streamingBehavior ?? (alreadyBusy ? "steer" : undefined);

		// 在设置状态为 running 之前检查进程是否还活着，避免进程崩溃后状态不一致
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addLocalizedMessage(
				input.agentId,
				"error",
				"diagnostic.agentStopped",
				errorMessage,
			);
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

		// 乐观更新：在等待 RPC 返回前先把用户消息写入会话，让用户立即看到自己的消息。
		// 只展示用户原文；agentMessage 里的宿主指令不进 UI 气泡。
		// 如果后续 RPC 失败，再追加错误消息；用户消息本身仍保留在聊天中（用户确已发送）。
		const optimisticMeta = {
			...(promptDeliveryBehavior ? { streamingBehavior: promptDeliveryBehavior } : {}),
			// 与渲染层乐观气泡共用 requestId：发送完成立刻中断再删时，
			// 删除按钮仍拿着乐观 id，不能再另起 UUID 导致 Message not found。
			...(input.requestId ? { requestId: input.requestId } : {}),
		};
		this.addMessage(
			input.agentId,
			"user",
			trimmed || this.translate("session.imagePlaceholder"),
			Object.keys(optimisticMeta).length > 0 ? optimisticMeta : undefined,
			input.images,
		);

		// streamingBehavior 只在 agent 忙碌时需要；UI 可以显式传 steer/followUp 以复用 pi 队列语义。
		// 当前端排队 flush 连续发送多条消息时，第一条会触发 agent_start 使 agent 变忙碌，
		// 后续消息必须带 streamingBehavior 否则 pi 直接返回 error。这里自动兜底。
		// images 用于传递粘贴/拖拽的图片，pi 会将 base64 图片直接传给支持视觉的模型。
		try {
			const promptIsExtensionCommand = await this.promptMatchesRegisteredExtensionCommand(runtime, agentMessage);
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
			// 首字计时起点：RPC 请求发出时刻（而非收到 message_start），把 pi 内部排队与
			// 模型服务端等待计入用户体感的首 token 延迟，避免统计系统性偏短。
			this.promptRequestedAtByAgent.set(input.agentId, rpcStartedAt);
			void this.appLogger?.info("session-perf", "Prompt RPC request started", {
				agentId: input.agentId,
				requestId: input.requestId,
			});
			const response = await runtime.process.client.request(
				requestPayload,
				this.settingsStore.get().rpcTimeout,
			);
			void this.appLogger?.info("session-perf", "Prompt RPC response received", {
				agentId: input.agentId,
				requestId: input.requestId,
				success: response.success,
				rpcMs: Date.now() - rpcStartedAt,
			});
			if (!response.success) {
				// pi RPC 会把不支持图片、忙碌队列参数缺失等前置错误作为 success:false 返回；
				// 必须显式显示出来，否则 UI 会停在"已发送但无响应"的状态。
				const errorMessage = response.error ?? "图片消息发送失败";
				runtime.tab.status = statusBeforePrompt === "running" ? "running" : "idle";
				this.addLocalizedMessage(
					input.agentId,
					"error",
					"diagnostic.promptRejected",
					"消息发送失败。",
					{ debugDetails: errorMessage },
				);
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

			if (promptIsExtensionCommand) {
				// 机制：Pi 扩展命令可在 prompt 阶段直接执行并返回，不进入 agent run。
				// 证据：@earendil-works/pi-coding-agent/dist/core/agent-session.js 中 AgentSession.prompt()
				//      先调用 _tryExecuteExtensionCommand()；命中后 return，不再调用 _runAgentPrompt()。
				// 推导：不能等 agent_end；只有 Pi get_state 明确报告无剩余工作时才恢复 idle。
				this.scheduleIdleCheckAfterExtensionCommand(input.agentId);
			}
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// prompt RPC 调用前已通过同步 write() 写入 pi stdin；此处所有异常都只说明
			// preflight 响应未到达，无法证明 pi 没有接收。返回 unknown，renderer 会永久禁用
			// 该快照的重试/编辑/取消，防止用户把同一条消息提交两次。
			runtime.tab.status = statusBeforePrompt === "running" ? "running" : "error";
			this.addLocalizedMessage(
				input.agentId,
				"error",
				"diagnostic.promptDeliveryUnknown",
				"消息接收结果未知。请先检查当前会话，避免重复发送；必要时重启 Agent。",
				{ debugDetails: errorMessage },
			);
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
	private async executeBashCommand(
		agentId: string,
		command: string,
		excludeFromContext: boolean,
	): Promise<SendPromptResult> {
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
				this.addLocalizedMessage(
					agentId,
					"error",
					"diagnostic.commandFailed",
					"命令执行失败。",
					{ debugDetails: errorMessage },
				);
				return {
					accepted: false,
					error: errorMessage,
					i18nKey: "diagnostic.commandFailed",
					debugDetails: errorMessage,
				};
			}

			this.addMessage(
				agentId,
				"user",
				`${excludeFromContext ? "!!" : "!"}${command}`,
			);
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
				this.addLocalizedMessage(
					agentId,
					"system",
					"diagnostic.commandCancelled",
					"命令已取消",
				);
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
			this.addLocalizedMessage(
				agentId,
				"error",
				"diagnostic.commandDeliveryUnknown",
				"命令接收结果未知。请先检查命令输出或工作区状态，避免重复执行。",
				{ debugDetails: errorMessage },
			);
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

	async abort(agentId: string) {
		const runtime = this.requireRuntime(agentId);

		// pi 在等待 extension_ui_response 时（如 ask_question），不发 abort 也能处理，
		// 但必须解除 pending 请求的阻塞，否则 pi 不会继续读取 stdin 中的后续命令。
		// 发 cancelled: true 会导致 pi 返回 undefined，ask_question 工具默认选第一个；
		// 改发 value: null（不带 cancelled 标记），select parser 返回 null，
		// 工具 result 的 answer = null，answered 为 false → 卡片显示"已取消"。
		const pending = this.pendingUIRequests.get(agentId);
		if (pending && pending.size > 0) {
			this.abortedDuringAsk.add(agentId);
			for (const [requestId] of pending) {
				// abort 视作用户在此刻结束等待：结算等待时长，供该 ask 工具耗时扣除
				this.settleAskWait(agentId, requestId);
				runtime.process.client.sendRaw({
					type: "extension_ui_response",
					id: requestId,
					value: null,
				});
				// The extension receives null to preserve its cancellation semantics, while
				// the renderer must immediately remove the runtime-only interaction.
				this.emit(ipcChannels.agentsUiRequest, {
					agentId,
					requestId,
					completed: true,
					cancelled: true,
				});
			}
		}

		// 标记最近中止的 agent，用于抑制 auto-retry/compaction 把状态重新标为 running。
		// 必须在发送 abort RPC 之前加入集合，避免事件处理函数在 RPC 发出后、
		// handlePiEvent 返回前收到管道中的旧事件并重建 assistant 消息。
		this.recentlyAborted.add(agentId);
		this.setAgentTurnActive(agentId, false);
		// 封印当前 stream generation：比 recentlyAborted 更硬，不依赖 activeAssistantMessageIds 例外条件，
		// 残留 thinking/text/tool 事件在 abort settled 前一律丢弃。
		this.sealAgentStream(agentId);
		this.scheduleAbortSettledFallback(agentId);

		runtime.process.client
			.request({ type: "abort" }, 10_000)
			.catch((error) => {
				// abort 超时或失败不影响前端状态切换，但必须留痕：abort 失败后
				// pi 可能仍在流式输出而 UI 已显示停止，是排查状态错位的关键线索。
				void this.appLogger?.warn("agent", "Abort RPC failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			});

		// Pending dialogs are runtime-only, so clearing their request map is enough.
		if (pending && pending.size > 0) {
			this.pendingUIRequests.delete(agentId);
		}
		// abort 时必须清除所有流式状态，防止后续 pi 的延迟事件（text_delta、thinking_delta、tool_execution_* 等）
		// 修改上次会话的旧消息，导致新会话消息混入被中止的旧输出。
		// 先把已累积思考落入当前 assistant 骨架（保留中断轮的推理），再清 live 通道。
		this.finalizeThinkingIntoMessage(agentId);
		this.flushMessageEmit(agentId);
		this.finishThinkingChannel(agentId);
		this.activeAssistantMessageIds.delete(agentId);
		this.streamingAgents.delete(agentId);
		this.textEmitter.cancel(agentId);
		this.streamingText.delete(agentId);
		this.lastSentTextByAgent.delete(agentId);
		this.textPushCountByAgent.delete(agentId);
		const hadActiveTool = Boolean(
			this.toolExecutingByAgent.get(agentId) ||
			(this.activeToolCallsByAgent.get(agentId)?.size ?? 0) > 0,
		);
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
		this.emit(ipcChannels.agentsNotice, {
			agentId,
			message: "已请求停止当前响应",
			i18nKey: "app.abortRequested",
			kind: "info",
			duration: 2500,
		});
		this.emitState();
	}

	/**
	 * 手动触发上下文压缩。pi 会将历史消息摘要化以释放 context 空间，
	 * 适用于长时间对话后 context 占比过高、但不想丢失关键信息的场景。
	 *
	 * 注意：pi 在压缩完成后可能会自动重启进程（尤其早期版本），此时 RPC 请求会因
	 * "pi exited" 错误而失败。本方法检测到进程退出后会自动重连同一会话并加载消息，
	 * 因此调用方不应把 RPC 失败等同于压缩失败。
	 */
	async compact(agentId: string, prompt?: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmedPrompt = prompt?.trim();
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Compact requested", {
			agentId,
			prompt: trimmedPrompt,
			hasSessionPath: !!runtime.tab.sessionPath,
		});

		// 已有压缩在进行（手动请求未返回 / pi 自动压缩中）：拒绝重复请求。
		// 渲染层按钮在 isCompacting 时禁用，这里是双保险。旧实现 return 成功状态，
		// 用户连点会当成「压缩完成」或完全没反应；改为明确错误，UI 映射 inProgress。
		if (this.compactingAgents.has(agentId) || this.rpcCompactingAgents.has(agentId)) {
			void this.appLogger?.info("agent", "Compact skipped: already compacting", {
				agentId,
			});
			throw new Error("already compacting");
		}

		// 标记压缩中，退出处理器据此区分压缩重启与异常崩溃
		this.compactingAgents.add(agentId);
		// 立即推送 isCompacting=true（getRuntimeState 合并 compactingAgents 集合）：
		// 让圆环按钮进入禁用/进度态，避免用户重复点击触发第二个 compact。
		// 此前 add 后无推送，isCompacting 要等 pi 的 compaction_start 事件才到渲染层。
		void this.emitRuntimeState(agentId);

		try {
			const response = await runtime.process.client.request(
				createCompactRpcRequest(trimmedPrompt),
				120_000,
			);
			void this.appLogger?.info("agent", "Compact RPC response received", {
				agentId,
				elapsedMs: Date.now() - startTime,
				rpcSuccess: response.success,
				rpcError: response.error,
			});

			// success:false 必须抛给上层：渲染层靠错误文案映射 nothing-to-do / too-small
			// 友好 toast。之前只 warn 不抛，导致「暂无可压缩内容」永远到不了 UI（#113 3.2-7）。
			if (!response.success) {
				const rpcError = response.error?.trim() || "compact failed";
				void this.appLogger?.warn("agent", "Compact RPC returned failure", {
					agentId,
					error: rpcError,
				});
				this.compactingAgents.delete(agentId);
				throw new Error(rpcError);
			}

			this.compactingAgents.delete(agentId);
			// 压缩成功且进程未退出，直接加载消息（压缩期间乐观/流式消息不能丢：保护到重载完成）
			await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
			void this.appLogger?.info("agent", "Compact completed successfully", {
				agentId,
				totalElapsedMs: Date.now() - startTime,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const processAlive = runtime.process.isRunning();
			void this.appLogger?.error("agent", "Compact failed", {
				agentId,
				elapsedMs: Date.now() - startTime,
				error: errorMsg,
				processAlive,
				hasSessionPath: !!runtime.tab.sessionPath,
			});

			this.compactingAgents.delete(agentId);

			// 如果进程在压缩期间退出（pi 压缩后自动重启进程的行为），
			// RPC 请求会因连接断开而失败，但压缩实际已完成。
			// 尝试重连同一会话，不从 compact() 层面抛出错误。
			if (!processAlive && runtime.tab.sessionPath) {
				void this.appLogger?.info("agent", "Compact: process exited, reattaching", {
					agentId,
				});
				await this.reattachProcess(agentId, runtime.tab.sessionPath);
				runtime.tab.status = "idle";
				await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
				this.addLocalizedMessage(
					agentId,
					"system",
					"diagnostic.compactDone",
					"会话压缩完成",
				);
				this.emitState();
				void this.appLogger?.info("agent", "Compact: reattach succeeded", {
					agentId,
					totalElapsedMs: Date.now() - startTime,
				});
			} else {
				// 非退出相关的 RPC 错误，正常抛出
				throw error;
			}
		}

		return this.getRuntimeState(agentId);
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

		void this.appLogger?.info("agent", "Reattaching process", {
			agentId,
			sessionPath,
		});

		const handshake = await this.handshakePiProcess(agentId, {
			projectPath: project.path,
			sessionPath,
			deckSessionId: runtime.tab.deckSessionId,
			onExit: (payload) => this.handleReattachProcessExit(agentId, runtime, payload),
		});
		const process = handshake.process;
		const restartDiag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process restarted", {
			agentId,
			command: restartDiag?.command,
			args: restartDiag?.args?.join(' '),
			cwd: restartDiag?.cwd,
			fallbackFromExtensions: handshake.fallbackFromExtensions,
		});

		try {
			const stateResponse = handshake.state;
			const data = stateResponse.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			runtime.tab.sessionPath = this.normalizeSessionPathFromPi(
				data?.sessionFile ?? sessionPath,
				project.path,
				runtime.tab.sessionEnvironment ?? "native",
			);
			// 重启后 get_state 的 sessionName 来自磁盘最新 session_info；tab 可能先沿用 catalog 旧标题，
			// 因此需要强制通知 catalog，确保 pi-tui 外部改名在“重启 Session”路径也能同步。
			this.applyRuntimeTitle(agentId, data?.sessionName ?? runtime.tab.title, false, true);
			runtime.tab.status = "idle";
			// 进程退出型压缩可能来不及发 compaction_end；重连成功即表示 Pi 已可继续接收消息。
			this.rpcCompactingAgents.delete(agentId);

			// 重连成功后清除自动重连标记，允许下一次再触发
			this.autoRestartAttempted.delete(agentId);

			// 如果有旧的 pending abort 标记，清理掉
			this.abortedDuringAsk.delete(agentId);

			// 重连期间用户可能已发送消息（乐观上屏）：必须保护，否则替换投影时未落盘消息丢失
			await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
			if (handshake.fallbackFromExtensions) {
				this.notifyExtensionFallback(agentId, handshake.fallbackDebug);
			}

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

	/**
	 * 会话缓存命中率读取器：按 (size, mtimeMs) 缓存文件解析结果，
	 * 会话文件未变化时 O(1) 复用，避免高频 getRuntimeState 反复读文件+逐行 parse。
	 */
	private readonly cacheHitStatsReader: CacheHitStatsReader = createCacheHitStatsReader({
		readFile: (path) => readFile(path, "utf8"),
		stat,
	});

	/**
	 * 读取 session 文件，统计缓存命中率：最后一条 assistant 消息（latest）与
	 * 全部 assistant 消息的平均值（average，即「当前会话平均缓存率」）。
	 * 口径与 pi CLI footer 的 latestCacheHitRate 一致：
	 * cacheRead / (input + cacheRead + cacheWrite) * 100
	 */
	private getSessionCacheHitStats(sessionPath: string): Promise<CacheHitStats> {
		return this.cacheHitStatsReader(this.toSessionHostPath(sessionPath));
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		// 文件统计（读会话 + 逐行 parse）与两个 RPC 并行：总耗时 = max(RPC, 文件)，
		// 且文件结果带 (size, mtimeMs) 缓存，会话未变化时零 IO 零 parse
		const [stateResponse, statsResponse, fileHitStats] = await Promise.all([
			runtime.process.client
				.request({ type: "get_state" }, this.rpcTimeoutMs)
				.catch(() => ({ data: undefined })),
			runtime.process.client
				.request({ type: "get_session_stats" })
				.catch(() => ({ data: undefined })),
			runtime.tab.sessionPath
				? this.getSessionCacheHitStats(runtime.tab.sessionPath)
				: Promise.resolve({
					latest: undefined as number | undefined,
					average: undefined as number | undefined,
					sampleCount: 0,
					messageChars: undefined as number | undefined,
				}),
		]);
		const state = stateResponse.data as any;
		const stats = statsResponse.data as any;
		const model = state?.model;
		const tokens = stats?.tokens;
		const inputTokens = pickNumber(
			tokens?.input,
			tokens?.inputTokens,
			tokens?.prompt,
			tokens?.promptTokens,
			stats?.inputTokens,
			stats?.usage?.input,
		);
		const outputTokens = pickNumber(
			tokens?.output,
			tokens?.outputTokens,
			tokens?.completion,
			tokens?.completionTokens,
			stats?.outputTokens,
			stats?.usage?.output,
		);
		const cacheRead = pickNumber(
			tokens?.cacheRead,
			tokens?.cache?.read,
			stats?.cacheRead,
			stats?.usage?.cacheRead,
		);
		const cacheWrite = pickNumber(
			tokens?.cacheWrite,
			tokens?.cache?.write,
			stats?.cacheWrite,
			stats?.usage?.cacheWrite,
		);
		const directCacheHitPercent = pickNumber(
			tokens?.cacheHitPercent,
			tokens?.cacheHitRate != null ? tokens.cacheHitRate * 100 : undefined,
			stats?.cacheHitPercent,
			stats?.cacheHitRate != null ? stats.cacheHitRate * 100 : undefined,
		);
	/**
	 * 使用最新一条 assistant 消息的缓存命中率，与 pi CLI footer 保持一致。
	 * pi 的 get_session_stats RPC 不直接返回 cacheHitPercent，需读取 session 文件。
	 * 同时统计全部 assistant 消息的平均命中率（当前会话平均缓存率）。
	 */
	const cacheHitPercent = clampPercent(
		directCacheHitPercent ?? fileHitStats.latest,
	);
	const cacheHitAveragePercent = clampPercent(fileHitStats.average);
	const perf = this.lastPerfByAgent.get(agentId);
	return {
		modelName: model?.name ?? model?.id,
		provider: model?.provider,
		modelId: model?.id,
		thinkingLevel: state?.thinkingLevel,
		isStreaming: state?.isStreaming || this.streamingAgents.has(agentId),
		...(this.agentTurnActiveById.has(agentId)
			? { isTurnActive: this.agentTurnActiveById.get(agentId) }
			: {}),
		isCompacting:
			state?.isCompacting ||
			this.rpcCompactingAgents.has(agentId) ||
			this.compactingAgents.has(agentId),
		/** 工具执行状态从本地追踪，无需 Pi 进程查询 */
		isExecutingTool: !!(this.toolExecutingByAgent.get(agentId)),
		executingToolName: this.toolExecutingByAgent.get(agentId) ?? undefined,
		toolStateSequence: this.toolStateSequenceByAgent.get(agentId) ?? 0,
		contextTokens: stats?.contextUsage?.tokens,
		contextWindow: stats?.contextUsage?.contextWindow ?? model?.contextWindow,
		contextPercent: stats?.contextUsage?.percent,
		/** 对话消息估算 token：消息字符 ÷ 4（1 token ≈ 4 chars），缺文件数据时不报 */
		contextMessageTokens:
			fileHitStats.messageChars != null
				? Math.round(fileHitStats.messageChars / 4)
				: undefined,
		inputTokens,
		outputTokens,
		cacheRead,
		cacheWrite,
		cacheTotal:
			cacheRead != null || cacheWrite != null
				? (cacheRead ?? 0) + (cacheWrite ?? 0)
				: undefined,
		cacheHitPercent,
		cacheHitAveragePercent,
		cacheHitSampleCount: fileHitStats.sampleCount,
		cost: stats?.cost,
		// 最近一次回复性能指标：本地结算缓存（不经 RPC），会话切换/轮询时保持可用
		ttftMs: perf?.ttftMs,
		totalMs: perf?.totalMs,
		tps: perf?.tps,
		perfAt: perf?.at,
	};
	}

	private applyActiveToolCallState(agentId: string, state: ActiveToolCallState) {
		if (state.calls.size > 0) {
			this.activeToolCallsByAgent.set(agentId, state.calls);
			this.toolExecutingByAgent.set(agentId, state.executingToolName ?? "tool");
			this.emitToolRuntimeTransition(
				agentId,
				true,
				state.executingToolName ?? "tool",
			);
			return;
		}
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.set(agentId, null);
		this.emitToolRuntimeTransition(agentId, false);
	}

	private emitToolRuntimeTransition(
		agentId: string,
		isExecutingTool: boolean,
		executingToolName?: string,
	) {
		const toolStateSequence = (this.toolStateSequenceByAgent.get(agentId) ?? 0) + 1;
		this.toolStateSequenceByAgent.set(agentId, toolStateSequence);
		// 工具边沿直接从原始 pi 事件发出，不等待 get_state/get_session_stats。
		// 这样即使工具极快完成或完整状态请求乱序，renderer 仍能稳定看到 true → false。
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: {
				isExecutingTool,
				executingToolName,
				toolStateSequence,
			},
		});
	}

	private async emitRuntimeState(agentId: string) {
		try {
			const state = await this.getRuntimeState(agentId);
			const latestToolSequence = this.toolStateSequenceByAgent.get(agentId) ?? 0;
			// getRuntimeState 包含异步 RPC；若期间发生新工具事件，只覆盖非工具字段，
			// 工具字段保留调用完成时的最新本地真值和序号。
			state.isExecutingTool = !!this.toolExecutingByAgent.get(agentId);
			state.executingToolName = this.toolExecutingByAgent.get(agentId) ?? undefined;
			state.toolStateSequence = latestToolSequence;
			this.emit(ipcChannels.agentsRuntimeState, { agentId, state });
		} catch {
			// 运行态刷新失败不影响主流程；下一次轮询或事件会继续同步。
		}
	}

	/**
	 * 主动推送一次完整 runtime state（get_state + 最新工具状态补丁）给渲染层。
	 *
	 * 懒启动/重启链路的 applyPreferences（setModel/setThinking）之后调用：
	 * setModel 内部只 emitState（AgentTab 无 state 字段），若不额外推送，
	 * 渲染层底栏会停留在旧绑定残留的 state 或仅 record 回退，看不到应用后的真实模型。
	 */
	async publishRuntimeState(agentId: string): Promise<void> {
		await this.emitRuntimeState(agentId);
	}

	async cycleModel(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request({ type: "cycle_model" }, 60_000);
		return this.getRuntimeState(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "get_available_models" },
			60_000,
		);
		return ((response.data as any)?.models ?? []) as AvailableModel[];
	}

	/**
	 * Ask the running Pi process for levels supported by its current model.
	 * TODO(remove-compat): once PiDeck's minimum Pi version is >= 0.81 and the
	 * migration window is over, make an unavailable RPC a hard error instead of
	 * falling back to the renderer's legacy static list.
	 */
	async getAvailableThinkingLevels(agentId: string): Promise<string[] | undefined> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "get_available_thinking_levels" },
			60_000,
		);
		return parseAvailableThinkingLevelsResponse(response);
	}

	async setModel(agentId: string, provider: string, modelId: string) {
		const runtime = this.requireRuntime(agentId);
		// Pi RPC 没有运行中 busy 门禁：set_model 立即更新 Agent state；已经发出的
		// provider request 不可改写，后续同一 turn step/下一次 request 会读取新模型。
		const response = await runtime.process.client.request(
			{ type: "set_model", provider, modelId },
			60_000,
		);
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
				const [localHasModel, catalogHasModel] = await Promise.all([
					this.localModelsContains(provider, modelId),
					this.resolveModelInCatalog?.(provider, modelId) ?? Promise.resolve(false),
				]);
				if (localHasModel || catalogHasModel) {
					const err = new Error(errorText) as Error & { needsRestart?: boolean };
					err.needsRestart = true;
					throw err;
				}
			}
			throw new Error(errorText || "set_model failed");
		}
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	/** 本地 models.json 是否包含指定 provider/modelId。 */
	private async localModelsContains(provider: string, modelId: string): Promise<boolean> {
		try {
			const result = await this.configManager.getModelsConfig();
			const config = result.parsed;
			return Boolean(
				config?.providers?.[provider]?.models?.some((model) => model.id === modelId),
			);
		} catch {
			return false;
		}
	}

	/**
	 * 刷新模型配置：让运行中的 agent 重新加载 models.json，无需完全重启。
	 *
	 * 当前仅支持轻量级 reload_config RPC（策略 1）。
	 * 策略 2（进程重启）已注释，等待 pi 官方支持 reload_config RPC 后再考虑：
	 *   - 运行中的 Agent 重启进程会打断正在进行的对话/工具执行
	 *   - 进程重启涉及 exit 事件竞态、模型恢复等复杂边界条件
	 *
	 * RPC 提案：https://github.com/earendil-works/pi/issues/6890
	 * pi 合并 reload_config 后，本方法将自动生效，无需任何修改。
	 */
	async refreshModels(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Model refresh requested", { agentId });

		// 策略 1：尝试 reload_config RPC（轻量级，无需重启进程）
		// 该命令在 pi model-runtime 中已实现为 reloadConfig()，会重新读取 models.json
		// 并重建所有 provider。当前 pi 0.80.10 的 RPC 协议尚未暴露此命令，
		// 待 pi 合并 https://github.com/earendil-works/pi/issues/6890 后自动生效。
		try {
			const response = await runtime.process.client.request(
				{ type: "reload_config" },
				8_000,
			);
			if (response.success) {
				await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
				void this.appLogger?.info("agent", "Model refresh succeeded via reload_config RPC", {
					agentId,
					elapsedMs: Date.now() - startTime,
				});
				this.emitState();
				return this.getRuntimeState(agentId);
			}
		} catch {
			// reload_config 尚不支持，当前 pi 版本无轻量级刷新路径
		}

		// 策略 2（已注释）：进程重启方案。
		// 原因：运行中重启会打断用户对话、工具执行，且涉及 exit 事件竞态。
		// 等 pi 官方支持 reload_config RPC 后，策略 1 自动生效，无需回退到策略 2。
		//
		// const sessionPath = runtime.tab.sessionPath;
		// if (!sessionPath) {
		// 	throw new Error("Cannot refresh models: agent has no session path");
		// }
		// this.modelRefreshingAgents.add(agentId);
		// try {
		// 	const previousState = await this.getRuntimeState(agentId).catch(() => null);
		// 	runtime.process.stop();
		// 	await new Promise<void>((resolve) => setTimeout(resolve, 600));
		// 	await this.reattachProcess(agentId, sessionPath);
		// 	if (previousState?.provider && previousState?.modelId) {
		// 		try { await this.setModel(agentId, previousState.provider, previousState.modelId); } catch {}
		// 	}
		// 	runtime.tab.status = "idle";
		// 	await this.loadMessages(agentId).catch(() => undefined);
		// } finally {
		// 	this.modelRefreshingAgents.delete(agentId);
		// }

		void this.appLogger?.info("agent", "Model refresh: reload_config not supported by current pi version, skipping", {
			agentId,
			elapsedMs: Date.now() - startTime,
		});
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	async cycleThinking(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "cycle_thinking_level" },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	async setThinking(agentId: string, level: string) {
		const runtime = this.requireRuntime(agentId);
		// 与 set_model 相同：Pi 允许运行中更新 state，具体 request 是否已经发出
		// 由 Agent 自己决定；PiDeck 不把它预先降级成下一轮 pending。
		await runtime.process.client.request(
			{ type: "set_thinking_level", level },
			60_000,
		);
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	/** Build one physical/logical file reference for the isolated JSONL transaction. */
	private createSessionFileRef(runtime: AgentRuntime, sessionPath: string): SessionFileRef {
		const environment = runtime.tab.sessionEnvironment ??
			(this.wslEnvironment ? "wsl" : "native");
		return {
			protocolPath: this.toSessionProtocolPath(sessionPath),
			hostPath: this.toSessionHostPath(sessionPath),
			environment,
			wslDistro: runtime.tab.wslDistro ?? (
				environment === "wsl" ? this.wslEnvironment?.distro : undefined
			),
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
	private async getActiveSessionLeafId(
		agentId: string,
		runtime: AgentRuntime,
	): Promise<string | undefined> {
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
			const response = await runtime.process.client.request(
				{ type: "get_entries" },
				15_000,
			);
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

	private createSessionEntryTarget(
		message: ChatMessage,
		activeLeafId?: string,
	): SessionEntryTarget {
		if (message.role !== "user" && message.role !== "assistant") {
			throw new Error("SESSION_ENTRY_ROLE_INVALID");
		}
		const entryId = typeof message.meta?.entryId === "string"
			? message.meta.entryId
			: undefined;
		return {
			entryId,
			legacyMessageId: message.id,
			legacyAgentId: message.agentId,
			role: message.role,
			text: message.text,
			activeLeafId,
		};
	}

	private async requestSessionReload(
		runtime: AgentRuntime,
		file: SessionFileRef,
	): Promise<void> {
		const response = await runtime.process.client.request({
			type: "switch_session",
			sessionPath: file.protocolPath,
		}, 30_000);
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
	private async locateMessageTarget(
		agentId: string,
		sessionPath: string,
		messageId: string,
		activeLeafId?: string,
	): Promise<{ target: SessionEntryTarget; resend?: { text: string; images?: ImageContent[] } }> {
		const cached = this.messages.get(agentId) ?? [];
		const message = cached.find((candidate) => candidate.id === messageId)
			?? cached.find((candidate) => candidate.meta?.requestId === messageId);
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
	private removeUnpersistedRuntimeTurn(
		agentId: string,
		messageId: string,
		target: SessionEntryTarget,
		error: unknown,
	): boolean {
		if (!this.isSessionEntryMissing(error)) return false;
		if (typeof target.entryId === "string" && target.entryId.trim()) return false;
		const list = this.messages.get(agentId);
		if (!list?.length) return false;
		const index = list.findIndex((candidate) => (
			candidate.id === messageId
			|| candidate.meta?.requestId === messageId
			|| (candidate.role === target.role && candidate.text === target.text)
		));
		if (index < 0) return false;
		const next = list.slice(0, index);
		this.messages.set(agentId, next);
		this.scheduleMessageEmit(agentId, true);
		return true;
	}

	private isSessionEntryMissing(error: unknown): boolean {
		// 按 code / 文案识别，不依赖 instanceof：部分测试夹具只注入 editor 方法，没有真实 Error 子类。
		const code = error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";
		if (code === "SESSION_ENTRY_NOT_FOUND") return true;
		const message = error instanceof Error ? error.message : String(error);
		const lower = message.toLowerCase();
		return lower.includes("message not found")
			|| lower.includes("not found on the active session branch");
	}

	async prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }> {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
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
		return resend ?? {
			text: cached?.text ?? "",
			...(cached?.images?.length ? { images: cached.images } : {}),
		};
	}

	async reload(agentId: string) {
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
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
		operation: "edit" | "delete" | "resend",
		options?: {
			newText?: string;
			environment?: SessionEnvironment;
			wslDistro?: string;
			/** 渲染层消息携带的文件条目 id（meta.entryId）：live randomUUID 无法在文件里定位，
			 * 必须用该锚点（见 SessionHistoryReader.readMessageByMessageId）。 */
			entryId?: string;
		},
	): Promise<{ text: string; images?: ImageContent[] } | undefined> {
		const hostPath = this.toSessionHostPath(sessionPath);
		const live = [...this.agents.values()].find(
			(candidate) => candidate.tab.sessionPath &&
				this.toSessionHostPath(candidate.tab.sessionPath) === hostPath,
		);
		// 边界防御：协调器已要求先停；这里再拦一次，避免漏调 stop 时静默写文件。
		if (live && live.tab.status !== "closed" && live.tab.status !== "error") {
			throw new Error("BUSY_GENERIC: Stop the running agent before mutating the session file");
		}
		const environment = options?.environment === "wsl" || this.wslEnvironment
			? "wsl" as const
			: "native" as const;
		const file: SessionFileRef = {
			protocolPath: this.toSessionProtocolPath(sessionPath),
			hostPath,
			environment,
			wslDistro: options?.wslDistro ?? (environment === "wsl" ? this.wslEnvironment?.distro : undefined),
		};
		const activeLeafId = await this.sessionHistoryReader.getActiveLeafId(sessionPath).catch(() => undefined);
		const located = await this.sessionHistoryReader.readMessageByMessageId(
			sessionPath,
			messageId,
			options?.entryId,
		);
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
		if (operation === "resend" && role !== "user") {
			throw new Error("Only user messages can be resent");
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

	async appendLocalMessagesToSession(
		sessionPath: string,
		entries: import("./SessionFileEditor").AppendMessageEntry[],
	): Promise<void> {
		if (entries.length === 0) return;
		const hostPath = this.toSessionHostPath(sessionPath);
		const runtime = [...this.agents.values()].find(
			(candidate) => candidate.tab.sessionPath &&
				this.toSessionHostPath(candidate.tab.sessionPath) === hostPath,
		);
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
	 * （stop 后由退出处理器消费删除）、modelRefreshingAgents（refresh 流程跨 stop 存活）、
	 * pendingTrustRequests（启动流程 await 中，删键会挂死 create）、
	 * compactingAgents（compact 的 catch 靠它决定重连）。
	 */
	private clearAgentState(agentId: string) {
		this.streamingThinking.delete(agentId);
		this.thinkingSegmentByAgent.delete(agentId);
		this.streamingAgents.delete(agentId);
		this.activeAssistantMessageIds.delete(agentId);
		this.toolMessageIds.delete(agentId);
		this.retryStatusMessageIds.delete(agentId);
		this.streamingText.delete(agentId);
		// 流式 delta 基准随生命周期清理（emitTextStreamNow 的 done 路径已自清，
		// 这里兜底 stop/restart/closed 等非 done 终止路径，防键残留慢泄漏）
		this.lastSentTextByAgent.delete(agentId);
		this.textPushCountByAgent.delete(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		this.rpcCompactingAgents.delete(agentId);
		this.agentTurnActiveById.delete(agentId);
		this.autoRestartAttempted.delete(agentId);
		this.messagePerfByAgent.delete(agentId);
		this.lastPerfByAgent.delete(agentId);
		this.notifiedAskAgents.delete(agentId);
		this.abortedDuringAsk.delete(agentId);
		this.pendingUIRequests.delete(agentId);
		this.startupHandshakeAgents.delete(agentId);
		// 启动期诊断与首 run 标记随生命周期清理：重启/关闭后新 runtime 重新队列
		this.pendingStartupDiagnostics.delete(agentId);
		this.agentStartedFirstRun.delete(agentId);
		this.clearStreamGate(agentId);
		// 工具完整结果缓存是运行期性能优化（回退读文件等价），agent 停止时整体释放
		this.toolFullTextByMessageId.clear();
	}

	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
		void this.appLogger?.info("agent", "Agent restart requested", {
			agentId,
			projectId: runtime.tab.projectId,
			sessionPath: runtime.tab.sessionPath,
		});
		const {
			projectId,
			title,
			sessionEnvironment: environment,
			sessionSource: source,
			wslDistro,
			wslUser,
			importedSourceId,
			noSession,
		} = runtime.tab;

		// 优先从 pi 获取最新 sessionFile，兜底用 tab 上缓存的值；
		// 避免首次创建时未指定 session 路径、restart 后丢失历史的情况。
		let sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) {
			try {
				const state = await runtime.process.client.request({
					type: "get_state",
				}, this.rpcTimeoutMs);
				sessionPath = this.normalizeSessionPathFromPi(
					(state.data as { sessionFile?: string } | undefined)?.sessionFile ??
						undefined,
					this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd,
					environment ?? "native",
				);
			} catch {
				// 获取失败时继续用 undefined，create 会启动新 session
			}
		}

		// 停止旧进程并清理状态
		runtime.process.stop();
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.messageDirtyFromByAgent.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		this.pendingSlideOutByAgent.delete(agentId);
		this.displayWindowStartByAgent.delete(agentId);
		this.displayWindowComputedLengthByAgent.delete(agentId);
		this.clearAgentState(agentId);
		this.emitState();

		// 用相同的 session 重新创建 agent，新进程会重新加载所有配置
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
		});
	}

	async exportHtml(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "export_html" },
			120_000,
		);
		return response.data;
	}

	/**
	 * 对未打开的历史会话执行官方 RPC 导出。
	 * 使用临时 pi 进程可以复用官方 export_html 样式，同时不切换当前桌面 Agent。
	 */
	async exportSessionHtml(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request(
				{ type: "export_html" },
				120_000,
			);
			return response.data;
		});
	}

	/**
	 * 对未打开的历史会话执行官方 clone。
	 * clone 会复制 active branch 到新 session；随后读取 get_state 拿到新 sessionFile 供历史列表刷新。
	 */
	async cloneSessionFile(
		projectId: string,
		sessionPath: string,
		environment: SessionEnvironment = "native",
	) {
		const project = this.getProject(projectId);
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request({ type: "clone" }, 120_000);
			const state = await process.client.request({ type: "get_state" }, this.rpcTimeoutMs);
			return {
				...((response.data as object | undefined) ?? {}),
				sessionPath: this.normalizeSessionPathFromPi(
					(state.data as { sessionFile?: string } | undefined)?.sessionFile,
					project?.path ?? "",
					environment,
				),
			};
		});
	}

	private async withTemporarySession<T>(
		projectId: string,
		sessionPath: string,
		run: (process: PiProcess) => Promise<T>,
	): Promise<T> {
		const project = this.getProject(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const process = this.createPiProcess(project.path, sessionPath);
		await process.start(sessionPath);
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
		return (
			(response.data as { messages?: ForkMessage[] } | undefined)?.messages ?? []
		);
	}

	async forkSession(agentId: string, entryId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "fork", entryId },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async cloneSession(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "clone" }, 120_000);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async switchSession(agentId: string, sessionPath: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "switch_session", sessionPath: this.toSessionProtocolPath(sessionPath) },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	private async refreshRuntimeAfterSessionReplacement(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const stateResponse = await runtime.process.client
			.request({ type: "get_state" }, this.rpcTimeoutMs)
			.catch(() => ({ data: undefined }));
		const state = stateResponse.data as { sessionFile?: string; sessionName?: string } | undefined;
		if (state?.sessionFile) {
			runtime.tab.sessionPath = this.normalizeSessionPathFromPi(
				state.sessionFile,
				this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd,
				runtime.tab.sessionEnvironment ?? "native",
			) ?? runtime.tab.sessionPath;
		}
		if (state?.sessionName) this.applyRuntimeTitle(agentId, state.sessionName, false, true);
		// 重新附加后恢复：保留附加期间用户发送/流式中的消息，避免投影替换吞掉乐观消息
		await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
		this.emitState();
	}

	async getCommands(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_commands",
		});
		return (
			(response.data as { commands?: unknown[] } | undefined)?.commands ?? []
		);
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
	async listCheckpoints(
		agentId: string,
		params?: RewindCheckpointPageParams,
	): Promise<RewindCheckpointPage> {
		const runtime = this.requireRuntime(agentId);
		const checkpoints = await loadAllCheckpoints(
			runtime.tab.cwd,
			runtime.tab.sessionId,
		);
		const all = checkpoints
			.map(toCheckpointSummary)
			.sort((a, b) => b.timestamp - a.timestamp);
		// 渲染层入参不可信：limit 钳制在 [1, 100]，beforeTimestamp 非有限数按未传处理。
		const limit = Math.min(
			Math.max(1, Math.floor(params?.limit ?? 10)),
			100,
		);
		const before = Number.isFinite(params?.beforeTimestamp)
			? (params!.beforeTimestamp as number)
			: Number.POSITIVE_INFINITY;
		const filtered = all.filter((cp) => cp.timestamp < before);
		// 未传 limit（如 rewind-to-message 需要全量最近检查点）时返回全部；
		// 否则按 limit 截取一页，并据此判断是否还有更早的检查点。
		if (params?.limit === undefined) {
			return { items: filtered, hasMore: false };
		}
		return {
			items: filtered.slice(0, limit),
			hasMore: filtered.length > limit,
		};
	}

	/** checkpoint 与当前 index 树的 diff 摘要（回退预览：「回到这里会改哪些文件」）。 */
	async getCheckpointDiff(agentId: string, checkpointId: string): Promise<string> {
		const runtime = this.requireRuntime(agentId);
		const root = runtime.tab.cwd;
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
	async restoreCheckpoint(
		agentId: string,
		checkpointId: string,
		scope: RewindRestoreScope,
	): Promise<RewindRestoreResult> {
		const runtime = this.requireRuntime(agentId);
		const cp = await loadCheckpointFromRef(runtime.tab.cwd, checkpointId);
		if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`);

		const wantFiles = scope === "files" || scope === "all";
		const wantConversation = scope === "conversation" || scope === "all";
		// 会话回退先解析 fork 锚点（失败则整体拒绝，避免「文件已回退但会话没 fork」的半成功态）。
		const forkEntryId = wantConversation
			? await this.resolveForkEntryBeforeCheckpoint(agentId, cp.timestamp)
			: undefined;
		if (wantFiles) await applyCheckpointRestore(runtime.tab.cwd, cp);
		let forkedSessionId: string | undefined;
		if (wantConversation && forkEntryId) {
			const data = (await this.forkSession(agentId, forkEntryId)) as
				| { targetSessionId?: string; [key: string]: unknown }
				| undefined;
			forkedSessionId = data?.targetSessionId;
		}
		return { filesRestored: wantFiles, forkedSessionId };
	}

	/**
	 * 找检查点时刻前最近的、带 entryId 的消息作为会话回退的 fork 锚点。
	 * live 消息（本轮未 settle）没有 entryId，回退到最近一条已落盘消息是合理近似：
	 * 即「该检查点之后的对话内容从 fork 会话里去掉」。
	 */
	private async resolveForkEntryBeforeCheckpoint(
		agentId: string,
		beforeTimestamp: number,
	): Promise<string | undefined> {
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

	/** agent_start 时推进回合计数，返回本轮 turnIndex（供自动打点用）。 */
	private bumpRewindTurn(agentId: string): number {
		const next = (this.rewindTurnCounters.get(agentId) ?? 0) + 1;
		this.rewindTurnCounters.set(agentId, next);
		return next;
	}

	/**
	 * 文件类工具（write/edit/bash）执行结束后异步创建文件检查点（fire-and-forget）。
	 * 打点放在 tool_execution_end：此时文件系统已静默，快照内容稳定，不会与进行中的
	 * 写入竞争；恢复语义为「回到该工具执行完成后的状态」。失败不影响 agent 主链路
	 * （纯旁路快照），只记日志。
	 */
	private scheduleRewindCheckpoint(agentId: string, toolName: string, turnIndex: number): void {
		const runtime = this.agents.get(agentId);
		const root = runtime?.tab.cwd;
		const sessionId = runtime?.tab.sessionId;
		if (!root || !sessionId) return;
		void createCheckpoint({
			root,
			// id 拼进 git ref 名，必须是 isRewindCheckpointId 允许的安全字符。
			id: `tool-${sessionId}-${turnIndex}-${Date.now()}`,
			sessionId,
			trigger: "tool",
			turnIndex,
			toolName,
		}).catch((error: unknown) => {
			this.appLogger?.warn("rewind", "checkpoint creation failed", {
				agentId,
				toolName,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private async promptMatchesRegisteredExtensionCommand(runtime: AgentRuntime, message: string): Promise<boolean> {
		const trimmed = message.trim();
		if (!trimmed.startsWith("/")) return false;

		const commandName = trimmed.slice(1).split(/\s+/, 1)[0];
		if (!commandName) return false;

		const response = await runtime.process.client
			.request({ type: "get_commands" }, 10_000)
			.catch(() => undefined);
		const commands = (response?.data as { commands?: unknown[] } | undefined)?.commands ?? [];
		return commands.some((command) => {
			if (!command || typeof command !== "object") return false;
			const typed = command as { name?: unknown; source?: unknown };
			return typed.name === commandName && typed.source === "extension";
		});
	}

	/**
	 * 聚合待广播的实时日志条目，节流刷出（见 LIVE_RPC_LOG_FLUSH_MS）。
	 * 批量推送既能降低 IPC 次数，也让渲染层一次 state 更新收到多条，减少重渲染频率。
	 */
	private enqueueLiveRpcLog(entry: RpcLogEntry) {
		let pending = this.pendingLiveRpcLogs.get(entry.agentId);
		if (!pending) {
			pending = [];
			this.pendingLiveRpcLogs.set(entry.agentId, pending);
		}
		if (pending.length >= AgentManager.LIVE_RPC_LOG_MAX_PENDING) {
			// 极端高频下丢弃最旧，保证聚合缓冲有界
			pending.splice(0, pending.length - AgentManager.LIVE_RPC_LOG_MAX_PENDING + 1);
		}
		pending.push(entry);
		if (this.liveRpcLogFlushTimer === null) {
			this.liveRpcLogFlushTimer = setTimeout(() => {
				this.liveRpcLogFlushTimer = null;
				this.flushLiveRpcLogs();
			}, AgentManager.LIVE_RPC_LOG_FLUSH_MS);
		}
	}

	/** 把聚合缓冲按 agent 拆分后批量广播；单次批次超限的条目留到下一轮，不丢日志 */
	private flushLiveRpcLogs() {
		if (this.pendingLiveRpcLogs.size === 0) return;
		for (const [agentId, entries] of [...this.pendingLiveRpcLogs]) {
			const batch = entries.slice(0, AgentManager.LIVE_RPC_LOG_MAX_BATCH);
			if (batch.length > 0) {
				this.emit(ipcChannels.agentsRpcLog, { agentId, entries: batch } satisfies RpcLogBatch);
			}
			const rest = entries.slice(AgentManager.LIVE_RPC_LOG_MAX_BATCH);
			if (rest.length > 0) {
				this.pendingLiveRpcLogs.set(agentId, rest);
			} else {
				this.pendingLiveRpcLogs.delete(agentId);
			}
		}
	}

	/** 清空某 agent 的实时日志聚合缓冲（agent 关闭时调用，防止残留数据泄漏） */
	private dropPendingLiveRpcLogs(agentId: string) {
		this.pendingLiveRpcLogs.delete(agentId);
	}

	/** 设置某 agent 的 RPC 日志记录开关 */
	setRpcLogging(agentId: string, enabled: boolean) {
		if (enabled) {
			this.rpcLoggingAgents.add(agentId);
		} else {
			this.rpcLoggingAgents.delete(agentId);
		}
	}

	/** 查询某 agent 是否开启了 RPC 日志记录 */
	isRpcLogging(agentId: string): boolean {
		return this.rpcLoggingAgents.has(agentId);
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
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.messageDirtyFromByAgent.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		this.pendingSlideOutByAgent.delete(agentId);
		this.clearStreamGate(agentId);
		// agent 关闭时自动关闭 RPC 日志记录，并丢弃未广播的实时日志缓冲
		this.rpcLoggingAgents.delete(agentId);
		this.dropPendingLiveRpcLogs(agentId);
		this.displayWindowStartByAgent.delete(agentId);
		this.displayWindowComputedLengthByAgent.delete(agentId);
		this.sessionFileVersionByAgent.delete(agentId);
		this.clearAgentState(agentId);
		process.stop();
		this.emitState();
	}

	/** 注册本地事件监听器（供 FeishuBridge 等主进程内部模块使用） */
	addLocalEventListener(listener: (agentId: string, event: unknown) => void): () => void {
		this.localEventListeners.add(listener);
		return () => { this.localEventListeners.delete(listener); };
	}

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	/** 注册状态变更监听器（供 PetStateBridge 等主进程内部模块使用）；每次 emitState 后同步回调最新 AgentTab[] */
	addStateListener(listener: (tabs: AgentTab[]) => void): () => void {
		this.stateListeners.add(listener);
		return () => { this.stateListeners.delete(listener); };
	}

	/**
	 * 注册「Agent 成功空闲」监听器（供 PetStateBridge 等主进程内部模块使用）。
	 * 仅在 agent_settled 成功路径或 get_state 兜底确认无工作后触发，
	 * abort / 自动重试 / 压缩 / agent_end 都不会触发 —— 这些都不是可靠的完成点。
	 */
	onAgentSettled(listener: (info: { agentId: string; title: string }) => void): () => void {
		this.settledListeners.add(listener);
		return () => { this.settledListeners.delete(listener); };
	}

	/** 装配层注入：运行时标题变化时写回 catalog（DSH 的 onTitleChanged 同语义）。 */
	setTitleChangedHandler(handler: (agentId: string, title: string) => void): void {
		this.onTitleChanged = handler;
	}

	/**
	 * 更新 tab.title；常规路径只在变化时 emit/通知，重启或会话替换可强制把 get_state 的
	 * 磁盘权威标题写回 catalog，修复 tab 已沿用旧 catalog 标题时被相等判断吞掉的问题。
	 */
	private applyRuntimeTitle(agentId: string, title: string, emit = true, forceCatalogSync = false): boolean {
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
		// restart/session replacement 的 tab 可能已经是该标题，但 catalog 仍旧；
		// forceCatalogSync 允许 get_state 的权威值穿过相等判断写回 catalog。
		if (changed || forceCatalogSync) this.onTitleChanged?.(agentId, next);
		return changed;
	}

	private notifyAgentSettled(agentId: string, title: string) {
		for (const listener of this.settledListeners) {
			try { listener({ agentId, title }); } catch {}
		}
	}

	private notifyStateListeners(tabs: AgentTab[]) {
		for (const listener of this.stateListeners) {
			try { listener(tabs); } catch {}
		}
	}

	stopAll() {
		// 应用退出时统一清理所有 pi 子进程，避免后台 agent 残留占用模型或文件句柄。
		for (const runtime of this.agents.values()) {
			this.userInitiatedStop.add(runtime.tab.id);
			this.clearAgentState(runtime.tab.id);
			runtime.process.stop();
		}
		this.agents.clear();
		this.messages.clear();
		// 退出时统一清理所有 gate / abort 兜底定时器，避免泄漏到下一次生命周期。
		for (const agentId of [...this.streamGates.keys()]) this.clearStreamGate(agentId);
		this.recentlyAborted.clear();
		// 实时日志广播的节流定时器与聚合缓冲同步清理
		if (this.liveRpcLogFlushTimer !== null) {
			clearTimeout(this.liveRpcLogFlushTimer);
			this.liveRpcLogFlushTimer = null;
		}
		this.pendingLiveRpcLogs.clear();
		this.emitState();
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
					eventType:
						event && typeof event === "object"
							? String((event as { type?: unknown }).type ?? "unknown")
							: typeof event,
				});
			}
		});
		piProcess.on("stderr", (text) =>
			this.emit(ipcChannels.agentsLog, { agentId, text }),
		);
		piProcess.on("protocol-error", (line) => {
			this.emit(ipcChannels.agentsLog, {
				agentId,
				text: `Protocol error: ${line}`,
			});
			void this.appLogger?.error(
				"agent",
				`Protocol error: ${(line as string)?.slice(0, 200)}`,
				{
					agentId,
					project: options.projectPath,
				},
			);
		});
		// 转发 RPC 日志到前端，用于调试面板展示请求/响应/事件
		piProcess.on("rpc-log", (entry: { direction: string; data: unknown }) => {
			try {
				const data = entry.data as Record<string, any>;
				let summary: string;
				if (entry.direction === "send") {
					const type = data.type ?? "?";
					if (type === "prompt") {
						const desc = data.description ? ` [${data.description}]` : "";
						summary = `→ prompt${desc}: ${(data.message ?? "").slice(0, 60)}`;
					}
					else if (type === "set_model")
						summary = `→ set_model: ${data.provider}/${data.modelId}`;
					else if (type === "set_thinking_level")
						summary = `→ set_thinking: ${data.level}`;
					else if (type === "bash")
						summary = `→ bash: ${(data.command ?? "").slice(0, 60)}`;
					else summary = `→ ${type}`;
				} else {
					const type = data.type ?? "?";
					if (type === "response")
						summary = `← ${data.command ?? "?"} ${data.success ? "✓" : "✗"}${data.error ? ` ${data.error}` : ""}`;
					else if (type === "message_update") {
						const evt = data.assistantMessageEvent?.type ?? "?";
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
				if (this.rpcLoggingAgents.has(agentId)) {
					this.rpcLogger?.push(logEntry);
					this.enqueueLiveRpcLog(logEntry);
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
				if (this.startupHandshakeAgents.has(agentId)) return;
				if (this.agents.get(agentId)?.process !== piProcess) return;
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
	private handleCreateProcessExit(
		agentId: string,
		tab: AgentTab,
		payload: { code: number | null; signal: string | null },
	) {
		if (this.startupHandshakeAgents.has(agentId)) return;
		// 模型配置刷新期间的进程退出由 refreshModels() 负责重连，此处静默忽略
		if (this.modelRefreshingAgents.has(agentId)) return;
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
					this.addLocalizedMessage(
						agentId,
						"system",
						"diagnostic.compactReconnected",
						"会话压缩完成，Agent 已自动重连",
					);
					this.emitState();
				})
				.catch(() => {
					tab.status = "closed";
					void this.appLogger?.error("agent", "Agent auto-restart failed", {
						agentId,
						code: payload.code,
						sessionPath: tab.sessionPath,
					});
					this.addLocalizedMessage(
						agentId,
						"error",
						"diagnostic.processReconnectFailed",
						"Agent 进程意外退出，自动重连失败",
					);
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
			this.addMessage(
				agentId,
				"error",
				this.buildStartupFailureMessage(
					`pi 进程退出 code=${payload.code}${payload.signal ? ` signal=${payload.signal}` : ""}`,
					diag,
				),
			);
		}
		// 最终停止（无重连路径）：统一清理该 agent 的运行态键，避免慢泄漏
		this.clearAgentState(agentId);
		this.emitState();
	}

	/** reattach 路径的进程 exit：同样做单次自动重连保护。 */
	private handleReattachProcessExit(
		agentId: string,
		runtime: AgentRuntime,
		payload: { code: number | null; signal: string | null },
	) {
		if (this.startupHandshakeAgents.has(agentId)) return;
		if (this.modelRefreshingAgents.has(agentId)) return;
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
		// 自动压缩也可能发生在重连后的进程中；继续复用同一会话文件重附加，
		// 但仍用 autoRestartAttempted 做单次保护，避免真正异常退出时无限重启。
		if (!this.autoRestartAttempted.has(agentId) && runtime.tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			runtime.tab.status = "starting";
			this.emitState();
			this.reattachProcess(agentId, runtime.tab.sessionPath)
				.then(() => {
					runtime.tab.status = "idle";
					this.addLocalizedMessage(
						agentId,
						"system",
						"diagnostic.compactReconnected",
						"会话压缩完成，Agent 已自动重连",
					);
					void this.appLogger?.info("agent", "Agent reattach auto-restart succeeded", {
						agentId,
						code: payload.code,
						sessionPath: runtime.tab.sessionPath,
					});
					this.emitState();
				})
				.catch(() => {
					runtime.tab.status = "closed";
					this.addLocalizedMessage(
						agentId,
						"error",
						"diagnostic.processReconnectFailed",
						"Agent 进程意外退出，自动重连失败",
					);
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
	private buildStartupFailureMessage(
		rawMessage: string,
		diag: ReturnType<PiProcess["getDiagnostics"]>,
	): string {
		if (!diag) {
			return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\nplatform=${globalThis.process.platform} arch=${globalThis.process.arch}`;
		}
		const lines: string[] = [];
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
		lines.push(`版本检测: ${diag.versionCheck ? "✓ 通过" : "✗ 失败"}`);
		lines.push(`运行环境: ${globalThis.process.platform}/${globalThis.process.arch}`);
		if (diag.blockedExtensions && diag.blockedExtensions.length > 0) {
			// 桌面端已自动隔离的扩展（如 codeisland），方便用户对照「为何 RPC 没加载该扩展」。
			lines.push(`已自动隔离扩展: ${diag.blockedExtensions.join(", ")}`);
		}
		lines.push("");
		lines.push("━━━ 排查步骤 ━━━");
		if (!diag.versionCheck) {
			lines.push("1. 在终端执行 pi --version，确认 pi 是否已安装且路径正确");
			lines.push("2. 如未安装，执行 npm install -g @earendil-works/pi-coding-agent");
			lines.push("3. macOS 若从 Dock 启动，可在设置中填写完整 pi 路径（Homebrew 常见 /opt/homebrew/bin/pi）");
		} else if (diag.exitCode !== 0 && diag.exitCode !== null) {
			lines.push("1. 在终端执行 pi --mode rpc 看是否能正常启动");
			lines.push("2. 注意终端中的错误信息（架构不匹配/权限/扩展崩溃都会体现在这里）");
		} else if (!stderrText && diag.exitCode === null) {
			lines.push("1. 桌面端已自动重试 get_state，但 pi 仍未响应。");
			lines.push("2. 在终端执行 pi --mode rpc 看是否能正常启动，注意终端中的错误信息");
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
			lines.push(
				`当前启动已禁用：${[
					noExt ? "扩展 (--no-extensions)" : null,
					noSkills ? "技能 (--no-skills)" : null,
				]
					.filter(Boolean)
					.join("、")}`,
			);
			lines.push("若仍失败，更可能是 pi 本体/路径/会话文件问题，而不是扩展加载。");
		} else {
			lines.push("若怀疑某个扩展或技能导致启动失败：");
			lines.push("1. 打开 设置 → 开发设置");
			lines.push("2. 临时开启「禁用扩展启动」和/或「禁用技能启动」");
			lines.push("3. 保存后重新启动 Agent 验证");
			lines.push("若禁用后能启动，再逐个排查 ~/.pi/agent/extensions 与 skills。");
		}
		lines.push("");
		lines.push("如问题持续，可在 GitHub 提交 Issue 并附上以上信息与应用日志。");
		return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\n${lines.join("\n")}`;
	}

	private handlePiEvent(agentId: string, event: unknown) {
		// 通知本地监听器（FeishuBridge、WebEventStream SSE 等主进程内部订阅）
		for (const listener of this.localEventListeners) {
			try { listener(agentId, event); } catch {}
		}
		// 2026-08 治理：agents:event 不再转发渲染进程。桌面 UI 没有任何消费者，
		// 而每 token 100+/s 的原始事件转发会让渲染端 applySessionRuntimeEventAtom
		// 无条件写 sessionRuntimeByIdAtom → timeline 等订阅者 100/s 全量重渲染
		// （O(消息数) + V8 committed 只涨不缩，GB 级内存爬升的核心驱动）。
		// web SSE/飞书等内部订阅走上方 localEventListeners，不受影响。
		// this.emit(ipcChannels.agentsEvent, { agentId, event });

		if (!event || typeof event !== "object") return;
		const typed = event as Record<string, any>;
		const runtime = this.agents.get(agentId);

		// 扩展/RPC 调用 setSessionName 后 Pi 会发 session_info_changed；
		// 同步到 tab.title 并写回 catalog，使侧栏/Tab 与手动 rename 看到同一标题。
		// 忽略空 name，避免把已有标题抹掉。
		if (typed.type === "session_info_changed" && runtime) {
			const name =
				typeof typed.name === "string"
					? typed.name.replace(/\s+/g, " ").trim()
					: "";
			this.applyRuntimeTitle(agentId, name);
		}

		if (typed.type === "agent_start" && runtime) {
			// 首个 run 开始：此刻用户的触发消息已落盘，把启动期诊断（扩展回退/启动扩展报错）
			// 按序写入时间线——位于用户消息之后、回答之前，避免插进历史轮次中间。
			this.flushStartupDiagnostics(agentId);
			this.agentStartedFirstRun.add(agentId);
			// agent_start 表示一轮新的 agent run 开始：
			// 1) 清理 recentlyAborted，允许状态机恢复 running
			// 2) 推进 stream generation，解封流式闸门（唯一合法解封点）
			this.recentlyAborted.delete(agentId);
			this.notifiedAskAgents.delete(agentId);
			this.openAgentStream(agentId);
			this.setAgentTurnActive(agentId, true);
			// rewind 回合计数：每轮 run 递增一次，供文件自动打点标记 turnIndex。
			this.bumpRewindTurn(agentId);
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
			this.emit(ipcChannels.agentsTextStream, { agentId, text: "", done: true, reset: true });
		}

		if (typed.type === "message_start" && typed.message?.role === "assistant") {
			// abort 封印后的残留 assistant 事件应丢弃，防止误重新激活流式状态。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.beginAssistantMessage(agentId);
			this.streamingAgents.add(agentId);
			// 性能计时起表（幂等：message_update start 先到则不重置）。
			// 顶层 message_start 是 mock/pi 均走的确定路径，不能只依赖 delta 事件。
			this.ensurePerfTimer(agentId);
			// 顶层 message_start（mock/pi 均走此路径）：必须允许空骨架，否则
			// text_delta 不再 upsert 时 History 无挂载点，Live 正文无处渲染。
			this.upsertAssistantMessage(agentId, typed.message, "", { allowEmpty: true });
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
			this.upsertRetryStatusMessage(
				agentId,
				typed,
				typed.success ? "success" : "error",
			);
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
			if (runtime) {
				// compaction 会向 session JSONL 写入新的边界记录；立即重载消息，
				// 避免前端仍展示压缩前分支，下一轮继续对话时看起来像“断在旧会话”。
				void this.loadMessages(agentId).catch(() => undefined);
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
			});
		}

		if (typed.type === "agent_end") {
			// agent_end closes the logical response turn even when Pi continues with
			// compaction/retry bookkeeping and keeps the runtime busy.
			this.setAgentTurnActive(agentId, false);
			// agent_end 只表示一次底层 run 结束；Pi 之后仍可能执行自动重试、自动压缩，
			// 或压缩后继续 queued follow-up。最终空闲必须等 agent_settled，避免中途误判 idle。
			if (runtime) {
				this.activeAssistantMessageIds.delete(agentId);
				this.streamingAgents.delete(agentId);
				this.toolMessageIds.delete(agentId);
				this.textEmitter.cancel(agentId);
				this.streamingText.delete(agentId);
				this.lastSentTextByAgent.delete(agentId);
				this.textPushCountByAgent.delete(agentId);
			}
			// agent 异常结束时（如 API 返回 400、模型报错等），将错误提示写入会话，避免用户看到空白。
			// 错误信息的存放位置因 pi 版本和错误类型不同而有多种可能：
			//   1. agent_end 顶层 errorMessage
			//   2. messages 数组中 stopReason=error 的消息的 errorMessage
			//   3. messages 数组中 assistant 消息的 content 里包含 error 片段
			//   4. agent_end 顶层 stopReason=error 但无 messages
			const agentMessages = Array.isArray(typed.messages) ? typed.messages : [];
			const errorMessages = agentMessages.filter(
				(m: any) => m.stopReason === "error",
			);
			// 逐级查找错误文本：顶层 → 错误消息列表 → 仅检查最后一轮对话中 type=error 的 content 块
			const topMsg = errorMessages[errorMessages.length - 1];
			// 只从最后一条 assistant 消息中查找显式 type=error 的 content 块，
			// 避免扫描全部历史消息导致工具成功输出被误判为错误。
			const lastAssistant = agentMessages
				.filter((m: any) => m.role === "assistant")
				.pop();
			const contentError = Array.isArray(lastAssistant?.content)
				? lastAssistant.content.find((c: any) => c?.type === "error")
				: undefined;
			const errorMsg =
				(typed.errorMessage as string | undefined) ??
				topMsg?.errorMessage ??
				(typed.error as string | undefined) ??
				(typeof contentError?.text === "string" ? contentError.text : undefined) ??
				(typeof contentError?.message === "string"
					? contentError.message
					: undefined);
			if (typed.willRetry === true) {
				// agent_end.willRetry 表示 pi 已判定本次错误会进入自动重试；
				// 此时不写入最终错误，避免用户误以为会话已经失败。
				if (errorMsg && !this.retryStatusMessageIds.has(agentId)) {
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
				this.addDetailedErrorMessage(agentId, String(errorMsg));
				// 有错误且不会重试 → Agent 进入 error 态，宠物聚合为 failed（行5），
				// 否则会被误置为 idle 触发"所有任务完成"通知
				if (runtime) runtime.tab.status = "error";
				// agent_end 携带错误且不重试：错误原文（API 400/模型报错等）必须进 applog，
				// 会话气泡只面向用户，排查时依赖这里的结构化记录。
				void this.appLogger?.error("agent", "Agent run ended with error", {
					agentId,
					error: String(errorMsg),
					stopReason: typed.stopReason,
				});
			} else if (
				typed.stopReason === "error" ||
				errorMessages.length > 0
			) {
				this.addDetailedErrorMessage(agentId);
				if (runtime) runtime.tab.status = "error";
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
			// recentlyAborted 被 agent_start 清除，但 abortSettledFallbackTimers 保留到 settled，
			// 两者任一命中都说明本轮被用户中止，不得触发「已完成」提醒。
			const isAbortSettled =
				this.recentlyAborted.has(agentId) || this.abortSettledFallbackTimers.has(agentId);
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
				this.finishThinkingChannel(agentId);
				this.activeAssistantMessageIds.delete(agentId);
				this.streamingAgents.delete(agentId);
				this.toolMessageIds.delete(agentId);
				this.textEmitter.cancel(agentId);
				this.streamingText.delete(agentId);
				this.lastSentTextByAgent.delete(agentId);
				this.textPushCountByAgent.delete(agentId);
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
				void this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() })
					.catch(() => undefined);

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

		if (
			typed.type === "message_update" &&
			typed.assistantMessageEvent
		) {
			// abort 封印后的延迟 text/thinking delta 一律丢弃，避免重建气泡或串台。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.handleAssistantMessageEvent(agentId, typed);
		}

		if (
			typed.type === "message_end" &&
			typed.message?.role === "assistant"
		) {
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			if (this.activeAssistantMessageIds.has(agentId)) {
				// 先写入 History thinking 并 flush，再发 done 清 live（顺序写进测试）。
				this.finalizeThinkingIntoMessage(agentId);
				this.upsertAssistantMessage(agentId, typed.message);
				this.flushMessageEmit(agentId);
				this.finishThinkingChannel(agentId);
				this.activeAssistantMessageIds.delete(agentId);
			}
			// 结算性能指标（幂等：message_update done 先结算则 map 已删，直接返回）
			this.settleMessagePerf(agentId, typed.message);
			// 终结 Live 正文通道（顶层 message_end 不经 handleAssistantMessageEvent）
			this.streamingAgents.delete(agentId);
			const finalText = this.streamingText.get(agentId);
			if (finalText !== undefined) {
				this.textEmitter.flush(agentId);
				this.emitTextStreamNow(agentId, finalText, true);
			}
			this.textEmitter.cancel(agentId);
			this.streamingText.delete(agentId);
			this.lastSentTextByAgent.delete(agentId);
			this.textPushCountByAgent.delete(agentId);
			this.emitStreamingStatePatch(agentId);
		}

		if (typed.type === "tool_execution_start") {
			// abort 封印后的延迟工具事件应丢弃，避免重新激活流式状态。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			// 新工具轮次开始：上一个 ask 的等待累计若未被其 end 事件消耗（如 abort 封印），
			// 在此清空，防止把旧等待算进后续工具耗时。
			this.askWaitMsByAgent.delete(agentId);
			this.upsertToolMessage(agentId, typed, "running");
			// 并行工具会先连续发多个 start；按 toolCallId 追踪，只有最后一个 end 才能表示工具阶段完成。
			const toolName = typed.toolName ?? "tool";
			const toolCallId = String(typed.toolCallId ?? `${toolName}-${Date.now()}`);
			const toolState = updateActiveToolCalls(
				this.activeToolCallsByAgent.get(agentId) ?? new Map<string, string>(),
				{ type: "start", toolCallId, toolName },
			);
			this.applyActiveToolCallState(agentId, toolState);
			// 工具调用开始时确保 agent 状态为 running
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 完整 runtime 信息异步补发；工具边沿已经同步推送，不依赖此请求的完成顺序。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_end") {
			// abort 封印后的延迟工具事件应丢弃。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.upsertToolMessage(
				agentId,
				typed,
				typed.isError ? "error" : "done",
			);
			// 文件类工具执行完成 → 异步自动打点（快照包含该工具改动后的状态）。
			// 检查点创建不阻塞工具结果推送（fire-and-forget，失败只记日志）。
			const endedToolName = typed.toolName ?? "";
			if (MUTATING_TOOLS.has(endedToolName)) {
				this.scheduleRewindCheckpoint(
					agentId,
					endedToolName,
					this.rewindTurnCounters.get(agentId) ?? 0,
				);
			}
			// 工具执行结束是终态，立即 flush 把最终结果推给渲染进程，避免节流窗口内用户看不到完成状态。
			this.flushMessageEmit(agentId);
			// 清除本次 toolCall；并行批次仅在最后一个工具结束时发布 false，
			// 否则 steer 会在其他工具仍运行时过早进入 pi 队列。
			const activeToolCalls = this.activeToolCallsByAgent.get(agentId) ?? new Map<string, string>();
			const toolState = updateActiveToolCalls(activeToolCalls, {
				type: "end",
				toolCallId: String(typed.toolCallId ?? ""),
			});
			this.applyActiveToolCallState(agentId, toolState);
			// 工具调用完成后保持 agent 状态为 running，等待后续的 agent_end 事件
			// 这样在工具完成到 agent 生成回复之间，thinking bubble 仍然会显示
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 完整 runtime 信息异步补发；序号保证它不会倒灌旧工具状态。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_update") {
			// abort 封印后的延迟工具事件应丢弃。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.upsertToolMessage(agentId, typed, "running");
		}

		if (typed.type === "extension_ui_request") {
			this.handleUIRequest(agentId, typed);
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
			// 首个 agent_start 之前到达 = 启动期扩展报错：按启动诊断暂存，
			// 首个 run 落盘到用户消息之后；否则是运行期间的报错，直接写时间线。
			if (!this.agentStartedFirstRun.has(agentId)) {
				this.queueStartupDiagnostic(agentId, diagnostic);
			} else {
				this.addLocalizedMessage(
					agentId,
					diagnostic.role,
					diagnostic.i18nKey,
					diagnostic.fallbackText,
					diagnostic.options,
				);
			}
		}
	}

	/**
	 * 处理 pi 扩展发起的 UI 请求。
	 * 对话类请求写入消息流等待用户回答；fire-and-forget 请求只转发给渲染进程或忽略。
	 */
	private handleUIRequest(agentId: string, typed: Record<string, any>) {
		const method = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		// pi RPC 协议将 setWidget / dialog 字段放在顶层，不嵌套 params
		if (method === "notify") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				// 扩展的 notify 消息常带终端颜色转义（如 billion-context-pi 的更新通知
				// `\x1B[32m✔ ACP auto-updated ...\x1B[0m`），toast 不是终端，直接透传会显示乱码转义符，
				// 在进程边界统一清洗后再交给渲染层。
				message: stripAnsi(String(typed.message ?? "")),
				notifyType: typed.notifyType,
			});
			return;
		}

		if (method === "set_editor_text") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				text: String(typed.text ?? ""),
			});
			return;
		}

		if (method === "setWidget") {
			// Plan Mode 等扩展会频繁刷新 widget；只走 IPC 状态，不落入会话消息，避免 JSONL 被进度噪声污染。
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				widgetKey: String(typed.widgetKey ?? requestId),
				widgetLines: Array.isArray(typed.widgetLines) ? typed.widgetLines : undefined,
				widgetPlacement: typed.widgetPlacement,
			});
			return;
		}
		// 其他非对话 UI 方法暂不占用桌面 UI 空间。
		if (["setStatus", "setTitle"].includes(method)) return;
		if (!["select", "confirm", "input", "editor"].includes(method)) return;

		// Batch ask_question sends its form as an input title envelope. Decode it at
		// the process boundary so no renderer can mistake the raw JSON for a prompt.
		const rawTitle = String(typed.title ?? typed.question ?? "");
		const batchEnvelope = this.tryParseBatchAskEnvelope(rawTitle);
		const rawOptions = Array.isArray(typed.options)
			? typed.options.filter((option): option is string => typeof option === "string")
			: undefined;
		// The bundled extension appends this marker for non-desktop clients. Replace it
		// with the desktop's own inline field so selecting custom text never opens a
		// second request above the composer.
		const hasCustomOption = rawOptions?.some((option) => option.startsWith("✎")) ?? false;
		const effectiveOptions = hasCustomOption
			? rawOptions?.filter((option) => !option.startsWith("✎"))
			: rawOptions;
		// select 无有效选项时降级为 input 而不是静默取消：ask_question 的 options 是
		// 可选的，模型经常只问问题不给选项——自动取消会让用户完全看不到提问 UI。
		// 降级后问题文本保留为标题，用户仍可输入文字回答。
		const effectiveMethod =
			method === "select" && (!effectiveOptions || effectiveOptions.length === 0)
				? "input"
				: method;
		const request = batchEnvelope
			? {
					agentId,
					requestId,
					method: "batch_ask" as const,
					title: "",
					batchQuestions: batchEnvelope.questions,
					batchReview: batchEnvelope.review,
				}
			: {
					agentId,
					requestId,
					method: effectiveMethod,
					title: rawTitle,
					options: effectiveOptions,
					placeholder: typed.placeholder as string | undefined,
					prefill: typed.prefill as string | undefined,
					allowOther: typed.allowOther === true || hasCustomOption,
				};

		// 记录 pending UI 请求，用于 abort 时自动 cancel；raisedAt 同时作为用户等待计时起点
		if (!this.pendingUIRequests.has(agentId)) {
			this.pendingUIRequests.set(agentId, new Map());
		}
		this.pendingUIRequests.get(agentId)!.set(requestId, {
			method: effectiveMethod,
			title: request.title,
			raisedAt: Date.now(),
		});

		// The session runtime owns pending UI. Do not write an additional system
		// message, because that creates a second interactive card in the timeline.
		this.emit(ipcChannels.agentsUiRequest, request);
		this.scheduleUIRequestTimeout(agentId, requestId, typed.timeout);
		// 桌面通知由 SessionRuntimeCoordinator 统一触发（非聚焦会话才提醒，避免打扰正在看当前会话的用户）；
		// 此处不重复发，防止一条提问出现两条通知。
	}

	/**
	 * 结算一次 ask 的用户等待时长（answer 时刻 - 提问弹起时刻），累加到该 agent 的
	 * 等待累计值（askWaitMsByAgent）。调用时机 = 用户回答 / 超时 / abort 取消，
	 * 与 pendingUIRequests 中该请求的删除成对，避免重复结算。
	 * 用途：ask_question 工具耗时（durationMs）要排除用户思考时间，只展示 agent 处理时长。
	 */
	private settleAskWait(agentId: string, requestId: string) {
		const entry = this.pendingUIRequests.get(agentId)?.get(requestId);
		if (!entry || typeof entry.raisedAt !== "number") return;
		const waitMs = Math.max(0, Date.now() - entry.raisedAt);
		this.askWaitMsByAgent.set(agentId, (this.askWaitMsByAgent.get(agentId) ?? 0) + waitMs);
	}

	/**
	 * 发送 Extension UI 响应（extension_ui_response）到 pi 的 stdin。
	 * 同时更新对应卡片消息的状态。
	 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		// 写入 extension_ui_response 到 pi 的 stdin

		const extPayload: Record<string, unknown> = {
			type: "extension_ui_response",
			id: requestId,
			value: response.value,
		};
		// pi 的 ctx.ui.confirm() 检查 confirmed 字段，ctx.ui.select/input 检查 value
		if ("confirmed" in response) extPayload.confirmed = response.confirmed;
		// 取消时发 cancelled: true
		if (response.cancelled) extPayload.cancelled = true;
		runtime.process.client.sendRaw(extPayload);

		// 结算用户等待时长（回答时刻），供该 ask 所属工具耗时扣除
		this.settleAskWait(agentId, requestId);

		// 清理 pending 记录
		const pending = this.pendingUIRequests.get(agentId);
		if (pending) {
			pending.delete(requestId);
			if (pending.size === 0) this.pendingUIRequests.delete(agentId);
		}

		// 通知渲染进程 UI 请求已完成
		this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true, ...response });
	}

	/**
	 * pi 信任机制只对“含项目级 pi 资源”的项目触发，且 RPC 模式下 pi 的 project_trust 事件
	 * hasUI 恒为 false、ctx.ui.select 不接 RPC UI 协议，无法弹窗。
	 * 因此 pi-desktop 在启动 pi 进程前自行完成信任确认：干净项目自动信任并写入 trust.json；
	 * 含 .pi/.agents 资源且未记录的项目弹窗让用户决策。
	 */
	private static readonly TRUST_REQUIRING_RESOURCE_FILES = [
		"settings.json",
		"extensions",
		"skills",
		"prompts",
		"themes",
		"SYSTEM.md",
		"APPEND_SYSTEM.md",
	] as const;

	/**
	 * 复刻 pi 的 hasTrustRequiringProjectResources：检查项目目录或其父目录是否存在
	 * 需要信任才能加载的资源（.pi 下的配置/扩展/skills 等，或项目级 .agents/skills）。
	 * 用户全局 ~/.agents/skills 视为可信，不触发信任确认。
	 */
	private hasTrustRequiringResources(hostCwd: string): boolean {
		const configDir = join(hostCwd, ".pi");
		if (
			AgentManager.TRUST_REQUIRING_RESOURCE_FILES.some((file) => existsSync(join(configDir, file)))
		) {
			return true;
		}
		const userAgentsSkillsDir = join(
			this.wslEnvironment?.windowsHome ?? homedir(),
			".agents",
			"skills",
		);
		let currentDir = hostCwd;
		while (true) {
			const agentsSkillsDir = join(currentDir, ".agents", "skills");
			if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
				return true;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) return false;
			currentDir = parentDir;
		}
	}

	/**
	 * 启动 pi 前完成项目信任确认。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任，后续不再重复检查。
	 * - 含信任资源的项目：已信任则放行；已显式拒绝则抛错；未记录则弹窗等待用户决策。
	 */
	/**
	 * 启动 pi 前完成项目信任确认，返回需传给 pi 的信任覆盖指令。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任。
	 * - 已信任：放行，pi 查 trustStore 即可。
	 * - 未记录或曾记 false：弹窗让用户选择。不持久化 false，保证下次仍可重新选择。
	 *   - trust-remember：写 true，pi 信任加载资源。
	 *   - trust-session：用 --approve 本次覆盖，不落盘。
	 *   - deny：用 --no-approve 本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
	 */
	private async ensureProjectTrust(project: Project): Promise<"approve" | "no-approve" | undefined> {
		const cwd = this.wslEnvironment
			? toWslLinuxPath(project.path, this.wslEnvironment)
			: project.path;
		const hostCwd = this.wslEnvironment
			? toWindowsHostPath(project.path, this.wslEnvironment)
			: project.path;
		if (!this.hasTrustRequiringResources(hostCwd)) {
			// 干净项目：pi 无需加载项目级资源，pi-desktop 自动记入信任，避免每次创建 Agent 重复检查。
			void this.appLogger?.info("agent", "Agent ensure trusted directory start", { cwd });
			await this.configManager.ensureTrustedDirectory(cwd);
			void this.appLogger?.info("agent", "Agent ensure trusted directory completed", { cwd });
			return undefined;
		}
		const decision = await this.configManager.getProjectTrustDecision(cwd);
		if (decision === true) return undefined;
		// 未记录或曾记 false：弹窗让用户选择信任策略。不写 false，确保下次打开仍可重新决策。
		const choice = await this.requestProjectTrust(cwd, project.name);
		if (choice === "trust-remember") {
			await this.configManager.setProjectTrustDecision(cwd, true);
			return undefined;
		}
		if (choice === "trust-session") {
			return "approve";
		}
		// deny：本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
		return "no-approve";
	}

	/**
	 * 通过 IPC 请求渲染进程弹出项目信任确认窗，等待用户选择。
	 * 无窗口可用（如 headless）或 60 秒未响应时默认拒绝（安全优先）。
	 */
	private requestProjectTrust(cwd: string, projectName: string): Promise<ProjectTrustChoice> {
		const requestId = randomUUID();
		const win = this.getWindow();
		if (!win || win.isDestroyed()) {
			return Promise.resolve<ProjectTrustChoice>("deny");
		}
		return new Promise<ProjectTrustChoice>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingTrustRequests.delete(requestId)) {
					resolve("deny");
				}
			}, 60_000);
			this.pendingTrustRequests.set(requestId, {
				resolve: (choice) => {
					clearTimeout(timer);
					resolve(choice);
				},
			});
			win.webContents.send(ipcChannels.projectsTrustRequest, { requestId, cwd, projectName });
		});
	}

	/** 渲染进程回传用户对信任确认弹窗的选择，唤醒等待中的 Agent 创建流程。 */
	respondTrustRequest(requestId: string, choice: ProjectTrustChoice): void {
		const pending = this.pendingTrustRequests.get(requestId);
		if (pending) {
			this.pendingTrustRequests.delete(requestId);
			pending.resolve(choice);
		}
	}

	private handleAssistantMessageEvent(agentId: string, event: Record<string, any>) {
		// 双保险：即使调用方漏判，也在这里拦截封印 generation 的残留 delta。
		if (this.isAgentStreamSealed(agentId)) return;
		const assistantEvent = event.assistantMessageEvent as Record<string, any>;
		const eventType = assistantEvent.type as string | undefined;
		const partialMessage =
			event.message ??
			assistantEvent.message ??
			assistantEvent.partial ??
			assistantEvent.partialMessage;

		if (eventType === "start" || eventType === "message_start") {
			this.beginAssistantMessage(agentId);
			this.streamingAgents.add(agentId);
			// 性能计时起表（幂等：顶层 message_start 先到则不重置）
			this.ensurePerfTimer(agentId);
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
			this.markFirstDelta(agentId);
			this.markFirstText(agentId);
			const delta = String(assistantEvent.delta ?? "");
			// Live 正文唯一热路径：累积后经 textEmitter（50ms）推送，不增长 messages。
			const prevText = this.streamingText.get(agentId) ?? "";
			const nextText = this.extractStreamingText(agentId, partialMessage) ?? prevText + delta;
			this.streamingText.set(agentId, nextText);
			this.textEmitter.push(agentId, stripAnsi(nextText));
			// 思考切正文：只标 endedAt，不落盘、不清 live（message_end/abort 才写入）。
			if (this.thinkingSegmentByAgent.has(agentId)) {
				this.markThinkingSegmentEnded(agentId);
			}
			return;
		}

		if (eventType === "thinking_delta") {
			this.ensureThinkingSegment(agentId);
			this.markFirstDelta(agentId);
			const prev = this.streamingThinking.get(agentId) ?? "";
			const delta = String(assistantEvent.delta ?? "");
			const next = prev + delta;
			this.streamingThinking.set(agentId, next);
			this.thinkingEmitter.push(agentId, stripAnsi(next));
			this.streamingAgents.add(agentId);
			// Live 思考唯一热路径：不 upsert messages，避免 50ms timeline 重组。
			return;
		}

		if (eventType === "thinking_end") {
			const finalThinking = String(
				assistantEvent.content ?? this.streamingThinking.get(agentId) ?? "",
			);
			if (finalThinking) {
				this.ensureThinkingSegment(agentId);
				this.streamingThinking.set(agentId, finalThinking);
			}
			// 阶段性终态：只标 endedAt + flush live；不落盘（message_end/abort 才写 messages）。
			this.markThinkingSegmentEnded(agentId);
			return;
		}

		if (eventType === "message_end" || eventType === "done" || eventType === "error") {
			// 结算性能指标（TTFT/总耗时/TPS）并边沿推送渲染层
			this.settleMessagePerf(agentId, partialMessage);
			// 先写入 History thinking 并 flush，再发 done 清 live。
			this.finalizeThinkingIntoMessage(agentId, partialMessage);
			this.upsertAssistantMessage(agentId, partialMessage);
			// message_end/done/error 是本轮回答的最终状态，立即 flush 确保完整消息及时可见。
			this.flushMessageEmit(agentId);
			this.finishThinkingChannel(agentId);
			this.activeAssistantMessageIds.delete(agentId);
			this.streamingAgents.delete(agentId);
			// 独立流式正文通道终止：推一次最终累积文本后清缓冲（渲染层由历史消息接管）
			const finalText = this.streamingText.get(agentId);
			if (finalText !== undefined) {
				this.textEmitter.flush(agentId);
				this.emitTextStreamNow(agentId, finalText, true);
			}
			this.textEmitter.cancel(agentId);
			this.streamingText.delete(agentId);
			this.lastSentTextByAgent.delete(agentId);
			this.textPushCountByAgent.delete(agentId);
		}
	}

	private beginAssistantMessage(agentId: string) {
		if (!this.activeAssistantMessageIds.has(agentId)) {
			this.activeAssistantMessageIds.set(agentId, randomUUID());
		}
	}

	/**
	 * 记录首个内容 delta 时刻（text/thinking 均算首 token，用户最先感知到的是二者之一）。
	 * 只记一次：思考切正文时 text_delta 不会覆盖已有的 firstDeltaAt。
	 */
	private markFirstDelta(agentId: string) {
		const perf = this.messagePerfByAgent.get(agentId);
		if (perf && perf.firstDeltaAt === 0) {
			perf.firstDeltaAt = Date.now();
		}
	}

	/**
	 * 记录正文首 delta 时刻：思考模式下 thinking_delta 先到，用户感知的「首字」是正文首字，
	 * 因此 text_delta 单独记一次（只在 text_delta 分支调用）；无思考时即首个 text_delta。
	 */
	private markFirstText(agentId: string) {
		const perf = this.messagePerfByAgent.get(agentId);
		if (perf && perf.firstTextAt === 0) {
			perf.firstTextAt = Date.now();
		}
	}

	/**
	 * 幂等起表：顶层 message_start 与 message_update start 两条路径都可能先到，
	 * 只在尚无计时器时创建，避免后者覆盖前者丢失 startedAt。
	 * 起点优先取 sendPrompt 记录的请求发出时刻（消费后删除，防止工具后续答回合
	 * 误用上一次请求起点）；无请求起点（续答/内部触发）时回退到事件到达时刻。
	 */
	private ensurePerfTimer(agentId: string) {
		if (!this.messagePerfByAgent.has(agentId)) {
			const requestedAt = this.promptRequestedAtByAgent.get(agentId);
			if (requestedAt !== undefined) this.promptRequestedAtByAgent.delete(agentId);
			this.messagePerfByAgent.set(agentId, {
				startedAt: requestedAt ?? Date.now(),
				firstDeltaAt: 0,
				firstTextAt: 0,
			});
		}
	}

	/**
	 * message_end/done/error：结算本次回复的性能指标并边沿推送渲染层（不触发 RPC，
	 * 避免流式热路径上叠加 get_state/get_session_stats 开销）。
	 * - ttftMs = 首字（正文首 delta，思考模式下用户感知的首字；无正文退回首 delta）− 请求发出时刻；
	 * - totalMs = 终态 − 请求发出时刻（本轮回复总耗时）；
	 * - tps = output tokens ÷ 生成期时长（首 delta → 终态），分母排除 TTFT 更贴近真实生成速度。
	 * 纯工具调用回合（无 text/thinking delta）只有 totalMs，ttft/tps 缺省。
	 */
	private settleMessagePerf(agentId: string, message?: Record<string, any>) {
		const perf = this.messagePerfByAgent.get(agentId);
		this.messagePerfByAgent.delete(agentId);
		if (!perf) return;
		const now = Date.now();
		const totalMs = now - perf.startedAt;
		// 首字延迟：正文首 delta 优先；纯思考/中途 abort 无正文时退回首 delta，保证有值可展示
		const firstContentAt =
			perf.firstTextAt > 0 ? perf.firstTextAt : perf.firstDeltaAt > 0 ? perf.firstDeltaAt : 0;
		const ttftMs = firstContentAt > 0 ? firstContentAt - perf.startedAt : undefined;
		// message_end 携带完整 assistant 消息，usage 兼容多种命名提取 output tokens
		const usage = (message as any)?.usage;
		const outputTokens = pickNumber(
			usage?.output,
			usage?.outputTokens,
			usage?.completion,
			usage?.completionTokens,
		);
		const tps =
			outputTokens != null &&
			outputTokens > 0 &&
			perf.firstDeltaAt > 0 &&
			now > perf.firstDeltaAt
				? outputTokens / ((now - perf.firstDeltaAt) / 1000)
				: undefined;
		this.lastPerfByAgent.set(agentId, { ttftMs, totalMs, tps, at: now });
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: { ttftMs, totalMs, tps, perfAt: now },
		});
	}

	/** 首 thinking_delta：铸造与 History 相同的稳定段 id（msg-thinking-${assistantMessageId}）。 */
	private ensureThinkingSegment(agentId: string) {
		const existing = this.thinkingSegmentByAgent.get(agentId);
		if (existing) return existing;
		// 新段开始：重置思考 delta 基准（上一段的末尾文本可能碰巧是下一段前缀，
		// 直接续 delta 会让新段在渲染层缺头，直到 2.5s 快照自愈）。
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		this.beginAssistantMessage(agentId);
		const assistantMessageId = this.activeAssistantMessageIds.get(agentId);
		if (!assistantMessageId) {
			throw new Error(`ensureThinkingSegment: missing assistant message id for ${agentId}`);
		}
		const segment = {
			id: `msg-thinking-${assistantMessageId}`,
			assistantMessageId,
			startedAt: Date.now(),
			endedAt: 0,
		};
		this.thinkingSegmentByAgent.set(agentId, segment);
		// 保证 History 有同 id 骨架，buildTurnDisplay 才能用 liveThinkingId 挂思考步。
		this.upsertAssistantMessage(agentId, undefined, "", { allowEmpty: true });
		this.flushMessageEmit(agentId);
		return segment;
	}

	/** thinking_end / 转正文：标 endedAt 并 flush live，不写 messages。 */
	private markThinkingSegmentEnded(agentId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment) return;
		// 已结束后勿在每个 text_delta 上重复 flush/emit。
		if (segment.endedAt > 0) return;
		segment.endedAt = Date.now();
		this.thinkingSegmentByAgent.set(agentId, segment);
		const text = this.streamingThinking.get(agentId) ?? "";
		this.thinkingEmitter.flush(agentId);
		this.emitThinkingNow(agentId, stripAnsi(text));
	}

	/**
	 * 终态：把累积思考写入当前 assistant 骨架一次。
	 * 必须在 finishThinkingChannel（done）之前调用，并先 flush messages。
	 */
	private finalizeThinkingIntoMessage(agentId: string, partialMessage?: unknown) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		const fromStream = this.streamingThinking.get(agentId) ?? "";
		const fromMessage =
			partialMessage && typeof partialMessage === "object"
				? this.messageProjector.extractThinking((partialMessage as any).content)
				: "";
		const nextThinking = stripAnsi(fromStream || fromMessage || "");
		if (!nextThinking.trim()) return;

		this.beginAssistantMessage(agentId);
		const messageIdBase =
			segment?.assistantMessageId ?? this.activeAssistantMessageIds.get(agentId);
		if (!messageIdBase) return;
		let messageId = messageIdBase;

		const list = this.messages.get(agentId) ?? [];
		let existingIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：运行期 id 已不在列表（被投影身份替换）。若列表里已有同一条
		// pi 消息（正文一致）则更新它并重定向身份，避免 append 造出双份。
		if (existingIndex < 0) {
			const textForMatch =
				partialMessage && typeof partialMessage === "object"
					? this.messageProjector.extractText((partialMessage as any).content)
					: "";
			const rebindIndex = this.findSamePiMessageIndex(list, "assistant", textForMatch);
			if (rebindIndex >= 0) {
				existingIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				if (segment) {
					segment.assistantMessageId = messageId;
					segment.id = `msg-thinking-${messageId}`;
				}
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

	/** 发 done 并清 live 思考通道；须在 finalize + flushMessageEmit 之后调用。 */
	private finishThinkingChannel(agentId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		const text = stripAnsi(this.streamingThinking.get(agentId) ?? "");
		this.thinkingEmitter.cancel(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		if (segment) {
			const update: ThinkingUpdate = {
				agentId,
				id: segment.id,
				text,
				startedAt: segment.startedAt,
				endedAt: segment.endedAt > 0 ? segment.endedAt : Date.now(),
				done: true,
			};
			this.emit(ipcChannels.agentsThinking, update);
		}
		this.streamingThinking.delete(agentId);
		this.thinkingSegmentByAgent.delete(agentId);
	}

	private upsertAssistantMessage(
		agentId: string,
		partialMessage?: unknown,
		fallbackDelta = "",
		options?: { allowEmpty?: boolean },
	) {
		const list = this.messages.get(agentId) ?? [];
		let messageId = this.activeAssistantMessageIds.get(agentId);
		if (!messageId) {
			messageId = randomUUID();
			this.activeAssistantMessageIds.set(agentId, messageId);
		}

		let existingIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：activeAssistantMessageIds 指向的运行期 id 在列表里已不存在
		// （loadMessages 替换为投影身份）。此时不能盲目 append——列表里可能已有同一条
		// pi 消息的投影版，append 会造出双份（同内容消息被用户消息切分到两个 run）。
		// 按内容指纹匹配既有消息：命中则更新它并把身份映射重定向到它，保持单份。
		if (existingIndex < 0) {
			const extractedTextForMatch =
				partialMessage && typeof partialMessage === "object"
					? this.messageProjector.extractText((partialMessage as any).content)
					: "";
			const rebindIndex = this.findSamePiMessageIndex(
				list,
				"assistant",
				extractedTextForMatch || fallbackDelta,
			);
			if (rebindIndex >= 0) {
				existingIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				this.activeAssistantMessageIds.set(agentId, messageId);
			}
		}
		const existing = existingIndex >= 0 ? list[existingIndex] : undefined;
		const extractedText =
			partialMessage && typeof partialMessage === "object"
				? this.messageProjector.extractText((partialMessage as any).content)
				: "";
		// stopReason（provider 归一化）：message_start 骨架为 pending，message_end 更新为
		// 真实值（stop/toolUse/aborted/error/length）。渲染层据此精确区分中间/最终回复。
		// pending 是骨架占位值：不持久化（new 分支）也不覆盖既有值（existing 分支），
		// 否则 message_end 缺 stopReason 时消息永远停 in pending，渲染层回退启发式失效。
		const extractedStopReason =
			partialMessage && typeof partialMessage === "object"
				? String((partialMessage as any).stopReason ?? "") || undefined
				: undefined;
		const finalStopReason =
			extractedStopReason && extractedStopReason !== "pending"
				? extractedStopReason
				: undefined;

		if (existing) {
			// 已有骨架：有抽出文本才覆盖；fallbackDelta 仅作追加兜底（终态路径）。
			// thinking 不在此写入——仅 finalizeThinkingIntoMessage 在终态写一次。
			if (extractedText || fallbackDelta) {
				existing.text = extractedText || `${existing.text}${fallbackDelta}`;
			}
			// 终态（message_end）带真实 stopReason 时更新；骨架占位值（pending）不覆盖旧值。
			if (finalStopReason) {
				existing.stopReason = finalStopReason;
			}
			// 保留原始时间戳，不随 delta 刷新。
			this.markMessagesDirtyFrom(agentId, existingIndex);
		} else {
			const text = extractedText || fallbackDelta;
			// 默认拒绝空消息；message_start 传 allowEmpty 以建立 Live 挂载点。
			if (!text && !options?.allowEmpty) return;
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text: text || "",
				timestamp: Date.now(),
				...(finalStopReason ? { stopReason: finalStopReason } : {}),
			});
			this.markMessagesDirtyFrom(agentId, list.length - 1);
		}

		this.messages.set(agentId, list);
		// upsertAssistantMessage 被 text_start/end 等路径调用，走节流合并；
		// message_end 等终态调用方会在调用后显式 flush，保证最终状态及时。
		this.scheduleMessageEmit(agentId);
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
	private findSamePiMessageIndex(
		list: ChatMessage[],
		role: ChatMessage["role"],
		text: string,
		toolCallId?: string,
	): number {
		const normalized = stripAnsi(text ?? "").trim();
		if (role === "tool" && toolCallId) {
			for (let index = list.length - 1; index >= 0; index -= 1) {
				const message = list[index];
				if (
					message.role === "tool" &&
					(message.meta as Record<string, unknown> | undefined)?.toolCallId === toolCallId
				) {
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
	private rebindInFlightMessages(
		agentId: string,
		nextMessages: ChatMessage[],
		projectedMessages: ChatMessage[],
	): void {
		const runningAssistantId = this.activeAssistantMessageIds.get(agentId);
		const runningInNext = runningAssistantId
			? nextMessages.find((message) => message.id === runningAssistantId)
			: undefined;
		// 运行期骨架被 preserved 保护保留在尾部（merge 未匹配到同指纹投影）：
		// 若投影里恰好有它的「未完成版」（无 stopReason、有部分文本——重载快照
		// 捕捉到的流式中间态），说明同一条消息将以两种身份并存（partial 投影版 +
		// 骨架，后续 message_end 会把骨架更新为完整版 → 双份）。把身份重定向到
		// 投影版并移除骨架：后续事件继续更新投影版，位置正确、单份。
		if (
			runningInNext &&
			runningInNext.role === "assistant" &&
			!runningInNext.stopReason &&
			!runningInNext.text.trim()
		) {
			let projectedIncomplete: ChatMessage | undefined;
			for (let index = projectedMessages.length - 1; index >= 0; index -= 1) {
				const message = projectedMessages[index];
				if (
					message.role === "assistant" &&
					!message.stopReason &&
					Boolean(message.text.trim())
				) {
					projectedIncomplete = message;
					break;
				}
			}
			if (projectedIncomplete) {
				const skeletonIndex = nextMessages.findIndex(
					(message) => message.id === runningAssistantId,
				);
				if (skeletonIndex >= 0) nextMessages.splice(skeletonIndex, 1);
				this.activeAssistantMessageIds.set(agentId, projectedIncomplete.id);
				const segment = this.thinkingSegmentByAgent.get(agentId);
				if (segment && segment.assistantMessageId === runningAssistantId) {
					segment.assistantMessageId = projectedIncomplete.id;
					segment.id = `msg-thinking-${projectedIncomplete.id}`;
				}
			}
		}
		const runningTool = this.toolMessageIds.get(agentId);
		if (runningTool) {
			for (const [toolCallId, runningToolId] of runningTool) {
				if (nextMessages.some((message) => message.id === runningToolId)) continue;
				const projectedIndex = nextMessages.findIndex(
					(message) =>
						message.role === "tool" &&
						(message.meta as Record<string, unknown> | undefined)?.toolCallId === toolCallId,
				);
				if (projectedIndex >= 0) {
					runningTool.set(toolCallId, nextMessages[projectedIndex].id);
				}
			}
		}
	}

	private upsertToolMessage(
		agentId: string,
		event: Record<string, any>,
		status: "running" | "done" | "error",
	) {
		const toolName = event.toolName || "tool";
		const toolCallId = String(event.toolCallId ?? `${toolName}-${Date.now()}`);
		let agentTools = this.toolMessageIds.get(agentId);
		if (!agentTools) {
			agentTools = new Map<string, string>();
			this.toolMessageIds.set(agentId, agentTools);
		}

		let messageId = agentTools.get(toolCallId);
		if (!messageId) {
			messageId = randomUUID();
			agentTools.set(toolCallId, messageId);
		}

		const list = this.messages.get(agentId) ?? [];
		let existingToolIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：运行期工具 id 已不在列表（被投影身份替换）。按 toolCallId
		// （两通道同源）匹配既有工具消息，更新它并重定向身份，避免 append 双份。
		if (existingToolIndex < 0) {
			const rebindIndex = this.findSamePiMessageIndex(list, "tool", "", toolCallId);
			if (rebindIndex >= 0) {
				existingToolIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				agentTools.set(toolCallId, messageId);
			}
		}
		const existing = existingToolIndex >= 0 ? list[existingToolIndex] : undefined;
		const isError = status === "error" || event.isError === true;
		const args = event.args ?? existing?.meta?.args;
		const startedAt =
			typeof existing?.meta?.startedAt === "number"
				? existing.meta.startedAt
				: Date.now();
		// 工具耗时只能由 start/end 两个事件推导；start 时先保存 startedAt，end 时再写入 durationMs，
		// 避免使用消息 timestamp（会在 update/end 时刷新）导致历史恢复后耗时不可还原。
		// ask_question 工具耗时需扣除用户等待时长（exclude_wait）：等待期由 settleAskWait 累计在
		// askWaitMsByAgent，工具结束时减掉并清零，让 durationMs 只反映 agent 实际处理时间。
		let durationMs =
			status === "running" ? undefined : Math.max(0, Date.now() - startedAt);
		if (durationMs !== undefined && toolName === "ask_question") {
			const askWaitMs = this.askWaitMsByAgent.get(agentId) ?? 0;
			if (askWaitMs > 0) {
				durationMs = Math.max(0, durationMs - askWaitMs);
				this.askWaitMsByAgent.delete(agentId);
			}
		}
		const result =
			event.result ??
			event.partialResult ??
			event.output ??
			existing?.meta?.result;
		const detailText = this.messageProjector.formatToolDetail(
			toolName,
			args,
			result,
			isError,
		);
		// detailText 整体截断（拼接后可能超单段上限）并标记 truncated/fullLength；
		// 完整结果文本缓存在 toolFullTextByMessageId（LRU），供「查看完整输出」按需读取。
		const detailDelivery = this.messageProjector.truncateDetailWithMeta(detailText);
		if (detailDelivery.truncated) {
			const fullText = this.messageProjector.extractToolResultText(result) || this.messageProjector.safeJson(result);
			if (fullText) {
				this.toolFullTextByMessageId.set(messageId, fullText);
				if (this.toolFullTextByMessageId.size > AgentManager.TOOL_FULL_TEXT_LRU_LIMIT) {
					// LRU 淘汰最旧（Map 迭代序 = 插入序）
					const oldest = this.toolFullTextByMessageId.keys().next().value;
					if (oldest !== undefined) this.toolFullTextByMessageId.delete(oldest);
				}
			}
		}
		const icon = status === "running" ? "▶" : isError ? "✗" : "✓";
		const text =
			status === "running" ? `${icon} ${toolName}` : `${icon} ${toolName}`;
		// args 可能来自 event.args（对象）或 existing.meta.args（已序列化的 JSON 字符串）。
		// 如果是后者（如 tool_execution_end 不带 args），直接复用已有字符串避免 double encoding。
		const argsMeta = typeof args === "string" ? args : this.messageProjector.truncateForDetail(this.messageProjector.safeJson(args));
		// 提取 ask_question 详情用于渲染提问卡片；支持批量（questions 数组）和单问题两种格式。
		// pi RPC 返回格式可能为 result.details 嵌套 或 result 顶层（无 details 包装）
		const askDetails = (() => {
			if (toolName !== "ask_question" || !result || typeof result !== "object") return undefined;
			// 格式 1: result.details.question 或 result.details.answers（批量）
			if ((result as any).details?.question || Array.isArray((result as any).details?.answers)) {
				return (result as any).details;
			}
			// 格式 2: result.question（无 details 包装）
			if ((result as any).question) {
				return result as any;
			}
			// 格式 3: 从 args 回退读取提问内容（当 result 仅为简单值如选中项字符串时）
			let parsedArgs: unknown = args;
			if (typeof args === "string") { try { parsedArgs = JSON.parse(args); } catch { parsedArgs = undefined; } }
			if (parsedArgs && typeof parsedArgs === "object" && (parsedArgs as any).question) {
				return {
					question: (parsedArgs as any).question,
					options: (parsedArgs as any).options,
					answer: typeof result === "string" ? result : (result as any).value ?? (result as any).answer,
					answered: true,
					answerLabel: typeof result === "string" ? result : (result as any).value ?? (result as any).answer,
				};
			}
			return undefined;
		})();
		const askCard = (() => {
			if (!askDetails) return undefined;
			// abort 时覆写 answer 为 null、answered 为 false，确保卡片显示"已取消"
			const aborted = this.abortedDuringAsk.has(agentId);
			// 单问题格式：details.question (string), details.answer
			if (askDetails.question) {
				return {
					question: askDetails.question,
					type: askDetails.type,
					answered: aborted ? false : askDetails.answered,
					answer: aborted ? null : askDetails.answer,
					answerLabel: aborted ? undefined : askDetails.answerLabel,
					options: askDetails.options,
				};
			}
			// 批量格式：保留完整问答列表，历史卡片才能同时展示每个问题与对应答案，
			// 不再只取第一题导致用户无法回看其余回答。
			if (Array.isArray(askDetails.answers) && askDetails.answers.length > 0) {
				const questions = Array.isArray(askDetails.questions) ? askDetails.questions : [];
				const batchQuestions = askDetails.answers.map((rawAnswer: unknown, index: number) => {
					const rawQuestion = questions[index];
					const questionText = typeof readAskField(rawQuestion, "question") === "string"
						? String(readAskField(rawQuestion, "question"))
						: String(readAskField(rawAnswer, "id") ?? "");
					const rawType = readAskField(rawAnswer, "type") ?? readAskField(rawQuestion, "type");
					const rawOptions = readAskField(rawQuestion, "options");
					return {
						question: questionText,
						type: typeof rawType === "string" ? rawType : "input",
						answered: !askDetails.cancelled && readAskField(rawAnswer, "value") !== null,
						answer: readAskField(rawAnswer, "value"),
						answerLabel: typeof readAskField(rawAnswer, "label") === "string" ? String(readAskField(rawAnswer, "label")) : undefined,
						options: Array.isArray(rawOptions) ? rawOptions : undefined,
					};
				});
				const firstQuestion = batchQuestions[0];
				return {
					...firstQuestion,
					questions: batchQuestions,
				};
			}
			return undefined;
		})();
		const meta = {
			status,
			toolName,
			toolCallId,
			startedAt,
			...(durationMs !== undefined ? { durationMs } : {}),
			args: argsMeta,
			result: this.messageProjector.truncateForDetail(this.messageProjector.extractToolResultText(result) || this.messageProjector.safeJson(result)),
			isError,
			detailText: detailDelivery.text,
			...(detailDelivery.truncated
				? { truncated: true, fullLength: detailDelivery.fullLength }
				: {}),
			// originalContent 不再存储到消息中（full file 会使会话元数据体积过大）。
			// diff 使用工具参数（oldText/newText 等）展示变动区域，无需完整文件快照。
			
			...(askCard ? { _askCard: askCard } : {}),
		};

		if (existing) {
			existing.text = text;
			existing.timestamp = Date.now();
			// 合并而非替换：重定向到投影版时保留其身份字段（entryId/_piDeckMsgSeq），
			// 否则渲染层接缝去重与编辑/删除/重发定位会因 entryId 丢失而失效。
			existing.meta = { ...(existing.meta ?? {}), ...meta };
			this.markMessagesDirtyFrom(agentId, existingToolIndex);
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "tool",
				text,
				timestamp: Date.now(),
				meta,
			});
			this.markMessagesDirtyFrom(agentId, list.length - 1);
		}

		this.messages.set(agentId, list);
		this.scheduleMessageEmit(agentId);
	}

	private addMessage(
		agentId: string,
		role: ChatMessage["role"],
		text: string,
		meta?: Record<string, unknown>,
		images?: ImageContent[],
	) {
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
		return this.applyRuntimeTitle(agentId, nextTitle);
	}

	private addDetailedErrorMessage(agentId: string, errorMessage?: string) {
		const retryMessageId = this.retryStatusMessageIds.get(agentId);
		const retryMessage = retryMessageId
			? this.messages.get(agentId)?.find((message) => message.id === retryMessageId)
			: undefined;
		const attempt = Number(retryMessage?.meta?.attempt ?? 0);
		const maxAttempts = Number(retryMessage?.meta?.maxAttempts ?? 0);
		const hasRetries = maxAttempts > 0;
		const fallback = errorMessage
			? `请求失败。${hasRetries ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : ""}`
			: `请求失败。${hasRetries ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : ""}\n\n请稍后重试。`;
		const i18nKey = errorMessage
			? hasRetries ? "diagnostic.requestFailedAfterRetries" : "diagnostic.requestFailed"
			: hasRetries ? "diagnostic.requestFailedUnknownAfterRetries" : "diagnostic.requestFailedUnknown";
		this.addLocalizedMessage(agentId, "error", i18nKey, fallback, {
			params: {
				attempt,
				maxAttempts,
			},
			debugDetails: errorMessage,
		});
	}

	private upsertRetryStatusMessage(
		agentId: string,
		event: Record<string, any>,
		status: "running" | "success" | "error",
	) {
		const list = this.messages.get(agentId) ?? [];
		let messageId = this.retryStatusMessageIds.get(agentId);
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
			i18nKey = delayMs > 0
				? "diagnostic.retryScheduledAfterDelay"
				: "diagnostic.retryScheduled";
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
	private buildActiveBranchEntryIds(
		entries: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
		leafId: string,
	): string[] {
		return buildActiveBranchEntryIdsForDisplay(entries, leafId);
	}

	private convertAgentMessages(
		agentId: string,
		rawMessages: unknown[],
		activeEntryIds?: string[],
	): ChatMessage[] {
		return this.messageProjector.convert(agentId, rawMessages, activeEntryIds);
	}

	/**
	 * The bundled ask_question extension wraps batch questions in one input request
	 * because Pi RPC dialogs are otherwise strictly sequential. Validate the shape
	 * before forwarding it so malformed extension data falls back to normal input.
	 */
	private tryParseBatchAskEnvelope(title: string): {
		review: boolean;
		questions: Array<Record<string, unknown>>;
	} | undefined {
		const raw = title.trim();
		if (!raw.startsWith("{")) return undefined;
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (parsed.__piDeckBatchAsk !== 1 || !Array.isArray(parsed.questions)) {
				return undefined;
			}
			const questions = parsed.questions.filter(
				(question): question is Record<string, unknown> => {
					if (!question || typeof question !== "object") return false;
					const typed = question as Record<string, unknown>;
					return (
						typeof typed.id === "string" &&
						typeof typed.question === "string" &&
						["select", "multi_select", "confirm", "input", "editor"].includes(String(typed.type))
					);
				},
			);
			return questions.length > 0
				? { review: parsed.review === true, questions }
				: undefined;
		} catch {
			return undefined;
		}
	}

	private scheduleUIRequestTimeout(agentId: string, requestId: string, timeout: unknown) {
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return;

		const timer = setTimeout(() => {
			if (!this.pendingUIRequests.get(agentId)?.has(requestId)) return;
			// A timeout must close both ends of the protocol. Merely hiding the
			// renderer form leaves Pi blocked on extension_ui_response indefinitely.
			this.sendUIResponse(agentId, requestId, { cancelled: true });
		}, Math.floor(timeout));
		timer.unref?.();
	}

	private scheduleIdleCheckAfterExtensionCommand(agentId: string) {
		const timer = setTimeout(() => {
			void this.markIdleIfPiReportsNoWork(agentId);
		}, 100);
		timer.unref?.();
	}

	private async markIdleIfPiReportsNoWork(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime || runtime.tab.status !== "running") return;
		if ((this.pendingUIRequests.get(agentId)?.size ?? 0) > 0) return;
		if (this.rpcCompactingAgents.has(agentId) || this.compactingAgents.has(agentId)) return;
		if (this.activeAssistantMessageIds.has(agentId)) return;
		if (this.toolExecutingByAgent.get(agentId)) return;

		const response = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => undefined);
		if (!response?.success || !response.data) return;

		const state = response.data as {
			isStreaming?: boolean;
			isCompacting?: boolean;
			pendingMessageCount?: number;
		};
		if (state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0) return;

		this.setAgentTurnActive(agentId, false);
		runtime.tab.status = "idle";
		this.finalizeThinkingIntoMessage(agentId);
		this.flushMessageEmit(agentId);
		// 兜底确认空闲同样视为一轮结束：重算尾部 9 轮窗口并裁剪运行期缓存。
		this.trimRuntimeCache(agentId);
		this.finishThinkingChannel(agentId);
		this.textEmitter.cancel(agentId);
		this.streamingText.delete(agentId);
		this.lastSentTextByAgent.delete(agentId);
		this.textPushCountByAgent.delete(agentId);
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
	 * 非聚焦会话收到 Ask 类 UI 请求时的桌面通知（SessionRuntimeCoordinator 调用）。
	 * 独立于 notifySessionEnd：由 askNotificationEnabled 单独门控（默认关闭），
	 * 即使用户关闭通用会话结束通知，仍可单独开启提问提醒，反之亦然。
	 * 每轮 run 只通知一次（去重标记在 agent_start 时清除），避免同一轮多次提问刷屏。
	 */
	notifyAskPending(agentId: string, sessionId: string, sessionTitle: string, question: string): void {
		try {
			const settings = this.settingsStore.get();
			if (!settings.askNotificationEnabled) return;
			if (!Notification.isSupported()) return;
			if (this.notifiedAskAgents.has(agentId)) return;
			this.notifiedAskAgents.add(agentId);

			const appName = app.getName();
			const title = sessionTitle || appName;
			// 有具体提问内容时展示问题，否则退回通用文案（批量提问等无 title 场景）
			const questionText = question.length > 60 ? `${question.slice(0, 60)}…` : question;
			const body = questionText
				? this.translate("mainNotification.askQuestion", { title, question: questionText })
				: this.translate("mainNotification.askPending", { title });
			const notification = new Notification({
				title: appName,
				body,
				silent: false,
				// 自定义 toast XML：launch 携带 sessionId，点击后经 pideck:// 协议唤起应用并跳转对应会话
				toastXml: this.buildToastXml(appName, body, sessionId),
			});
			// 点击通知：聚焦主窗口并切换到对应会话（session-first，跳转按 SessionRecord.id）
			notification.on("click", () => {
				this.focusMainWindowForSession(sessionId);
			});
			notification.on("failed", (_event, error) => {
				// Windows 拒绝显示 toast 时触发（show() 本身不抛异常），记 warn 便于排查
				void this.appLogger?.warn("agent", "Ask notification failed to show", { agentId, error: String(error) });
			});
			notification.show();
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
			if (!Notification.isSupported()) return;

			// 使用应用名称作为通知标题，在 Windows/macOS 通知中心中显示为应用标识
			const appName = app.getName();
			const body = this.translate("mainNotification.sessionDone", { title: sessionTitle });
			// 会话结束时 runtime 一定已绑定会话；跳转目标用 record.id（renderer 按它索引会话），
			// tab.sessionId 是 pi 侧会话 id 只能兜底（见 resolveNotificationSessionId 注释）。
			const resolveSessionId = this.resolveSessionId;
			const sessionId = resolveNotificationSessionId(
				resolveSessionId ? () => resolveSessionId(agentId) : undefined,
				this.agents.get(agentId)?.tab.sessionId,
			);
			const notification = new Notification({
				title: appName,
				body,
				silent: false,
				// 自定义 toast XML：launch 携带 sessionId，点击后经 pideck:// 协议唤起应用并跳转对应会话
				toastXml: this.buildToastXml(appName, body, sessionId),
			});
			notification.on("click", () => {
				this.focusMainWindowForSession(sessionId);
			});
			notification.on("failed", (_event, error) => {
				// Windows 拒绝显示 toast 时触发（show() 本身不抛异常），记 warn 便于排查
				void this.appLogger?.warn("agent", "Session notification failed to show", { agentId, error: String(error) });
			});
			notification.show();
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
	 * 生成带会话跳转参数的 Windows toast XML。
	 * 使用 activationType="protocol" + pideck:// 协议 URL：点击通知时 Windows 通过
	 * 注册表协议关联唤起应用（不依赖 ToastActivatorCLSID / 快捷方式匹配，更可靠），
	 * 被唤起实例的 argv 携带协议 URL，主实例据此识别要跳转的会话。
	 * sessionId 缺省时 launch 回退为 pideck:// 根地址（点击仅聚焦窗口）。
	 */
	private buildToastXml(title: string, body: string, sessionId?: string): string {
		const esc = (s: string) =>
			s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const launch = sessionId ? `pideck://session/${sessionId}` : "pideck://";
		return `<toast activationType="protocol" launch="${launch}">
  <visual>
    <binding template="ToastGeneric">
      <text>${esc(title)}</text>
      <text>${esc(body)}</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default" />
</toast>`;
	}

	/**
	 * 安排一次消息 emit。流式高频事件走节流合并（同一 agent 50ms 内多次调用只 emit 一次最新数组）；
	 * immediate=true 时跳过节流立即 flush，用于 message_end/tool_execution_end 等终态事件，确保最终状态不丢。
	 */
	/** 取/建 agent 的 stream gate 状态。 */
	private getStreamGate(agentId: string): StreamGateState {
		let gate = this.streamGates.get(agentId);
		if (!gate) {
			gate = createStreamGateState();
			this.streamGates.set(agentId, gate);
		}
		return gate;
	}

	/** abort 时封印当前 generation。 */
	private sealAgentStream(agentId: string) {
		const next = sealStreamGate(this.getStreamGate(agentId));
		this.streamGates.set(agentId, next);
	}

	/** agent_start 时尝试推进 generation；若仍在等 abort settled，则只记 pending。 */
	private openAgentStream(agentId: string) {
		const next = openStreamGateForNewRun(this.getStreamGate(agentId));
		this.streamGates.set(agentId, next);
	}

	/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
	private noteAgentAbortSettled(agentId: string) {
		this.clearAbortSettledFallback(agentId);
		const next = noteAbortSettled(this.getStreamGate(agentId));
		this.streamGates.set(agentId, next);
	}

	/**
	 * pi 偶发不发 agent_settled 时的兜底：超时后按 settled 处理，
	 * 避免用户立刻重发时新一轮永远无法接收流式事件。
	 * 同时触发 abort 升级检查：若 pi 仍未停稳，补发 abort_bash / 二次 abort。
	 */
	private scheduleAbortSettledFallback(agentId: string) {
		this.clearAbortSettledFallback(agentId);
		const timer = setTimeout(() => {
			this.abortSettledFallbackTimers.delete(agentId);
			// 仅在仍 waiting 时生效；正常 settled 路径会先 clear 定时器。
			if (this.getStreamGate(agentId).waitingForAbortSettled) {
				this.noteAgentAbortSettled(agentId);
			}
			// 工具执行中 abort 偶发不被 pi 及时处理（长 bash/扩展工具阻塞），
			// 若不升级，agent 会继续跑到工具结束，用户看到“停止不了”。
			void this.escalateAbortIfStillRunning(agentId);
		}, AgentManager.ABORT_SETTLED_FALLBACK_MS);
		timer.unref?.();
		this.abortSettledFallbackTimers.set(agentId, timer);
	}

	/**
	 * abort 升级：兜底窗口已过但 pi 仍在流式/执行，补发专用命令并验证。
	 * - abort_bash：pi 提供的杀 bash 进程树命令（RPC abort 不覆盖 bash 阻塞场景）
	 * - 二次 abort：覆盖 abort 事件与工具事件交错时被丢弃的竞态
	 * - 仍未停止则通过 notice 明确告知用户（stop 慢是可见问题，不能只写日志）
	 */
	private async escalateAbortIfStillRunning(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		try {
			const response = await runtime.process.client
				.request({ type: "get_state" }, 5_000)
				.catch(() => undefined);
			const isStreaming =
				response?.success &&
				Boolean((response.data as { isStreaming?: boolean } | undefined)?.isStreaming);
			if (!isStreaming) return; // pi 已停，无需升级
			void this.appLogger?.warn("agent", "Abort escalation: pi still streaming after abort", {
				agentId,
			});
			await runtime.process.client
				.request({ type: "abort_bash" }, 5_000)
				.catch(() => undefined);
			await runtime.process.client
				.request({ type: "abort" }, 5_000)
				.catch(() => undefined);
			// 第二轮验证：仍未停则通知用户，提示可重启会话。
			const verifyTimer = setTimeout(() => {
				void this.appLogger?.warn("agent", "Abort escalation: still running after second attempt", {
					agentId,
				});
				this.emit(ipcChannels.agentsNotice, {
					agentId,
					message: "停止响应较慢，可尝试重启会话",
					i18nKey: "app.abortSlow",
					kind: "warning",
					duration: 6000,
				});
			}, AgentManager.ABORT_ESCALATION_VERIFY_MS);
			verifyTimer.unref?.();
		} catch {
			// RPC 失败（进程退出等）不再升级；agent 生命周期由 exit 路径接管。
		}
	}

	private clearAbortSettledFallback(agentId: string) {
		const timer = this.abortSettledFallbackTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.abortSettledFallbackTimers.delete(agentId);
		}
	}

	/** 当前 generation 是否已封印，封印期间所有流式事件应丢弃。 */
	private isAgentStreamSealed(agentId: string): boolean {
		return isStreamGateSealed(this.getStreamGate(agentId));
	}

	/** agent 关闭/重建时清理 gate，避免泄漏到新生命周期。 */
	private clearStreamGate(agentId: string) {
		this.clearAbortSettledFallback(agentId);
		this.streamGates.delete(agentId);
		this.recentlyAborted.delete(agentId);
		this.thinkingEmitter.cancel(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		this.cancelMessageEmit(agentId);
	}

	/** 取消节流中的消息推送（不触发 emit），用于 abort/关闭时丢弃 pending 的旧内容。 */
	private cancelMessageEmit(agentId: string) {
		const timer = this.messageFlushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.messageFlushTimers.delete(agentId);
		}
		this.pendingMessageAgents.delete(agentId);
	}

	private scheduleMessageEmit(agentId: string, immediate = false) {
		if (immediate) {
			// 终态 immediate flush 永远全量：作为渲染层增量合并的天然校准点，
			// 丢弃的增量（长度不连续）由这里的全量纠正（message_end/tool 结束/加载完成）。
			this.messageDirtyFromByAgent.delete(agentId);
			this.flushMessageEmit(agentId);
			return;
		}
		if (this.pendingMessageAgents.has(agentId)) return;
		this.pendingMessageAgents.add(agentId);
		const timer = setTimeout(() => this.flushMessageEmit(agentId), AgentManager.MESSAGE_FLUSH_INTERVAL_MS);
		// 节流定时器不应阻止进程退出
		timer.unref?.();
		this.messageFlushTimers.set(agentId, timer);
	}

	private flushMessageEmit(agentId: string) {
		const timer = this.messageFlushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.messageFlushTimers.delete(agentId);
		}
		this.pendingMessageAgents.delete(agentId);
		const all = this.messages.get(agentId) ?? [];
		let dirtyFrom = this.messageDirtyFromByAgent.get(agentId);
		this.messageDirtyFromByAgent.delete(agentId);
		// 新一轮进入尾部后，窗口起点必须右移到最近 9 轮；坐标变化时升级为
		// 全量快照，并把滑出的完整轮次交给 renderer history 保存。
		const currentWindowStart = this.displayWindowStartByAgent.get(agentId) ?? 0;
		const lastComputedLength = this.displayWindowComputedLengthByAgent.get(agentId) ?? -1;
		let nextWindowStart = currentWindowStart;
		if (all.length !== lastComputedLength) {
			nextWindowStart = findTurnPageStart(
				all.map((message) => ({ role: message.role, byteLength: 0 })),
				all.length,
				AgentManager.DISPLAY_WINDOW_TURNS,
			);
			this.displayWindowComputedLengthByAgent.set(agentId, all.length);
		}
		if (nextWindowStart > currentWindowStart) {
			const slideOut = all.slice(currentWindowStart, nextWindowStart);
			if (slideOut.length > 0) {
				const pending = this.pendingSlideOutByAgent.get(agentId) ?? [];
				this.pendingSlideOutByAgent.set(agentId, [...pending, ...slideOut]);
			}
			dirtyFrom = undefined;
		}
		this.displayWindowStartByAgent.set(agentId, nextWindowStart);
		const windowStart = nextWindowStart;
		const payload = buildMessageFlushPayload(
			agentId,
			all,
			dirtyFrom,
			windowStart,
			this.sessionFileVersionByAgent.get(agentId),
			this.computeWindowStartFilePos(agentId, all, windowStart),
		);
		// trim 窗口右移滑出的旧窗口头部轮次随全量 flush 下发（渲染层并入历史前缀）；
		// 增量 flush 不携带（新轮还在写），等终态全量校准。
		if (payload.upsertFrom === undefined) {
			const slideOut = this.pendingSlideOutByAgent.get(agentId);
			if (slideOut && slideOut.length > 0) {
				// 与窗口段同口径脱敏（删 tool result 大载荷），避免前缀持有未脱敏副本
				payload.slideOut = stripToolResultForDelivery(slideOut);
				this.pendingSlideOutByAgent.delete(agentId);
			}
		}
		this.emit(ipcChannels.agentsMessage, payload);
		// 消息 flush 时顺带同步本地流式标志：text_delta 置位 streamingAgents 后，
		// 渲染进程必须及时拿到 isStreaming=true 才会走逐字渐显；此路径 50ms 节流、
		// 无 RPC（不发 get_state），不会像 emitRuntimeState 那样在高频 delta 下过重。
		this.emitStreamingStatePatch(agentId);
	}

	/** 轻量 runtime 状态补丁：只同步本地流式标志与工具执行状态，不发 RPC。 */
	private emitStreamingStatePatch(agentId: string) {
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: {
				isStreaming: this.streamingAgents.has(agentId),
				isExecutingTool: !!this.toolExecutingByAgent.get(agentId),
				executingToolName: this.toolExecutingByAgent.get(agentId) ?? undefined,
				toolStateSequence: this.toolStateSequenceByAgent.get(agentId) ?? 0,
			} as AgentRuntimeState,
		});
	}

	private setAgentTurnActive(agentId: string, isTurnActive: boolean) {
		if (this.agentTurnActiveById.get(agentId) === isTurnActive) return;
		this.agentTurnActiveById.set(agentId, isTurnActive);
		// agent_start/agent_end are protocol edges, so publish immediately instead
		// of waiting for the next asynchronous get_state snapshot.
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: { isTurnActive },
		});
	}

	/** 标记 agent 消息数组自 index 起变脏（多次标记取最小值），供增量 flush 使用。 */
	private markMessagesDirtyFrom(agentId: string, index: number) {
		const prev = this.messageDirtyFromByAgent.get(agentId);
		if (prev === undefined || index < prev) {
			this.messageDirtyFromByAgent.set(agentId, Math.max(0, index));
		}
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
		const trimmedStart = turnTrimStartIndex(list, AgentManager.MAX_RUNTIME_CACHE_TURNS);
		const trimmed = list.slice(trimmedStart);
		const didTrim = trimmed.length !== list.length;
		const currentWindowStart = this.displayWindowStartByAgent.get(agentId) ?? 0;
		const nextWindowStartInList = findTurnPageStart(
			list.map((m) => ({ role: m.role, byteLength: 0 })),
			list.length,
			AgentManager.DISPLAY_WINDOW_TURNS,
		);
		// 不超过 12 轮时也要校准尾部 9 轮窗口。通常 settled 前的 flush 已经做过这步，
		// 这里保留独立调用时的兜底，避免新会话在 12 轮以内把全部消息留在 atom。
		if (!didTrim) {
			if (nextWindowStartInList > currentWindowStart) {
				const slideOut = list.slice(currentWindowStart, nextWindowStartInList);
				if (slideOut.length > 0) {
					const pending = this.pendingSlideOutByAgent.get(agentId) ?? [];
					this.pendingSlideOutByAgent.set(agentId, [...pending, ...slideOut]);
				}
				this.displayWindowStartByAgent.set(agentId, nextWindowStartInList);
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
			this.messageHeadOffsetByAgent.set(
				agentId,
				prevHeadOffset + countRoleMessagesBefore(list, trimmedStart),
			);
		}
		this.messages.set(agentId, next);
		// 裁剪后数组下标空间前移，尾部 9 轮的身份不变但数值起点改变；
		// 先重置坐标，再用全量 flush 校准 renderer。
		this.displayWindowStartByAgent.set(
			agentId,
			findTurnPageStart(
				next.map((m) => ({ role: m.role, byteLength: 0 })),
				next.length,
				AgentManager.DISPLAY_WINDOW_TURNS,
			),
		);
		this.markMessagesDirtyFrom(agentId, 0);
		this.flushMessageEmit(agentId);
	}

	/** 节流推送 live 思考（done=false）；无段身份时丢弃。 */
	private emitThinkingNow(agentId: string, text: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment) return;
		// 增量推送（同正文通道治理）：只发上次快照之后的新字符；非 append
		// （重置/ANSI 变化）或距上次快照超过 50 次推送（≈2.5s）时补一次全量，
		// 兜底渲染层 HMR/晚绑定丢失的增量。
		const lastSent = this.lastSentThinkingByAgent.get(agentId) ?? "";
		const pushCount = (this.thinkingPushCountByAgent.get(agentId) ?? 0) + 1;
		const sendFull = !text.startsWith(lastSent) || pushCount >= 50;
		const update: ThinkingUpdate = {
			agentId,
			id: segment.id,
			...(!sendFull
				? { delta: text.slice(lastSent.length) }
				: { text }),
			startedAt: segment.startedAt,
			endedAt: segment.endedAt,
			done: false,
		};
		this.lastSentThinkingByAgent.set(agentId, text);
		this.thinkingPushCountByAgent.set(agentId, sendFull ? 0 : pushCount);
		this.emit(ipcChannels.agentsThinking, update);
	}

	/**
	 * 从 message_update 的 partialMessage 提取累积正文；无法提取时返回 undefined，
	 * 调用方回退到「旧累积 + delta」拼接（兼容仅带 delta 的事件格式）。
	 */
	private extractStreamingText(agentId: string, partialMessage?: unknown): string | undefined {
		if (partialMessage && typeof partialMessage === "object") {
			const text = this.messageProjector.extractText((partialMessage as any).content);
			if (text) return text;
		}
		return undefined;
	}

	/** 推送独立流式正文通道（agents:text-stream），渲染层写入 streamingTextByIdAtom。
	 *  done=true 表示本轮回答结束（message_end），渲染层据此把 streaming 置 false。
	 *  顺带同步 isStreaming 补丁：text_delta 走独立通道后不再触发 flushMessageEmit，
	 *  若仍只在 flush 里推 patch，渲染层拿不到 isStreaming=true，气泡不会渲染。
	 *
	 *  增量推送（2026-08 IPC 治理）：正常 append 只发 delta；非 append（重置/
	 *  ANSI 变化）或距上次全量超过 50 次推送（≈2.5s）时改发全量快照（text 字段），
	 *  渲染层据此替换本地累积。done 时清空 delta 基准。 */
	private emitTextStreamNow(agentId: string, text: string, done = false) {
		const lastSent = this.lastSentTextByAgent.get(agentId) ?? "";
		const pushCount = (this.textPushCountByAgent.get(agentId) ?? 0) + 1;
		const sendFull = !text.startsWith(lastSent) || pushCount >= 50;
		const payload: {
			agentId: string;
			text?: string;
			delta?: string;
			done: boolean;
		} = {
			agentId,
			...(!sendFull ? { delta: text.slice(lastSent.length) } : { text }),
			done,
		};
		this.lastSentTextByAgent.set(agentId, text);
		this.textPushCountByAgent.set(agentId, sendFull ? 0 : pushCount);
		if (done) {
			this.lastSentTextByAgent.delete(agentId);
			this.textPushCountByAgent.delete(agentId);
		}
		this.emit(ipcChannels.agentsTextStream, payload);
		this.emitStreamingStatePatch(agentId);
	}

	private emitState() {
		const tabs = this.list();
		this.emit(ipcChannels.agentsState, tabs);
		// 同步通知主进程内部状态订阅者（PetStateBridge），使宠物窗能拿到聚合状态。
		// 设计文档原拟用 ipcMain.on("agents:state") 桥接是错的：webContents.send 是
		// 主进程→渲染层单向通道，ipcMain 收不到主进程自己发出的消息，故改用本钩子。
		this.notifyStateListeners(tabs);
	}

	private emit(channel: string, payload: unknown) {
		for (const listener of this.outputListeners) listener(channel, payload);
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		window.webContents.send(channel, payload);
	}
}

type AgentRuntime = {
	tab: AgentTab;
	process: PiProcess;
};
