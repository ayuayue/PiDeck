/**
 * GTD 收件箱（#546）的共享契约。
 *
 * 只定义「桶」与「人类意图账本」两类数据：桶永远由运行时快照 + 账本实时投影得出
 * （见 shared/gtdProjection.ts），账本里不存桶名，避免异步事件乱序导致状态漂移。
 */

/** 分诊桶（按展示优先级排列）。 */
export type GtdBucket = "needs-you" | "pinned" | "active" | "working" | "snoozed" | "settled";

/** 展示顺序：needs-you 顶置且不可折叠；settled 默认折叠。 */
export const GTD_BUCKET_ORDER: readonly GtdBucket[] = ["needs-you", "pinned", "active", "working", "snoozed", "settled"];

/** 默认折叠的桶（仍然计数、可展开，但不占视觉空间）。 */
export const GTD_COLLAPSED_BUCKETS: readonly GtdBucket[] = ["working", "snoozed", "settled"];

/**
 * 单个会话的人类意图（稀疏账本的一条）。
 *
 * 三个字段都是「时间水位」，不是布尔开关：
 * - `settledAt`：用户点结清的时刻；晚于它的活动会自动让会话复活；
 * - `viewedAt`：最后一次聚焦查看的时刻，用于未读判定；
 * - `snoozeUntil`：稍后提醒的到期时刻；过期即自动回 active。
 */
export type GtdSessionState = {
	settledAt?: number;
	viewedAt?: number;
	snoozeUntil?: number;
};

/** sessionId → 意图。缺省条目 = 没有人类干预，纯按运行态分桶。 */
export type GtdLedger = Record<string, GtdSessionState>;

/**
 * 账本补丁（IPC 入参）：字段为 `null` 表示清除该水位（撤销结清 / 取消 snooze）。
 * 缺省（undefined）= 本次不改。
 */
export type GtdStatePatch = {
	settledAt?: number | null;
	viewedAt?: number | null;
	snoozeUntil?: number | null;
};
