/**
 * ACP agent CLI 的进程内会话管理器:backend="acp" 的 SessionAgentGateway 实现。
 *
 * 每个 agent(会话 runtime)独占一个 ACP CLI 子进程(stdio NDJSON JSON-RPC):
 * spawn → initialize → session/new(或 session/load 恢复)→ 会话期收
 * session/update 通知投影消息、应答 session/request_permission 审批。
 *
 * 结构对照 DshAgentManager(同类第三后端),但大幅简化:无共享 host、无 mux
 * 重连、无 follow 泵——进程即会话,stop 即结束。历史不落 PiDeck 本地文件,
 * 由 agent CLI 自行持久化;重启恢复靠 acpSessionId + session/load 重放。
 */
import { randomUUID } from "node:crypto";
import { ipcChannels } from "../../shared/ipc";
import type { AcpAgentInfo, AcpToolConfig } from "../../shared/types/acp";
import type { AgentGatewayCapability, AgentRuntimeState, AgentStatus, AgentTab, AvailableModel, CreateAgentInput } from "../../shared/types/agent";
import type { ChatMessage, SendPromptInput, SendPromptResult, SessionUiResponseInput } from "../../shared/types/session";
import type { PiCommand } from "../../shared/types/app";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { PiLocator } from "../pi/PiLocator";
import { ACP_PROTOCOL_VERSION, type AcpConfigOption, type AcpContentBlock, type AcpRpcNotification, type AcpSessionPromptResult, type AcpStopReason } from "./acpProtocol";
import { AcpTimeoutError } from "./AcpConnection";
import { AcpPermissionRequests } from "./AcpPermissionRequests";
import { acpPromptBlocks, appendAcpUserPrompt, initialAcpProjection, rollbackAcpUserPrompt, settleAcpTurn, type AcpProjectionState } from "./AcpEventProjector";
import { authRequiredDescriptor, localizeCreateFailure } from "./acpFailureDescriptors";
import { buildAgentRuntimeState, type AcpAgentRuntime } from "./acpAgentRuntime";
import { AcpTurnWatchdog } from "./acpTurnWatchdog";
import { AcpMessageSnapshotStore } from "./AcpMessageSnapshotStore";
import { killAcpProcessTree, spawnAcpProcess } from "./AcpProcessHost";
import { performAcpHandshake } from "./AcpHandshake";
import { AcpUpdatePipeline } from "./AcpUpdatePipeline";
import { emptyTurnRejection, escalatedStopRejection, hasTurnOutput, resolvePromptDispatch } from "./acpTurnSettlement";

/** session/prompt 回合兑底超时。测试用 deps.promptTurnTimeoutMs 注入缩短。 */
const PROMPT_TURN_TIMEOUT_MS = 10 * 60_000;

type AcpManagerDeps = {
	/** 解析命令启动形态(Windows .cmd 垫片还原、node 直启等)。 */
	piLocator: PiLocator;
	getProject: (id: string) => { path: string } | undefined;
	/** 读取用户登记的 ACP 工具表(settings.acpTools)。 */
	getTools: () => AcpToolConfig[];
	/**
	 * ACP 总开关(settings.acpEnabled)的运行时读口。
	 * 必须每次 create 时实时读:设置页变更立即生效,不需要重启应用。
	 */
	isEnabled: () => boolean;
	onTitleChanged?: (deckSessionId: string, title: string) => void;
	/** configOptions 变更推送(set_config_option 响应/config_option_update 通知)。 */
	onConfigOptionsChanged?: (tab: AgentTab, options: AcpConfigOption[]) => void;
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
	/** 回合无输出 stall 判定阈值(默认 90s)。测试注入短值验证看门狗。 */
	promptStallTimeoutMs?: number;
	/**
	 * ACP 超时口径的运行时读口（settings.acpPromptStallTimeoutMs / acpPromptTurnTimeoutMs）。
	 * 每次布防/派发实时读：设置变更后新回合立即生效，不需要重启。静态注入字段
	 * （promptStallTimeoutMs/promptTurnTimeoutMs，单测用）优先于本读口（#411：静态快照
	 * 让设置够不到看门狗，长工具调用/长回合被 90s/10min 硬编码误杀）。
	 */
	readAcpTimeoutSettings?: () => { promptStallTimeoutMs?: number; promptTurnTimeoutMs?: number };
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
	/** 回合看门狗（abort 升级宽限/stall 检测）：强杀出口回注 forceStopRuntime→stop()。 */
	private readonly turnWatchdog: AcpTurnWatchdog;
	/** session/update 摄入与消息发布管线（投影→物化→标题→节流 flush→快照）。 */
	private readonly updates: AcpUpdatePipeline;

	constructor(private readonly deps: AcpManagerDeps) {
		this.turnWatchdog = new AcpTurnWatchdog({
			ownsRuntime: (runtime) => this.runtimes.get(runtime.tab.id) === runtime,
			forceStop: (runtime, reason) => this.forceStopRuntime(runtime, reason),
			logger: deps.logger,
			abortEscalationMs: deps.abortEscalationMs,
			// getter：stall 阈值每次布防时实时解析（静态测试注入优先，其次 settings 读口，
			// 最后代码内默认 90s）。构造期静态快照会让设置变更够不到看门狗（#411 根因之一）。
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

	/**
	 * 按 agent 侧 sessionId 找消息。runtime 在场返回全量投影；已停止（stop/升级强杀）
	 * 返回最近一次 flush 的内存快照（cap MESSAGE_SNAPSHOT_LIMIT）——重入会话时时间线
	 * 不再空白，激活后 session/load 重放会覆盖为完整历史（无 load 能力则快照即全部可见历史）。
	 */
	readMessagesByAcpSessionId(acpSessionId: string): ChatMessage[] {
		if (!acpSessionId) return [];
		for (const runtime of this.runtimes.values()) {
			if (runtime.acpSessionId === acpSessionId) return runtime.projection.messages;
		}
		return this.messageSnapshots.get(acpSessionId) ?? [];
	}

	getMessages(agentId: string): ChatMessage[] {
		return this.readMessages(agentId);
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		// ACP v1 无改名请求;标题由 agent 侧 session_info_update 维护,这里只改本地 tab。
		const runtime = this.requireRuntime(agentId);
		runtime.tab = { ...runtime.tab, title: name };
		this.emit(ipcChannels.agentsState, this.list());
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
		const runtime = this.requireRuntime(agentId);
		// 串行化同一 runtime 的配置写入:乱序响应下迟到的旧整表会回退 runtime.configOptions
		// 并通过通知推过期状态(复核发现的乱序回退缺陷);排队后通知顺序=请求顺序。
		const previous = (runtime.configChain ?? Promise.resolve()).catch(() => undefined);
		const operation = previous.then(() => this.performConfigOptionRequest(runtime, optionId, value));
		runtime.configChain = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** 真正发出 session/set_config_option;在串行链上迟到执行,需重新校验 runtime 归属与连接。 */
	private async performConfigOptionRequest(runtime: AcpAgentRuntime, optionId: string, value: string | boolean): Promise<AcpConfigOption[]> {
		if (this.runtimes.get(runtime.tab.id) !== runtime) throw new Error("ACP agent is not running");
		const conn = runtime.conn;
		if (!conn || conn.isClosed()) throw new Error("ACP agent is not running");
		const result = (await conn.request("session/set_config_option", { sessionId: runtime.acpSessionId, configId: optionId, value }, 15_000)) as { configOptions?: AcpConfigOption[] } | null;
		if (!result || !Array.isArray(result.configOptions)) throw new Error("session/set_config_option returned no configOptions");
		runtime.configOptions = result.configOptions;
		this.deps.onConfigOptionsChanged?.(runtime.tab, result.configOptions);
		return result.configOptions;
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
		const { proc, conn, spawnFailure } = spawnAcpProcess(tool, cwd, { piLocator: this.deps.piLocator, logger: this.deps.logger });

		const agentId = `acp:${randomUUID()}`;
		const runtime: AcpAgentRuntime = {
			tab: {
				id: agentId,
				projectId: input.projectId,
				cwd,
				title: input.title ?? `${tool.name} 会话`,
				status: "starting",
				deckSessionId: input.deckSessionId,
				backend: "acp",
				agentPreset: tool.id,
				noSession: input.noSession,
				createdAt: Date.now(),
			},
			acpSessionId: "",
			tool,
			proc,
			conn,
			projection: initialAcpProjection(),
			updateChain: Promise.resolve(),
			agentInfo: { capabilities: { loadSession: false, agentThought: false, sessionList: false, promptImage: false }, protocolVersion: ACP_PROTOCOL_VERSION },
			status: "starting",
			turnActive: false,
			permissions: new AcpPermissionRequests(conn, (event) => this.emit(ipcChannels.agentsUiRequest, { agentId, ...event }), this.deps.permissionTimeoutMs),
			cancelling: false,
			cancelReason: null,
			reloading: false,
			flushTimer: null,
			flushPending: false,
			abortEscalateTimer: null,
			stallTimer: null,
			lastUpdateAt: 0,
			inFlightToolCalls: new Set<string>(),
			escalatedStop: null,
		};
		this.runtimes.set(agentId, runtime);
		this.emit(ipcChannels.agentsState, this.list());

		try {
			await performAcpHandshake(runtime, input.acpSessionId, cwd, spawnFailure, {
				handshakeTimeoutMs: this.deps.handshakeTimeoutMs,
				logger: this.deps.logger,
				seedMessages: (acpSessionId) => this.messageSnapshots.get(acpSessionId) ?? [],
				onNotification: (rt, notification) => this.updates.enqueueSessionUpdate(rt, notification),
				onConfigOptionsChanged: this.deps.onConfigOptionsChanged,
			});
		} catch (error) {
			this.runtimes.delete(agentId);
			this.killProcess(runtime);
			this.emit(ipcChannels.agentsState, this.list());
			const thrown = error instanceof Error ? error : new Error(String(error));
			// AUTH_REQUIRED / CLI 未安装(ENOENT) / 握手超时：附描述符再抛，
			// coordinator 透传为本地化引导 toast（不命中的错误原样透出原文）。
			localizeCreateFailure(thrown, tool);
			throw thrown;
		}

		this.wireConnection(runtime);
		if (runtime.title && runtime.tab.deckSessionId) this.deps.onTitleChanged?.(runtime.tab.deckSessionId, runtime.title);
		runtime.status = "idle";
		runtime.tab.status = "idle";
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(agentId);
		// load 重放/新建即回显:attach 会话历史立即可见。
		this.updates.flushMessages(runtime, true);
		return { ...runtime.tab };
	}

	/** 会话期请求处理注册(session/request_permission 等)。 */
	private wireConnection(runtime: AcpAgentRuntime): void {
		const conn = runtime.conn;
		if (!conn) return;
		conn.handleRequest("session/request_permission", (params, rpcId) => runtime.permissions.request(params, rpcId, runtime.acpSessionId, runtime.cancelling || runtime.status === "closed"));
		// fs/read_text_file 等未声明能力,规范约定回 method not found(AcpConnection 默认行为)。
		conn.on("closed", (error: Error | null) => {
			if (runtime.conn && runtime.conn.isClosed() && runtime.status === "closed") return;
			this.turnWatchdog.clearTurnTimers(runtime);
			runtime.status = "error";
			runtime.tab.status = "error";
			runtime.turnActive = false;
			// 进程死掉:结束流式消息、结算 pending 审批为 cancelled、推终态。
			// 结算排到 update 链尾:死亡前最后一批 update 可能还在链上物化,
			// 直接 settle 会把未消费的流式块拆成新回合。
			runtime.updateChain = runtime.updateChain
				.then(() => {
					runtime.projection = settleAcpTurn(runtime.projection, "error");
					this.failPendingPermissions(runtime);
					this.updates.flushMessages(runtime, true);
					this.emit(ipcChannels.agentsState, this.list());
					this.emitRuntimeState(runtime.tab.id);
					if (error) this.deps.logger?.warn("acp", `[${runtime.tool.name}] connection closed: ${error.message}`);
				})
				.catch(() => {
					// 结算链兜底:任何异常也不留 rejected promise 挂在链上
				});
		});
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		const dispatch = resolvePromptDispatch(input, runtime);
		if ("rejection" in dispatch) return dispatch.rejection;
		const { conn } = dispatch;
		const prompt = acpPromptBlocks(input.message, input.images);
		// 本回合结算 stopReason 的快照:成功路径的空白回合守卫在 try 外使用,需提前记录。
		let settledStopReason: AcpStopReason = "end_turn";
		// 用户消息先落投影:ACP 规范不保证 agent 回显 user_message_chunk(OpenCode 等根本不发),
		// 而 agents:message 是全量替换语义,主进程不落条目的话渲染层乐观气泡会被第一次 flush 抹掉。
		const messagesBeforeSeed = runtime.projection.messages.length;
		runtime.projection = appendAcpUserPrompt(runtime.projection, input.message, input.images, runtime.tab.id);
		const seededIndex = runtime.projection.messages.length > messagesBeforeSeed ? messagesBeforeSeed : -1;
		this.updates.applyProjectionTitle(runtime);
		runtime.turnActive = true;
		runtime.cancelling = false;
		runtime.cancelReason = null;
		runtime.escalatedStop = null;
		runtime.status = "running";
		runtime.tab.status = "running";
		this.emit(ipcChannels.agentsState, this.list());
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
			// 新回合生效）→ 代码内默认 10min。
			const turnTimeoutMs = this.deps.promptTurnTimeoutMs ?? this.deps.readAcpTimeoutSettings?.().promptTurnTimeoutMs ?? PROMPT_TURN_TIMEOUT_MS;
			const result = (await conn.request("session/prompt", { sessionId: runtime.acpSessionId, prompt }, turnTimeoutMs)) as AcpSessionPromptResult;
			this.turnWatchdog.clearTurnTimers(runtime);
			// 结算前先排空 update 链:result 帧与末批 update 同为 stdout 行序分发,
			// 但链上每步含异步物化,settle 提前会把在途流式块拆成新回合。
			await runtime.updateChain;
			settledStopReason = result?.stopReason ?? "end_turn";
			runtime.projection = settleAcpTurn(runtime.projection, settledStopReason);
		} catch (error) {
			await runtime.updateChain;
			this.turnWatchdog.clearTurnTimers(runtime);
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
			this.emit(ipcChannels.agentsState, this.list());
			this.emitRuntimeState(input.agentId);
			const message = error instanceof Error ? error.message : String(error);
			const hasOutput = hasTurnOutput(runtime.projection.messages, seededIndex);
			// 升级强杀（abort 宽限超时/二次停止/stall）：用户消息已留在时间线（cancelling 不回滚），
			// delivery=unknown（CLI 是否已处理不可知，不回填草稿避免重发重复），文案本地化并带原因。
			if (runtime.escalatedStop) {
				return escalatedStopRejection(runtime.escalatedStop, message, runtime.tool.name);
			}
			// AUTH_REQUIRED（凭据过期等回合期失败）：描述符随拒收结果透出登录引导。
			const descriptor = authRequiredDescriptor(error, runtime.tool);
			return { accepted: false, error: message, delivery: hasOutput || error instanceof AcpTimeoutError ? "unknown" : "rejected", ...(descriptor ?? {}) };
		}
		runtime.turnActive = false;
		runtime.permissions.cancelAll();
		runtime.inFlightToolCalls.clear();
		if (runtime.status === "running") {
			runtime.status = "idle";
			runtime.tab.status = "idle";
		}
		this.updates.flushMessages(runtime, true);
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		// 成功结算 ≠ 有可见输出：部分 CLI 因自身事件流竞态会正常回 end_turn 却漏掉全部
		// session/update（OpenCode 1.15.4 /event 订阅竞态实测：消息已被处理但 client 一无所获，
		// UI 只剩本地用户气泡、草稿已清空、还谎报成功）。回合已确定结束且无任何产出，
		// 按 rejected 收口并回滚本地用户条目：渲染层回填草稿，用户升级 CLI 后可安全重发。
		// 用户主动停止(cancelling 且来源 user_stop,CLI 回 cancelled)不在此列:语义同 pi 后端
		// abort,正常收口;看门狗 stall 代发的 cancel 不豁免——那就是本守卫要抓的异常形态。
		const hasOutput = hasTurnOutput(runtime.projection.messages, seededIndex);
		if (!hasOutput && runtime.cancelReason !== "user_stop") {
			runtime.projection = rollbackAcpUserPrompt(runtime.projection, seededIndex);
			this.updates.flushMessages(runtime, true);
			const error = `ACP agent ${runtime.tool.name} completed the turn without any output`;
			this.deps.logger?.warn("acp", error, { tool: runtime.tool.name, sessionId: runtime.acpSessionId, stopReason: settledStopReason });
			return emptyTurnRejection(runtime.tool.name);
		}
		return { accepted: true };
	}

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime?.conn || runtime.conn.isClosed() || !runtime.turnActive) return;
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

	async stop(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		runtime.status = "closed";
		runtime.tab.status = "closed";
		this.failPendingPermissions(runtime);
		this.killProcess(runtime);
		// 删除前先推一次终态:stop()/abort 升级强杀都走这里,渲染层需要 closed 事件把
		// 会话从 running 收口(删除后的 list() 不再含该 agent,不会产生逐 agent 事件;
		// 用户主动停止另有 coordinator 的 detach 事件,此推送与其幂等)。
		this.emit(ipcChannels.agentsState, this.list());
		this.runtimes.delete(agentId);
		this.emit(ipcChannels.agentsState, this.list());
	}

	async stopAll(): Promise<void> {
		for (const agentId of [...this.runtimes.keys()]) await this.stop(agentId);
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

	notifyAskPending(_agentId: string, _sessionId: string, _sessionTitle: string, _question: string): void {
		// 桌面通知由 SessionRuntimeCoordinator.observeRuntimeEvent 统一触发。
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

	private emitRuntimeState(agentId: string): void {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		// runtime state 与 agentsState 同步推送：渲染层底栏状态依赖两个通道。
		this.emit(ipcChannels.agentsState, this.list());
		this.emit(ipcChannels.agentsRuntimeState, { agentId, state: buildAgentRuntimeState(runtime) });
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
		if (runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		this.turnWatchdog.clearTurnTimers(runtime);
		runtime.conn?.close();
		const proc = runtime.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		runtime.proc = null;
		// 进程树击杀(Windows taskkill /T + 兑底 proc.kill)见 AcpProcessHost.killAcpProcessTree。
		killAcpProcessTree(proc);
	}
}
