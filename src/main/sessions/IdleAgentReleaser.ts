import type { AgentTab, SessionRuntimeTarget } from "../../shared/types";
import type { AppSettings } from "../../shared/types/settings";
import type { SessionAgentGateway, SessionRuntimeLogger } from "./SessionRuntimeCoordinator";
import type { SessionRuntimeCoordinator } from "./SessionRuntimeCoordinator";

/**
 * 闲置 agent 自动释放器（内存优化，见设置「闲置 agent 内存优化」）。
 *
 * AgentTab 没有 lastActivityAt 字段，本模块只能靠轮询 agents.list() 自己记录
 * 每个 agent「首次观测到 idle」的时间（idleSinceById）。每轮扫描：
 *  1. 计算最新 idleSince 快照（新 idle 的记入、已非 idle 的剔除、已退出的清理）；
 *  2. 候选 = 连续闲置 ≥ timeoutMs 且非当前聚焦会话的 idle agent；
 *  3. 候选数 > keepCount 时，按「闲置最久优先」释放超出部分。
 *
 * 释放一律走 coordinator.stopAgentById —— 它负责解绑 + agents.stop +
 * agents:state 推送，会话下次发送时自动懒启动新 agent，状态同步由既有链路保证，
 * 本模块不做任何状态复刻。
 */

/** 一轮扫描的输入参数（与模块解耦，便于纯函数单测）。 */
export interface IdleReleaseOptions {
	/** 开关：关闭时不做任何释放，同时清空计时（重新开启后从零计时） */
	autoRelease: boolean;
	/** 保留的闲置 agent 数量；候选超过该数量才释放超出部分 */
	keepCount: number;
	/** 闲置判定阈值（毫秒）；连续闲置低于该值不进入候选 */
	timeoutMs: number;
	/** 当前聚焦会话的 agentId；聚焦会话豁免释放（用户正在看的不动） */
	focusedAgentId?: string;
}

/** 一轮扫描的决策结果。 */
export interface IdleReleasePlan {
	/** 下一轮应使用的 idleSince 快照（已剔除失效项，纯副本） */
	idleSinceById: ReadonlyMap<string, number>;
	/** 本轮应释放的 agentId，按闲置最久优先排序 */
	toRelease: string[];
}

/** 释放成功后的收尾回调（由装配层注入：关终端 + detach 推送），本模块保持可单测。 */
export type IdleAgentReleasedHandler = (agentId: string, target: SessionRuntimeTarget | undefined) => void;

/**
 * 纯策略：给定当前 tabs、上一轮 idleSince 快照和配置，产出本轮决策。
 * 不做任何副作用（不停止进程、不写状态），便于 node --test 直接验证。
 */
export function planIdleAgentRelease(tabs: AgentTab[], prevIdleSinceById: ReadonlyMap<string, number>, now: number, options: IdleReleaseOptions): IdleReleasePlan {
	// 开关关闭：清空计时快照，重新开启后所有 agent 从零计时
	if (!options.autoRelease) {
		return { idleSinceById: new Map(), toRelease: [] };
	}
	// 坏配置兜底（防止旧版本/手改的非法持久化值进来）：钳制到默认语义范围
	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : 60 * 60_000;
	const keepCount = Number.isFinite(options.keepCount) ? Math.max(1, Math.floor(options.keepCount)) : 5;

	// 1. 剔除已退出/消失的 agent 的计时
	const liveIds = new Set(tabs.map((tab) => tab.id));
	const idleSinceById = new Map<string, number>();
	for (const [id, since] of prevIdleSinceById) {
		if (liveIds.has(id)) idleSinceById.set(id, since);
	}

	// 2. 维护 idle 计时：新 idle 记 now；已恢复 busy 的删除（再次 idle 时从零计时）
	const idleTabs: AgentTab[] = [];
	for (const tab of tabs) {
		if (tab.status !== "idle") {
			idleSinceById.delete(tab.id);
			continue;
		}
		idleTabs.push(tab);
		if (!idleSinceById.has(tab.id)) idleSinceById.set(tab.id, now);
	}

	// 3. 候选：闲置超时 且 非聚焦会话
	const candidates = idleTabs.filter((tab) => {
		if (tab.id === options.focusedAgentId) return false;
		const since = idleSinceById.get(tab.id);
		return since !== undefined && now - since >= timeoutMs;
	});
	if (candidates.length <= keepCount) {
		return { idleSinceById, toRelease: [] };
	}

	// 4. 按闲置最久优先释放超出 keepCount 的部分
	const sorted = [...candidates].sort((a, b) => (idleSinceById.get(a.id) ?? 0) - (idleSinceById.get(b.id) ?? 0));
	const toRelease = sorted.slice(0, candidates.length - keepCount).map((tab) => tab.id);
	return { idleSinceById, toRelease };
}

/**
 * 轮询式释放器：默认 60s 扫一轮。start/stop 生命周期配对，quit 时必须 stop。
 * 注意：本文件会被 node --test 直接 import，只能用可擦除语法
 * （不用 constructor 参数属性，字段显式声明 + 构造器赋值）。
 */
export class IdleAgentReleaser {
	private readonly coordinator: SessionRuntimeCoordinator;
	private readonly agents: SessionAgentGateway;
	private readonly getSettings: () => AppSettings;
	private readonly logger?: SessionRuntimeLogger;
	private readonly sweepIntervalMs: number;
	private readonly idleSinceById = new Map<string, number>();
	private readonly onAgentReleased?: IdleAgentReleasedHandler;
	private timer: NodeJS.Timeout | undefined;

	constructor(coordinator: SessionRuntimeCoordinator, agents: SessionAgentGateway, getSettings: () => AppSettings, logger?: SessionRuntimeLogger, sweepIntervalMs = 60_000, onAgentReleased?: IdleAgentReleasedHandler) {
		this.coordinator = coordinator;
		this.agents = agents;
		this.getSettings = getSettings;
		this.logger = logger;
		this.sweepIntervalMs = sweepIntervalMs;
		this.onAgentReleased = onAgentReleased;
	}

	/** 启动轮询；幂等。 */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.sweepIntervalMs);
		// 不阻止进程退出：释放只是内存优化，不是必须完成的收尾任务
		this.timer.unref?.();
	}

	/** 停止轮询并清空计时（应用退出/关闭开关路径）；幂等。 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.idleSinceById.clear();
	}

	/** 立即执行一轮扫描（测试入口/设置变更后可手动触发）。 */
	async sweep(): Promise<void> {
		const settings = this.getSettings();
		const plan = planIdleAgentRelease(this.agents.list(), this.idleSinceById, Date.now(), {
			autoRelease: settings.idleAgentAutoRelease,
			keepCount: settings.idleAgentKeepCount,
			timeoutMs: settings.idleAgentTimeoutMin * 60_000,
			focusedAgentId: this.resolveFocusedAgentId(),
		});
		// 用本轮快照替换旧计时
		this.idleSinceById.clear();
		for (const [id, since] of plan.idleSinceById) {
			this.idleSinceById.set(id, since);
		}
		for (const agentId of plan.toRelease) {
			// 逐个串行释放：每个 stop 都会触发 agents:state 推送，串行让日志与状态更有序
			const result = await this.coordinator.stopAgentById(agentId);
			if (!result.ok) {
				void this.logger?.warn("idle-releaser", "Failed to release idle agent", {
					agentId,
					error: result.error,
				});
				continue;
			}
			// 收尾（关终端 + sessions:runtime-detach 推送）由装配层回调完成：
			// 没有 detach 推送时渲染层的会话运行标记会停留在 running。
			void this.onAgentReleased?.(agentId, result.value);
			void this.logger?.info("idle-releaser", "Released idle agent", { agentId });
		}
	}

	/** 当前聚焦会话的 agentId；无聚焦会话时 undefined（此时无人豁免）。 */
	private resolveFocusedAgentId(): string | undefined {
		const sessionId = this.coordinator.getFocusedSession();
		return sessionId ? this.coordinator.getAgentId(sessionId) : undefined;
	}
}
