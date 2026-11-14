/**
 * ACP agent CLI 的进程内会话管理器:backend="acp" 的 SessionAgentGateway 实现。
 *
 * 每个 agent(会话 runtime)独占一个 ACP CLI 子进程(stdio NDJSON JSON-RPC):
 * spawn → initialize → session/new(或 session/load 恢复)→ 会话期收
 * session/update 通知投影消息、应答 session/request_permission 审批。
 *
 * 结构对照 DshAgentManager(同类第三后端),但大幅简化:无共享 host、无 mux
 * 重连、无 follow 泵——进程即会话,stop 即结束。
 *
 * 历史来源有两级:agent CLI 侧(主)与 deck 侧归档(AcpSessionArchive,userData/acp-sessions,
 * 副)。CLI 侧的 session/load 重放才是权威历史;归档只是为了「CLI 存档被清(换机器/清缓存)
 * 或 CLI 根本不支持 load 时仍有历史可读 + 会话内可检索」,因此写盘只挂在回合结算与
 * stop 上(见 create/sendPrompt/stop),失败只记日志,不参与会话成败判定。
 */
import { randomUUID } from "node:crypto";
import { agentEventTags } from "../../shared/ipc";
import type { AcpAgentInfo, AcpToolConfig } from "../../shared/types/acp";
import type { AgentGatewayCapability, AgentRuntimeState, AgentStatus, AgentTab, AvailableModel, CreateAgentInput } from "../../shared/types/agent";
import type { ChatMessage, SendPromptInput, SendPromptResult, SessionUiResponseInput } from "../../shared/types/session";
import type { PiCommand } from "../../shared/types/app";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { PiLocator } from "../pi/PiLocator";
import { type AcpConfigOption, type AcpMcpServer, type AcpSessionPromptResult, type AcpStopReason } from "./acpProtocol";
import { AcpTimeoutError } from "./AcpConnection";
import { AcpPermissionRequests } from "./AcpPermissionRequests";
import { acpPromptBlocks, appendAcpCommandReceipt, appendAcpUserPrompt, rollbackAcpUserPrompt, settleAcpTurn, upsertAcpRetryStatus } from "./AcpEventProjector";
import { authRequiredDescriptor, localizeCreateFailure, promptTurnTimeoutDescriptor } from "./acpFailureDescriptors";
import { buildAcpAgentRuntime, buildAgentRuntimeState, type AcpAgentRuntime } from "./acpAgentRuntime";
import { AcpConfigOptions } from "./AcpConfigOptions";
import { AcpRuntimeLifecycle } from "./AcpRuntimeLifecycle";
import { accumulateAcpUsage, acpReplyPerf, readAcpTurnUsage } from "./acpUsageMetrics";
import { AcpTurnWatchdog } from "./acpTurnWatchdog";
import { AcpMessageSnapshotStore } from "./AcpMessageSnapshotStore";
import type { AcpSessionArchive } from "./AcpSessionArchive";
import { spawnAcpProcess } from "./AcpProcessHost";
import { clearAcpRuntimeTimers, killAcpRuntimeProcess, shutdownAcpRuntimeProcess } from "./acpRuntimeTeardown";
import type { AcpProxyEnvSettings } from "../sessions/sessionProxyPolicy";
import { AcpUpdatePipeline } from "./AcpUpdatePipeline";
import { describeEmptyTurn, emptyTurnRejection, escalatedStopRejection, hasTurnOutput, isNativeCommandPrompt, promptResultSnippet, resolvePromptDispatch, stalledTurnRejection } from "./acpTurnSettlement";
import { decideAcpTurnRetry, resolveAcpTurnRetrySettings, type AcpTurnRetrySettings } from "./acpTurnRetry";
import { failureMessage } from "../../shared/retry/transientFailure";
import { pushStderrTail } from "./acpRuntimeDiagnostics";
import { persistAcpArchive, readAcpMessagesBySessionId, readAcpMessagesWithArchive, restoreAcpArchivedSnapshot } from "./acpSessionMessages";

/** session/prompt 回合兑底超时：口径是「无进展静默上限」——回合内每有 session/update 或挂起审批
 *  就顺延截止（见 runtime.turnDeadlineRefresh），所以这里只约束「完全没动静」的时长。
 *  取 15 分钟：实测 intra-turn 静默峰值约 53s（两个 CodeBuddy 归档共 1096 条消息，超 90s 的空隙全部是
 *  回合结束后等用户输入），3.4 倍余量；带在途工具的正常长任务不受这条限制（stall 已放行在途工具），
 *  本值是「工具永不返回」时的最后一道网。测试用 deps.promptTurnTimeoutMs 注入缩短。 */
const PROMPT_TURN_TIMEOUT_MS = 15 * 60_000;
/** 断线重连的握手上限：比冷启动 60s 短，重连失败要尽快让用户看到失败而不是干等。 */
const RESPAWN_HANDSHAKE_TIMEOUT_MS = 20_000;

type AcpManagerDeps = {
	/** 解析命令启动形态(Windows .cmd 垫片还原、node 直启等)。 */
	piLocator: PiLocator;
	/**
	 * 会话级 MCP 服务器（`session/new` / `session/load` 的 mcpServers）。
	 * PiDeck 用它把 `pideck-agent-memory` 挂给外部 CLI，让 ACP 会话拥有与 pi 同一套记忆工具。
	 * 参数是会话 cwd：项目记忆按路径派生键落盘，三种后端因此共享同一份项目记忆。
	 * 缺省不给工具，保持引入前行为。
	 */
	mcpServers?: (cwd: string) => AcpMcpServer[];
	getProject: (id: string) => { path: string } | undefined;
	/** 读取用户登记的 ACP 工具表(settings.acpTools)。 */
	getTools: () => AcpToolConfig[];
	/**
	 * ACP 总开关(settings.acpEnabled)的运行时读口。
	 * 必须每次 create 时实时读:设置页变更立即生效,不需要重启应用。
	 */
	isEnabled: () => boolean;
	/**
	 * ACP 代理(settings.acpProxy*)的运行时读口:每次 create 时实时读,只影响新进程。
	 * 缺省不注入,进程继承系统环境变量(与引入该设置前的行为一致)。
	 */
	getProxySettings?: () => AcpProxyEnvSettings | undefined;
	onTitleChanged?: (deckSessionId: string, title: string) => void;
	/** configOptions 变更推送(set_config_option 响应/config_option_update 通知)。 */
	onConfigOptionsChanged?: (tab: AgentTab, options: AcpConfigOption[]) => void;
	/** 读取某工具记住的会话级配置(settings.acpToolConfigDefaults[toolId]);缺省不重放。 */
	getToolConfigDefaults?: (toolId: string) => Record<string, string | boolean> | undefined;
	/** 用户手动切换配置成功后的记忆回调(主进程写 settings;缺省不持久化)。 */
	rememberConfigOption?: (toolId: string, optionId: string, value: string | boolean) => void;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
	/** 图片落盘(base64→内容寻址 ref):生图 ImageBlobStore 的最小结构化依赖,便于单测注入假实现。 */
	imageStore?: { put(data: string, mimeType: string): Promise<string | null> };
	/** session/prompt 回合超时(默认 10 分钟)。测试注入短值验证超时补发 session/cancel。 */
	promptTurnTimeoutMs?: number;
	/** initialize/session-new/load 握手超时(默认 60s)。测试注入短值验证启动超时本地化。 */
	handshakeTimeoutMs?: number;
	/** permission expiry 的测试注入，不新增持久化设置。 */
	permissionTimeoutMs?: number;
	/** abort 升级强杀宽限(默认 5s)。测试注入短值验证升级路径。 */
	abortEscalationMs?: number;
	/**
	 * 有序停止宽限(默认 ACP_GRACEFUL_EXIT_MS = 1.5s，与 pi 侧 #450 同值)：
	 * 关 stdin 后等 CLI 自己退出（便于其 SessionEnd 钩子落地），到点才整树强杀。
	 * 测试注入短值避免集成用例每停一个会话多等 1.5s。
	 */
	gracefulExitMs?: number;
	/** 回合无输出 stall 判定阈值(默认 180s)。测试注入短值验证看门狗。 */
	promptStallTimeoutMs?: number;
	/**
	 * 会话归档（userData/acp-sessions）：投影消息按 acpSessionId 落盘，重启后仍可读回。
	 * 缺省不落盘（单测/未装配场景）：归档永远是增强项，不是会话可用性的前提。
	 */
	archive?: AcpSessionArchive;
	/**
	 * ACP 超时口径的运行时读口（settings.acpPromptStallTimeoutMs / acpPromptTurnTimeoutMs）。
	 * 每次布防/派发实时读：设置变更后新回合立即生效，不需要重启。静态注入字段
	 * （promptStallTimeoutMs/promptTurnTimeoutMs，单测用）优先于本读口（#411：静态快照
	 * 让设置够不到看门狗，长工具调用/长回合被 180s/15min 硬编码误杀）。
	 */
	readAcpTimeoutSettings?: () => { promptStallTimeoutMs?: number; promptTurnTimeoutMs?: number };
	/**
	 * 回合失败自动重试口径读口（settings.acpTurnRetry*）：每次派发实时读，改设置后新回合生效。
	 * 缺省不注入 = 代码默认（enabled/maxRetries=2/baseDelayMs=2000），与 pi/DSH 的自动重试对齐。
	 */
	readAcpTurnRetrySettings?: () => AcpTurnRetrySettings | undefined;
	/**
	 * 桌面 Ask 通知出口（与 pi 同一份门控/toast，见 notifications/agentToast.ts）。
	 * 返回是否真的弹出：false 时不占用「每轮只提醒一次」的去重位。缺省静默。
	 */
	notify?: { askPending?: (input: { agentId: string; sessionId: string; sessionTitle: string; question: string }) => boolean };
};

export class AcpAgentManager implements SessionAgentGateway {
	readonly backend = "acp" as const;
	/**
	 * 首版能力:仅 getCommands(available_commands_update 投影)。
	 * fork/compact/exportHtml 等待 ACP 生态补齐对应方法后再开(能力门控是硬规则,
	 * UI 按能力禁用,缺失项不得硬造等价物)。
	 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set<AgentGatewayCapability>(["getCommands"]);

	private readonly runtimes = new Map<string, AcpAgentRuntime>();
	/** acpSessionId → 最近一次 flush 的消息快照（每会话 400 条 + LRU 会话数上限）：
	 *  stop/升级强杀后 runtime 删除，重入会话时 readMessagesByAcpSessionId 的临时数据源。 */
	private readonly messageSnapshots = new AcpMessageSnapshotStore();
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();
	/** 成功收口订阅（桌宠 done 气泡 / 会话完成通知）：用户停止与失败不触发。 */
	private readonly settledListeners = new Set<(info: { agentId: string; title: string }) => void>();
	/** 每轮只提醒一次 Ask：sendPrompt 开头清空（与 pi 的 agent_start 同口径）。 */
	private readonly notifiedAskAgents = new Set<string>();
	/** 回合看门狗（abort 升级宽限/stall 检测）：强杀出口回注 forceStopRuntime→stop()。 */
	private readonly turnWatchdog: AcpTurnWatchdog;
	/** session/update 摄入与消息发布管线（投影→物化→标题→节流 flush→快照）。 */
	private readonly updates: AcpUpdatePipeline;
	/** 会话级配置写入（串行链）与工具级记忆重放。 */
	private readonly configOptions: AcpConfigOptions;
	/** runtime 生命周期：会话期接线 / 就绪握手链 / 断线重连。 */
	private readonly lifecycle: AcpRuntimeLifecycle;

	constructor(private readonly deps: AcpManagerDeps) {
		this.turnWatchdog = new AcpTurnWatchdog({
			ownsRuntime: (runtime) => this.runtimes.get(runtime.tab.id) === runtime,
			forceStop: (runtime, reason) => this.forceStopRuntime(runtime, reason),
			logger: deps.logger,
			abortEscalationMs: deps.abortEscalationMs,
			// getter：stall 阈值每次布防时实时解析（静态测试注入优先，其次 settings 读口，
			// 最后代码内默认 180s）。构造期静态快照会让设置变更够不到看门狗（#411 根因之一）。
			get promptStallTimeoutMs() {
				return deps.promptStallTimeoutMs ?? deps.readAcpTimeoutSettings?.().promptStallTimeoutMs;
			},
		});
		this.updates = new AcpUpdatePipeline(
			{
				ownsRuntime: (runtime) => this.runtimes.get(runtime.tab.id) === runtime,
				isTracked: (tabId) => this.runtimes.has(tabId),
				emit: (channel, payload) => this.emit(channel, payload),
				emitRuntimeState: (agentId) => this.emitRuntimeState(agentId),
				onTitleChanged: deps.onTitleChanged,
				onConfigOptionsChanged: deps.onConfigOptionsChanged,
				imageStore: deps.imageStore,
			},
			this.messageSnapshots,
		);
		this.configOptions = new AcpConfigOptions({
			requireRuntime: (agentId) => this.requireRuntime(agentId),
			ownsRuntime: (runtime) => this.runtimes.get(runtime.tab.id) === runtime,
			onConfigOptionsChanged: deps.onConfigOptionsChanged,
			rememberConfigOption: deps.rememberConfigOption,
			getToolConfigDefaults: deps.getToolConfigDefaults,
			logger: deps.logger,
		});
		this.lifecycle = new AcpRuntimeLifecycle({
			killProcess: (runtime) => this.killProcess(runtime),
			recreatePermissions: (runtime, conn) => {
				runtime.permissions = new AcpPermissionRequests(conn, (event) => this.emit(agentEventTags.agentsUiRequest, { agentId: runtime.tab.id, ...event }), deps.permissionTimeoutMs);
			},
			restoreArchivedSnapshot: (acpSessionId) => this.restoreArchivedSnapshot(acpSessionId),
			persistArchive: (runtime) => this.persistArchive(runtime),
			seedMessages: (sessionId) => this.messageSnapshots.get(sessionId) ?? [],
			replayToolConfigDefaults: (runtime) => this.configOptions.replayToolConfigDefaults(runtime),
			applyBypassPermissionDefault: (runtime) => this.configOptions.applyBypassPermissionDefault(runtime),
			wireConnection: (runtime) => this.lifecycle.wireConnection(runtime),
			enqueueSessionUpdate: (runtime, notification) => this.updates.enqueueSessionUpdate(runtime, notification),
			flushMessages: (runtime, immediate) => this.updates.flushMessages(runtime, immediate),
			flushMessagesChunked: (runtime) => this.updates.flushMessagesChunked(runtime),
			failPendingPermissions: (runtime) => this.failPendingPermissions(runtime),
			clearTurnTimers: (runtime) => this.turnWatchdog.clearTurnTimers(runtime),
			emitAgentsState: () => this.emit(agentEventTags.agentsState, this.list()),
			emitRuntimeState: (agentId) => this.emitRuntimeState(agentId),
			onTitleChanged: deps.onTitleChanged,
			onConfigOptionsChanged: deps.onConfigOptionsChanged,
			mcpServers: deps.mcpServers,
			piLocator: deps.piLocator,
			getProxySettings: deps.getProxySettings,
			logger: deps.logger,
			handshakeTimeoutMs: deps.handshakeTimeoutMs,
		});
	}

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	private emit(channel: string, payload: unknown): void {
		for (const listener of this.outputListeners) listener(channel, payload);
	}

	list(): AgentTab[] {
		return [...this.runtimes.values()].map((runtime) => ({ ...runtime.tab, status: runtime.status }));
	}

	getTool(agentId: string): AcpToolConfig | undefined {
		return this.runtimes.get(agentId)?.tool;
	}

	getAgentInfo(agentId: string): AcpAgentInfo | undefined {
		return this.runtimes.get(agentId)?.agentInfo;
	}

	readMessages(agentId: string): ChatMessage[] {
		return this.runtimes.get(agentId)?.projection.messages ?? [];
	}

	/** 同步读口（只覆盖内存态）：契约与「为何不回退归档」见 acpSessionMessages。 */
	readMessagesByAcpSessionId(acpSessionId: string): ChatMessage[] {
		return readAcpMessagesBySessionId(this.runtimes, this.messageSnapshots, acpSessionId);
	}

	/** 异步读口：runtime 投影 → 磁盘归档 → 内存快照；三级回退的取舍见 acpSessionMessages。 */
	async readMessagesWithArchive(acpSessionId: string): Promise<ChatMessage[]> {
		return readAcpMessagesWithArchive(this.runtimes, this.messageSnapshots, this.deps.archive, acpSessionId);
	}

	getMessages(agentId: string): ChatMessage[] {
		return this.readMessages(agentId);
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		// ACP v1 无改名请求;标题由 agent 侧 session_info_update 维护,这里只改本地 tab。
		const runtime = this.requireRuntime(agentId);
		runtime.tab = { ...runtime.tab, title: name };
		this.emit(agentEventTags.agentsState, this.list());
		return { ...runtime.tab };
	}

	async compact(): Promise<AgentRuntimeState> {
		// capabilities 不含 compact,UI 已禁用入口;此实现仅兑现接口契约。
		throw new Error("ACP backend does not support compaction");
	}

	async prepareResendFromMessage(): Promise<{ text: string; images?: ChatMessage["images"] }> {
		// ACP 历史存 agent 侧,PiDeck 无法重写;capabilities 不含 editMessage/重发。
		throw new Error("ACP backend does not support message resend");
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return [];
	}

	async forkSession(): Promise<unknown> {
		throw new Error("ACP backend does not support forking");
	}

	async setModel(agentId: string, _provider: string, _modelId: string): Promise<unknown> {
		// ACP v1 模型选择走 session/set_config_option(configOptions 规范路径),
		// 不经 pi 的 setModel;no-op 保住 applyLatestPreferences 链路。
		this.requireRuntime(agentId);
		return {};
	}

	/** 当前会话配置枚举(模型/思考档/模式);agent 未提供时 undefined(渲染层隐藏选择器)。 */
	getSessionConfigOptions(agentId: string): AcpConfigOption[] | undefined {
		return this.requireRuntime(agentId).configOptions;
	}

	/** 下发配置选择并返回 agent 回传的完整 configOptions(规范:响应必带整表)。 */
	async applyConfigOption(agentId: string, optionId: string, value: string | boolean): Promise<AcpConfigOption[]> {
		return this.configOptions.applyConfigOption(agentId, optionId, value);
	}

	async setThinking(agentId: string, _level: string): Promise<unknown> {
		this.requireRuntime(agentId);
		return {};
	}

	// ── SessionAgentGateway ────────────────────────────────────────────────

	async create(input: CreateAgentInput): Promise<AgentTab> {
		// 开关运行时判定:关闭时拒绝 spawn(渲染层已隐藏 ACP 入口,这里是边界防御;
		// 也覆盖「从历史恢复 ACP 会话」这类不经过后端下拉的启动路径)。
		if (!this.deps.isEnabled()) throw new Error("ACP backend is disabled (settings off or stable channel)");
		const project = this.deps.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		// 工具选择:agentPreset 字段承载 AcpToolConfig.id(coordinator 已归一传入)。
		const toolId = input.agentPreset ?? "";
		const tool = this.deps.getTools().find((candidate) => candidate.id === toolId && candidate.enabled);
		// 工具被删/禁用：会话绑定还在（acpToolId 落 catalog），给明确引导而不是裸 id 报错。
		if (!tool) throw Object.assign(new Error(`ACP tool not found or disabled: ${toolId || "(none)"}`), { i18nKey: "acp.toolMissing", i18nParams: { tool: toolId || "(none)" } });
		const cwd = project.path;
		const { proc, conn, spawnFailure } = spawnAcpProcess(tool, cwd, { piLocator: this.deps.piLocator, proxy: this.deps.getProxySettings?.(), logger: this.deps.logger });

		const agentId = `acp:${randomUUID()}`;
		const runtime = buildAcpAgentRuntime({
			agentId,
			input,
			tool,
			cwd,
			proc,
			conn,
			permissions: new AcpPermissionRequests(conn, (event) => this.emit(agentEventTags.agentsUiRequest, { agentId, ...event }), this.deps.permissionTimeoutMs),
		});
		this.runtimes.set(agentId, runtime);
		this.emit(agentEventTags.agentsState, this.list());
		// CLI 诊断输出（stderr）留一份尾部：限流/登录失败常常只打在这里，空白回合时要随
		// 拒收结果带进 UI，否则用户只看到「无输出」的概括（主进程日志另有全量记录）。
		runtime.proc?.stderr?.on("data", (chunk: Buffer) => pushStderrTail(runtime, chunk.toString("utf8")));

		try {
			await this.lifecycle.bootstrapRuntime(runtime, input.acpSessionId, spawnFailure);
		} catch (error) {
			this.runtimes.delete(agentId);
			this.killProcess(runtime);
			this.emit(agentEventTags.agentsState, this.list());
			const thrown = error instanceof Error ? error : new Error(String(error));
			// AUTH_REQUIRED / CLI 未安装(ENOENT) / 握手超时：附描述符再抛，
			// coordinator 透传为本地化引导 toast（不命中的错误原样透出原文）。
			localizeCreateFailure(thrown, tool);
			throw thrown;
		}
		return { ...runtime.tab };
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		const dispatch = resolvePromptDispatch(input, runtime);
		if ("rejection" in dispatch) return dispatch.rejection;
		const { conn } = dispatch;
		const prompt = acpPromptBlocks(input.message, input.images);
		// 本回合结算 stopReason 的快照:成功路径的空白回合守卫在 try 外使用,需提前记录。
		let settledStopReason: AcpStopReason = "end_turn";
		// session/prompt 响应原文:空白回合时把它的非 stopReason 部分带进诊断。
		let promptResult: AcpSessionPromptResult | undefined;
		// 自动重试口径与计数：失败收口（catch / 空白回合守卫）要用，因此声明在 try 之外。
		// 每次 sendPrompt 只读一次设置——同一回合的重试序列用同一口径，回合中途改设置只影响新回合。
		const retrySettings = resolveAcpTurnRetrySettings(this.deps.readAcpTurnRetrySettings?.());
		let retryAttempts = 0;
		// 用户消息先落投影:ACP 规范不保证 agent 回显 user_message_chunk(OpenCode 等根本不发),
		// 而 agents:message 是全量替换语义,主进程不落条目的话渲染层乐观气泡会被第一次 flush 抹掉。
		const messagesBeforeSeed = runtime.projection.messages.length;
		runtime.projection = appendAcpUserPrompt(runtime.projection, input.message, input.images, runtime.tab.id);
		// 断线重连会重建投影并重落本回合条目，索引必须可重算。
		let seededIndex = runtime.projection.messages.length > messagesBeforeSeed ? messagesBeforeSeed : -1;
		this.updates.applyProjectionTitle(runtime);
		runtime.turnActive = true;
		runtime.cancelling = false;
		runtime.cancelReason = null;
		runtime.escalatedStop = null;
		// 新一轮开始：Ask 提醒去重复位（同一轮多次提问只提醒一次，跨轮重新提醒）。
		this.notifiedAskAgents.delete(input.agentId);
		runtime.status = "running";
		runtime.tab.status = "running";
		this.emit(agentEventTags.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		// 先 flush 用户气泡再走物化链:base64→ref 可能慢,不等它,渲染层立即看到本条消息;
		// 物化完成后下一次 flush 把快照里的 base64 换成 ref(内存形态不违反「base64 不进存储」契约)。
		// turnActive 必须在物化前置位:abort 依赖它置 cancelling,晚置会把 abort 的取消意图抹掉。
		this.updates.flushMessages(runtime, true);
		try {
			// 与 update 共用物化链，防止本地图片异步回写覆盖 agent 首批响应。
			runtime.updateChain = runtime.updateChain.then(() => this.updates.materializeTouchedImages(runtime));
			await runtime.updateChain;
			if (this.runtimes.get(runtime.tab.id) !== runtime || conn.isClosed()) throw new Error("ACP agent process stopped before prompt dispatch");
			if (runtime.cancelling) throw new Error("ACP prompt cancelled before dispatch");
			this.updates.flushMessages(runtime, true);
			// 回合 stall 看门狗:全静默(无 update/无挂起审批)超阈值先 cancel 再升级强杀,
			// 否则 CLI 侧流错误吞掉回合(opencode 实测)时 UI 只能等 10 分钟兑底超时。
			this.turnWatchdog.armStallWatchdog(runtime);
			// 长回合请求不套默认 60s 短超时:深思模型单回合可超分钟级,超时应由 abort/stop/连接死亡驱动;
			// 10 分钟兑底防真悬死(实测 codex-acp 思考型回合 >60s,见 scripts/acpLiveSmoke.mjs)。
			// 可注入 deps.promptTurnTimeoutMs 供测试缩短。
			// 回合兑底超时三段解析：静态测试注入 → settings 读口（每次派发实时读，变更后
			// 新回合生效）→ 代码内默认 10min。截止随进展顺延（onArm 拿到 refresh 句柄，
			// 回合内每有 session/update 就 refresh）：口径是「无进展静默上限」，长但健康的
			// 回合不会因为总时长到点被掐断。
			const turnTimeoutMs = this.deps.promptTurnTimeoutMs ?? this.deps.readAcpTimeoutSettings?.().promptTurnTimeoutMs ?? PROMPT_TURN_TIMEOUT_MS;
			// 自动重试：协议层兜底，与具体 CLI 无关——本轮还没任何产出、错误像瞬时故障，
			// 就重发同一个 session/prompt（判定/退避口径见 acpTurnRetry.ts）。
			// 已有产出绝不重发：重复的 JSON-RPC 请求可能让 agent 重复执行工具/写文件。
			for (;;) {
				// 每次迭代都重读连接：断线重连后 runtime.conn 已换成新对象，捕获旧值等于往死连接发。
				const attemptConn = runtime.conn;
				if (!attemptConn || attemptConn.isClosed()) throw new Error("ACP connection closed before prompt dispatch");
				// 本回合诊断清零:update 类型计数/非标准通知只统计这一回合。
				// 重试同样清零：TTFT 与总耗时以本次派发为基准，不把退避等待算进去。
				runtime.turnSawActivity = false;
				runtime.turnUpdateKinds.clear();
				runtime.turnForeignNotification = undefined;
				// 回合计时基准：TTFT（首个正文 chunk）与总耗时（结算）都以派发时刻为起点，
				// 不含本地 seed/物化耗时；上一回合的残留值在这里清掉。
				runtime.turnStartedAt = Date.now();
				runtime.turnFirstTextAt = undefined;
				runtime.turnFirstThoughtAt = undefined;
				// 重试的每次派发都重新布防：上一轮失败后 clearTurnTimers 已撤掉旧定时器。
				if (retryAttempts > 0) this.turnWatchdog.armStallWatchdog(runtime);
				try {
					const result = (await attemptConn.request("session/prompt", { sessionId: runtime.acpSessionId, prompt }, turnTimeoutMs, (refresh) => {
						runtime.turnDeadlineRefresh = refresh;
					})) as AcpSessionPromptResult;
					promptResult = result;
					break;
				} catch (error) {
					// 每次判定都重新算产出：失败尝试可能仍在推 update（CLI 未及时收口）。
					// 待审批的工具请求同样算「已经开动」：CLI 已经决定要执行某个工具（可能已在写文件），
					// 此时重发会让它再跑一遍；而且用户还在面对审批弹窗，撤回气泡只会更混乱。
					const hasOutput = hasTurnOutput(runtime.projection.messages, seededIndex) || runtime.permissions.hasPending();
					const connectionDead = !runtime.conn || runtime.conn.isClosed();
					// ① 连接死亡（进程退出/stdout 断）：这不是「重发」而是「重开进程再重发」，
					// 只有本轮无产出、未取消、未强杀且在预算内才做；连接换了必然要重派同一个 prompt。
					if (connectionDead && !hasOutput && !runtime.turnSawActivity && !runtime.cancelling && runtime.escalatedStop === null && retrySettings.enabled && retryAttempts < retrySettings.maxRetries) {
						// 本回合落下的用户条目（含已物化的图片 ref）：重连会重建投影，靠它把这条原样搬回去。
						const dispatchedUserMessage = seededIndex >= 0 ? runtime.projection.messages[seededIndex] : undefined;
						retryAttempts += 1;
						const delayMs = Math.min(retrySettings.baseDelayMs * 2 ** (retryAttempts - 1), retrySettings.maxDelayMs);
						this.turnWatchdog.clearTurnTimers(runtime);
						runtime.projection = upsertAcpRetryStatus(runtime.projection, {
							agentId: runtime.tab.id,
							status: "running",
							attempt: retryAttempts,
							maxAttempts: retrySettings.maxRetries,
							delayMs,
							errorMessage: `connection: ${failureMessage(error)}`,
						});
						this.updates.flushMessages(runtime, true);
						this.emitRuntimeState(input.agentId);
						this.deps.logger?.warn("acp", `[${runtime.tool.name}] reconnecting after connection loss`, {
							agentId: runtime.tab.id,
							attempt: retryAttempts,
							maxAttempts: retrySettings.maxRetries,
							delayMs,
							error: failureMessage(error),
						});
						await this.awaitRetryDelay(runtime, delayMs);
						// 退避期间被停止/替换：不再重连，按原错误走统一失败收口。
						if (runtime.cancelling || this.runtimes.get(runtime.tab.id) !== runtime) throw error;
						if (!(await this.lifecycle.respawnRuntime(runtime))) throw error;
						// 重连已按握手重放重建了投影（旧卡随之丢弃）：把本回合的用户条目与重试卡补回去再重派。
						const resumedTail = runtime.projection.messages.at(-1);
						if (resumedTail?.role === "user" && resumedTail.text.trim() === input.message.trim()) {
							// agent 重放里已回显过这条（少数 CLI 会 echo user_message_chunk）：不重复落条目。
							seededIndex = runtime.projection.messages.length - 1;
						} else if (dispatchedUserMessage) {
							// 原样搬回（同一个 id + 已物化的图片 ref）：换 id 会让渲染层当成新消息重新起一条，
							// 而重新 append 原始 base64 会把大图又带回内存/归档。
							runtime.projection = { ...runtime.projection, messages: [...runtime.projection.messages, dispatchedUserMessage], lastTouched: [runtime.projection.messages.length] };
							seededIndex = runtime.projection.messages.length - 1;
						}
						this.updates.applyProjectionTitle(runtime);
						runtime.projection = upsertAcpRetryStatus(runtime.projection, {
							agentId: runtime.tab.id,
							status: "running",
							attempt: retryAttempts,
							maxAttempts: retrySettings.maxRetries,
							delayMs: 0,
							errorMessage: `connection: ${failureMessage(error)}`,
						});
						runtime.turnActive = true;
						runtime.status = "running";
						runtime.tab.status = "running";
						this.updates.flushMessages(runtime, true);
						this.emit(agentEventTags.agentsState, this.list());
						this.emitRuntimeState(input.agentId);
						continue;
					}
					const decision = decideAcpTurnRetry({
						error,
						settings: retrySettings,
						attemptsMade: retryAttempts,
						hasOutput,
						cancelled: runtime.cancelling,
						escalated: runtime.escalatedStop !== null,
						connectionAlive: !connectionDead && this.runtimes.get(runtime.tab.id) === runtime,
						authRequired: Boolean(authRequiredDescriptor(error, runtime.tool)),
						timedOut: error instanceof AcpTimeoutError,
					});
					if (!decision.retry) throw error;
					retryAttempts = decision.attempt;
					this.turnWatchdog.clearTurnTimers(runtime);
					// 同一张卡原地推进（与 pi/DSH 同形），保持 running：退避期间不显示空闲，停止按钮仍有效。
					runtime.projection = upsertAcpRetryStatus(runtime.projection, {
						agentId: runtime.tab.id,
						status: "running",
						attempt: decision.attempt,
						maxAttempts: decision.maxAttempts,
						delayMs: decision.delayMs,
						errorMessage: `${decision.kind}: ${failureMessage(error)}`,
					});
					this.updates.flushMessages(runtime, true);
					this.emitRuntimeState(input.agentId);
					this.deps.logger?.warn("acp", `[${runtime.tool.name}] retrying turn after transient failure`, {
						agentId: runtime.tab.id,
						attempt: decision.attempt,
						maxAttempts: decision.maxAttempts,
						delayMs: decision.delayMs,
						reason: decision.reason,
						error: failureMessage(error),
					});
					await this.awaitRetryDelay(runtime, decision.delayMs);
					// 退避期间可能被停止/替换/连接死亡：抛回原错误走统一失败收口（不再多试一次）。
					if (this.runtimes.get(runtime.tab.id) !== runtime || !runtime.conn || runtime.conn.isClosed()) throw error;
					if (runtime.cancelling) throw error;
				}
			}
			this.turnWatchdog.clearTurnTimers(runtime);
			// 结算前先排空 update 链:result 帧与末批 update 同为 stdout 行序分发,
			// 但链上每步含异步物化,settle 提前会把在途流式块拆成新回合。
			await runtime.updateChain;
			settledStopReason = promptResult?.stopReason ?? "end_turn";
			runtime.projection = settleAcpTurn(runtime.projection, settledStopReason);
			// 重试成功：同一张卡原地改成功态（不新建，时间线只留一条推进记录）。
			if (retryAttempts > 0) runtime.projection = upsertAcpRetryStatus(runtime.projection, { agentId: runtime.tab.id, status: "success", attempt: retryAttempts, maxAttempts: retrySettings.maxRetries, delayMs: 0 });
		} catch (error) {
			await runtime.updateChain;
			this.turnWatchdog.clearTurnTimers(runtime);
			const message = error instanceof Error ? error.message : String(error);
			// 重试卡先收口再撤回用户条目：卡片本身要留下（用户得看到「重试 N 次仍失败」），
			// rollbackAcpUserPrompt 已允许用户条目后面只挂重试卡并把卡保留。
			if (retryAttempts > 0) {
				runtime.projection = upsertAcpRetryStatus(runtime.projection, {
					agentId: runtime.tab.id,
					status: "error",
					attempt: retryAttempts,
					maxAttempts: retrySettings.maxRetries,
					delayMs: 0,
					errorMessage: message,
				});
			}
			// 失败/中止回合不记账，计时基准也一并清掉，避免下一次成功结算算出跨回合的超长耗时。
			runtime.turnStartedAt = undefined;
			runtime.turnFirstTextAt = undefined;
			runtime.turnFirstThoughtAt = undefined;
			// 派发失败（JSON-RPC 拒绝 / 连接死）且 agent 未产出任何内容：撤回刚落的用户条目，
			// 否则时间线会留一条没有回复的「幽灵消息」，而渲染层已把草稿回填输入框（会重发）。
			// 用户主动取消(cancelling)不撤回:语义同 pi 后端 abort,用户消息留在时间线。
			// 结算用 cancelled,与 abort 语义一致，不算错误。
			if (!runtime.cancelling) runtime.projection = rollbackAcpUserPrompt(runtime.projection, seededIndex);
			runtime.projection = settleAcpTurn(runtime.projection, runtime.cancelling ? "cancelled" : "error");
			runtime.turnActive = false;
			runtime.permissions.cancelAll();
			runtime.inFlightToolCalls.clear();
			// 请求超时 ≠ agent 侧回合结束:agent 仍在跑旧回合,后续 session/prompt 会一直
			// 排在它后面反复超时(opencode 卡死实测);abort() 也因 turnActive 已清而 no-op。
			// 超时必须补发 session/cancel 让 agent 收口旧回合,否则会话永久卡死。
			if (error instanceof AcpTimeoutError && runtime.conn && !runtime.conn.isClosed()) {
				runtime.cancelling = true;
				try {
					runtime.conn.notify("session/cancel", { sessionId: runtime.acpSessionId, reason: "turn_timeout" });
				} catch {
					// 通知失败只能放弃:连接层随后会自行死亡/关闭并结算。
				}
			}
			// 连接死亡等外部终态(error/closed)由 closed handler 结算,不回 idle;
			// 仅本回合请求失败(如 JSON-RPC 拒绝)从 running 回 idle。
			if (runtime.status === "running") {
				runtime.status = "idle";
				runtime.tab.status = "idle";
			}
			this.updates.flushMessages(runtime, true);
			this.emit(agentEventTags.agentsState, this.list());
			this.emitRuntimeState(input.agentId);
			// 回合结算（失败收口）后落盘：此时投影已 settle，是稳定快照；一次回合最多写一次，
			// 不进 80ms flush。失败路径也要写 —— 已产生的部分输出同样是用户可见历史。
			await this.persistArchive(runtime);
			const hasOutput = hasTurnOutput(runtime.projection.messages, seededIndex);
			// 升级强杀（abort 宽限超时/二次停止/stall）：用户消息已留在时间线（cancelling 不回滚），
			// delivery=unknown（CLI 是否已处理不可知，不回填草稿避免重发重复），文案本地化并带原因。
			if (runtime.escalatedStop) {
				return escalatedStopRejection(runtime.escalatedStop, message, runtime.tool.name);
			}
			// AUTH_REQUIRED（凭据过期等回合期失败）：描述符随拒收结果透出登录引导。
			// 回合兑底超时同样挂描述符：渲染层弹「人性化时长 + acpPromptTurnTimeoutMs 指引」，
			// 原文留在 debugDetails（#431）。
			const descriptor = authRequiredDescriptor(error, runtime.tool) ?? promptTurnTimeoutDescriptor(error, runtime.tool);
			return { accepted: false, error: message, delivery: hasOutput || error instanceof AcpTimeoutError ? "unknown" : "rejected", ...(descriptor ?? {}) };
		}
		runtime.turnActive = false;
		runtime.permissions.cancelAll();
		runtime.inFlightToolCalls.clear();
		if (runtime.status === "running") {
			runtime.status = "idle";
			runtime.tab.status = "idle";
		}
		// 产出判定提前算：记账只对真有可见输出的回合做（空白回合稍后会被回滚并报错）。
		const hasOutput = hasTurnOutput(runtime.projection.messages, seededIndex);
		// 看门狗 stall 代发 cancel 的回合按失败收口（#500）：CLI 按协议正常回 stopReason="cancelled"，
		// session/prompt 是 resolve 而不是 reject ⇒ 进不了 catch 里的 escalatedStop 分支，回合会被
		// 谎报 accepted:true，用户在 UI 上只看到「说着说着就停了」且没有任何提示。
		// 有可见产出时用户消息留在时间线（cancelling 不回滚），因此 delivery=unknown 不回填草稿，
		// 只把「被自动停止」的原因弹出来；零产出的 stall 仍走下面的空白回合守卫（回滚 + 回填草稿，
		// 用户能直接重发）。
		if (runtime.cancelReason === "stall" && hasOutput) {
			if (retryAttempts > 0) {
				runtime.projection = upsertAcpRetryStatus(runtime.projection, { agentId: runtime.tab.id, status: "error", attempt: retryAttempts, maxAttempts: retrySettings.maxRetries, delayMs: 0, errorMessage: "turn stalled and was cancelled" });
			}
			this.updates.flushMessages(runtime, true);
			const stalledDetails = describeEmptyTurn({
				stopReason: settledStopReason,
				updateKinds: runtime.turnUpdateKinds,
				stderrTail: runtime.stderrTail,
				foreignNotification: runtime.turnForeignNotification,
				rawResult: promptResultSnippet(promptResult),
			});
			this.deps.logger?.warn("acp", "turn stalled: cancelled by the stall watchdog", {
				tool: runtime.tool.name,
				sessionId: runtime.acpSessionId,
				stopReason: settledStopReason,
				updateKinds: Object.fromEntries(runtime.turnUpdateKinds),
			});
			await this.persistArchive(runtime);
			return stalledTurnRejection(runtime.tool.name, stalledDetails);
		}
		if (hasOutput) this.recordTurnMetrics(runtime, promptResult);
		this.updates.flushMessages(runtime, true);
		this.emit(agentEventTags.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		// 成功结算 ≠ 有可见输出：部分 CLI 因自身事件流竞态会正常回 end_turn 却漏掉全部
		// session/update（OpenCode 1.15.4 /event 订阅竞态实测：消息已被处理但 client 一无所获，
		// UI 只剩本地用户气泡、草稿已清空、还谎报成功）。回合已确定结束且无任何产出，
		// 按 rejected 收口并回滚本地用户条目：渲染层回填草稿，用户升级 CLI 后可安全重发。
		// 用户主动停止(cancelling 且来源 user_stop,CLI 回 cancelled)不在此列:语义同 pi 后端
		// abort,正常收口;看门狗 stall 代发的 cancel 不豁免——那就是本守卫要抓的异常形态
		//（已有可见产出的 stall 已在上面按失败收口，走到这里只剩零产出形态）。
		if (!hasOutput && runtime.cancelReason !== "user_stop") {
			// CLI 原生命令（`/clear` 等）由 CLI 自己执行，本来就不产出 assistant/tool 正文：
			// 它与「事件流丢失」在消息层面同形（#512）。此时回滚用户条目 + 报 emptyTurn 是谎报
			// 发送失败（命令其实已执行），改为落一张中性回执卡收口；诊断仍写日志供排查。
			if (isNativeCommandPrompt(input)) {
				const commandText = input.message?.trim() ?? "";
				runtime.projection = appendAcpCommandReceipt(runtime.projection, { agentId: runtime.tab.id, tool: runtime.tool.name, command: commandText });
				this.updates.flushMessages(runtime, true);
				this.deps.logger?.warn("acp", "native command turn produced no output", {
					tool: runtime.tool.name,
					sessionId: runtime.acpSessionId,
					command: commandText.slice(0, 120),
					stopReason: settledStopReason,
					updateKinds: Object.fromEntries(runtime.turnUpdateKinds),
					stderrTail: runtime.stderrTail,
					foreignNotification: runtime.turnForeignNotification,
				});
				await this.persistArchive(runtime);
				return { accepted: true };
			}
			// 重试过但仍是空白回合：卡片按失败收口（报 retrySucceeded 会与「什么都没产出」矛盾），
			// 且必须在 rollback 之前落，rollback 只在尾巴上挂着重试卡时才保留它。
			if (retryAttempts > 0) {
				runtime.projection = upsertAcpRetryStatus(runtime.projection, { agentId: runtime.tab.id, status: "error", attempt: retryAttempts, maxAttempts: retrySettings.maxRetries, delayMs: 0, errorMessage: "completed the turn without any output" });
			}
			runtime.projection = rollbackAcpUserPrompt(runtime.projection, seededIndex);
			this.updates.flushMessages(runtime, true);
			const error = `ACP agent ${runtime.tool.name} completed the turn without any output`;
			// 概括文案看不出根因（限流/登录失败/事件流丢失都长一个样）：把这一回合能拿到的
			// 原始证据拼进 debugDetails，toast 与日志都能看到。
			const debugDetails = describeEmptyTurn({
				stopReason: settledStopReason,
				updateKinds: runtime.turnUpdateKinds,
				stderrTail: runtime.stderrTail,
				foreignNotification: runtime.turnForeignNotification,
				rawResult: promptResultSnippet(promptResult),
			});
			this.deps.logger?.warn("acp", error, {
				tool: runtime.tool.name,
				sessionId: runtime.acpSessionId,
				stopReason: settledStopReason,
				updateKinds: Object.fromEntries(runtime.turnUpdateKinds),
				stderrTail: runtime.stderrTail,
				foreignNotification: runtime.turnForeignNotification,
			});
			await this.persistArchive(runtime);
			return emptyTurnRejection(runtime.tool.name, debugDetails);
		}
		await this.persistArchive(runtime);
		// 真正成功收口（已过空白回合守卫）：通知装配层（会话完成通知 / 桌宠 done 气泡）。
		// 用户主动停止不算完成，与 pi 的 agent_settled 语义一致。
		if (runtime.cancelReason !== "user_stop") this.notifyAgentSettled(input.agentId, runtime.tab.title);
		return { accepted: true };
	}

	/**
	 * 重试退避等待：必须可被打断 —— 否则 2s/4s（最长 30s）的等待期间点「停止」毫无反应。
	 *
	 * 用 150ms 轮询而不是新增 runtime 字段 + 唤醒回调：等待只发生在失败后的退避里，
	 * 轮询代价可以忽略；而唤醒方案要求 abort/stop/连接死亡/会话重建四条路径各自记得唤醒，
	 * 漏一条就是「停止 2 秒后才生效」的 bug。轮询只看状态快照，天然不会漏。
	 */
	private async awaitRetryDelay(runtime: AcpAgentRuntime, delayMs: number): Promise<void> {
		const deadline = Date.now() + Math.max(0, delayMs);
		while (Date.now() < deadline) {
			if (runtime.cancelling || runtime.status === "closed" || this.runtimes.get(runtime.tab.id) !== runtime) return;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(150, Math.max(0, deadline - Date.now())));
				timer.unref?.();
			});
		}
	}

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		this.deps.logger?.info("acp", `[${runtime.tool.name}] abort requested`, {
			agentId,
			status: runtime.status,
			turnActive: runtime.turnActive,
			cancelling: runtime.cancelling,
			connClosed: !runtime.conn || runtime.conn.isClosed(),
		});
		if (!runtime.conn || runtime.conn.isClosed() || !runtime.turnActive) {
			// 回合已结算（结论早就出完）或连接已死，但渲染层可能因迟到的 status 事件仍显示运行中；
			// 停止按钮必须是一个有效收口动作，静默 no-op 会表现成「点停止没反应」。
			this.correctStaleRunningStatus(agentId, runtime);
			return;
		}
		if (runtime.cancelling) {
			// 二次停止:cancel 已发出但回合仍未收口(CLI wedged),不再等待,立即强杀。
			// 强杀 → conn.close 拒绝在途 session/prompt → sendPrompt catch 定向结算。
			this.forceStopRuntime(runtime, "abort_repeat");
			return;
		}
		// session/cancel 后仍接收尾部 update，原 prompt 返回才收口；审批则立即全部结算。
		runtime.cancelling = true;
		runtime.cancelReason = "user_stop";
		runtime.permissions.cancelAll();
		runtime.inFlightToolCalls.clear();
		runtime.conn.notify("session/cancel", { sessionId: runtime.acpSessionId, reason: "user_stop" });
		// cancel 只是通知:CLI 可能既不处理也不回包(opencode 流错误后实测 wedged)。
		// 宽限内回合自行结算则定时器被清;超时升级强杀,保证「停止」最终必然生效。
		this.turnWatchdog.scheduleAbortEscalation(runtime, "abort_no_response");
	}

	/**
	 * 收口渲染层可能残留的 running/starting：只在本端已确定没有活动回合时调用。
	 * conn 还在 → 推 idle；连接已死 → 推 error（与 closed handler 同语义），并清回合定时器。
	 */
	private correctStaleRunningStatus(agentId: string, runtime: AcpAgentRuntime): void {
		if (runtime.status !== "running" && runtime.status !== "starting") return;
		this.turnWatchdog.clearTurnTimers(runtime);
		runtime.turnActive = false;
		runtime.status = runtime.conn && !runtime.conn.isClosed() ? "idle" : "error";
		runtime.tab.status = runtime.status;
		this.emit(agentEventTags.agentsState, this.list());
		this.emitRuntimeState(agentId);
	}

	async stop(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		// 停止是最后一个写盘窗口：进程即将被杀、runtime 即将删除，之后没有投影可写。
		// 必须 await（退出路径 before-quit 会 await stopAll），否则最后一次写盘可能没落地。
		await this.persistArchive(runtime);
		runtime.status = "closed";
		runtime.tab.status = "closed";
		this.failPendingPermissions(runtime);
		// 先摘除并推终态:stop()/abort 升级强杀都走这里,渲染层需要 closed 事件把
		// 会话从 running 收口(删除后的 list() 不再含该 agent,不会产生逐 agent 事件;
		// 用户主动停止另有 coordinator 的 detach 事件,此推送与其幂等)。
		// 必须在有序停止之前:关 stdin 到 CLI 真退出最多等 gracefulExitMs，不能让 UI 干等。
		this.emit(agentEventTags.agentsState, this.list());
		this.runtimes.delete(agentId);
		this.emit(agentEventTags.agentsState, this.list());
		// 有序停止（#475）：关 stdin 给 CLI 跑 SessionEnd 钩子，宽限到点才强杀。
		await this.shutdownProcess(runtime);
	}

	async stopAll(): Promise<void> {
		// 并发而非串行：退出路径 before-quit 只有 5s 总预算，串行宽限会按 agent 数累加。
		await Promise.all([...this.runtimes.keys()].map((agentId) => this.stop(agentId)));
	}

	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No ACP runtime: ${agentId}`);
		const input: CreateAgentInput = {
			projectId: runtime.tab.projectId,
			title: runtime.tab.title,
			deckSessionId: runtime.tab.deckSessionId,
			backend: "acp",
			agentPreset: runtime.tool.id,
			// 无 loadSession 能力也要传 acpSessionId:握手制用本进程内快照播种投影保住显示连续性
			// (agent 侧仍是新会话);传 undefined 会让 create 末尾的全量 flush 把可见历史抹空。
			acpSessionId: runtime.acpSessionId || undefined,
			noSession: runtime.tab.noSession,
		};
		await this.stop(agentId);
		return this.create(input);
	}

	async sendUIResponse(agentId: string, requestId: string, response: SessionUiResponseInput["response"]): Promise<unknown> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime?.permissions.respond(requestId, response)) return { accepted: false, reason: "no-pending-request" };
		return { accepted: true };
	}

	notifyAskPending(agentId: string, sessionId: string, sessionTitle: string, question: string): void {
		// 桌面通知出口由装配层注入（与 pi 同一份门控/toast）；开关关着时不占用每轮去重位。
		if (!this.deps.notify?.askPending) return;
		if (this.notifiedAskAgents.has(agentId)) return;
		if (!this.deps.notify.askPending({ agentId, sessionId, sessionTitle, question })) return;
		this.notifiedAskAgents.add(agentId);
	}

	/** 注册「本轮成功收口」监听器（桌宠 / 完成通知）；返回退订。 */
	onAgentSettled(listener: (info: { agentId: string; title: string }) => void): () => void {
		this.settledListeners.add(listener);
		return () => {
			this.settledListeners.delete(listener);
		};
	}

	private notifyAgentSettled(agentId: string, title: string): void {
		for (const listener of this.settledListeners) {
			try {
				listener({ agentId, title });
			} catch {
				// 订阅者失败不得影响会话收口
			}
		}
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No ACP runtime: ${agentId}`);
		return buildAgentRuntimeState(runtime);
	}

	async publishRuntimeState(agentId: string): Promise<void> {
		if (this.runtimes.has(agentId)) this.emitRuntimeState(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		// ACP v1 无模型枚举方法(各 CLI 自管模型);声明空目录,UI 走 agent 自身。
		this.requireRuntime(agentId);
		return [];
	}

	async listCommands(agentId: string): Promise<PiCommand[]> {
		const runtime = this.runtimes.get(agentId);
		return runtime?.projection.commands ?? [];
	}

	/** SessionAgentGateway.getCommands(可选能力 getCommands):available_commands_update 投影。 */
	async getCommands(agentId: string): Promise<PiCommand[]> {
		return this.listCommands(agentId);
	}

	// ── 内部 ───────────────────────────────────────────────────────────────

	private requireRuntime(agentId: string): AcpAgentRuntime {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No ACP runtime: ${agentId}`);
		return runtime;
	}

	private async restoreArchivedSnapshot(acpSessionId: string | undefined): Promise<void> {
		await restoreAcpArchivedSnapshot(this.messageSnapshots, this.deps.archive, acpSessionId);
	}

	private persistArchive(runtime: AcpAgentRuntime): Promise<void> {
		return persistAcpArchive(this.deps.archive, runtime);
	}

	/**
	 * 成功回合记账：session/prompt 响应的实验性 usage（Qoder 返回 input/output tokens）
	 * 累计进会话 totals；TTFT/总耗时/TPS 用本地计时。空白回合会被回滚并报错，
	 * 由调用方用 hasOutput 挡掉，不污染「最近一次回复」与命中率样本。
	 */
	private recordTurnMetrics(runtime: AcpAgentRuntime, result: AcpSessionPromptResult | undefined): void {
		const endedAt = Date.now();
		const usage = readAcpTurnUsage(result);
		// TTFT 优先正文首字；纯思考回合（没有任何正文）回退思考首字——与 pi 的语义一致。
		const perf = acpReplyPerf({ startedAt: runtime.turnStartedAt, firstTextAt: runtime.turnFirstTextAt ?? runtime.turnFirstThoughtAt, endedAt, usage });
		if (perf) runtime.lastReplyPerf = { ...perf, at: endedAt };
		runtime.usageTotals = accumulateAcpUsage(runtime.usageTotals, usage, perf ? { totalMs: perf.totalMs ?? 0, ttftMs: perf.ttftMs } : undefined);
		runtime.turnStartedAt = undefined;
		runtime.turnFirstTextAt = undefined;
		runtime.turnFirstThoughtAt = undefined;
	}

	private emitRuntimeState(agentId: string): void {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		// runtime state 与 agentsState 同步推送：渲染层底栏状态依赖两个通道。
		this.emit(agentEventTags.agentsState, this.list());
		this.emit(agentEventTags.agentsRuntimeState, { agentId, state: buildAgentRuntimeState(runtime) });
	}

	/** 连接关闭/stop 时撤销全部审批并清在途工具集；RPC 回包与 timer 清理由权限 owner 配对。 */
	private failPendingPermissions(runtime: AcpAgentRuntime): void {
		runtime.permissions.cancelAll();
		runtime.inFlightToolCalls.clear();
	}

	/**
	 * abort 升级强杀出口：标记原因后走 stop() 同一路径（杀进程 → conn.close →
	 * 在途 session/prompt 被拒 → sendPrompt catch 定向结算）。
	 * cancelling 同步置位：强杀语义等价用户取消，不回滚用户消息。
	 */
	private forceStopRuntime(runtime: AcpAgentRuntime, reason: "abort_repeat" | "abort_no_response" | "stall"): void {
		if (this.runtimes.get(runtime.tab.id) !== runtime) return;
		this.turnWatchdog.clearTurnTimers(runtime);
		runtime.cancelling = true;
		runtime.escalatedStop = reason;
		this.deps.logger?.warn("acp", `[${runtime.tool.name}] force-stopping wedged agent (${reason})`, { agentId: runtime.tab.id, acpSessionId: runtime.acpSessionId });
		void this.stop(runtime.tab.id);
	}

	private killProcess(runtime: AcpAgentRuntime): void {
		killAcpRuntimeProcess(runtime, this.turnWatchdog);
	}

	private async shutdownProcess(runtime: AcpAgentRuntime): Promise<void> {
		await shutdownAcpRuntimeProcess(runtime, this.turnWatchdog, this.deps.gracefulExitMs);
	}

	private clearRuntimeTimers(runtime: AcpAgentRuntime): void {
		clearAcpRuntimeTimers(runtime, this.turnWatchdog);
	}
}
