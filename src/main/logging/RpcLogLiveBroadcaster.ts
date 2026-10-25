import { ipcChannels } from "../../shared/ipc";
import type { RpcLogBatch, RpcLogEntry } from "../../shared/types/rpcLog";

/** 直发渲染层通道的宿主回调：装配层保证窗口存活检查，销毁后静默丢弃。 */
export type RpcLogLiveSend = (channel: string, payload: unknown) => void;

export type RpcLogLiveBroadcasterDeps = {
	/**
	 * 窗口直发（agentsRpcLog 在 pi AgentManager 的 DIRECT_EMIT_CHANNELS 白名单内：
	 * preload 直订 webContents，不走 sessions:runtime-envelope 桥）。
	 */
	send: RpcLogLiveSend;
	/** 节流间隔；缺省 80ms（与 pi AgentManager.LIVE_RPC_LOG_FLUSH_MS 一致）。测试可注入小值。 */
	flushMs?: number;
};

/**
 * 实时 RPC 日志广播器依赖的最小接口（DshAgentManager 按此注入，避免直接依赖具体类）。
 */
export interface RpcLogLiveSink {
	setWatching(agentId: string, watching: boolean): void;
	enqueue(entry: RpcLogEntry): void;
	dropPending(agentId: string): void;
	clear(): void;
}

/**
 * 实时 RPC 日志广播器：把开启了「实时查看」的 agent 的日志条目按 80ms 节流批量直发渲染层。
 *
 * 语义与 pi AgentManager 的 enqueueLiveRpcLog/flushLiveRpcLogs 逐条对齐（DSH 复用同一套
 * 常量与丢最旧/留余量的边界），渲染层 RpcLogPanel 对两个后端无感：
 * - 观看闸门：面板没打开（setWatching 未登记）直接丢弃——落盘/环形缓冲已在 RpcLogger.push 完成，
 *   面板打开时初始历史走 rpcLogsGetLive 环形缓冲补齐；
 * - 批量推送：降低 IPC 次数，渲染层一次 state 更新收到多条，减少重渲染频率；
 * - 有界聚合：极端高频下丢最旧保上限；单次批次超限的条目留到下一轮，不丢日志。
 *
 * 与 pi 的差异（刻意的）：本类只负责广播，不持有「记录开关」（记录开关语义上属于
 * AgentManager 各自的 rpcLoggingAgents，DSH 侧见 DshAgentManager.setRpcLogging）。
 */
export class RpcLogLiveBroadcaster implements RpcLogLiveSink {
	private static readonly DEFAULT_FLUSH_MS = 80;
	private static readonly MAX_BATCH = 100;
	private static readonly MAX_PENDING = 1000;

	private readonly flushMs: number;
	private readonly watchingAgents = new Set<string>();
	private readonly pendingByAgent = new Map<string, RpcLogEntry[]>();
	private flushTimer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: RpcLogLiveBroadcasterDeps) {
		this.flushMs = deps.flushMs ?? RpcLogLiveBroadcaster.DEFAULT_FLUSH_MS;
	}

	/**
	 * 登记「某 agent 的实时日志面板是否在看」。
	 * 由渲染层面板挂载/卸载成对调用（rpcLogsSetWatching）；只影响广播，不影响记录与落盘。
	 */
	setWatching(agentId: string, watching: boolean): void {
		if (watching) this.watchingAgents.add(agentId);
		else this.watchingAgents.delete(agentId);
	}

	/**
	 * 聚合待广播的实时日志条目（入口喂 RpcLogger.push 返回的截断副本，与 getLive 形态一致）。
	 * 无观看者直接丢弃；聚合缓冲按 agent 有界（超限丢最旧）。
	 */
	enqueue(entry: RpcLogEntry): void {
		if (!this.watchingAgents.has(entry.agentId)) return;
		let pending = this.pendingByAgent.get(entry.agentId);
		if (!pending) {
			pending = [];
			this.pendingByAgent.set(entry.agentId, pending);
		}
		if (pending.length >= RpcLogLiveBroadcaster.MAX_PENDING) {
			// 极端高频下丢弃最旧，保证聚合缓冲有界
			pending.splice(0, pending.length - RpcLogLiveBroadcaster.MAX_PENDING + 1);
		}
		pending.push(entry);
		if (this.flushTimer === null) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null;
				this.flush();
			}, this.flushMs);
		}
	}

	/** 把聚合缓冲按 agent 拆分后批量广播；单次批次超限的条目留到下一轮，不丢日志。 */
	private flush(): void {
		if (this.pendingByAgent.size === 0) return;
		for (const [agentId, entries] of [...this.pendingByAgent]) {
			const batch = entries.slice(0, RpcLogLiveBroadcaster.MAX_BATCH);
			if (batch.length > 0) {
				this.deps.send(ipcChannels.agentsRpcLog, { agentId, entries: batch } satisfies RpcLogBatch);
			}
			const rest = entries.slice(RpcLogLiveBroadcaster.MAX_BATCH);
			if (rest.length > 0) {
				this.pendingByAgent.set(agentId, rest);
			} else {
				this.pendingByAgent.delete(agentId);
			}
		}
	}

	/**
	 * 清空某 agent 的聚合缓冲（会话停止时调用，防止残留数据泄漏给下一次 attach）。
	 * 刻意不清观看登记：DSH 的 agentId（dsh:<sessionId>）跨 stop/attach 稳定，
	 * 面板可能合法地跨重启周期保持挂载（其 watching 登记必须存活）；pi 侧因
	 * agentId 每次 spawn 随机，关闭时观看登记随进程一起废弃（见 AgentManager）。
	 */
	dropPending(agentId: string): void {
		this.pendingByAgent.delete(agentId);
	}

	/** 全量清理（stopAll/退出）：清观看登记、聚合缓冲与在途定时器。 */
	clear(): void {
		this.watchingAgents.clear();
		this.pendingByAgent.clear();
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}
}
