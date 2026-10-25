import type { RewindCheckpointHealth } from "../../shared/types";
import { createCheckpoint, MIN_CHECKPOINT_INTERVAL_MS, pruneCheckpoints, pruneOldSessions, PRUNE_CURRENT_MIN_INTERVAL_MS, PRUNE_OLD_SESSIONS_MIN_INTERVAL_MS } from "../rewind/index.ts";

/** 协调器需要的最小 runtime 形状（AgentManager 注入 agents 表的投影）。 */
export interface RewindAgentSessionInfo {
	cwd: string;
	wslDistro?: string;
	sessionId?: string;
}

/** 非 git 仓库的打点重试冷却：目录可能后续才 git init，不能永久放弃。 */
const NO_GIT_RETRY_INTERVAL_MS = 30 * 60 * 1000;

/** 宿主注入：runtime 查询、WSL root 归一化、活跃会话枚举与日志（AgentManager 适配）。 */
export interface RewindCheckpointHost {
	/** agent 的当前 runtime 投影；agent 不存在/已停止时返回 undefined。 */
	getSessionInfo(agentId: string): RewindAgentSessionInfo | undefined;
	/** root 归一化（WSL 存储形态 → Windows 宿主形态）；转换失败退回原值。 */
	hostRoot(cwd: string, distro?: string): string;
	/** 当前所有活跃 agent 的会话信息（pruneOldSessions 的 keep 集合来源）。 */
	listAgentSessions(): RewindAgentSessionInfo[];
	logInfo(message: string, meta?: Record<string, unknown>): void;
	logWarn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * rewind 自动打点协调器（从 AgentManager 迁出，行为零变化）。
 *
 * 职责：agent_start 回合计数、文件类工具执行结束后的节流打点（fire-and-forget）、
 * 打点健康状态（per 工作目录）、checkpoint 裁剪节流。
 * rewindHostRoot 的 WSL 归一化与 listCheckpoints/restoreCheckpoint 等 RPC 入口
 * 仍在 AgentManager（依赖 wslEnvironment 实例态与 runtime 校验）。
 */
export class RewindCheckpointCoordinator {
	/** rewind 自动打点的回合计数（agent_start 递增一次 = 一轮 run）。 */
	private readonly turnCounters = new Map<string, number>();
	/**
	 * 自动打点节流状态（per agent）：最小间隔 + 在途合并。
	 * 每个文件类工具动作结束都请求打点，不节流时高频 bash 循环下中位间隔仅 6.3s
	 * （2026-09-13 用户报告：两个会话并排施工把磁盘读满整机卡死）。与字节预算构成
	 * 双重防线：预算限「单次多贵」，这里限「单位时间打几次」。
	 */
	private readonly schedules = new Map<string, { lastAt: number; inFlight: boolean; pending: boolean; timer: NodeJS.Timeout | null }>();
	/**
	 * checkpoint 裁剪节流（key = `${cwd}:${kind}`，kind = current | old）。
	 * 2026-09-15 发现：pruneCheckpoints/pruneOldSessions 一直是死代码，本仓库
	 * refs/pi-checkpoints 积累到 5627 条，`git log --all` 被 73% 的快照噪声占据。
	 */
	private readonly pruneAt = new Map<string, number>();
	/** 自动打点健康状态（per 工作目录）：失败态上屏用。 */
	private readonly healthByRoot = new Map<string, RewindCheckpointHealth>();
	/**
	 * 非 git 仓库的 root → 下次允许重试的时间戳（#373）。
	 *
	 * 这类目录的 write-tree 每轮必败且不会自愈，实测占全部打点失败的 70%（单日 52 次），
	 * 日志被同一行刷满。这里跳过并隔一段时间再试，而不是永久放弃——用户可能后来才
	 * git init，或在别的分支里继续工作。
	 */
	private readonly noGitRetryAt = new Map<string, number>();

	constructor(private readonly host: RewindCheckpointHost) {}

	/** agent_start 时推进回合计数，返回本轮 turnIndex（供自动打点用）。 */
	bumpTurn(agentId: string): number {
		const next = (this.turnCounters.get(agentId) ?? 0) + 1;
		this.turnCounters.set(agentId, next);
		return next;
	}

	/** 当前回合计数（tool_execution_end 打点标记 turnIndex 用）。 */
	turnCounter(agentId: string): number {
		return this.turnCounters.get(agentId) ?? 0;
	}

	/** 工作目录的打点健康状态（listCheckpoints 附带给渲染层显示警示条）。 */
	healthForRoot(root: string): RewindCheckpointHealth | undefined {
		return this.healthByRoot.get(root);
	}

	/**
	 * 文件类工具（write/edit/bash）执行结束后异步创建文件检查点（fire-and-forget）。
	 * 打点放在 tool_execution_end：此时文件系统已静默，快照内容稳定，不会与进行中的
	 * 写入竞争；恢复语义为「回到该工具执行完成后的状态」。失败不影响 agent 主链路
	 * （纯旁路快照），记日志并更新健康状态供界面提示。
	 *
	 * 节流（MIN_CHECKPOINT_INTERVAL_MS + 在途合并）：
	 * - 在途时有新请求 → 置 pending，当前快照完成后立即补拍一次（合并到最新状态）；
	 * - 距上次打点不足间隔 → 挂 trailing 定时器到点补拍（间隔内的多次请求合并成一次）；
	 * - before-restore 等关键快照不走此路径，不受节流影响。
	 */
	scheduleToolCheckpoint(agentId: string, toolName: string, turnIndex: number): void {
		const session = this.host.getSessionInfo(agentId);
		const root = session?.cwd;
		const sessionId = session?.sessionId;
		if (!root || !sessionId) return;
		const state = this.schedules.get(agentId) ?? { lastAt: 0, inFlight: false, pending: false, timer: null as NodeJS.Timeout | null };
		this.schedules.set(agentId, state);

		if (state.inFlight) {
			state.pending = true;
			return;
		}
		const elapsed = Date.now() - state.lastAt;
		if (elapsed < MIN_CHECKPOINT_INTERVAL_MS) {
			// 间隔内：已有 trailing 定时器就无需重复挂（到点拍的本来就是最新状态）。
			if (state.timer) return;
			state.timer = setTimeout(() => {
				state.timer = null;
				if (state.inFlight) {
					state.pending = true;
					return;
				}
				void this.runCheckpoint(agentId, state, toolName, turnIndex);
			}, MIN_CHECKPOINT_INTERVAL_MS - elapsed);
			state.timer.unref?.();
			return;
		}
		void this.runCheckpoint(agentId, state, toolName, turnIndex);
	}

	/** 实际执行打点：成功/失败都更新健康状态；完成后处理 pending 合并补拍。 */
	private async runCheckpoint(agentId: string, state: { lastAt: number; inFlight: boolean; pending: boolean; timer: NodeJS.Timeout | null }, toolName: string, turnIndex: number): Promise<void> {
		const session = this.host.getSessionInfo(agentId);
		const root = session ? this.host.hostRoot(session.cwd, session.wslDistro) : undefined;
		const sessionId = session?.sessionId;
		// agent 已停止/换 runtime：丢弃补拍（节流 map 已随生命周期清理兜底）。
		if (!root || !sessionId) return;
		// 非 git 仓库：已在上一次失败时记过原因，重试只会重复同一次失败（#373）。
		const retryAt = this.noGitRetryAt.get(root);
		if (retryAt !== undefined && Date.now() < retryAt) return;
		state.inFlight = true;
		state.lastAt = Date.now();
		try {
			const result = await createCheckpoint({
				root,
				// id 拼进 git ref 名，必须是 isRewindCheckpointId 允许的安全字符。
				id: `tool-${sessionId}-${turnIndex}-${Date.now()}`,
				sessionId,
				trigger: "tool",
				turnIndex,
				toolName,
			});
			this.recordHealth(root, null);
			// 目录后来变成 git 仓库了（用户 git init / 切到别的项目）：清掉跳过标记恢复打点
			this.noGitRetryAt.delete(root);
			// 2027-02 接线（此前从未被调用，见 pruneCurrentFor 头注释）：打点成功后裁剪
			// 本会话超限 refs。工具打点每 ≥8s 一次、prune 自身 60s 节流，长会话 refs
			// 不再无界累积（DEFAULT_MAX_CHECKPOINTS=50 此前形同虚设，listCheckpoints
			// 全量解析的延迟随会话时长线性劣化）。
			this.pruneCurrentFor(root, sessionId);
			// merge 冲突态降级快照：健康恢复但要留集，便于用户自查「为什么恢复后暂存区变了」。
			if (result.indexTreeDegraded) {
				this.host.logWarn("checkpoint index tree degraded (unmerged index), recorded HEAD tree instead", { agentId, toolName });
			}
			// 被剔除的路径只在开发诊断时有用：有值记一条 debug 级摘要（不刷屏）。
			if (result.droppedPaths) {
				this.host.logWarn("checkpoint added with dropped paths", {
					agentId,
					toolName,
					dropped: result.droppedPaths.length,
					sample: result.droppedPaths.slice(0, 5).join(", "),
				});
			}
		} catch (error: unknown) {
			const wasNoGit = this.healthByRoot.get(root)?.lastErrorKind === "no-git";
			this.recordHealth(root, error);
			// 非 git 仓库（#373）：失败原因不变、重试无收益，所以只说明一次并进入冷却，
			// 不再每轮写一行同样的 warn（实测单日 52 次，占全部失败 70%）。
			if (this.healthByRoot.get(root)?.lastErrorKind === "no-git") {
				this.noGitRetryAt.set(root, Date.now() + NO_GIT_RETRY_INTERVAL_MS);
				if (!wasNoGit) {
					this.host.logWarn("checkpoint disabled: working directory is not a git repository", {
						agentId,
						root,
						retryAfterMinutes: Math.round(NO_GIT_RETRY_INTERVAL_MS / 60000),
					});
				}
				return;
			}
			// 错误串可能极长（git add 会把全部路径 + CRLF 警告写进一条消息，实测 9KB+），
			// 截断后再进日志，防止失败风暴时日志膨胀（一天 2.4MB 的教训）。
			const rawError = error instanceof Error ? error.message : String(error);
			this.host.logWarn("checkpoint creation failed", {
				agentId,
				toolName,
				error: rawError.length > 500 ? `${rawError.slice(0, 500)}…(${rawError.length} chars)` : rawError,
			});
		} finally {
			state.inFlight = false;
			if (state.pending) {
				state.pending = false;
				if (this.host.getSessionInfo(agentId)) {
					void this.runCheckpoint(agentId, state, toolName, turnIndex);
				}
			}
		}
	}

	/**
	 * 打点成功后裁剪当前会话 checkpoint（保留 DEFAULT_MAX_CHECKPOINTS 个）。
	 * 节流：每仓库至少间隔 PRUNE_CURRENT_MIN_INTERVAL_MS——prune 要全量扫 refs，
	 * 不必跟着每次打点跑；60s 一次足够把超限部分削掉。
	 *
	 * 2027-02 起接线到 runCheckpoint 成功分支（此前从未被调用，长会话 refs 无界
	 * 累积、DEFAULT_MAX_CHECKPOINTS 形同虚设）。
	 */
	pruneCurrentFor(root: string, sessionId: string): void {
		const now = Date.now();
		const key = `${root}\u0000current`;
		const last = this.pruneAt.get(key) ?? 0;
		if (now - last < PRUNE_CURRENT_MIN_INTERVAL_MS) return;
		this.pruneAt.set(key, now);
		void pruneCheckpoints(root, sessionId)
			.then((deleted) => {
				if (deleted > 0) {
					this.host.logInfo("pruned checkpoints for session", { root, sessionId, deleted });
				}
			})
			.catch((error: unknown) => {
				this.host.logWarn("checkpoint prune failed", {
					root,
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/**
	 * 会话首轮 run 时清理非活跃会话的 checkpoint（keepPerOldSession=0，设计默认）。
	 * keep 集合 = 同仓库当前所有活跃 agent 的 sessionId，并发会话互不误删；
	 * 首次触发会顺带消化历史积压（本仓库实测 5627 条 ref）。
	 * 节流：每仓库至少间隔 PRUNE_OLD_SESSIONS_MIN_INTERVAL_MS。
	 */
	pruneOldSessionsFor(root: string, sessionId: string): void {
		const now = Date.now();
		const key = `${root}\u0000old`;
		const last = this.pruneAt.get(key) ?? 0;
		if (now - last < PRUNE_OLD_SESSIONS_MIN_INTERVAL_MS) return;
		this.pruneAt.set(key, now);
		const keep = this.activeSessionIdsForRoot(root);
		void pruneOldSessions(root, keep)
			.then((deleted) => {
				if (deleted > 0) {
					this.host.logInfo("pruned checkpoints of inactive sessions", { root, kept: keep.length, deleted });
				}
			})
			.catch((error: unknown) => {
				this.host.logWarn("old session checkpoint prune failed", {
					root,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/** 同仓库当前所有活跃 agent 的 sessionId（pruneOldSessions 的 keep 集合）。 */
	private activeSessionIdsForRoot(root: string): string[] {
		const ids = new Set<string>();
		for (const session of this.host.listAgentSessions()) {
			// 与 prune 传入的 root 同为宿主形态：WSL 项目的 tab.cwd 是存储形态（UNC 或 /mnt/...），
			// 不归一化会与宿主 root 对不上，keep 集合漏掉同仓库活跃会话 → 并发会话被误删。
			if (this.host.hostRoot(session.cwd, session.wslDistro) === root && session.sessionId) {
				ids.add(session.sessionId);
			}
		}
		return [...ids];
	}

	/** 更新工作目录的打点健康状态（成功清零；失败累计并保留最近原因）。 */
	private recordHealth(root: string, error: unknown): void {
		const health = this.healthByRoot.get(root) ?? { consecutiveFailures: 0 };
		if (error === null) {
			health.lastSuccessAt = Date.now();
			health.consecutiveFailures = 0;
			health.lastError = undefined;
			health.lastErrorAt = undefined;
			health.lastErrorKind = undefined;
		} else {
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
			health.lastErrorAt = Date.now();
			health.consecutiveFailures += 1;
			health.lastError = message;
			health.lastErrorKind = /not a git repository/i.test(message) ? "no-git" : "other";
		}
		this.healthByRoot.set(root, health);
	}

	/** agent 关闭/重建时清理回合计数与节流状态；pending 补拍自然终止，timer 清掉防悬挂回调。 */
	clearAgent(agentId: string): void {
		this.turnCounters.delete(agentId);
		const schedule = this.schedules.get(agentId);
		if (schedule?.timer) clearTimeout(schedule.timer);
		this.schedules.delete(agentId);
	}
}
