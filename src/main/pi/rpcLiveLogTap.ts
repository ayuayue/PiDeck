import type { RpcLogBatch, RpcLogEntry } from "../../shared/types/rpcLog";
import { ipcChannels } from "../../shared/ipc";

/**
 * RPC 实时日志广播闸门与聚合缓冲（从 AgentManager 迁出，行为零变化）。
 *
 * 三个开关层级（缺一不可）：
 * 1. rpcLoggingAgents —— 用户手动开启记录的 agent 才产生日志流量（落盘 + 广播）；
 * 2. rpcLogWatchingAgents —— 渲染层日志面板在看才广播（落盘与环形缓冲不受影响）；
 *    没有观看者时每条 RPC 日志仍按批结构化克隆发过去，重度会话里等于每秒 ~5MB 的
 *    无主 IPC，序列化在主进程做，表现为整个应用（含输入、流式）掉帧；
 * 3. pendingLiveRpcLogs 聚合缓冲 —— 流式阶段 RPC 事件可能非常高频，
 *    逐条 IPC 会把渲染进程打爆，必须按 80ms 批量推送。
 */
export class RpcLiveLogTap {
	/** 开启了 RPC 日志记录的 agent id 集合 */
	private readonly loggingAgents = new Set<string>();
	/**
	 * 当前有渲染层日志面板在看的 agent id 集合（面板挂载/卸载时经 rpcLogsSetWatching 登记）。
	 * 落盘与环形缓冲不受它影响（记录开着就一直写），只用于**广播闸门**。
	 */
	private readonly watchingAgents = new Set<string>();
	/** 实时 RPC 日志广播缓冲：按 agent 聚合待发条目，节流刷出。 */
	private readonly pendingByAgent = new Map<string, RpcLogEntry[]>();
	private flushTimer: NodeJS.Timeout | null = null;
	/** 实时日志广播节流间隔：聚合 ~80ms 的条目一次性推送 */
	private static readonly FLUSH_MS = 80;
	/** 单次广播批次的条数上限，防止单条 IPC 负载过大 */
	private static readonly MAX_BATCH = 100;
	/** 聚合缓冲的条数上限，极端高频时丢弃最旧条目，防止内存失控 */
	private static readonly MAX_PENDING = 1000;

	constructor(
		/** 批量广播出口（AgentManager.emit，保持事件通道不变）。 */
		private readonly emitBatch: (channel: string, payload: RpcLogBatch) => void,
	) {}

	/**
	 * 聚合待广播的实时日志条目，节流刷出（见 FLUSH_MS）。
	 * 批量推送既能降低 IPC 次数，也让渲染层一次 state 更新收到多条，减少重渲染频率。
	 */
	enqueue(entry: RpcLogEntry): void {
		// 广播闸门：面板没打开就直接丢弃（落盘/环形缓冲已在 RpcLogger.push 里完成）。
		// 面板打开时会先 setWatching(true)，初始历史走 getLive 环形缓冲补齐。
		if (!this.watchingAgents.has(entry.agentId)) return;
		let pending = this.pendingByAgent.get(entry.agentId);
		if (!pending) {
			pending = [];
			this.pendingByAgent.set(entry.agentId, pending);
		}
		if (pending.length >= RpcLiveLogTap.MAX_PENDING) {
			// 极端高频下丢弃最旧，保证聚合缓冲有界
			pending.splice(0, pending.length - RpcLiveLogTap.MAX_PENDING + 1);
		}
		pending.push(entry);
		if (this.flushTimer === null) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null;
				this.flush();
			}, RpcLiveLogTap.FLUSH_MS);
		}
	}

	/** 把聚合缓冲按 agent 拆分后批量广播；单次批次超限的条目留到下一轮，不丢日志 */
	flush(): void {
		if (this.pendingByAgent.size === 0) return;
		for (const [agentId, entries] of [...this.pendingByAgent]) {
			const batch = entries.slice(0, RpcLiveLogTap.MAX_BATCH);
			if (batch.length > 0) {
				this.emitBatch(ipcChannels.agentsRpcLog, { agentId, entries: batch } satisfies RpcLogBatch);
			}
			const rest = entries.slice(RpcLiveLogTap.MAX_BATCH);
			if (rest.length > 0) {
				this.pendingByAgent.set(agentId, rest);
			} else {
				this.pendingByAgent.delete(agentId);
			}
		}
	}

	/** 设置某 agent 的 RPC 日志记录开关 */
	setLogging(agentId: string, enabled: boolean): void {
		if (enabled) {
			this.loggingAgents.add(agentId);
		} else {
			this.loggingAgents.delete(agentId);
		}
	}

	/** 查询某 agent 是否开启了 RPC 日志记录 */
	isLogging(agentId: string): boolean {
		return this.loggingAgents.has(agentId);
	}

	/**
	 * 登记「某 agent 的实时日志面板是否在看」。
	 * 由渲染层面板挂载/卸载成对调用；只影响广播，不影响记录与落盘。
	 */
	setWatching(agentId: string, watching: boolean): void {
		if (watching) {
			this.watchingAgents.add(agentId);
		} else {
			this.watchingAgents.delete(agentId);
		}
	}

	/** 清空某 agent 的实时日志聚合缓冲（agent 关闭时调用，防止残留数据泄漏） */
	dropPending(agentId: string): void {
		this.pendingByAgent.delete(agentId);
	}

	/** agent 关闭：记录/观看标记与聚合缓冲一并清理 */
	clearAgent(agentId: string): void {
		this.loggingAgents.delete(agentId);
		this.watchingAgents.delete(agentId);
		this.dropPending(agentId);
	}

	/** 应用退出：清节流定时器与全部缓冲（stopAll 路径） */
	dispose(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.pendingByAgent.clear();
		this.watchingAgents.clear();
	}
}
