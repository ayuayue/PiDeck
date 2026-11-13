import type { AgentTab, ChatMessage, DshQueuedMessage, TodoItem } from "../../../shared/types";
import type { DshTeamState } from "../../../shared/types/agent";
import type { SessionProcessEvent } from "../../../shared/types/trajectory";
// DSH 会话 id 品牌类型（零运行时成本，仅类型擦除）
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { DshProjection } from "../dshEventProjector";
import type { DshUsageTotals, DshSessionStatsProjection } from "../dshProcessEvents";
import type { DshControlState } from "../dshRuntimeControl";

export type DshAgentRuntime = {
	tab: AgentTab;
	/** 本轮是用户主动停止的（abort 置位，turn/end 消费后复位）：完成信号据此跳过。 */
	userStoppedTurn?: boolean;
	sessionId: SessionId;
	cwd: string;
	messages: ChatMessage[];
	projection: DshProjection;
	isStreaming: boolean;
	control: DshControlState;
	executingTool?: string;
	model?: { provider: string; model: string };
	modelRoutable?: boolean;
	thinkingLevel?: string;
	/** DSH 权限预设（permission/preset 事件折叠；read-only/workspace-write/danger-full-access）。 */
	permissionPreset?: string;
	/** DSH plan 模式（plan/mode 事件折叠）。 */
	planModeActive?: boolean;
	/** /compact 命令回合进行中（命令已发出、turn/end 未到）；UI 压缩按钮显示进行态。 */
	isCompacting?: boolean;
	/** 最近一次请求因上下文超限失败；保留压缩恢复入口，即使 host 没有 pressure 投影。 */
	contextOverflow?: boolean;
	/** 已投影的最大事件 seq（D6：mux 重连补帧时跳过已投影事件，避免重复）。 */
	lastProjectedSeq?: number;
	/**
	 * attach 窗口前还有更早历史（host session/page 的 hasMore）与续页游标（窗口最旧事件 seq）。
	 * DSH 的运行时消息窗口只取尾部 200 条消息事件；渲染层的分页协议只认
	 * windowStart（数字）/windowStartFilePos（数值游标）两个槽位，见 emitMessages 的合成标记。
	 */
	historyHasOlder?: boolean;
	historyBeforeSeq?: number;
	/** 每个 host projection key 的水位线，按 DSH web 的 higher-seq-wins 规则维护。 */
	projectionSeq: Map<string, number>;
	/** 已尝试拉取过的 DSH attachmentId（避免 mux 每帧对同一图片重复 RPC）。 */
	hydratedImageRefs?: Set<string>;
	/** 最近一次 assistant 回合的 token 用量（G16；assistant/message 事件投影更新）。 */
	usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
	/** 会话累计 token 用量（host tokenUsage 投影；整段日志累计，dsh-web StatsLine 同源）。
	 *  优先于 usage（最近一步），缺失时回退 usage。 */
	usageTotals?: DshUsageTotals;
	/** 会话统计（host sessionStats 投影；整段日志回合/步骤计数与墙钟汇总，dsh-web StatsLine 同源）。 */
	sessionStats?: DshSessionStatsProjection;
	/** host 侧排队消息（inbox 投影；空数组 = 无排队）。见 parseDshInboxProjection。 */
	queuedMessages?: DshQueuedMessage[];
	/**
	 * 上下文占用投影（host contextPressure 单元）：provider 上报的最新请求大小 +
	 * 下一条请求的估算成本 + 路由容量。mux session/projection 帧与 attach 初值双来源，
	 * 供上下文圆环（ContextMeter）展示 DSH 会话占用。
	 */
	contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number };
	/** 上下文构成投影（host contextBreakdown 单元）：系统提示/工具 schema/对话的启发式估算；字段缺失 = host 未上报，保持 undefined 而非 0。 */
	contextBreakdown?: { systemTokens?: number; toolsTokens?: number; messageTokens?: number };
	/** 路由上下文容量（request/context 事件的 contextWindow；无 pressure 投影时的兜底窗口）。 */
	contextWindow?: number;
	/** 轨迹过程事件（modelChange/permission/plan/goal/compaction；pi 会话文件过程事件的 DSH 等价物）。 */
	processEvents: SessionProcessEvent[];
	/** 当前 goal（G5；goal/change 事件投影更新，clear 后为 undefined）。 */
	goal?: {
		refId: string;
		revision: number;
		objective: string;
		phase: "active" | "paused" | "blocked" | "complete";
		maxGoalRounds: number;
		roundsStarted: number;
	};
	/**
	 * 当前待办计划（官方 todos projection / todo/write 快照的归一化折叠）：
	 * 实时 mux、attach/restart/backfill/recover 的多来源恢复都收敛到这一个字段，
	 * 经 runtime-state 推给渲染层 todo 条；null = 已清空（standing plan 语义）。
	 */
	todos?: TodoItem[] | null;
	/** agent-team 团队状态（agentTeam 投影；仅启用实验预设的会话有值）。见 parseDshTeamProjection。 */
	dshTeam?: DshTeamState | null;
	/** 进行中的思考段 id（turn 内首个 reasoning-delta 起登记；终态清空）。 */
	thinkingId?: string;
	thinkingStartedAt?: number;
};
