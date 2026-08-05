import { app, type BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type {
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ForkMessage,
	I18nParams,
	ImageContent,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionMessagePage,
	ThinkingUpdate,
} from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { PiProcess } from "./PiProcess";
import { listActiveBuiltInExtensionPaths } from "../extensions/builtInExtensions";
import type { RpcResponse } from "./PiRpcClient";
import { formatBashToolMessage } from "./bashResult";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { mergeHistoryWithPreservedMessages } from "./historyMessages";
import {
	buildAgentSessionKey,
	type AgentSessionIdentityDefaults,
} from "./agentSessionIdentity";
import {
	SessionFileEditor,
	type SessionEntryTarget,
	type SessionFileRef,
} from "./SessionFileEditor";
import { SessionHistoryReader } from "./SessionHistoryReader";
import {
	AgentMessageProjector,
	buildActiveBranchEntryIds as buildActiveBranchEntryIdsForDisplay,
} from "./AgentMessageProjector";
import { LatestByKeyEmitter } from "./LatestByKeyEmitter";
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
	cleanTitle,
	inferTitleFromMessages,
	isDefaultAgentTitle,
} from "./agentUtils";
import {
  updateActiveToolCalls,
  type ActiveToolCallState,
} from "../../shared/toolRuntimeState";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RpcLogger } from "../logging/RpcLogger";
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

export class AgentManager {
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly messages = new Map<string, ChatMessage[]>();

	/** 当前流式思考的累积文本，用于实时推送给前端展示 */
	private readonly streamingThinking = new Map<string, string>();
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
	private readonly thinkingEmitter = new LatestByKeyEmitter<string, string>(
		50,
		(agentId, thinking) => this.emitThinkingNow(agentId, thinking),
	);
	/** 流式 emit 合并窗口（毫秒）。50ms 兼顾流畅度与传输量，肉眼几乎无延迟。 */
	private static readonly MESSAGE_FLUSH_INTERVAL_MS = 50;
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
	 * 原值 8 对于一些需要回看较多历史的长会话偏少，提高至 30 轮。
	 */
	private static readonly MAX_HISTORY_LOAD_TURNS = 30;
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
	/** 正在执行手动压缩操作的 agent，用于区分手动压缩重启和异常崩溃 */
	private readonly compactingAgents = new Set<string>();
	/**
	 * Pi 通过事件报告正在自动/手动压缩的 agent。
	 * 自动压缩发生在 agent_end 之后，桌面端若不单独追踪，会过早把会话置为 idle，
	 * 用户随后发送的新消息可能撞上 Pi 内部 compaction，表现为“会话中断”。
	 */
	private readonly rpcCompactingAgents = new Set<string>();
	/** 正在执行模型配置刷新的 agent，用于退出处理器中忽略进程退出事件 */
	private readonly modelRefreshingAgents = new Set<string>();
	/** 用户主动停止的 agent，用于退出处理器中跳过自动重连 */
	private readonly userInitiatedStop = new Set<string>();
	/** 已尝试过自动重连的 agent（防止无限循环），重连成功后清除 */
	private readonly autoRestartAttempted = new Set<string>();
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
	/** abort 后等待 agent_settled 的超时定时器；避免 pi 漏发 settled 导致永久封印。 */
	private readonly abortSettledFallbackTimers = new Map<string, NodeJS.Timeout>();
	/** abort settled 兜底超时：覆盖多数管道残留，同时不让“立刻重发”永久卡死。 */
	private static readonly ABORT_SETTLED_FALLBACK_MS = 1500;

	/**
	 * 待处理的 Extension UI 请求。key 为 agentId，value 为 Map<requestId, { method, title, options }>。
	 * 用于在 abort 时及时发送 cancellation 防止 pi 等待超时。
	 */
	private readonly pendingUIRequests = new Map<string, Map<string, { method: string; title: string }>>();
	/** abort 时正在等待 ask_question 响应的 agent，用于在工具结果中覆写 answer 为 null。 */
	private readonly abortedDuringAsk = new Set<string>();
	/** 待处理的项目信任确认请求。key 为 requestId，用于在 Agent 启动前等待用户的信任决策。 */
	private readonly pendingTrustRequests = new Map<string, { resolve: (choice: ProjectTrustChoice) => void }>();
	private wslEnvironment: WslEnvironment | null = null;

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
	 * 统一构造 PiProcess：注入 PiDeck 内置扩展路径解析。
	 * 内置扩展以 -e 从 app resources 加载，不再依赖用户扩展目录副本。
	 */
	private createPiProcess(cwd: string): PiProcess {
		const settings = this.settingsStore.get();
		return new PiProcess(cwd, settings, undefined, {
			resolveBuiltInExtensionPaths: (processSettings) =>
				listActiveBuiltInExtensionPaths(
					{
						appPath: app.getAppPath(),
						resourcesPath: process.resourcesPath,
						isDev: !app.isPackaged,
					},
					processSettings?.removedBuiltInExtensions ?? settings.removedBuiltInExtensions ?? [],
				),
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
	 * The reader owns persisted JSONL parsing and paging. This facade keeps the
	 * Session-first public contract on AgentManager while runtime remains inactive.
	 */
	async readSessionDisplayMessages(
		sessionPath: string,
		agentId = "_viewer",
		sessionContent?: string,
	): Promise<ChatMessage[]> {
		return this.sessionHistoryReader.readSessionDisplayMessages(
			sessionPath,
			agentId,
			sessionContent,
		);
	}

	async readSessionDisplayMessagePage(
		sessionPath: string,
		agentId = "_viewer",
		before?: number,
		pageSize?: number,
	): Promise<SessionMessagePage> {
		return this.sessionHistoryReader.readSessionDisplayMessagePage(
			sessionPath,
			agentId,
			before,
			pageSize,
		);
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

		// 并行请求：get_messages 和 get_entries 互不依赖，可以同时发起
		// 如果已有提前发出的请求（earlyMessagesPromise），直接复用，避免重复发送
		const messagesPromise = earlyMessagesPromise ?? runtime.process.client.request({
			type: "get_messages",
		});

		let entriesPromise: Promise<any> | undefined;
		if (!skipEntries) {
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
		if (entriesResult) {
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
			const archiveData = await this.parseSessionArchives(runtime.tab.sessionPath, agentId).catch((err) => {
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
					archivedMessageCounts: [...archiveData.archivedMessagesByCompactionId.entries()].map(([id, msgs]) => ({ compactionId: id, count: msgs.length })),
				});

				const last = archiveData.compactions[archiveData.compactions.length - 1];
				const archivedMessages = archiveData.archivedMessagesByCompactionId.get(last.id) ?? [];

				if (!rpcAlreadyHasSummary) {
					// RPC 未返回摘要 → 我们自己创建压缩卡片
					compactionSummaryRaw = {
						role: "compactionSummary",
						summary: last.summary || this.translate("session.summaryPlaceholder"),
						timestamp: last.timestamp ? Date.parse(last.timestamp) : Date.now(),
						meta: {
							compactionId: last.id || null,
							compactionCount: archiveData.compactions.length,
							firstKeptEntryId: last.firstKeptEntryId,
							tokensBefore: last.tokensBefore,
							archivedMessages,
						},
					};
				} else {
					// RPC 已返回摘要 → 找到它并注入 archivedMessages（pi 的摘要不带归档消息）
					for (const msg of trimmed) {
						const m = msg as Record<string, unknown>;
						if (m.role === "compactionSummary") {
							m.meta = (m.meta as Record<string, unknown> | null) ?? {};
							(m.meta as Record<string, unknown>).archivedMessages = archivedMessages;
							break;
						}
					}
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
		const nextMessages = mergeHistoryWithPreservedMessages(
			messages,
			this.messages.get(agentId) ?? [],
			options?.preserveMessagesAfter,
		);
		this.messages.set(agentId, nextMessages);
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

	private async parseSessionArchives(
		sessionPath: string,
		agentId: string,
		sessionContent?: string,
	) {
		return this.sessionHistoryReader.parseSessionArchives(
			sessionPath,
			agentId,
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
		const process = this.createPiProcess(project.path);
		process.on("version-check", (payload) => {
			void this.appLogger?.info("agent", "Pi version check completed", {
				agentId: id,
				...(payload && typeof payload === "object" ? payload : {}),
			});
		});
		const runtime: AgentRuntime = { tab, process };
		this.agents.set(id, runtime);
		this.messages.set(id, []);
		this.emitState();

		// 关键：监听器必须在 process.start() 之前挂上。
		// spawn 的 ENOENT / EACCES 等 error 事件是异步的；若等 start() 返回后再 on("error")，
		// 中间窗口可能 0 listener，EventEmitter 会把 error 升级成未捕获异常，
		// 在部分 macOS arm 环境上表现为“一点启动 Agent 就闪退”。
		this.attachPiProcessLifecycle(id, process, {
			projectPath: project.path,
			onExit: (payload) => this.handleCreateProcessExit(id, tab, payload),
		});

		let client: Awaited<ReturnType<PiProcess["start"]>>;
		try {
			client = await process.start(input.sessionPath, trustOverride, input.noSession);
		} catch (error) {
			// start() 同步失败（非法 cwd、spawn 抛错等）也要落到会话错误卡，而不是 IPC 裸抛。
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Agent pi process start threw", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
				diagnostics: process.getDiagnostics(),
				// 注意：局部变量 process 是 PiProcess，宿主平台要用 globalThis.process
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			this.addMessage(id, "error", this.buildStartupFailureMessage(rawMessage, process.getDiagnostics()));
			this.emitState();
			return tab;
		}
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
		});

		// 启动后先获取状态，get_messages 必须等状态就绪后再发送，
		// 确保 pi 进程已完全加载会话文件，避免竞态导致返回空结果。
		void this.appLogger?.info("agent", "Agent get_state request start", { agentId: id });
		const statePromise = client.request({ type: "get_state" });
		const historyLoadDecision = this.getHistoryAutoLoadDecision(input.sessionPath);


		try {
			void this.appLogger?.info("agent", "Agent get_state request completed", { agentId: id });
			const state = await statePromise;
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
			tab.sessionPath = data?.sessionFile ?? input.sessionPath;
			tab.title =
				input.title ||
				data?.sessionName ||
				(input.sessionPath
					? this.translate("session.historyTitle", { project: project.name })
					: `${project.name} agent`);
			tab.status = "idle";
			// 大历史会话的 get_messages 可能需要十几秒；Agent 可用只依赖 get_state，
			// 因此历史消息后台加载，避免 40MB+ 会话把“打开 Agent”阻塞到十几秒。
			// 同时插入一条临时系统消息，给用户明确的加载反馈，避免空白页面看起来像冻结。
			// preserveMessagesAfter 保护加载期间用户新发的消息/流式回复，防止历史结果回写时覆盖当前会话。
			// 状态就绪后发送 get_messages，确保 pi 进程已完全加载会话文件，避免竞态。
			const messagesPromise = historyLoadDecision.shouldLoad
				? client.request({ type: "get_messages" })
				: undefined;
			const preserveMessagesAfter = Date.now();
			if (messagesPromise) {
				void this.loadMessages(id, true, messagesPromise, { preserveMessagesAfter })
					.catch(() =>
						new Promise<void>((resolve) => setTimeout(resolve, 800))
							.then(() => this.loadMessages(id, true, undefined, { preserveMessagesAfter })),
					)
					.then(() => {
						void this.appLogger?.info("agent", "Agent history loaded in background", {
							agentId: id,
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
						void this.appLogger?.warn("agent", "Agent history background load failed", {
							agentId: id,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			} else if (input.sessionPath) {
				void this.loadMessages(
					id,
					true,
					this.readRecentMessagesFromSessionFile(
						input.sessionPath,
						AgentManager.MAX_HISTORY_LOAD_TURNS,
					),
					{ preserveMessagesAfter },
				)
					.then(() => {
						void this.appLogger?.info("agent", "Agent recent history loaded from file", {
							agentId: id,
							sessionPath: input.sessionPath,
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
							sessionPath: input.sessionPath,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				totalMs: Date.now() - t0,
				historyLoading: "background",
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
			});
			// 构建丰富的错误诊断信息
			const diag = process.getDiagnostics();
			let debugDetails: string | undefined;
			if (diag) {
				const lines: string[] = [];
				// 退出码
				if (diag.exitCode !== null) {
					lines.push(`Exit code: ${diag.exitCode}${diag.exitSignal ? ` (signal: ${diag.exitSignal})` : ""}`);
				}
				// stderr 输出（截取末尾最有用的部分）
				const stderrText = diag.stderr.join("").trim();
				if (stderrText) {
					// 只保留末尾 600 字符，避免刷屏
					const snippet = stderrText.length > 600 ? "…" + stderrText.slice(-600) : stderrText;
					lines.push(`Process stderr:\n${snippet}`);
				}
				// pi 路径与版本检测
				lines.push(`Pi command: ${diag.command}`);
				if (diag.customPiPath) {
					lines.push(`Configured path: ${diag.customPiPath}`);
				}
				lines.push(`Working directory: ${diag.cwd}`);
				lines.push(`Version check: ${diag.versionCheck ? "passed" : "failed"}`);

				// 诊断与指引
				lines.push("");
				lines.push("Troubleshooting");
				if (!diag.versionCheck) {
					lines.push("1. Run pi --version in a terminal and verify the configured path.");
					lines.push("2. If Pi is missing, run npm install -g @earendil-works/pi-coding-agent.");
					lines.push("3. Run pi --version again after installation.");
				} else if (diag.exitCode !== 0) {
					lines.push("1. Run pi --mode rpc in a terminal.");
					lines.push("2. Resolve the error reported by Pi before retrying.");
				} else if (!stderrText && diag.exitCode === null) {
					lines.push("1. Pi may still be starting. Increase the RPC timeout in settings and retry.");
				} else {
					lines.push("1. Run pi --mode rpc and verify that Pi starts successfully.");
					lines.push("2. Verify the Pi path in settings.");
				}
				lines.push("");
				lines.push("If the problem persists, include these diagnostics in a GitHub issue.");

				debugDetails = lines.join("\n");
			}
			this.addLocalizedMessage(id, "error", "diagnostic.agentStartFailed", "Pi RPC 启动失败。", {
				debugDetails: [rawMessage, debugDetails].filter(Boolean).join("\n\n"),
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

		runtime.tab.title = trimmed;
		const state = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => ({ data: undefined }));
		const data = state.data as
			| { sessionId?: string; sessionFile?: string; sessionName?: string }
			| undefined;
		runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
		runtime.tab.sessionPath = data?.sessionFile ?? runtime.tab.sessionPath;
		runtime.tab.title = data?.sessionName || runtime.tab.title;
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
			this.emitState();
			return { accepted: false, error: errorMessage, i18nKey: "diagnostic.agentStopped" };
		}

		runtime.tab.status = "running";
		this.emitState();

		// 乐观更新：在等待 RPC 返回前先把用户消息写入会话，让用户立即看到自己的消息。
		// 只展示用户原文；agentMessage 里的宿主指令不进 UI 气泡。
		// 如果后续 RPC 失败，再追加错误消息；用户消息本身仍保留在聊天中（用户确已发送）。
		this.addMessage(
			input.agentId,
			"user",
			trimmed || this.translate("session.imagePlaceholder"),
			promptDeliveryBehavior ? { streamingBehavior: promptDeliveryBehavior } : undefined,
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
		// 封印当前 stream generation：比 recentlyAborted 更硬，不依赖 activeAssistantMessageIds 例外条件，
		// 残留 thinking/text/tool 事件在 abort settled 前一律丢弃。
		this.sealAgentStream(agentId);
		this.scheduleAbortSettledFallback(agentId);

		runtime.process.client
			.request({ type: "abort" }, 10_000)
			.catch(() => {
				// abort 超时或失败不影响前端状态切换
			});

		// Pending dialogs are runtime-only, so clearing their request map is enough.
		if (pending && pending.size > 0) {
			this.pendingUIRequests.delete(agentId);
		}
		// abort 时必须清除所有流式状态，防止后续 pi 的延迟事件（text_delta、thinking_delta、tool_execution_* 等）
		// 修改上次会话的旧消息，导致新会话消息混入被中止的旧输出。
		this.activeAssistantMessageIds.delete(agentId);
		this.streamingThinking.delete(agentId);
		this.toolMessageIds.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.set(agentId, null);
		// 取消节流中的 thinking/message 推送，避免 abort 后还有 pending flush 把旧内容刷回 UI。
		this.thinkingEmitter.cancel(agentId);
		this.emitThinking(agentId, "");
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

		// 标记压缩中，退出处理器据此区分压缩重启与异常崩溃
		this.compactingAgents.add(agentId);

		try {
			const response = await runtime.process.client.request(
				trimmedPrompt ? { type: "compact", prompt: trimmedPrompt } : { type: "compact" },
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
			// 压缩成功且进程未退出，直接加载消息
			await this.loadMessages(agentId).catch(() => undefined);
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
				await this.loadMessages(agentId).catch(() => undefined);
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

		const process = this.createPiProcess(project.path);
		// 与 createUnlocked 同理：监听器必须在 start() 前挂上，
		// 避免重连窗口期 spawn error 变成未捕获异常。
		this.attachPiProcessLifecycle(agentId, process, {
			projectPath: project.path,
			onExit: (payload) => this.handleReattachProcessExit(agentId, runtime, payload),
		});
		const client = await process.start(sessionPath);
		const restartDiag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process restarted", {
			agentId,
			command: restartDiag?.command,
			args: restartDiag?.args?.join(' '),
			cwd: restartDiag?.cwd,
		});


		// 替换旧进程引用（但不修改 agents map 中的 key）
		runtime.process = process;

		try {
			const stateResponse = await client.request({ type: "get_state" });
			const data = stateResponse.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			runtime.tab.sessionPath = data?.sessionFile ?? sessionPath;
			runtime.tab.title = data?.sessionName ?? runtime.tab.title;
			runtime.tab.status = "idle";
			// 进程退出型压缩可能来不及发 compaction_end；重连成功即表示 Pi 已可继续接收消息。
			this.rpcCompactingAgents.delete(agentId);

			// 重连成功后清除自动重连标记，允许下一次再触发
			this.autoRestartAttempted.delete(agentId);

			// 如果有旧的 pending abort 标记，清理掉
			this.abortedDuringAsk.delete(agentId);

			await this.loadMessages(agentId).catch(() => undefined);

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
				.request({ type: "get_state" })
				.catch(() => ({ data: undefined })),
			runtime.process.client
				.request({ type: "get_session_stats" })
				.catch(() => ({ data: undefined })),
			runtime.tab.sessionPath
				? this.getSessionCacheHitStats(runtime.tab.sessionPath)
				: Promise.resolve({ latest: undefined as number | undefined, average: undefined as number | undefined, sampleCount: 0 }),
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
	return {
		modelName: model?.name ?? model?.id,
		provider: model?.provider,
		modelId: model?.id,
		thinkingLevel: state?.thinkingLevel,
		isStreaming: state?.isStreaming,
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

	async setModel(agentId: string, provider: string, modelId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "set_model", provider, modelId },
			60_000,
		);
		if (!response.success) {
			// pi 对 set_model 用启动时加载的模型快照校验；模型不在快照中返回
			// "Model not found: provider/model"。若本地 models.json 确实有该模型，
			// 说明是运行中 Agent 未加载新配置——抛带 needsRestart 标记的错误，
			// 渲染层据此引导用户重启 Agent（新进程会重新加载 models.json）。
			const errorText = response.error ?? "";
			if (/model not found/i.test(errorText)) {
				const localHasModel = await this.localModelsContains(provider, modelId);
				if (localHasModel) {
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
				await this.loadMessages(agentId).catch(() => undefined);
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
	 * A current Pi leaf constrains every locator, including explicit entry IDs.
	 * If the RPC is unavailable, SessionFileEditor falls back to the last valid leaf.
	 */
	private async getActiveSessionLeafId(
		agentId: string,
		runtime: AgentRuntime,
	): Promise<string | undefined> {
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

	async editMessage(agentId: string, messageId: string, newText: string) {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");
		const message = this.messages.get(agentId)?.find((candidate) => candidate.id === messageId);
		if (!message) throw new Error("Message not found");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		await this.sessionFileEditor.editMessage({
			file,
			target: this.createSessionEntryTarget(message, activeLeafId),
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
		const message = this.messages.get(agentId)?.find((candidate) => candidate.id === messageId);
		if (!message) throw new Error("Message not found");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		await this.sessionFileEditor.deleteMessage({
			file,
			target: this.createSessionEntryTarget(message, activeLeafId),
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Delete message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
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
		const message = this.messages.get(agentId)?.find((candidate) => candidate.id === messageId);
		if (!message) throw new Error("Message not found");
		if (message.role !== "user") throw new Error("Only user messages can be resent");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		await this.sessionFileEditor.truncateForResend({
			file,
			target: this.createSessionEntryTarget(message, activeLeafId),
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Prepare resend completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
		return {
			text: message.text,
			...(message.images?.length ? { images: message.images } : {}),
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
	 * 重启 agent 进程：停止当前 pi RPC 子进程，用同一个 session 重新启动。
	 * 适用场景：修改了 provider 配置、切换了 API key、更新了 pi 版本后，
	 * /reload 只重载 extension，不会重新读取配置文件，restart 才能生效。
	 */
	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
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
				});
				sessionPath =
					(state.data as { sessionFile?: string } | undefined)?.sessionFile ??
					undefined;
			} catch {
				// 获取失败时继续用 undefined，create 会启动新 session
			}
		}

		// 停止旧进程并清理状态
		runtime.process.stop();
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
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
	async cloneSessionFile(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request({ type: "clone" }, 120_000);
			const state = await process.client.request({ type: "get_state" });
			return {
				...((response.data as object | undefined) ?? {}),
				sessionPath: (state.data as { sessionFile?: string } | undefined)?.sessionFile,
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
		const process = this.createPiProcess(project.path);
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
			.request({ type: "get_state" })
			.catch(() => ({ data: undefined }));
		const state = stateResponse.data as { sessionFile?: string; sessionName?: string } | undefined;
		if (state?.sessionFile) runtime.tab.sessionPath = state.sessionFile;
		if (state?.sessionName) runtime.tab.title = state.sessionName;
		await this.loadMessages(agentId).catch(() => undefined);
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
		// 标记用户主动停止，退出处理器将跳过自动重连
		this.userInitiatedStop.add(agentId);
		const process = runtime.process;
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		this.clearStreamGate(agentId);
		// agent 关闭时自动关闭 RPC 日志记录
		this.rpcLoggingAgents.delete(agentId);
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

	private notifyStateListeners(tabs: AgentTab[]) {
		for (const listener of this.stateListeners) {
			try { listener(tabs); } catch {}
		}
	}

	stopAll() {
		// 应用退出时统一清理所有 pi 子进程，避免后台 agent 残留占用模型或文件句柄。
		for (const runtime of this.agents.values()) {
			this.userInitiatedStop.add(runtime.tab.id);
			runtime.process.stop();
		}
		this.agents.clear();
		this.messages.clear();
		// 退出时统一清理所有 gate / abort 兜底定时器，避免泄漏到下一次生命周期。
		for (const agentId of [...this.streamGates.keys()]) this.clearStreamGate(agentId);
		this.recentlyAborted.clear();
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
				const logEntry = {
					id: randomUUID(),
					agentId,
					direction: entry.direction,
					summary,
					data,
					time: Date.now(),
				};
				this.emit(ipcChannels.agentsRpcLog, logEntry);
				// 只有用户手动开启 RPC 日志记录的 agent 才落盘
				if (this.rpcLoggingAgents.has(agentId)) {
					this.rpcLogger?.push(logEntry);
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
					diagnostics: piProcess.getDiagnostics(),
				});
				options.onExit(payload);
			} catch (error) {
				void this.appLogger?.error("agent", "Pi process exit handler failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		piProcess.on("error", (error: Error) => {
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
		// 模型配置刷新期间的进程退出由 refreshModels() 负责重连，此处静默忽略
		if (this.modelRefreshingAgents.has(agentId)) return;
		// 用户主动停止 → 不自动重连
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			tab.status = "closed";
			this.emitState();
			return;
		}
		// 手动压缩期间退出 → compact() 的 catch 块会负责重连
		if (this.compactingAgents.has(agentId)) {
			tab.status = "closed";
			this.emitState();
			return;
		}
		// 自动压缩 / 进程干净退出（exit code 0）且有会话路径 → 尝试一次自动重连
		if (!this.autoRestartAttempted.has(agentId) && tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			tab.status = "starting";
			this.emitState();
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
					this.addLocalizedMessage(
						agentId,
						"error",
						"diagnostic.processReconnectFailed",
						"Agent 进程意外退出，自动重连失败",
					);
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
		this.emitState();
	}

	/** reattach 路径的进程 exit：同样做单次自动重连保护。 */
	private handleReattachProcessExit(
		agentId: string,
		runtime: AgentRuntime,
		payload: { code: number | null; signal: string | null },
	) {
		if (this.modelRefreshingAgents.has(agentId)) return;
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			runtime.tab.status = "closed";
			this.emitState();
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
					this.emitState();
				});
			return;
		}
		runtime.tab.status = "closed";
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
		// 通知本地监听器（FeishuBridge 等主进程内部订阅）
		for (const listener of this.localEventListeners) {
			try { listener(agentId, event); } catch {}
		}
		this.emit(ipcChannels.agentsEvent, { agentId, event });

		if (!event || typeof event !== "object") return;
		const typed = event as Record<string, any>;
		const runtime = this.agents.get(agentId);

		// 扩展/RPC 调用 setSessionName 后 Pi 会发 session_info_changed；
		// 同步到 tab.title，使侧边栏与手动 rename 路径看到同一标题。
		// 忽略空 name，避免把已有标题抹掉。
		if (typed.type === "session_info_changed" && runtime) {
			const name =
				typeof typed.name === "string"
					? typed.name.replace(/\s+/g, " ").trim()
					: "";
			if (name && name !== runtime.tab.title) {
				runtime.tab.title = name;
				this.emitState();
			}
		}

		if (typed.type === "agent_start" && runtime) {
			// agent_start 表示一轮新的 agent run 开始：
			// 1) 清理 recentlyAborted，允许状态机恢复 running
			// 2) 推进 stream generation，解封流式闸门（唯一合法解封点）
			this.recentlyAborted.delete(agentId);
			this.openAgentStream(agentId);
			runtime.tab.status = "running";
			this.activeAssistantMessageIds.delete(agentId);
			this.toolMessageIds.delete(agentId);
			this.activeToolCallsByAgent.delete(agentId);
			this.toolExecutingByAgent.set(agentId, null);
			this.emitState();
		}

		if (typed.type === "message_start" && typed.message?.role === "assistant") {
			// abort 封印后的残留 assistant 事件应丢弃，防止误重新激活流式状态。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.beginAssistantMessage(agentId);
			this.upsertAssistantMessage(agentId, typed.message);
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
			// agent_end 只表示一次底层 run 结束；Pi 之后仍可能执行自动重试、自动压缩，
			// 或压缩后继续 queued follow-up。最终空闲必须等 agent_settled，避免中途误判 idle。
			if (runtime) {
				this.activeAssistantMessageIds.delete(agentId);
				this.toolMessageIds.delete(agentId);
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
			} else if (
				typed.stopReason === "error" ||
				errorMessages.length > 0
			) {
				this.addDetailedErrorMessage(agentId);
				if (runtime) runtime.tab.status = "error";
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
			this.noteAgentAbortSettled(agentId);
			this.recentlyAborted.delete(agentId);
			if (runtime && runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
				// agent_settled 是 Pi 的最终稳定点：没有自动重试、自动压缩、压缩 retry
				// 或 queued follow-up 会继续执行，此时才允许恢复 idle 并通知用户完成。
				runtime.tab.status = "idle";
				this.streamingThinking.delete(agentId);
				this.activeAssistantMessageIds.delete(agentId);
				this.toolMessageIds.delete(agentId);
				this.activeToolCallsByAgent.delete(agentId);
				this.toolExecutingByAgent.set(agentId, null);
				this.rpcCompactingAgents.delete(agentId);
				this.thinkingEmitter.cancel(agentId);
				this.emitThinking(agentId, "");
				this.emitState();
				void this.emitRuntimeState(agentId);

				const messages = this.messages.get(agentId) ?? [];
				const lastMessage = messages[messages.length - 1];
				if (lastMessage?.role === "assistant") {
					this.notifySessionEnd(runtime.tab.title);
				}
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
				this.upsertAssistantMessage(agentId, typed.message);
				this.activeAssistantMessageIds.delete(agentId);
				// message_end 是本轮回答的最终状态，立即 flush 确保完整消息及时可见
				this.flushMessageEmit(agentId);
			}
		}

		if (typed.type === "tool_execution_start") {
			// abort 封印后的延迟工具事件应丢弃，避免重新激活流式状态。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
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
			const reason = String(typed.error ?? "Extension error");
			this.addLocalizedMessage(
				agentId,
				"error",
				"diagnostic.extensionError",
				"扩展执行错误。",
				{ debugDetails: reason },
			);
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
				message: String(typed.message ?? ""),
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

		// 记录 pending UI 请求，用于 abort 时自动 cancel
		if (!this.pendingUIRequests.has(agentId)) {
			this.pendingUIRequests.set(agentId, new Map());
		}
		this.pendingUIRequests.get(agentId)!.set(requestId, { method: effectiveMethod, title: request.title });

		// The session runtime owns pending UI. Do not write an additional system
		// message, because that creates a second interactive card in the timeline.
		this.emit(ipcChannels.agentsUiRequest, request);
		this.scheduleUIRequestTimeout(agentId, requestId, typed.timeout);
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
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "text_start" || eventType === "text_end") {
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "text_delta") {
			this.upsertAssistantMessage(
				agentId,
				partialMessage,
				String(assistantEvent.delta ?? ""),
			);
			return;
		}

		if (eventType === "thinking_delta") {
			const prev = this.streamingThinking.get(agentId) ?? "";
			const delta = String(assistantEvent.delta ?? "");
			this.streamingThinking.set(agentId, prev + delta);
			this.thinkingEmitter.push(agentId, stripAnsi(prev + delta));
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "thinking_end") {
			const finalThinking = String(
				assistantEvent.content ?? this.streamingThinking.get(agentId) ?? "",
			);
			if (finalThinking) {
				this.streamingThinking.set(agentId, finalThinking);
				this.thinkingEmitter.push(agentId, stripAnsi(finalThinking));
				this.thinkingEmitter.flush(agentId);
			}
			this.upsertAssistantMessage(agentId, partialMessage);
			// thinking_end 是阶段性终态，立即 flush 让思考块完整落盘显示。
			this.flushMessageEmit(agentId);
			return;
		}

		if (eventType === "message_end" || eventType === "done" || eventType === "error") {
			this.upsertAssistantMessage(agentId, partialMessage);
			// message_end/done/error 是本轮回答的最终状态，立即 flush 确保完整消息及时可见。
			this.flushMessageEmit(agentId);
			this.activeAssistantMessageIds.delete(agentId);
		}
	}

	private beginAssistantMessage(agentId: string) {
		if (!this.activeAssistantMessageIds.has(agentId)) {
			this.activeAssistantMessageIds.set(agentId, randomUUID());
		}
	}

	private upsertAssistantMessage(
		agentId: string,
		partialMessage?: unknown,
		fallbackDelta = "",
	) {
		const list = this.messages.get(agentId) ?? [];
		let messageId = this.activeAssistantMessageIds.get(agentId);
		if (!messageId) {
			messageId = randomUUID();
			this.activeAssistantMessageIds.set(agentId, messageId);
		}

		const existing = list.find((message) => message.id === messageId);
		const extractedText =
			partialMessage && typeof partialMessage === "object"
				? this.messageProjector.extractText((partialMessage as any).content)
				: "";
		const extractedThinking =
			partialMessage && typeof partialMessage === "object"
				? this.messageProjector.extractThinking((partialMessage as any).content)
				: "";
		const pendingThinking = this.streamingThinking.get(agentId);
		const nextThinking = stripAnsi(extractedThinking || pendingThinking || "");

		if (existing) {
			existing.text = extractedText || `${existing.text}${fallbackDelta}`;
			if (nextThinking) existing.thinking = nextThinking;
			// 保留原始时间戳，不随 delta 刷新。思考耗时依赖首条消息的时间戳与
			// 最后一条消息的时间戳之差，每次刷新会导致思考耗时始终为 0ms。
		} else {
			const text = extractedText || fallbackDelta;
			if (!text) return;
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text,
				timestamp: Date.now(),
				...(nextThinking ? { thinking: nextThinking } : {}),
			});
		}

		// 思考切换到正文（text_delta）时，emitThinking("") 会立即清空渲染进程的
		// runtime.thinking，若消息仍走 50ms 节流，思考内容会在底部卡片消失后、
		// TurnRow 出现前短暂不可见，产生视觉闪烁。此时必须立即 flush，让消息中
		// 的 thinking 与清空事件同时到达。用 fallbackDelta 区分 text_delta（有值）
		// 和 thinking_delta（无值），避免思考阶段高频 delta 破坏节流。
		const shouldClearThinking = nextThinking && (extractedText || fallbackDelta);
		if (shouldClearThinking) {
			this.streamingThinking.delete(agentId);
			this.emitThinking(agentId, "");
		}

		this.messages.set(agentId, list);
		if (shouldClearThinking && fallbackDelta) {
			// text_delta 清空思考：立即 flush，消除闪烁间隙
			this.flushMessageEmit(agentId);
		} else {
			// upsertAssistantMessage 被 text_delta/thinking_delta 高频调用，走节流合并；
			// message_end/thinking_end 等终态调用方会在调用后显式 flush，保证最终状态及时。
			this.scheduleMessageEmit(agentId);
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
		const existing = list.find((message) => message.id === messageId);
		const isError = status === "error" || event.isError === true;
		const args = event.args ?? existing?.meta?.args;
		const startedAt =
			typeof existing?.meta?.startedAt === "number"
				? existing.meta.startedAt
				: Date.now();
		// 工具耗时只能由 start/end 两个事件推导；start 时先保存 startedAt，end 时再写入 durationMs，
		// 避免使用消息 timestamp（会在 update/end 时刷新）导致历史恢复后耗时不可还原。
		const durationMs =
			status === "running" ? undefined : Math.max(0, Date.now() - startedAt);
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
			detailText,
			// originalContent 不再存储到消息中（full file 会使会话元数据体积过大）。
			// diff 使用工具参数（oldText/newText 等）展示变动区域，无需完整文件快照。
			
			...(askCard ? { _askCard: askCard } : {}),
		};

		if (existing) {
			existing.text = text;
			existing.timestamp = Date.now();
			existing.meta = meta;
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "tool",
				text,
				timestamp: Date.now(),
				meta,
			});
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
		list.push({
			id: randomUUID(),
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
		if (!nextTitle || nextTitle === runtime.tab.title) return false;
		// Agent 列表标题应和历史会话列表的“摘要名”一致；
		// 只覆盖默认标题，避免打开/重命名过的历史会话名称被第一条消息反向改掉。
		runtime.tab.title = nextTitle;
		this.emitState();
		return true;
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
						["select", "confirm", "input", "editor"].includes(String(typed.type))
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

		runtime.tab.status = "idle";
		this.streamingThinking.delete(agentId);
		this.emitThinking(agentId, "");
		this.emitState();
		void this.emitRuntimeState(agentId);
	}

	private requireRuntime(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error(`Agent not found: ${agentId}`);
		return runtime;
	}

	/**
	 * 非聚焦会话收到 Ask 类 UI 请求时的桌面通知（SessionRuntimeCoordinator 调用）。
	 * 与 notifySessionEnd 共用同一套设置门控：enableNotifications + Notification.isSupported。
	 */
	notifyAskPending(sessionTitle: string): void {
		try {
			const settings = this.settingsStore.get();
			if (!settings.enableNotifications) return;
			if (!Notification.isSupported()) return;

			const appName = app.getName();
			const notification = new Notification({
				title: appName,
				body: this.translate("mainNotification.askPending", { title: sessionTitle || appName }),
				silent: false,
			});
			// 点击通知时把主窗口带到前台，让用户能立刻处理确认请求
			notification.on("click", () => {
				const win = this.getWindow();
				if (win) {
					if (win.isMinimized()) win.restore();
					win.show();
					win.focus();
				}
			});
			notification.show();
		} catch {
			// 通知失败不影响主流程，静默处理
		}
	}

	/**
	 * 会话结束时发送系统通知。
	 * 仅在设置中启用通知且 Electron Notification 可用时触发，
	 * 通知用户 agent 已完成响应，可以查看结果或继续对话。
	 */
	private notifySessionEnd(sessionTitle: string) {
		try {
			const settings = this.settingsStore.get();
			if (!settings.enableNotifications) return;
			if (!Notification.isSupported()) return;

			// 使用应用名称作为通知标题，在 Windows/macOS 通知中心中显示为应用标识
			const appName = app.getName();
			const notification = new Notification({
				title: appName,
				body: this.translate("mainNotification.sessionDone", { title: sessionTitle }),
				silent: false,
			});
			notification.show();
		} catch {
			// 通知失败不影响主流程，静默处理
		}
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
	 */
	private scheduleAbortSettledFallback(agentId: string) {
		this.clearAbortSettledFallback(agentId);
		const timer = setTimeout(() => {
			this.abortSettledFallbackTimers.delete(agentId);
			// 仅在仍 waiting 时生效；正常 settled 路径会先 clear 定时器。
			if (this.getStreamGate(agentId).waitingForAbortSettled) {
				this.noteAgentAbortSettled(agentId);
			}
		}, AgentManager.ABORT_SETTLED_FALLBACK_MS);
		timer.unref?.();
		this.abortSettledFallbackTimers.set(agentId, timer);
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
		this.emit(ipcChannels.agentsMessage, {
			agentId,
			messages: this.messages.get(agentId) ?? [],
		});
	}

	private emitThinking(agentId: string, thinking: string) {
		if (!thinking) this.thinkingEmitter.cancel(agentId);
		this.emitThinkingNow(agentId, thinking);
	}

	private emitThinkingNow(agentId: string, thinking: string) {
		const update: ThinkingUpdate = { agentId, thinking };
		this.emit(ipcChannels.agentsThinking, update);
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
