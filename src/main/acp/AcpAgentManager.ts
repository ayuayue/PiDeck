/**
 * ACP agent CLI 的进程内会话管理器:backend="acp" 的 SessionAgentGateway 实现。
 *
 * 每个 agent(会话 runtime)独占一个 ACP CLI 子进程(stdio NDJSON JSON-RPC):
 * spawn → initialize → session/new(或 session/load 恢复)→ 会话期收
 * session/update 通知投影消息、应答 permission/request 审批。
 *
 * 结构对照 DshAgentManager(同类第三后端),但大幅简化:无共享 host、无 mux
 * 重连、无 follow 泵——进程即会话,stop 即结束。历史不落 PiDeck 本地文件,
 * 由 agent CLI 自行持久化;重启恢复靠 acpSessionId + session/load 重放。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ipcChannels } from "../../shared/ipc";
import type { AcpAgentInfo, AcpToolConfig } from "../../shared/types/acp";
import type { AgentGatewayCapability, AgentRuntimeState, AgentStatus, AgentTab, AvailableModel, CreateAgentInput } from "../../shared/types/agent";
import type { ChatMessage, SendPromptInput, SendPromptResult, SessionUiResponseInput } from "../../shared/types/session";
import type { PiCommand } from "../../shared/types/app";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { PiLocator } from "../pi/PiLocator";
import { ACP_ERROR_CODE, type AcpAgentCapabilities, type AcpConfigOption, type AcpContentBlock, type AcpIncomingRequest, type AcpPermissionRequestParams, type AcpSessionPromptResult, type AcpSessionSetupResult, type AcpSessionUpdateNotification } from "./acpProtocol";
import { AcpConnection, AcpRpcError, ACP_DEFER_RESPONSE } from "./AcpConnection";
import { acpPromptBlocks, initialAcpProjection, projectAcpSessionUpdate, settleAcpTurn, type AcpProjectionState } from "./AcpEventProjector";

/** ACP 协议握手版本(v1)。 */
const ACP_PROTOCOL_VERSION = 1;

/** initialize/session 握手超时:CLI 冷启动(npm 包)可能要十几秒。 */
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** permission/request 未应答超时:超时按 cancelled 回,避免 agent 侧永久挂起。 */
const PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** 流式消息 flush 节流:每 chunk 都 emit 会打爆 IPC(与 DSH 实测同因)。 */
const FLUSH_THROTTLE_MS = 80;

type AcpAgentRuntime = {
	tab: AgentTab;
	/** agent 侧 sessionId(ACP 会话身份,catalog 持久化为 acpSessionId)。 */
	acpSessionId: string;
	/** 使用的工具配置快照(会话期工具被删/改不影响运行中进程)。 */
	tool: AcpToolConfig;
	proc: import("node:child_process").ChildProcess | null;
	conn: AcpConnection | null;
	projection: AcpProjectionState;
	agentInfo: AcpAgentInfo;
	status: AgentStatus;
	/** 是否有进行中的 prompt 回合(session/prompt 尚未返回)。 */
	turnActive: boolean;
	/** permission/request pending:requestId(AgentUiRequest 用)→ { rpcId, optionsById }。 */
	pendingPermissions: Map<string, { rpcId: number; optionsById: Map<string, string> }>;
	permissionTimers: Map<string, NodeJS.Timeout>;
	flushTimer: NodeJS.Timeout | null;
	flushPending: boolean;
	/** 会话标题(session_info_update / new 返回值;供 catalog 自动标题)。 */
	title?: string;
	/** session/new|load 与 set_config_option 返回的会话级配置(模型/思考档/模式)。
	 *  渲染层按 category 渲染选择器;agent 不提供时恒 undefined(回退隐藏)。 */
	configOptions?: AcpConfigOption[];
	/** session/update 串行链:投影→物化(异步落盘)→flush 必须按序完成,
	 * 否则并发的物化回写会用旧 messages 快照覆盖后到的投影结果(图片/流式块丢失)。 */
	updateChain: Promise<void>;
};

type AcpManagerDeps = {
	/** 解析命令启动形态(Windows .cmd 垫片还原、node 直启等)。 */
	piLocator: PiLocator;
	getProject: (id: string) => { path: string } | undefined;
	/** 读取用户登记的 ACP 工具表(settings.acpTools)。 */
	getTools: () => AcpToolConfig[];
	onTitleChanged?: (deckSessionId: string, title: string) => void;
	/** configOptions 变更推送(set_config_option 响应/config_option_update 通知)。 */
	onConfigOptionsChanged?: (tab: AgentTab, options: AcpConfigOption[]) => void;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
	/** 图片落盘(base64→内容寻址 ref):生图 ImageBlobStore 的最小结构化依赖,便于单测注入假实现。 */
	imageStore?: { put(data: string, mimeType: string): Promise<string | null> };
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
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();

	constructor(private readonly deps: AcpManagerDeps) {}

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

	/** 按 agent 侧 sessionId 找消息(未激活/已停止返回空数组:历史在 agent 侧,需激活后 load 重放)。 */
	readMessagesByAcpSessionId(acpSessionId: string): ChatMessage[] {
		if (!acpSessionId) return [];
		for (const runtime of this.runtimes.values()) {
			if (runtime.acpSessionId === acpSessionId) return runtime.projection.messages;
		}
		return [];
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
		const project = this.deps.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		// 工具选择:agentPreset 字段承载 AcpToolConfig.id(coordinator 已归一传入)。
		const toolId = input.agentPreset ?? "";
		const tool = this.deps.getTools().find((candidate) => candidate.id === toolId && candidate.enabled);
		if (!tool) throw new Error(`ACP tool not found or disabled: ${toolId || "(none)"}`);
		const cwd = project.path;

		const invocation = this.deps.piLocator.createInvocation(tool.command, tool.args);
		// 工具级 env(如 codex-acp 的 ZAI_CODING_KEY)叠加在基础进程 env 之上;
		// 值可能含密钥,绝不进日志。
		const env = { ...this.deps.piLocator.createProcessEnv(), ...(tool.env ?? {}) };
		this.deps.logger?.info("acp", "Spawning ACP agent", { tool: tool.name, command: invocation.command, args: invocation.args });
		// ACP 规范:client 透传 stdio 的其余输出(日志走 stderr);windowsHide 对齐全项目惯例。
		const proc = spawn(invocation.command, invocation.args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell, env, windowsHide: true });
		// spawn 失败/被杀必须挂 error 监听(硬规则:未处理 error 事件崩主进程)。
		const spawnFailure = new Promise<never>((_, reject) => {
			proc.once("error", (error) => reject(error));
		});
		const conn = new AcpConnection(proc.stdin, proc.stdout);
		proc.stderr?.on("data", (chunk: Buffer) => {
			// CLI 诊断日志(stderr)只进主进程日志,不上时间线。
			const text = chunk.toString("utf8").trim();
			if (text) this.deps.logger?.info("acp", `[${tool.name}] ${text.slice(0, 2000)}`);
		});
		proc.once("exit", (code, signal) => {
			conn.close(new Error(`ACP agent exited (code=${code} signal=${signal})`));
		});

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
			agentInfo: { capabilities: { loadSession: false, agentThought: false, sessionList: false }, protocolVersion: ACP_PROTOCOL_VERSION },
			status: "starting",
			turnActive: false,
			pendingPermissions: new Map(),
			permissionTimers: new Map(),
			flushTimer: null,
			flushPending: false,
		};
		this.runtimes.set(agentId, runtime);
		this.emit(ipcChannels.agentsState, this.list());

		try {
			await this.handshake(runtime, input.acpSessionId, cwd, spawnFailure);
		} catch (error) {
			this.runtimes.delete(agentId);
			this.killProcess(runtime);
			this.emit(ipcChannels.agentsState, this.list());
			throw error instanceof Error ? error : new Error(String(error));
		}

		this.wireConnection(runtime);
		runtime.status = "idle";
		runtime.tab.status = "idle";
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(agentId);
		// load 重放/新建即回显:attach 会话历史立即可见。
		this.flushMessages(runtime, true);
		return { ...runtime.tab };
	}

	/** initialize + session/new(或 load);失败由调用方清理进程。 */
	private async handshake(runtime: AcpAgentRuntime, resumeSessionId: string | undefined, cwd: string, spawnFailure: Promise<never>): Promise<void> {
		const conn = runtime.conn;
		if (!conn) throw new Error("ACP connection missing");
		// 通知在握手后才有意义,但先注册分发(部分 CLI 握手期即可能推 update)。
		conn.on("notification", (notification: { method?: string }) => {
			// config_option_update:agent 主动推送配置变更(如限流降级模型),不进投影链,
			// 直接整表替换并通知渲染层(会话期可能无 in-flight set 请求,不能只在响应里更新)
			if (notification.method === "config_option_update") {
				const params = (notification as { params?: { sessionId?: string; configOptions?: AcpConfigOption[] } }).params;
				if (params?.sessionId === runtime.acpSessionId && Array.isArray(params.configOptions)) {
					runtime.configOptions = params.configOptions;
					this.deps.onConfigOptionsChanged?.(runtime.tab, params.configOptions);
				}
				return;
			}
			// 串行链:物化(异步落盘)回写 projection 前不能让下一个 update 先投影,
			// 否则旧快照覆盖新消息;链兑 catch,单条失败不断链。
			runtime.updateChain = runtime.updateChain
				.then(() => this.handleSessionUpdate(runtime, notification as unknown as AcpSessionUpdateNotification))
				.catch(() => {
					// handleSessionUpdate 自身已对物化降级,这里只兑 unexpected 异常
				});
		});
		conn.on("protocol-error", (line: unknown) => {
			// stdout 混入非 JSON(CLI banner/进度条):不致命,记录即可;ACP 规范允许 client 忽略。
			this.deps.logger?.warn("acp", `[${runtime.tool.name}] non-JSON stdout ignored: ${String(line).slice(0, 300)}`);
		});

		const initTask = conn.request(
			"initialize",
			{
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			},
			HANDSHAKE_TIMEOUT_MS,
		);
		const initResult = (await Promise.race([initTask, spawnFailure])) as { protocolVersion?: number; agentCapabilities?: AcpAgentCapabilities; authMethods?: unknown } & Record<string, unknown>;
		const agentCaps = initResult?.agentCapabilities ?? {};
		runtime.agentInfo = {
			name: typeof initResult.name === "string" ? initResult.name : undefined,
			capabilities: {
				loadSession: agentCaps.loadSession === true,
				agentThought: agentCaps.promptCapabilities?.agentThought === true,
				sessionList: agentCaps.sessionCapabilities?.list === true,
			},
			protocolVersion: typeof initResult.protocolVersion === "number" ? initResult.protocolVersion : ACP_PROTOCOL_VERSION,
		};
		conn.notify("initialized", {});

		// session/new 或 session/load。load 失败(id 在 agent 侧已不存在)回退新建。
		let setup: AcpSessionSetupResult | undefined;
		if (resumeSessionId && runtime.agentInfo.capabilities.loadSession) {
			try {
				setup = (await conn.request("session/load", { sessionId: resumeSessionId, cwd }, HANDSHAKE_TIMEOUT_MS)) as AcpSessionSetupResult;
			} catch (error) {
				this.deps.logger?.warn("acp", `session/load failed, falling back to session/new: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!setup?.sessionId) {
			setup = (await conn.request("session/new", { cwd }, HANDSHAKE_TIMEOUT_MS)) as AcpSessionSetupResult;
		}
		if (!setup?.sessionId || typeof setup.sessionId !== "string") throw new Error("ACP session/new returned no sessionId");
		runtime.acpSessionId = setup.sessionId;
		if (typeof setup.title === "string" && setup.title.trim()) runtime.title = setup.title.trim();
		// configOptions 规范路径(取代旧 modes):模型/思考档/模式枚举,渲染层选择器数据源
		runtime.configOptions = Array.isArray(setup.configOptions) ? setup.configOptions : undefined;
	}

	/** 会话期请求处理注册(permission/request 等)。 */
	private wireConnection(runtime: AcpAgentRuntime): void {
		const conn = runtime.conn;
		if (!conn) return;
		conn.handleRequest("permission/request", (params, rpcId) => {
			this.handlePermissionRequest(runtime, params as unknown as AcpPermissionRequestParams, rpcId);
			// 异步审批：等用户应答后经 conn.respond(rpcId, …) 回，连接层不代答。
			return ACP_DEFER_RESPONSE;
		});
		// fs/read_text_file 等未声明能力,规范约定回 method not found(AcpConnection 默认行为)。
		conn.on("closed", (error: Error | null) => {
			if (runtime.conn && runtime.conn.isClosed() && runtime.status === "closed") return;
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
					this.flushMessages(runtime, true);
					this.emit(ipcChannels.agentsState, this.list());
					this.emitRuntimeState(runtime.tab.id);
					if (error) this.deps.logger?.warn("acp", `[${runtime.tool.name}] connection closed: ${error.message}`);
				})
				.catch(() => {
					// 结算链兜底:任何异常也不留 rejected promise 挂在链上
				});
		});
	}

	private async handleSessionUpdate(runtime: AcpAgentRuntime, notification: AcpSessionUpdateNotification): Promise<void> {
		if (notification.method !== "session/update") return;
		if (notification.params?.sessionId !== runtime.acpSessionId) return;
		runtime.projection = projectAcpSessionUpdate(runtime.projection, notification.params.update, runtime.tab.id);
		// 图片物化:投影器产出的 base64 图在进消息缓存前落盘成 ref(同生图「base64 不进历史」契约);
		// 失败保留 data 形态展示(ACP 不写 JSONL,内联形态只是内存开销,不违反存储约束)。
		await this.materializeTouchedImages(runtime);
		if (runtime.projection.title && runtime.projection.title !== runtime.title) {
			runtime.title = runtime.projection.title;
			if (runtime.tab.deckSessionId) this.deps.onTitleChanged?.(runtime.tab.deckSessionId, runtime.projection.title);
		}
		this.scheduleFlush(runtime);
	}

	/** 把本轮投影 touched 消息里的 data 形态图片替换成落盘 ref;仅替换成功项,失败保留原样。 */
	private async materializeTouchedImages(runtime: AcpAgentRuntime): Promise<void> {
		const store = this.deps.imageStore;
		const touched = runtime.projection.lastTouched;
		if (!store || !touched || touched.length === 0) return;
		let messages = runtime.projection.messages;
		let mutated = false;
		for (const index of touched) {
			const message = messages[index];
			if (!message?.images?.length) continue;
			const images = await Promise.all(
				message.images.map(async (image) => {
					if (image.type !== "image" || image.ref || typeof image.data !== "string") return image;
					try {
						const ref = await store.put(image.data, image.mimeType);
						return ref ? { type: "image" as const, mimeType: image.mimeType, ref } : image;
					} catch {
						return image;
					}
				}),
			);
			if (mutated || images.some((image, i) => image !== message.images?.[i])) {
				messages = [...messages];
				messages[index] = { ...message, images };
				mutated = true;
			}
		}
		if (mutated) runtime.projection = { ...runtime.projection, messages };
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		if (!runtime.conn || runtime.conn.isClosed()) {
			return { accepted: false, error: "ACP agent process is not running", delivery: "rejected" };
		}
		if (input.agentMessage) {
			return { accepted: false, error: "Host instructions are not supported by ACP backend", delivery: "rejected" };
		}
		if (runtime.turnActive) {
			return { accepted: false, error: "ACP agent is still responding; stop or wait for the current turn", delivery: "rejected" };
		}
		const prompt = acpPromptBlocks(input.message, input.images);
		runtime.turnActive = true;
		runtime.status = "running";
		runtime.tab.status = "running";
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		try {
			// 长回合请求不套默认 60s 短超时:深思模型单回合可超分钟级,超时应由 abort/stop/连接死亡驱动;
			// 10 分钟兑底防真悬死(实测 codex-acp 思考型回合 >60s,见 scripts/acpLiveSmoke.mjs)
			const result = (await runtime.conn.request("session/prompt", { sessionId: runtime.acpSessionId, prompt }, 10 * 60_000)) as AcpSessionPromptResult;
			// 结算前先排空 update 链:result 帧与末批 update 同为 stdout 行序分发,
			// 但链上每步含异步物化,settle 提前会把在途流式块拆成新回合。
			await runtime.updateChain;
			runtime.projection = settleAcpTurn(runtime.projection, result?.stopReason ?? "end_turn");
		} catch (error) {
			await runtime.updateChain;
			runtime.projection = settleAcpTurn(runtime.projection, "error");
			runtime.turnActive = false;
			// 连接死亡等外部终态(error/closed)由 closed handler 结算,不回 idle;
			// 仅本回合请求失败(如 JSON-RPC 拒绝)从 running 回 idle。
			if (runtime.status === "running") {
				runtime.status = "idle";
				runtime.tab.status = "idle";
			}
			this.flushMessages(runtime, true);
			this.emit(ipcChannels.agentsState, this.list());
			this.emitRuntimeState(input.agentId);
			const message = error instanceof Error ? error.message : String(error);
			return { accepted: false, error: message, delivery: "rejected" };
		}
		runtime.turnActive = false;
		runtime.status = "idle";
		runtime.tab.status = "idle";
		this.flushMessages(runtime, true);
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		return { accepted: true };
	}

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime?.conn || runtime.conn.isClosed() || !runtime.turnActive) return;
		// session/cancel:agent 端尽快收口;本地状态由 prompt 返回/连接关闭结算。
		runtime.conn.notify("session/cancel", { sessionId: runtime.acpSessionId, reason: "user_stop" });
	}

	async stop(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		runtime.status = "closed";
		runtime.tab.status = "closed";
		this.failPendingPermissions(runtime);
		this.killProcess(runtime);
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
			acpSessionId: runtime.agentInfo.capabilities.loadSession ? runtime.acpSessionId : undefined,
			noSession: runtime.tab.noSession,
		};
		await this.stop(agentId);
		return this.create(input);
	}

	async sendUIResponse(agentId: string, requestId: string, response: SessionUiResponseInput["response"]): Promise<unknown> {
		const runtime = this.runtimes.get(agentId);
		const pending = runtime?.pendingPermissions.get(requestId);
		if (!runtime || !pending) return { accepted: false, reason: "no-pending-request" };
		runtime.pendingPermissions.delete(requestId);
		this.clearPermissionTimer(runtime, requestId);
		// 渲染层 select 的 value 是选项 label;映射回 ACP optionId。
		let optionId = typeof response.value === "string" ? pending.optionsById.get(response.value) : undefined;
		if (response.cancelled || optionId === undefined) {
			runtime.conn?.respond(pending.rpcId, { outcome: "cancelled" });
		} else {
			runtime.conn?.respond(pending.rpcId, { outcome: "selected", optionId });
		}
		this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
		return { accepted: true };
	}

	notifyAskPending(_agentId: string, _sessionId: string, _sessionTitle: string, _question: string): void {
		// 桌面通知由 SessionRuntimeCoordinator.observeRuntimeEvent 统一触发。
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No ACP runtime: ${agentId}`);
		return this.buildRuntimeState(runtime);
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

	private buildRuntimeState(runtime: AcpAgentRuntime): AgentRuntimeState {
		return {
			isStreaming: runtime.turnActive,
			isTurnActive: runtime.turnActive,
			// 工具名作展示模型位：让底栏显示当前 CLI（如 "Gemini CLI"）。
			modelName: runtime.tool.name,
			provider: "acp",
			modelId: runtime.tool.id,
			todos: runtime.projection.todos,
		};
	}

	private emitRuntimeState(agentId: string): void {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		// runtime state 与 agentsState 同步推送：渲染层底栏状态依赖两个通道。
		this.emit(ipcChannels.agentsState, this.list());
		this.emit("agents:runtime-state" as string, { agentId, runtime: this.buildRuntimeState(runtime) });
	}

	/** 节流 flush:流式 chunk 80ms 合并一次;force 立即全量(session 结算)。 */
	private scheduleFlush(runtime: AcpAgentRuntime): void {
		if (runtime.flushTimer) {
			runtime.flushPending = true;
			return;
		}
		runtime.flushTimer = setTimeout(() => {
			runtime.flushTimer = null;
			const pending = runtime.flushPending;
			runtime.flushPending = false;
			this.flushMessages(runtime, !pending);
			if (pending) this.scheduleFlush(runtime);
		}, FLUSH_THROTTLE_MS);
		runtime.flushTimer.unref?.();
	}

	private flushMessages(runtime: AcpAgentRuntime, force: boolean): void {
		if (force && runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		this.emit(ipcChannels.agentsMessage, {
			agentId: runtime.tab.id,
			deckSessionId: runtime.tab.deckSessionId,
			messages: runtime.projection.messages,
			totalLength: runtime.projection.messages.length,
		});
	}

	private handlePermissionRequest(runtime: AcpAgentRuntime, params: AcpPermissionRequestParams, rpcId: number): void {
		if (!params || params.sessionId !== runtime.acpSessionId || !Array.isArray(params.options) || params.options.length === 0) {
			// 规范:client 拒绝不了请求本身,最小可应答 = cancel。
			return;
		}
		// 被许可对象描述(标题):command / path 等变体的可读摘要。
		const summary = (params.permissions ?? [])
			.map((item) => {
				if (item.type === "command") return item.command;
				if (item.type === "read_path" || item.type === "write_path") return item.path;
				if (item.type === "web_search") return "web search";
				return item.type;
			})
			.join(", ");
		const requestId = `acp-ask-${randomUUID().slice(0, 8)}`;
		const optionsById = new Map<string, string>();
		const labels: string[] = [];
		for (const option of params.options) {
			const label = option.name ?? option.kind.replace(/_/g, " ");
			optionsById.set(label, option.kind);
			labels.push(label);
		}
		runtime.pendingPermissions.set(requestId, { rpcId, optionsById });
		const timer = setTimeout(() => {
			runtime.pendingPermissions.delete(requestId);
			this.clearPermissionTimer(runtime, requestId);
			this.emit(ipcChannels.agentsUiRequest, { agentId: runtime.tab.id, requestId, completed: true });
		}, PERMISSION_TIMEOUT_MS);
		timer.unref();
		runtime.permissionTimers.set(requestId, timer);
		this.emit(ipcChannels.agentsUiRequest, {
			agentId: runtime.tab.id,
			requestId,
			method: "select",
			title: summary || `${runtime.tool.name} permission`,
			options: labels,
		});
	}

	/** 连接关闭/stop 时把未应答审批全部按 cancelled 回结，避免 agent 侧永久挂起。 */
	private failPendingPermissions(runtime: AcpAgentRuntime): void {
		for (const [requestId, pending] of [...runtime.pendingPermissions]) {
			runtime.conn?.respond(pending.rpcId, { outcome: "cancelled" });
			runtime.pendingPermissions.delete(requestId);
			this.clearPermissionTimer(runtime, requestId);
			this.emit(ipcChannels.agentsUiRequest, { agentId: runtime.tab.id, requestId, completed: true });
		}
	}

	private clearPermissionTimer(runtime: AcpAgentRuntime, requestId: string): void {
		const timer = runtime.permissionTimers.get(requestId);
		if (timer) {
			clearTimeout(timer);
			runtime.permissionTimers.delete(requestId);
		}
	}

	private killProcess(runtime: AcpAgentRuntime): void {
		if (runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		runtime.conn?.close();
		const proc = runtime.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		proc.removeAllListeners("exit");
		proc.kill();
		runtime.proc = null;
	}
}

export { AcpRpcError, ACP_ERROR_CODE };
