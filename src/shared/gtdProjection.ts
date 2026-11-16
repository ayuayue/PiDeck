import type { AgentStatus } from "./types/agent";
import type { GtdBucket, GtdSessionState } from "./types/gtd";

/**
 * GTD 分诊投影（#546）：运行时快照 + 人类意图 → 唯一一个桶。
 *
 * 纯函数、只读、无副作用：UI 每帧重算也不会漂移；账本只记意图（见 types/gtd.ts），
 * 桶本身从不落盘。顺序即优先级，改动这里等于改产品语义，必须同步 docs/gtd-inbox-plan.md。
 */
export type GtdProjectionInput = {
	/** 运行态（pi/dsh/acp 同一枚举）。 */
	status: AgentStatus;
	/** 有未答复的 Ask 提问或工具审批：人必须介入。 */
	pendingInteraction?: boolean;
	/** 会话最近一次产生内容的时间（助手消息/工具结果/用户消息）。 */
	lastActivityAt?: number;
	/** 用户手动置顶。 */
	pinned?: boolean;
	/** 该会话的人类意图账本条目。 */
	state?: GtdSessionState;
	/** 当前时间（注入以便单测）。 */
	now: number;
};

/** 结清后只要出现更晚的活动就自动复活——不需要额外的「重新打开」动作。 */
function isSettled(input: GtdProjectionInput): boolean {
	const settledAt = input.state?.settledAt;
	if (settledAt === undefined) return false;
	return (input.lastActivityAt ?? 0) <= settledAt;
}

/**
 * 分桶。优先级：needs-you > pinned > snoozed > settled > working > active。
 *
 * needs-you 压过置顶与结清：已经结清但报错/等审批的会话不能被折叠区藏起来。
 */
export function projectGtdBucket(input: GtdProjectionInput): GtdBucket {
	if (input.pendingInteraction) return "needs-you";
	if (input.status === "error") return "needs-you";
	if (input.pinned) return "pinned";
	if (input.state?.snoozeUntil !== undefined && input.state.snoozeUntil > input.now && !isSettled(input)) return "snoozed";
	if (isSettled(input)) return "settled";
	if (input.status === "starting" || input.status === "running") return "working";
	return "active";
}

/** 未读：最近活动晚于最后一次聚焦查看。没有 viewedAt（从没看过）也算未读。 */
export function isGtdUnread(input: { lastActivityAt?: number; viewedAt?: number }): boolean {
	if (input.lastActivityAt === undefined) return false;
	return input.viewedAt === undefined || input.lastActivityAt > input.viewedAt;
}
