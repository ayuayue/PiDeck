/**
 * CUA 审批请求的 FIFO 队列纯策略。
 *
 * 背景（修复前行为）：`useCuaApproval` 只保存一个 pendingRequest，新请求直接
 * 覆盖旧请求，被覆盖的请求在主进程只剩 30s 超时兜底，用户界面根本见不到它。
 * 队列化保证每个审批都被逐一呈现、逐一应答（FIFO 呈现队首，响应后出队）。
 *
 * 抽成纯函数以便 node 单测（AGENTS.md：纯策略可单测，禁止只活在 JSX/hook 里）。
 */

/** 队列容量上限：超出时丢弃最旧请求（主进程 30s 超时会兜底拒绝它）。 */
export const MAX_PENDING_APPROVALS = 32;

/**
 * 审批存活时长：与主进程 CuaIpcManager.createApprovalHandler / CuaGate 的 30s 超时对齐。
 * 到期后主进程已按拒绝结算（fail-closed），渲染层队列里只剩无效条目——
 * 不清理的话用户点「允许」是无效操作，还误以为已放行。
 */
export const APPROVAL_TTL_MS = 30_000;

/**
 * 过期清理：移除队首已过期的条目（主进程按创建时间逐条超时，队列有序，
 * 过期段一定是前缀）。始终返回新数组，语义与 enqueue/dequeue 保持一致。
 */
export function expireApprovals<T extends { timestampMs: number }>(queue: readonly T[], nowMs: number, ttlMs = APPROVAL_TTL_MS): T[] {
	const firstAlive = queue.findIndex((item) => nowMs - item.timestampMs < ttlMs);
	if (firstAlive === 0) return [...queue];
	if (firstAlive === -1) return [];
	return queue.slice(firstAlive);
}

/** 入队：追加到队尾；超出容量时丢弃最旧的请求（它被主进程 30s 超时兜底拒绝）。 */
export function enqueueApproval<T>(queue: readonly T[], item: T, maxLength = MAX_PENDING_APPROVALS): T[] {
	const next = [...queue, item];
	if (next.length <= maxLength) return next;
	return next.slice(next.length - maxLength);
}

/** 当前应呈现的请求（队首）。 */
export function peekApproval<T>(queue: readonly T[]): T | undefined {
	return queue[0];
}

/** 出队：移除队首（响应/取消后调用）。 */
export function dequeueApproval<T>(queue: readonly T[]): T[] {
	return queue.slice(1);
}
