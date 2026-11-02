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
import { ACP_PROTOCOL_VERSION, type AcpConfigOption, type AcpContentBlock, type AcpMcpServer, type AcpRpcNotification, type AcpSessionPromptResult, type AcpStopReason } from "./acpProtocol";
import { AcpTimeoutError } from "./AcpConnection";
import { AcpPermissionRequests } from "./AcpPermissionRequests";
import { acpPromptBlocks, appendAcpUserPrompt, initialAcpProjection, rollbackAcpUserPrompt, settleAcpTurn, upsertAcpRetryStatus, type AcpProjectionState } from "./AcpEventProjector";
import { authRequiredDescriptor, localizeCreateFailure, promptTurnTimeoutDescriptor } from "./acpFailureDescriptors";
import { buildAgentRuntimeState, type AcpAgentRuntime } from "./acpAgentRuntime";
import { findAcpBypassModeValue, findAcpModeOption, isAcpBypassModeValue, isRememberedAcpConfigOption, planAcpConfigReplay } from "./acpToolConfig";
import { accumulateAcpUsage, acpReplyPerf, readAcpTurnUsage } from "./acpUsageMetrics";
import { AcpTurnWatchdog } from "./acpTurnWatchdog";
import { AcpMessageSnapshotStore } from "./AcpMessageSnapshotStore";
import type { AcpSessionArchive } from "./AcpSessionArchive";
import { killAcpProcessTree, shutdownAcpProcess, spawnAcpProcess } from "./AcpProcessHost";
import type { AcpProxyEnvSettings } from "../sessions/sessionProxyPolicy";
import { performAcpHandshake } from "./AcpHandshake";
import { AcpUpdatePipeline } from "./AcpUpdatePipeline";
import { describeEmptyTurn, emptyTurnRejection, escalatedStopRejection, hasTurnOutput, promptResultSnippet, resolvePromptDispatch } from "./acpTurnSettlement";
import { decideAcpTurnRetry, resolveAcpTurnRetrySettings, type AcpTurnRetrySettings } from "./acpTurnRetry";
import { failureMessage } from "../../shared/retry/transientFailure";

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
	/** 回合无输出 stall 判定阈值(默认 90s)。测试注入短值验证看门狗。 */
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
	 * 让设置够不到看门狗，长工具调用/长回合被 90s/10min 硬编码误杀）。
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

/** CLI 诊断输出(stderr)尾部:只留最近几行且每行截断,仅供空白回合诊断/日志,不进时间线。 */
const STDERR_TAIL_LINES = 5;
const STDERR_LINE_MAX_CHARS = 200;

function pushStderrTail(runtime: AcpAgentRuntime, text: string): void {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line) runtime.stderrTail.push(line.slice(0, STDERR_LINE_MAX_CHARS));
	}
	if (runtime.stderrTail.length > STDERR_TAIL_LINES) runtime.stderrTail.splice(0, runtime.stderrTail.length - STDERR_TAIL_LINES);
}

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
	 * 按 agent 侧 sessionId 找消息（**同步读口，只覆盖内存态**）。runtime 在场返回全量投影；
	 * 已停止（stop/升级强杀）返回最近一次 flush 的内存快照（cap MESSAGE_SNAPSHOT_LIMIT）——
	 * 重入会话时时间线不再空白，激活后 session/load 重放会覆盖为完整历史（无 load 能力
	 * 则快照即全部可见历史）。
	 *
	 * 为什么这里不回退磁盘归档：这是同步契约（重启播种链路与既有回归用例都按同步返回
	 * 断言），而归档读取是磁盘 IO，同步读在 Electron 主进程会阻塞事件循环。需要
	 * 「内存 miss 时读归档」的异步边界（IPC/Web）用 readMessagesWithArchive。
	 */
	readMessagesByAcpSessionId(acpSessionId: string): ChatMessage[] {
		if (!acpSessionId) return [];
		for (const runtime of this.runtimes.values()) {
			if (runtime.acpSessionId === acpSessionId) return runtime.projection.messages;
		}
		return this.messageSnapshots.get(acpSessionId) ?? [];
	}

	/**
	 * 按 acpSessionId 读消息（**异步读口**）：runtime 投影 → 磁盘归档 → 内存快照逐级回退
	 * （归档在快照之前，理由见方法内注释：快照有 400 条上限，归档才是完整历史）。
	 *
	 * 为什么保留两个入口：同步版是既有契约（开机恢复/播种与历史用例按同步断言），只覆盖
	 * 内存；归档是磁盘 IO，不能塞进同步路径。归档读失败/文件损坏在 AcpSessionArchive
	 * 内部降级为空数组，不抛——跨 IPC 不得把归档异常透给渲染层。
	 */
	async readMessagesWithArchive(acpSessionId: string): Promise<ChatMessage[]> {
		if (!acpSessionId) return [];
		for (const runtime of this.runtimes.values()) {
			if (runtime.acpSessionId === acpSessionId) return runtime.projection.messages;
		}
		// 归档优先于内存快照：归档是结算点写的完整快照（≤2000 条），内存快照只是
		// ≤400 条的流式末段。先读快照会让重开的长会话只剩末尾 400 条（时间线、分页、
		// 会话内查找都被截断）。归档读不到（首次运行/写盘失败）才回退快照。
		const archived = (await this.deps.archive?.read(acpSessionId)) ?? [];
		if (archived.length > 0) return archived;
		return this.messageSnapshots.get(acpSessionId) ?? [];
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
		return this.enqueueConfigOption(agentId, optionId, value, true);
	}

	/**
	 * 配置写入入队:串行化同一 runtime 的配置写入(乱序响应下迟到的旧整表会回退
	 * runtime.configOptions 并推过期通知;排队后通知顺序=请求顺序)。
	 * remember=false 用于新建会话重放,避免把记忆值再写回设置。
	 */
	private enqueueConfigOption(agentId: string, optionId: string, value: string | boolean, remember: boolean): Promise<AcpConfigOption[]> {
		const runtime = this.requireRuntime(agentId);
		const previous = (runtime.configChain ?? Promise.resolve()).catch(() => undefined);
		const operation = previous.then(() => this.performConfigOptionRequest(runtime, optionId, value, remember));
		runtime.configChain = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** 真正发出 session/set_config_option;在串行链上迟到执行,需重新校验 runtime 归属与连接。 */
	private async performConfigOptionRequest(runtime: AcpAgentRuntime, optionId: string, value: string | boolean, remember: boolean): Promise<AcpConfigOption[]> {
		if (this.runtimes.get(runtime.tab.id) !== runtime) throw new Error("ACP agent is not running");
		const conn = runtime.conn;
		if (!conn || conn.isClosed()) throw new Error("ACP agent is not running");
		let result: { configOptions?: AcpConfigOption[] } | null;
		try {
			// boolean 项必须带上 agent 声明的 type：CodeBuddy 2.178.1 的 set_config_option
			// 对 {configId, value} 按 string 分支校验，boolean 值直接 -32602 Invalid params；
			// 带 type:"boolean" 才走 boolean 分支（issue #451）。select 项保持旧帧形状，
			// 部分实现（opencode 等）对多余字段更敏感，没必要多带。
			const declaredType = (runtime.configOptions ?? []).find((candidate) => candidate.id === optionId)?.type;
			const params = declaredType === "boolean" ? { sessionId: runtime.acpSessionId, configId: optionId, type: declaredType, value } : { sessionId: runtime.acpSessionId, configId: optionId, value };
			result = (await conn.request("session/set_config_option", params, 15_000)) as { configOptions?: AcpConfigOption[] } | null;
		} catch (error) {
			// 拒绝原因常只写在 error.data.details 里（如 Qoder 的 "unknown permission_mode: yolo"），
			// 而 IPC 只透传 message：不拼进去渲染层就只剩 "Internal error"，用户无从判断为什么没生效。
			const details = (error as { data?: { details?: unknown } } | null)?.data?.details;
			if (typeof details === "string" && details.trim() && !(error instanceof Error && error.message.includes(details))) {
				throw new Error(`${error instanceof Error ? error.message : String(error)}: ${details.trim()}`);
			}
			throw error;
		}
		if (!result || !Array.isArray(result.configOptions)) throw new Error("session/set_config_option returned no configOptions");
		runtime.configOptions = result.configOptions;
		this.deps.onConfigOptionsChanged?.(runtime.tab, result.configOptions);
		if (remember) this.rememberAppliedConfigOption(runtime, optionId, value, result.configOptions);
		return result.configOptions;
	}

	/** 只记忆 agent 实际接受的值;模型类选项(用户口径)不落盘。 */
	private rememberAppliedConfigOption(runtime: AcpAgentRuntime, optionId: string, requested: string | boolean, options: AcpConfigOption[]): void {
		const option = options.find((candidate) => candidate.id === optionId);
		if (!option || !isRememberedAcpConfigOption(option)) return;
		const applied = option.currentValue ?? requested;
		if (typeof applied !== "string" && typeof applied !== "boolean") return;
		this.deps.rememberConfigOption?.(runtime.tool.id, optionId, applied);
	}

	/** 非 session/update 通知留样本（诊断）：只保留最后一条，截断防长帧污染 UI。 */
	private rememberTurnNotification(runtime: AcpAgentRuntime, notification: AcpRpcNotification): void {
		const method = notification.method ?? "";
		// config_option_update 是已知通道（握手期即处理），不算异常信号。
		if (!method || method === "session/update" || method === "config_option_update") return;
		runtime.turnForeignNotification = `${method}: ${JSON.stringify(notification).slice(0, 300)}`;
	}

	/**
	 * 工具级 bypass 权限：握手后在 agent 自己的 mode 枚举里挑 bypass 档下发。
	 *
	 * 只能用运行期下发：Claude 适配器不读启动参数（初始模式只取 settings.json 的
	 * permissions.defaultMode），Qoder 适配器则直接拒绝 set_config_option（见 #444 同类问题）。
	 * 所以失败只记日志——某些 CLI 版本压根没有 bypass 档，不该因此开不了会话。
	 * 启动参数已经定档（Qoder `--permission-mode`）时记忆重放会让路，见 pinnedBypassModeOptionId。
	 *
	 * session/load 恢复的会话也必须下发：agent 不持久化权限模式，load 回来的是新进程的默认档
	 * （CodeBuddy/Claude 实测都是 auto），跳过这一步历史会话就从 full/bypass 掉回 auto。
	 * 已处于 bypass 档时 currentValue 与目标值相等，自然不会重复下发。
	 */
	private async applyBypassPermissionDefault(runtime: AcpAgentRuntime): Promise<void> {
		if (runtime.tool.bypassPermissions !== true) return;
		const mode = findAcpModeOption(runtime.configOptions);
		if (!mode) return;
		const bypass = findAcpBypassModeValue(mode);
		if (!bypass || mode.currentValue === bypass) return;
		try {
			await this.enqueueConfigOption(runtime.tab.id, mode.id, bypass, false);
		} catch (error) {
			// 记忆里不落这条：用户没主动选过，写进去会污染后续会话的默认值
			this.deps.logger?.warn("acp", `[${runtime.tool.name}] bypass permission mode rejected: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * 模式档已由启动参数定在 bypass 时的选项 id（记忆重放必须让路）。
	 *
	 * Qoder 只能靠 `--permission-mode` 定档（运行期 set_config_option 回
	 * -32603 unknown permission_mode: yolo），若这里不拦，重放记忆里的旧档位（如 auto）会把
	 * 会话降回非 bypass，随后补设 bypass 又必然失败——新会话显示 Auto、重开（session/load
	 * 不重放）反而正常，正是这条链。
	 */
	private pinnedBypassModeOptionId(runtime: AcpAgentRuntime): string | undefined {
		if (runtime.tool.bypassPermissions !== true) return undefined;
		const mode = findAcpModeOption(runtime.configOptions);
		if (!mode) return undefined;
		const bypass = findAcpBypassModeValue(mode);
		return bypass && mode.currentValue === bypass ? mode.id : undefined;
	}

	/**
	 * 握手后重放工具级记忆：新建会话全量重放；session/load 恢复的会话只补回 bypass 档。
	 *
	 * 恢复会话全量重放会覆盖 agent 自己恢复的会话状态（思考档等），所以保持不重放；
	 * 权限模式是唯一例外——agent 不持久化它，load 回来只是进程默认档（如 auto），不补的话
	 * 用户上次在历史会话里选的 full/bypass 重开后就没了。只补 bypass 值而非记忆里的任意模式，
	 * 是为了不把 agent 恢复出的会话模式降级成一条更早的记忆。
	 */
	private async replayToolConfigDefaults(runtime: AcpAgentRuntime): Promise<void> {
		const defaults = this.deps.getToolConfigDefaults?.(runtime.tool.id);
		// 工具级 bypass 开关是「明确配置」：模式已是 bypass 时保住它，不让学来的上次选择覆盖。
		const pinnedModeId = this.pinnedBypassModeOptionId(runtime);
		const mode = findAcpModeOption(runtime.configOptions);
		// 恢复会话只补「当前还不是 bypass」的模式：agent 恢复出的已是 bypass（可能更强，如
		// fullAccess）就保持不动——跨档重放会把它降成记忆里的弱档；非 bypass 记忆则一律不覆盖。
		const restoreBypass = runtime.loadedSession && mode !== undefined && !isAcpBypassModeValue(mode.currentValue ?? false);
		for (const item of planAcpConfigReplay(runtime.configOptions, defaults)) {
			if (item.id === pinnedModeId) continue;
			if (runtime.loadedSession && !(restoreBypass && item.id === mode?.id && isAcpBypassModeValue(item.value))) continue;
			try {
				await this.enqueueConfigOption(runtime.tab.id, item.id, item.value, false);
			} catch (error) {
				// 选项在当前 CLI 版本已移除/值被拒:跳过,不能让记忆阻断开会话。
				this.deps.logger?.warn("acp", `[${runtime.tool.name}] remembered config skipped: ${item.id}`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
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
			permissions: new AcpPermissionRequests(conn, (event) => this.emit(agentEventTags.agentsUiRequest, { agentId, ...event }), this.deps.permissionTimeoutMs),
			cancelling: false,
			cancelReason: null,
			reloading: false,
			loadedSession: false,
			flushTimer: null,
			flushPending: false,
			abortEscalateTimer: null,
			stallTimer: null,
			lastUpdateAt: 0,
			turnDeadlineRefresh: null,
			inFlightToolCalls: new Set<string>(),
			escalatedStop: null,
			turnSawActivity: false,
			turnUpdateKinds: new Map<string, number>(),
			stderrTail: [],
		};
		this.runtimes.set(agentId, runtime);
		this.emit(agentEventTags.agentsState, this.list());
		// CLI 诊断输出（stderr）留一份尾部：限流/登录失败常常只打在这里，空白回合时要随
		// 拒收结果带进 UI，否则用户只看到「无输出」的概括（主进程日志另有全量记录）。
		runtime.proc?.stderr?.on("data", (chunk: Buffer) => pushStderrTail(runtime, chunk.toString("utf8")));

		try {
			await this.bootstrapRuntime(runtime, input.acpSessionId, spawnFailure);
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

	/** 会话期请求处理注册(session/request_permission 等)。 */
	private wireConnection(runtime: AcpAgentRuntime): void {
		const conn = runtime.conn;
		if (!conn) return;
		conn.handleRequest("session/request_permission", (params, rpcId) => {
			// 已发出审批 = 工具已开动（可能已在写文件）：断线重连不再重跑。
			runtime.turnSawActivity = true;
			// 挂起审批 = agent 在等用户输入，属合法等待：顺延回合兑底截止
			// （审批本身另有 PERMISSION_TIMEOUT_MS 到期，不会无限拖延）。
			runtime.lastUpdateAt = Date.now();
			runtime.turnDeadlineRefresh?.();
			return runtime.permissions.request(params, rpcId, runtime.acpSessionId, runtime.cancelling || runtime.status === "closed");
		});
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
					this.emit(agentEventTags.agentsState, this.list());
					this.emitRuntimeState(runtime.tab.id);
					if (error) this.deps.logger?.warn("acp", `[${runtime.tool.name}] connection closed: ${error.message}`);
				})
				.catch(() => {
					// 结算链兜底:任何异常也不留 rejected promise 挂在链上
				});
		});
	}

	/**
	 * runtime 就绪序列：归档回灌 → 握手（load 续历史/快照播种）→ 配置重放 → 接线 → idle。
	 * create() 与断线重连共用同一条序列；失败原样抛出，由调用方决定丢弃 runtime 还是按失败收口。
	 */
	private async bootstrapRuntime(runtime: AcpAgentRuntime, acpSessionId: string | undefined, spawnFailure: Promise<never>, handshakeTimeoutMs?: number): Promise<void> {
		// 归档回灌必须在 performAcpHandshake **之前**：握手的 seedMessages 读的是快照存储
		// （load 失败回退 session/new、CLI 无 loadSession 能力这两条路径都靠它播种投影），
		// 晚一步播种就是空数组 —— 重启/换机后历史仍然空白，正是本功能要解决的那件事。
		await this.restoreArchivedSnapshot(acpSessionId);
		await performAcpHandshake(runtime, acpSessionId, runtime.tab.cwd, spawnFailure, {
			handshakeTimeoutMs: handshakeTimeoutMs ?? this.deps.handshakeTimeoutMs,
			logger: this.deps.logger,
			mcpServers: this.deps.mcpServers,
			seedMessages: (sessionId) => this.messageSnapshots.get(sessionId) ?? [],
			onNotification: (rt, notification) => {
				// 有过任何通知 = agent 已经开始干活：断线后重开会重跑工具，不再自动重连。
				rt.turnSawActivity = true;
				// 非标准通知（如 session/error）留样本：空白回合的诊断要能说出 agent 是否用
				// 协议外通道报过错，而不是一律当作没看见。
				this.rememberTurnNotification(rt, notification);
				this.updates.enqueueSessionUpdate(rt, notification);
			},
			onConfigOptionsChanged: this.deps.onConfigOptionsChanged,
		});
		// 新建会话(含 load 失败回退 session/new)重放工具级记忆:思考档/模式/权限等跨会话继承,
		// 模型不在记忆范围(见 acpToolConfig.isRememberedAcpConfigOption)。单条失败只跳过,
		// 不影响开会话。session/load 成功的恢复会话交给 agent 自己恢复状态。
		await this.replayToolConfigDefaults(runtime);
		// 放记忆重放之后：工具级开关是「明确配置」，优先级高于学来的上次选择
		await this.applyBypassPermissionDefault(runtime);

		this.wireConnection(runtime);
		if (runtime.title && runtime.tab.deckSessionId) this.deps.onTitleChanged?.(runtime.tab.deckSessionId, runtime.title);
		runtime.status = "idle";
		runtime.tab.status = "idle";
		this.emit(agentEventTags.agentsState, this.list());
		this.emitRuntimeState(runtime.tab.id);
		// load 重放/新建即回显:attach 会话历史立即可见。
		this.updates.flushMessages(runtime, true);
		// 握手成功即留一份归档副本（load 重放完成 / 归档回灌后），不必等到第一次回合结算
		// 或 stop()。空投影不会写盘（AcpSessionArchive 的护栏），load 重放为空也不会写坏归档。
		await this.persistArchive(runtime);
	}

	/**
	 * 断线重连（原地、同一 agentId）：杀旧进程 → 重开 → 用原 acpSessionId 走 session/load
	 * 续上历史 → 接线回 idle。显示层由握手重建（load 重放 / 无 loadSession 时快照播种），
	 * 所以旧投影必须丢弃 —— 留着会和重放历史重复，这正是 restart() 当初「换新 runtime」的理由。
	 * 返回 false 表示重连失败（进程起不来/握手超时），调用方按原失败收口。
	 */
	private async respawnRuntime(runtime: AcpAgentRuntime): Promise<boolean> {
		const tool = runtime.tool;
		const resumingSessionId = runtime.acpSessionId || undefined;
		this.deps.logger?.warn("acp", `[${tool.name}] connection lost, respawning session`, { agentId: runtime.tab.id, sessionId: resumingSessionId ?? null });
		this.killProcess(runtime);
		let spawned: ReturnType<typeof spawnAcpProcess>;
		try {
			spawned = spawnAcpProcess(tool, runtime.tab.cwd, { piLocator: this.deps.piLocator, proxy: this.deps.getProxySettings?.(), logger: this.deps.logger });
		} catch (error) {
			this.deps.logger?.warn("acp", `[${tool.name}] respawn failed: ${failureMessage(error)}`, { agentId: runtime.tab.id });
			return false;
		}
		const { proc, conn, spawnFailure } = spawned;
		runtime.proc = proc;
		runtime.conn = conn;
		// 审批对象绑定旧连接：换连接必须换审批入口，否则弹窗回包会往死连接写。
		runtime.permissions = new AcpPermissionRequests(conn, (event) => this.emit(agentEventTags.agentsUiRequest, { agentId: runtime.tab.id, ...event }), this.deps.permissionTimeoutMs);
		proc?.stderr?.on("data", (chunk: Buffer) => pushStderrTail(runtime, chunk.toString("utf8")));
		runtime.stderrTail = [];
		// 重连失败时投影要还原（下面 catch 里做）：显示层丢了历史比「这回合失败」严重得多。
		const previousProjection = runtime.projection;
		runtime.projection = initialAcpProjection();
		runtime.updateChain = Promise.resolve();
		runtime.turnDeadlineRefresh = null;
		runtime.loadedSession = false;
		runtime.reloading = false;
		runtime.status = "starting";
		runtime.tab.status = "starting";
		try {
			// 重连不给人等 60s：CLI 起不来就按原失败收口，用户还能手动重启。
			await this.bootstrapRuntime(runtime, resumingSessionId, spawnFailure, RESPAWN_HANDSHAKE_TIMEOUT_MS);
			return true;
		} catch (error) {
			this.deps.logger?.warn("acp", `[${tool.name}] respawn handshake failed: ${failureMessage(error)}`, { agentId: runtime.tab.id });
			this.killProcess(runtime);
			runtime.projection = previousProjection;
			return false;
		}
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
						if (!(await this.respawnRuntime(runtime))) throw error;
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
		if (hasOutput) this.recordTurnMetrics(runtime, promptResult);
		this.updates.flushMessages(runtime, true);
		this.emit(agentEventTags.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		// 成功结算 ≠ 有可见输出：部分 CLI 因自身事件流竞态会正常回 end_turn 却漏掉全部
		// session/update（OpenCode 1.15.4 /event 订阅竞态实测：消息已被处理但 client 一无所获，
		// UI 只剩本地用户气泡、草稿已清空、还谎报成功）。回合已确定结束且无任何产出，
		// 按 rejected 收口并回滚本地用户条目：渲染层回填草稿，用户升级 CLI 后可安全重发。
		// 用户主动停止(cancelling 且来源 user_stop,CLI 回 cancelled)不在此列:语义同 pi 后端
		// abort,正常收口;看门狗 stall 代发的 cancel 不豁免——那就是本守卫要抓的异常形态。
		if (!hasOutput && runtime.cancelReason !== "user_stop") {
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

	/**
	 * 从磁盘归档回灌内存快照（仅在内存没有该会话时）。
	 * 内存优先的理由：内存快照是本进程最新的投影（归档只在结算点写，可能更旧），
	 * 用归档覆盖会回退刚产生的历史。读失败/文件损坏在 AcpSessionArchive 内部降级空数组，
	 * 这里不做错误分支——归档不可用等价于「没有历史」，不能影响 create。
	 */
	private async restoreArchivedSnapshot(acpSessionId: string | undefined): Promise<void> {
		const archive = this.deps.archive;
		if (!archive || !acpSessionId) return;
		if (this.messageSnapshots.get(acpSessionId)) return;
		const archived = await archive.read(acpSessionId);
		if (archived.length === 0) return;
		// 双检：await 期间同会话可能有 runtime 结算并写入更新的快照，别用旧归档盖掉它。
		if (this.messageSnapshots.get(acpSessionId)) return;
		// setRestored：回灌要完整历史，不能套用流式末段的 400 条裁剪（否则重启后只回灌
		// 末尾 400 条，#415 的「历史可读回」打折）。
		this.messageSnapshots.setRestored(acpSessionId, archived);
	}

	/**
	 * 把当前投影排队写入归档（失败只记日志，永不外抛）。调用点固定在「回合结算后」与
	 * stop()/stopAll()：那里投影已 settle、内容稳定，且是一回合一次的写频率。
	 */
	private persistArchive(runtime: AcpAgentRuntime): Promise<void> {
		const acpSessionId = runtime.acpSessionId;
		if (!this.deps.archive || !acpSessionId) return Promise.resolve();
		return this.deps.archive.enqueueSave(acpSessionId, runtime.projection.messages);
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
		this.clearRuntimeTimers(runtime);
		runtime.conn?.close();
		const proc = runtime.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		runtime.proc = null;
		// 进程树击杀(Windows taskkill /T + 兑底 proc.kill)见 AcpProcessHost.killAcpProcessTree。
		killAcpProcessTree(proc);
	}

	/**
	 * 有序停止（issue #475）：结算在途请求 → 关 stdin → 等 CLI 自己退出（跑 SessionEnd
	 * 钩子/自身清理），宽限到点仍未退出才整树强杀。与 pi 侧 LocalPiRuntimeLauncher 的
	 * stop 对齐（#450）；握手失败/断线重连仍走 killProcess 的立即强杀（进程/连接已死，
	 * 没有可等的收尾）。
	 */
	private async shutdownProcess(runtime: AcpAgentRuntime): Promise<void> {
		this.clearRuntimeTimers(runtime);
		runtime.conn?.close();
		const proc = runtime.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		runtime.proc = null;
		await shutdownAcpProcess(proc, { gracefulExitMs: this.deps.gracefulExitMs });
	}

	/** flush 批处理 + 回合看门狗的定时器收尾；两条停止路径共用。 */
	private clearRuntimeTimers(runtime: AcpAgentRuntime): void {
		if (runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		this.turnWatchdog.clearTurnTimers(runtime);
	}
}
