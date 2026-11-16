import type { AgentRuntimeState } from "../../../shared/types";
import { cacheHitPercentOf, deriveDshSessionStats, deriveSessionStatsFallback, estimateContextTokens } from "../dshProcessEvents";
import type { DshAgentRuntime } from "./dshAgentRuntime";

/**
 * 运行时状态快照（`SessionAgentGateway.getRuntimeState` 的 DSH 实现）。
 *
 * 纯投影：只读 runtime 上已折叠的投影字段，不触发 RPC、不改状态——宿主只是先按
 * agentId 取到 runtime 再调这里。
 */
export function buildDshRuntimeState(runtime: DshAgentRuntime): AgentRuntimeState {
	// 上下文占用圆环（ContextMeter）：优先 host contextPressure 投影（provider 上报 +
	// 下一条请求估算 + 路由容量，dsh-web 同源）；投影缺失（token-meter 未挂载 /
	// adapter 未上报 usage / 投影帧未推送）时退化到「request/context 的 contextWindow
	// + 消息字符估算」，保证 dsh 会话首个回合后圆环即出现，与 pi 行为统一。
	const pressure = runtime.contextPressure;
	const breakdown = runtime.contextBreakdown;
	const contextWindow = pressure?.contextWindow ?? runtime.contextWindow;
	// 对话消息估算（CJK 加权，与 pi 的 contextMessageTokens 同规则）；空会话不兜底
	const estimatedTokens = estimateContextTokens(runtime.messages);
	const fallbackTokens = estimatedTokens > 0 ? estimatedTokens : undefined;
	const contextTokens = pressure?.projectedTokens ?? pressure?.pressureTokens ?? fallbackTokens;
	const contextMessageTokens = breakdown?.messageTokens ?? fallbackTokens;
	// 不封顶 100：投影/估算可能超过窗口（缓存超窗、估算偏大），封顶会
	// 让显示卡在 100% 而 ~used/window 与头部明细继续增长，口径不一致。
	const contextPercent = typeof contextTokens === "number" && typeof contextWindow === "number" && contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : undefined;
	// 用量：优先 host tokenUsage 投影（整段日志累计，dsh-web StatsLine 同源），
	// 缺失（token-meter 未挂载/未推送）时回退最近一步 usage（G16）。
	const usage = runtime.usageTotals ?? runtime.usage;
	// 会话统计：优先 host sessionStats；投影未到时用已投影消息估回合/步骤。
	const sessionStatsRaw = runtime.sessionStats ?? deriveSessionStatsFallback(runtime.messages);
	return {
		isStreaming: runtime.isStreaming,
		isCompacting: runtime.isCompacting === true,
		isExecutingTool: runtime.executingTool !== undefined,
		executingToolName: runtime.executingTool,
		modelName: runtime.model?.model,
		provider: runtime.model?.provider,
		modelId: runtime.model?.model,
		modelRoutable: runtime.modelRoutable,
		thinkingLevel: runtime.thinkingLevel,
		permissionPreset: runtime.permissionPreset,
		planModeActive: runtime.planModeActive,
		// G5：当前 goal（goal/change 事件投影）
		goal: runtime.goal,
		// 当前待办计划（官方 todos projection / todo/write 快照；渲染层 todo 条数据源）
		todos: runtime.todos,
		// agent-team 团队状态（agentTeam 投影；渲染层 Team 面板数据源，未启用预设时 undefined）
		dshTeam: runtime.dshTeam,
		// host 侧排队消息（inbox 投影；渲染层排队提示条数据源）
		queuedMessages: runtime.queuedMessages,
		// 上下文占用（host contextPressure/contextBreakdown 投影；缺失时消息估算兜底）
		contextTokens: typeof contextTokens === "number" ? contextTokens : undefined,
		contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
		contextPercent: contextPercent,
		contextOverflow: runtime.contextOverflow === true,
		contextMessageTokens: typeof contextMessageTokens === "number" ? contextMessageTokens : undefined,
		// host contextBreakdown 的系统/工具两段（dsh-web ContextMeter 三段图例同源；
		// 0 是有效值，undefined 表示无投影）
		contextSystemTokens: breakdown?.systemTokens,
		contextToolsTokens: breakdown?.toolsTokens,
		// G16：usage 指标（tokenUsage 累计投影优先；缺失时最近一步 usage）
		inputTokens: usage?.inputTokens,
		outputTokens: usage?.outputTokens,
		cacheRead: usage?.cacheReadTokens,
		cacheWrite: usage?.cacheWriteTokens,
		cacheTotal: usage ? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : undefined,
		// 缓存命中率：cacheRead ÷ (input + cacheRead + cacheWrite)，与 pi/dsh-web 同公式
		cacheHitPercent: cacheHitPercentOf(usage),
		dshSessionStats: sessionStatsRaw ? deriveDshSessionStats(sessionStatsRaw) : undefined,
	};
}
