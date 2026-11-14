/**
 * ACP runtime 生命周期：会话期请求接线 → 就绪序列（归档回灌/握手/配置重放 → idle）→ 断线重连。
 *
 * 从 AcpAgentManager 抽出：这三段是同一条链上的三个位置（create 与 respawn 共用
 * bootstrapRuntime，closed 处理又只在接线处注册），散在 manager 里最容易出现
 * 「改了一条路径漏了另一条」。协议细节（握手超时、load 回退、旧投影丢弃）保持原样，
 * 本模块只按 host 出口动作，会话成败判定仍由 manager 的 sendPrompt 收口。
 */
import type { AgentTab } from "../../shared/types/agent";
import type { ChatMessage } from "../../shared/types/session";
import type { PiLocator } from "../pi/PiLocator";
import type { AcpProxyEnvSettings } from "../sessions/sessionProxyPolicy";
import type { AcpConnection } from "./AcpConnection";
import type { AcpConfigOption, AcpMcpServer, AcpRpcNotification } from "./acpProtocol";
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import { initialAcpProjection, settleAcpTurn } from "./AcpEventProjector";
import { performAcpHandshake } from "./AcpHandshake";
import { spawnAcpProcess } from "./AcpProcessHost";
import { pushStderrTail, rememberTurnNotification } from "./acpRuntimeDiagnostics";
import { failureMessage } from "../../shared/retry/transientFailure";

/** 断线重连的握手上限：比冷启动 60s 短，重连失败要尽快让用户看到失败而不是干等。 */
const RESPAWN_HANDSHAKE_TIMEOUT_MS = 20_000;

export type AcpRuntimeLifecycleHost = {
	/** 立即强杀（重连前替旧进程 / 握手失败收口）。 */
	killProcess(runtime: AcpAgentRuntime): void;
	/** 换连接后重建审批入口：弹窗回包不得写向死连接。 */
	recreatePermissions(runtime: AcpAgentRuntime, conn: AcpConnection): void;
	/** 归档回灌（必须在握手之前，握手的 seedMessages 依赖它）。 */
	restoreArchivedSnapshot(acpSessionId: string | undefined): Promise<void>;
	persistArchive(runtime: AcpAgentRuntime): Promise<void>;
	/** 握手播种用的内存快照读取口。 */
	seedMessages(sessionId: string): ChatMessage[];
	replayToolConfigDefaults(runtime: AcpAgentRuntime): Promise<void>;
	applyBypassPermissionDefault(runtime: AcpAgentRuntime): Promise<void>;
	/** 会话期请求处理注册(session/request_permission 等)与连接关闭结算。 */
	wireConnection(runtime: AcpAgentRuntime): void;
	enqueueSessionUpdate(runtime: AcpAgentRuntime, notification: AcpRpcNotification): void;
	flushMessages(runtime: AcpAgentRuntime, immediate: boolean): void;
	flushMessagesChunked(runtime: AcpAgentRuntime): void;
	failPendingPermissions(runtime: AcpAgentRuntime): void;
	clearTurnTimers(runtime: AcpAgentRuntime): void;
	emitAgentsState(): void;
	emitRuntimeState(agentId: string): void;
	onTitleChanged?: (deckSessionId: string, title: string) => void;
	onConfigOptionsChanged?: (tab: AgentTab, options: AcpConfigOption[]) => void;
	mcpServers?: (cwd: string) => AcpMcpServer[];
	piLocator: PiLocator;
	getProxySettings?: () => AcpProxyEnvSettings | undefined;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
	/** initialize/session-new/load 握手超时（默认 60s）。 */
	handshakeTimeoutMs?: number;
};

export class AcpRuntimeLifecycle {
	constructor(private readonly host: AcpRuntimeLifecycleHost) {}

	/** 会话期请求处理注册(session/request_permission 等)。 */
	wireConnection(runtime: AcpAgentRuntime): void {
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
			this.host.clearTurnTimers(runtime);
			runtime.status = "error";
			runtime.tab.status = "error";
			runtime.turnActive = false;
			// 进程死掉:结束流式消息、结算 pending 审批为 cancelled、推终态。
			// 结算排到 update 链尾:死亡前最后一批 update 可能还在链上物化,
			// 直接 settle 会把未消费的流式块拆成新回合。
			runtime.updateChain = runtime.updateChain
				.then(() => {
					runtime.projection = settleAcpTurn(runtime.projection, "error");
					this.host.failPendingPermissions(runtime);
					this.host.flushMessages(runtime, true);
					this.host.emitAgentsState();
					this.host.emitRuntimeState(runtime.tab.id);
					if (error) this.host.logger?.warn("acp", `[${runtime.tool.name}] connection closed: ${error.message}`);
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
	async bootstrapRuntime(runtime: AcpAgentRuntime, acpSessionId: string | undefined, spawnFailure: Promise<never>, handshakeTimeoutMs?: number): Promise<void> {
		// 归档回灌必须在 performAcpHandshake **之前**：握手的 seedMessages 读的是快照存储
		// （load 失败回退 session/new、CLI 无 loadSession 能力这两条路径都靠它播种投影），
		// 晚一步播种就是空数组 —— 重启/换机后历史仍然空白，正是本功能要解决的那件事。
		await this.host.restoreArchivedSnapshot(acpSessionId);
		await performAcpHandshake(runtime, acpSessionId, runtime.tab.cwd, spawnFailure, {
			handshakeTimeoutMs: handshakeTimeoutMs ?? this.host.handshakeTimeoutMs,
			logger: this.host.logger,
			mcpServers: this.host.mcpServers,
			seedMessages: (sessionId) => this.host.seedMessages(sessionId),
			onNotification: (rt, notification) => {
				// 有过任何通知 = agent 已经开始干活：断线后重开会重跑工具，不再自动重连。
				rt.turnSawActivity = true;
				// 非标准通知（如 session/error）留样本：空白回合的诊断要能说出 agent 是否用
				// 协议外通道报过错，而不是一律当作没看见。
				rememberTurnNotification(rt, notification);
				this.host.enqueueSessionUpdate(rt, notification);
			},
			onConfigOptionsChanged: this.host.onConfigOptionsChanged,
		});
		// 新建会话(含 load 失败回退 session/new)重放工具级记忆:思考档/模式/权限等跨会话继承,
		// 模型不在记忆范围(见 acpToolConfig.isRememberedAcpConfigOption)。单条失败只跳过,
		// 不影响开会话。session/load 成功的恢复会话交给 agent 自己恢复状态。
		await this.host.replayToolConfigDefaults(runtime);
		// 放记忆重放之后：工具级开关是「明确配置」，优先级高于学来的上次选择
		await this.host.applyBypassPermissionDefault(runtime);

		this.host.wireConnection(runtime);
		if (runtime.title && runtime.tab.deckSessionId) this.host.onTitleChanged?.(runtime.tab.deckSessionId, runtime.title);
		runtime.status = "idle";
		runtime.tab.status = "idle";
		this.host.emitAgentsState();
		this.host.emitRuntimeState(runtime.tab.id);
		// load 重放/新建即回显:attach 会话历史立即可见。
		// 重放是全量投递（实测 1076 条 / 4251KB），一次发完会在渲染进程形成 ~236ms 长任务，
		// 这里按块摊开；条数不多时内部直接退化为一次常规 flush。
		this.host.flushMessagesChunked(runtime);
		// 握手成功即留一份归档副本（load 重放完成 / 归档回灌后），不必等到第一次回合结算
		// 或 stop()。空投影不会写盘（AcpSessionArchive 的护栏），load 重放为空也不会写坏归档。
		await this.host.persistArchive(runtime);
	}

	/**
	 * 断线重连（原地、同一 agentId）：杀旧进程 → 重开 → 用原 acpSessionId 走 session/load
	 * 续上历史 → 接线回 idle。显示层由握手重建（load 重放 / 无 loadSession 时快照播种），
	 * 所以旧投影必须丢弃 —— 留着会和重放历史重复，这正是 restart() 当初「换新 runtime」的理由。
	 * 返回 false 表示重连失败（进程起不来/握手超时），调用方按原失败收口。
	 */
	async respawnRuntime(runtime: AcpAgentRuntime): Promise<boolean> {
		const tool = runtime.tool;
		const resumingSessionId = runtime.acpSessionId || undefined;
		this.host.logger?.warn("acp", `[${tool.name}] connection lost, respawning session`, { agentId: runtime.tab.id, sessionId: resumingSessionId ?? null });
		this.host.killProcess(runtime);
		let spawned: ReturnType<typeof spawnAcpProcess>;
		try {
			spawned = spawnAcpProcess(tool, runtime.tab.cwd, { piLocator: this.host.piLocator, proxy: this.host.getProxySettings?.(), logger: this.host.logger });
		} catch (error) {
			this.host.logger?.warn("acp", `[${tool.name}] respawn failed: ${failureMessage(error)}`, { agentId: runtime.tab.id });
			return false;
		}
		const { proc, conn, spawnFailure } = spawned;
		runtime.proc = proc;
		runtime.conn = conn;
		// 审批对象绑定旧连接：换连接必须换审批入口，否则弹窗回包会往死连接写。
		this.host.recreatePermissions(runtime, conn);
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
			this.host.logger?.warn("acp", `[${tool.name}] respawn handshake failed: ${failureMessage(error)}`, { agentId: runtime.tab.id });
			this.host.killProcess(runtime);
			runtime.projection = previousProjection;
			return false;
		}
	}
}
