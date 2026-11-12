import { stat } from "node:fs/promises";
import type { AgentRuntimeState, AgentTab } from "../../shared/types";
import { agentEventTags } from "../../shared/ipc";
import type { ActiveToolCallState } from "../../shared/toolRuntimeState";
import type { PiProcess } from "./PiProcess";
import { createCacheHitStatsReader, type CacheHitStats, type CacheHitStatsReader } from "./cacheHitStats";
import { createJsonlScanLines } from "../sessions/jsonlLineStream";
import { asRecord, clampPercent, nonEmptyString, pickNumber } from "./agentUtils";

/** 状态读取域只读到的运行时切片（宿主 agents map 的值类型）。 */
type RuntimeStateRuntime = { tab: AgentTab; process: PiProcess };

/** 一个 agent 的流式轻补丁签名（避免同一状态在刷新窗口内重复下发）。 */
type StreamingPatch = { signature: string; at: number };

/**
 * 运行时状态读取/忙碌判据域协作方的窄接口：只列实现真正用到的读取器与发布入口，不引入新状态。
 *
 * 过程集合（streaming/tool/compaction/overflow 标志与最后一次快照）由宿主持有并按引用传入——
 * `handlePiEvent`、`clearAgentState`、`abort` 都直接读写它们，搬进协作者只会把同样的状态藏一层。
 */
/** pi 上报的模型名/ID 归一化：去空白，空串视为缺失。 */
export function normalizedRuntimeName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

export interface RuntimeStateReaderHost {
	requireRuntime(agentId: string): RuntimeStateRuntime;
	readonly agents: Map<string, RuntimeStateRuntime>;
	isRemoteRuntime(projectId: string): boolean;
	toSessionHostPath(sessionPath: string): string;
	/** 命中率读取走回调：行为测试按实例属性替换该读取器（读实时值，不用构造时快照）。 */
	getSessionCacheHitStats(sessionPath: string): Promise<CacheHitStats>;
	/** 状态查询走宿主同名入口：行为测试按实例属性替换它来模拟「查询完成到发布前」的换绑。 */
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
	readonly rpcTimeoutMs: number;
	readonly messagePerf: {
		getLast(agentId: string): { ttftMs?: number; totalMs?: number; endToEndTps?: number; tps?: number; sessionTps?: number; sessionEndToEndTps?: number; at?: number } | undefined;
		getLastReplyModel(agentId: string): unknown;
		getLastReplyModelFields(agentId: string): Partial<AgentRuntimeState>;
	};
	readonly streamingAgents: Set<string>;
	readonly agentTurnActiveById: Map<string, boolean>;
	readonly rpcCompactingAgents: Set<string>;
	readonly compactingAgents: Set<string>;
	readonly pendingCompactProcesses: Map<string, PiProcess>;
	readonly activeToolCallsByAgent: Map<string, Map<string, string>>;
	readonly toolExecutingByAgent: Map<string, string | null>;
	readonly toolStateSequenceByAgent: Map<string, number>;
	readonly contextOverflowByAgent: Map<string, boolean>;
	readonly toolEdgeStateTimers: Map<string, NodeJS.Timeout>;
	readonly lastStreamingPatchByAgent: Map<string, StreamingPatch>;
	readonly lastRuntimeStateByAgent: Map<string, AgentRuntimeState>;
	emit(channel: string, payload: unknown): void;
}

/**
 * 运行时状态读取/忙碌判据域（拆分第八刀）：`getRuntimeState` 快照装配、会话缓存命中率读取、
 * 工具调用状态合成与运行态发布（轻补丁 + 去抖全量）、回合活跃标志。
 *
 * 宿主保留同名薄包装（公开签名不变），调用点与契约测试形态不动。
 */
export class RuntimeStateReader {
	/** 轻补丁刷新窗口（毫秒）：同一签名在该窗口内不重复下发，长跑会话仍周期性补帧。 */
	private static readonly STREAMING_PATCH_REFRESH_MS = 5000;

	constructor(private readonly host: RuntimeStateReaderHost) {}

	/** 宿主字段/回调别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get requireRuntime() {
		return this.host.requireRuntime;
	}

	private get agents() {
		return this.host.agents;
	}

	private get isRemoteRuntime() {
		return this.host.isRemoteRuntime;
	}

	private get toSessionHostPath() {
		return this.host.toSessionHostPath;
	}

	private get getSessionCacheHitStats() {
		return this.host.getSessionCacheHitStats;
	}

	private get getRuntimeState() {
		return this.host.getRuntimeState;
	}

	private get rpcTimeoutMs() {
		return this.host.rpcTimeoutMs;
	}

	private get messagePerf() {
		return this.host.messagePerf;
	}

	private get streamingAgents() {
		return this.host.streamingAgents;
	}

	private get agentTurnActiveById() {
		return this.host.agentTurnActiveById;
	}

	private get rpcCompactingAgents() {
		return this.host.rpcCompactingAgents;
	}

	private get compactingAgents() {
		return this.host.compactingAgents;
	}

	private get pendingCompactProcesses() {
		return this.host.pendingCompactProcesses;
	}

	private get activeToolCallsByAgent() {
		return this.host.activeToolCallsByAgent;
	}

	private get toolExecutingByAgent() {
		return this.host.toolExecutingByAgent;
	}

	private get toolStateSequenceByAgent() {
		return this.host.toolStateSequenceByAgent;
	}

	private get contextOverflowByAgent() {
		return this.host.contextOverflowByAgent;
	}

	private get toolEdgeStateTimers() {
		return this.host.toolEdgeStateTimers;
	}

	private get lastStreamingPatchByAgent() {
		return this.host.lastStreamingPatchByAgent;
	}

	private get lastRuntimeStateByAgent() {
		return this.host.lastRuntimeStateByAgent;
	}

	private get emit() {
		return this.host.emit;
	}

	// ── 以下为实现本体（自 AgentManager 原样搬入） ──

	/** 当前是否有任何 agent 正在流式输出（内存采样探针用，避免直接暴露内部 Set）。 */
	hasActiveStreaming(): boolean {
		return this.streamingAgents.size > 0;
	}
	/**
	 * 会话缓存命中率读取器：按 (size, mtimeMs) 缓存，未变化时 O(1) 复用；
	 * 会话只追加，变化时仅扫描尾部新增内容增量续算。
	 *
	 * 必须用**流式**扫描（scanJsonlLines）而不是 readFile：本读取器挂在
	 * getRuntimeState 轮询路径上，Codex 导入的 1GB 级会话整读会撞主进程 384MB 堆上限，
	 * V8 直接 abort 整个主进程（用户看到「大会话闪退」，连堆栈都记不下来）。
	 */
	private readonly cacheHitStatsReader: CacheHitStatsReader = createCacheHitStatsReader({
		// 适配器必须把读取器算出的增量起点 `{ start }` 透传给 scanJsonlLines：
		// 漏传时底层从字节 0 重扫、上层却复用旧累加器，样本会被重复累计（#511）。
		scanLines: createJsonlScanLines(),
		stat,
	});

	/**
	 * 读取 session 文件，统计缓存命中率：最后一条 assistant 消息（latest）与
	 * 全部 assistant 消息的平均值（average，即「当前会话平均缓存率」）。
	 * 口径与 pi CLI footer 的 latestCacheHitRate 一致：
	 * cacheRead / (input + cacheRead + cacheWrite) * 100
	 * 同一次扫描还顺带产出提示词装载（系统提示词/工具声明）与对话估算，见 cacheHitStats。
	 */
	readCacheHitStats(sessionPath: string): Promise<CacheHitStats> {
		return this.cacheHitStatsReader(this.toSessionHostPath(sessionPath));
	}
	/** 读取同一运行时的 RPC/文件统计快照；等待期间退役或换绑时拒绝旧结果。 */
	/** 快照装配本体；宿主同名方法经薄包装转发到这里（读取入口可被行为测试替换）。 */
	async readRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		const process = runtime.process;
		const { deckSessionId, runtimeGeneration, sessionPath } = runtime.tab;
		// 文件统计（读会话 + 逐行 parse）与两个 RPC 并行：总耗时 = max(RPC, 文件)，
		// 且文件结果带 (size, mtimeMs) 缓存，会话未变化时零 IO 零 parse。
		// 远端会话文件不在本机：跳过文件统计（此方法在轮询路径上，不能把远端路径交给本机 reader）。
		const localSessionPath = this.isRemoteRuntime(runtime.tab.projectId) ? undefined : runtime.tab.sessionPath;
		const [stateResponse, statsResponse, fileHitStats] = await Promise.all([
			process.client.request({ type: "get_state" }, this.rpcTimeoutMs).catch(() => ({ data: undefined })),
			process.client.request({ type: "get_session_stats" }).catch(() => ({ data: undefined })),
			localSessionPath
				? this.getSessionCacheHitStats(localSessionPath)
				: Promise.resolve<CacheHitStats>({
						latest: undefined,
						average: undefined,
						sampleCount: 0,
						conversationTokens: undefined,
					}),
		]);
		// 不能把旧进程的模型/用量与新绑定的本地状态拼成一份有效快照。
		if (this.agents.get(agentId) !== runtime || runtime.process !== process || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Runtime state cancelled: runtime changed");
		const state = asRecord(stateResponse.data);
		const stats = asRecord(statsResponse.data);
		const model = asRecord(state?.model);
		const tokens = asRecord(stats?.tokens);
		const usage = asRecord(stats?.usage);
		const tokenCache = asRecord(tokens?.cache);
		const contextUsage = asRecord(stats?.contextUsage);
		const tokenHitRate = pickNumber(tokens?.cacheHitRate);
		const statsHitRate = pickNumber(stats?.cacheHitRate);
		const inputTokens = pickNumber(tokens?.input, tokens?.inputTokens, tokens?.prompt, tokens?.promptTokens, stats?.inputTokens, usage?.input);
		const outputTokens = pickNumber(tokens?.output, tokens?.outputTokens, tokens?.completion, tokens?.completionTokens, stats?.outputTokens, usage?.output);
		const cacheRead = pickNumber(tokens?.cacheRead, tokenCache?.read, stats?.cacheRead, usage?.cacheRead);
		const cacheWrite = pickNumber(tokens?.cacheWrite, tokenCache?.write, stats?.cacheWrite, usage?.cacheWrite);
		const directCacheHitPercent = pickNumber(tokens?.cacheHitPercent, tokenHitRate != null ? tokenHitRate * 100 : undefined, stats?.cacheHitPercent, statsHitRate != null ? statsHitRate * 100 : undefined);
		/**
		 * 使用最新一条 assistant 消息的缓存命中率，与 pi CLI footer 保持一致。
		 * pi 的 get_session_stats RPC 不直接返回 cacheHitPercent，需读取 session 文件。
		 * 同时统计全部 assistant 消息的平均命中率（当前会话平均缓存率）。
		 */
		const cacheHitPercent = clampPercent(directCacheHitPercent ?? fileHitStats.latest);
		const cacheHitAveragePercent = clampPercent(fileHitStats.average);
		const perf = this.messagePerf.getLast(agentId);
		const replyModel = this.messagePerf.getLastReplyModel(agentId);
		const contextTokens = pickNumber(contextUsage?.tokens);
		/**
		 * 上下文构成三段：
		 * - 系统 / 工具：从会话文件重放出的提示词装载直接测量（promptLoadout），
		 *   不再用「总占用 − 对话估算」反推——反推值会被估算误差与各供应商 usage 口径
		 *   差异打到 0（用户看到「系统 + 工具 ~0」）或反向放大；
		 * - 对话：有总占用与两段测量值时取差值（提供商上报的 prompt 就是这三段之和，
		 *   差值自动包含 thinking/图片/末尾回答等没被文本估算覆盖的部分），
		 *   差值不可用（无 usage / 装载缺失 / 差为负）时回退到消息文本估算。
		 */
		const loadoutMeasured = fileHitStats.systemTokens != null && fileHitStats.toolsTokens != null;
		const conversationResidual = loadoutMeasured && contextTokens != null && contextTokens > 0 ? Math.round(contextTokens - (fileHitStats.systemTokens ?? 0) - (fileHitStats.toolsTokens ?? 0)) : undefined;
		const contextMessageTokens = conversationResidual != null && conversationResidual > 0 ? conversationResidual : fileHitStats.conversationTokens;
		// 流式结算（message_end）拿不到 RPC，只能读这里缓存的模型事实，因此必须在返回前写回。
		// 只在本 agent 仍是当前绑定时写（上面已校验 runtime 未变化，此处之下的 await 已不存在）。
		const runtimeState: AgentRuntimeState = {
			modelName: normalizedRuntimeName(model?.name) ?? normalizedRuntimeName(model?.id),
			provider: normalizedRuntimeName(model?.provider),
			modelId: normalizedRuntimeName(model?.id),
			thinkingLevel: nonEmptyString(state?.thinkingLevel),
			isStreaming: state?.isStreaming === true || this.streamingAgents.has(agentId),
			...(this.agentTurnActiveById.has(agentId) ? { isTurnActive: this.agentTurnActiveById.get(agentId) } : {}),
			isCompacting: state?.isCompacting === true || this.rpcCompactingAgents.has(agentId) || this.compactingAgents.has(agentId) || this.pendingCompactProcesses.has(agentId),
			/** 工具执行状态从本地追踪，无需 Pi 进程查询 */
			isExecutingTool: !!this.toolExecutingByAgent.get(agentId),
			executingToolName: this.toolExecutingByAgent.get(agentId) ?? undefined,
			toolStateSequence: this.toolStateSequenceByAgent.get(agentId) ?? 0,
			contextTokens,
			contextWindow: pickNumber(contextUsage?.contextWindow) ?? pickNumber(model?.contextWindow),
			contextPercent: pickNumber(contextUsage?.percent),
			contextOverflow: this.contextOverflowByAgent.get(agentId) === true,
			/** 对话段 token：优先「总占用 − 系统 − 工具」差值，否则消息文本估算（CJK 加权，含工具调用/结果文本，遇压缩重置） */
			contextMessageTokens,
			...(loadoutMeasured ? { contextSystemTokens: fileHitStats.systemTokens, contextToolsTokens: fileHitStats.toolsTokens } : {}),
			inputTokens,
			outputTokens,
			cacheRead,
			cacheWrite,
			cacheTotal: cacheRead != null || cacheWrite != null ? (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined,
			cacheHitPercent,
			cacheHitAveragePercent,
			cacheHitSampleCount: fileHitStats.sampleCount,
			cost: pickNumber(stats?.cost),
			// 最近一次回复性能指标：本地结算缓存（不经 RPC），会话切换/轮询时保持可用
			ttftMs: perf?.ttftMs,
			totalMs: perf?.totalMs,
			endToEndTps: perf?.endToEndTps,
			tps: perf?.tps,
			sessionTps: perf?.sessionTps,
			sessionEndToEndTps: perf?.sessionEndToEndTps,
			// 最近一次回复真实使用的模型（与上面「当前模型」不同：切模型后仍归属发起它的那一次）。
			// 全字段下发（含 undefined）：否则渲染层会把上一个模型的归属 merge 保留下来。
			...this.messagePerf.getLastReplyModelFields(agentId),
			perfAt: perf?.at,
		};
		this.lastRuntimeStateByAgent.set(agentId, runtimeState);
		return runtimeState;
	}
	applyActiveToolCallState(agentId: string, state: ActiveToolCallState) {
		if (state.calls.size > 0) {
			this.activeToolCallsByAgent.set(agentId, state.calls);
			this.toolExecutingByAgent.set(agentId, state.executingToolName ?? "tool");
			this.emitToolRuntimeTransition(agentId, true, state.executingToolName ?? "tool");
			return;
		}
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.set(agentId, null);
		this.emitToolRuntimeTransition(agentId, false);
	}

	emitToolRuntimeTransition(agentId: string, isExecutingTool: boolean, executingToolName?: string) {
		const toolStateSequence = (this.toolStateSequenceByAgent.get(agentId) ?? 0) + 1;
		this.toolStateSequenceByAgent.set(agentId, toolStateSequence);
		// 工具边沿直接从原始 pi 事件发出，不等待 get_state/get_session_stats。
		// 这样即使工具极快完成或完整状态请求乱序，renderer 仍能稳定看到 true → false。
		this.emit(agentEventTags.agentsRuntimeState, {
			agentId,
			state: {
				isExecutingTool,
				executingToolName,
				toolStateSequence,
			},
		});
	}

	/**
	 * 工具边沿的完整 runtime state 补发去抖（2027-02 性能审计）：每个工具
	 * start/end 各触发一次 get_state + get_session_stats 双 RPC，并行工具批下
	 * 每秒多次；而工具执行态本身已由 emitToolRuntimeTransition 同步轻补丁承载，
	 * 完整状态的其余字段（模型/tokens/todo）在工具边沿之间不变。尾沿 300ms
	 * 合并：突发收尾后补一次即可。立即路径（agent_end/settled/compaction/
	 * publishRuntimeState）不受影响，且会自取消在途的去抖（避免重复推送）。
	 */
	scheduleToolEdgeRuntimeState(agentId: string): void {
		const existing = this.toolEdgeStateTimers.get(agentId);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.toolEdgeStateTimers.delete(agentId);
			void this.emitRuntimeState(agentId);
		}, 300);
		timer.unref?.();
		this.toolEdgeStateTimers.set(agentId, timer);
	}

	async emitRuntimeState(agentId: string) {
		// 立即全量推送让在途的工具边沿去抖失效（它要推的内容即将被更新鲜的覆盖）
		const pending = this.toolEdgeStateTimers.get(agentId);
		if (pending) {
			clearTimeout(pending);
			this.toolEdgeStateTimers.delete(agentId);
		}
		try {
			const runtime = this.requireRuntime(agentId);
			const process = runtime.process;
			const { deckSessionId, runtimeGeneration, sessionPath } = runtime.tab;
			const state = await this.getRuntimeState(agentId);
			// 查询完成到恢复发布之间仍有 microtask 间隙，必须在真正 emit 处再次校验。
			if (this.agents.get(agentId) !== runtime || runtime.process !== process || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) return;
			const latestToolSequence = this.toolStateSequenceByAgent.get(agentId) ?? 0;
			// getRuntimeState 包含异步 RPC；若期间发生新工具事件，只覆盖非工具字段，
			// 工具字段保留调用完成时的最新本地真值和序号。
			state.isExecutingTool = !!this.toolExecutingByAgent.get(agentId);
			state.executingToolName = this.toolExecutingByAgent.get(agentId) ?? undefined;
			state.toolStateSequence = latestToolSequence;
			this.emit(agentEventTags.agentsRuntimeState, { agentId, state });
		} catch {
			// 运行态刷新失败不影响主流程；下一次轮询或事件会继续同步。
		}
	}
	/**
	 * 主动推送一次完整 runtime state（get_state + 最新工具状态补丁）给渲染层。
	 *
	 * 懒启动/重启链路的 applyPreferences（setModel/setThinking）之后调用：
	 * setModel 内部只 emitState（AgentTab 无 state 字段），若不额外推送，
	 * 渲染层底栏会停留在旧绑定残留的 state 或仅 record 回退，看不到应用后的真实模型。
	 */
	async publishRuntimeState(agentId: string): Promise<void> {
		await this.emitRuntimeState(agentId);
	}
	/** 轻量 runtime 状态补丁：只同步本地流式标志与工具执行状态，不发 RPC。 */
	emitStreamingStatePatch(agentId: string) {
		const signature = JSON.stringify([this.streamingAgents.has(agentId), this.toolExecutingByAgent.get(agentId) ?? null, this.toolStateSequenceByAgent.get(agentId) ?? 0]);
		const now = Date.now();
		const previous = this.lastStreamingPatchByAgent.get(agentId);
		if (previous?.signature === signature && now - previous.at < RuntimeStateReader.STREAMING_PATCH_REFRESH_MS) return;
		this.lastStreamingPatchByAgent.set(agentId, { signature, at: now });
		this.emit(agentEventTags.agentsRuntimeState, {
			agentId,
			state: {
				isStreaming: this.streamingAgents.has(agentId),
				isExecutingTool: !!this.toolExecutingByAgent.get(agentId),
				executingToolName: this.toolExecutingByAgent.get(agentId) ?? undefined,
				toolStateSequence: this.toolStateSequenceByAgent.get(agentId) ?? 0,
			} as AgentRuntimeState,
		});
	}
	setAgentTurnActive(agentId: string, isTurnActive: boolean) {
		if (this.agentTurnActiveById.get(agentId) === isTurnActive) return;
		this.agentTurnActiveById.set(agentId, isTurnActive);
		// agent_start/agent_end are protocol edges, so publish immediately instead
		// of waiting for the next asynchronous get_state snapshot.
		this.emit(agentEventTags.agentsRuntimeState, {
			agentId,
			state: { isTurnActive },
		});
	}
}
