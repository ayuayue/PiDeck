import type { AgentStatus } from "../../../../shared/types/agent";
import type { GtdBucket, GtdLedger, GtdStatePatch } from "../../../../shared/types/gtd";
import { GTD_BUCKET_ORDER } from "../../../../shared/types/gtd";
import { isGtdUnread, projectGtdBucket } from "../../../../shared/gtdProjection";

/**
 * GTD 视图的分桶（#546 阶段 2）：把活动页的行按 `shared/gtdProjection` 分成六组。
 *
 * 纯函数、保留输入顺序（活动页本来就按最近活动排好），空桶不输出——渲染层只管画。
 * 分桶规则本身在 shared，这里只做「批量 + 归组」，避免两处判定漂移。
 */

export type GtdRowMeta = {
	sessionId?: string;
	/** 运行态（pi/dsh/acp 同一枚举）。 */
	status: AgentStatus;
	/** 有未答复的 Ask / 审批。 */
	pendingInteraction?: boolean;
	/** 会话最近一次产生内容的时间。 */
	lastActivityAt?: number;
};

export type GtdGroupedRow<T> = {
	bucket: GtdBucket;
	unread: boolean;
	row: T;
};

export function bucketGtdRows<T>(input: { rows: readonly T[]; describe: (row: T) => GtdRowMeta; ledger: GtdLedger; pinned: ReadonlySet<string>; now: number }): Array<{ bucket: GtdBucket; rows: Array<GtdGroupedRow<T>> }> {
	const buckets = new Map<GtdBucket, Array<GtdGroupedRow<T>>>();
	for (const row of input.rows) {
		const meta = input.describe(row);
		const state = meta.sessionId ? input.ledger[meta.sessionId] : undefined;
		const bucket = projectGtdBucket({
			status: meta.status,
			pendingInteraction: meta.pendingInteraction,
			lastActivityAt: meta.lastActivityAt,
			pinned: Boolean(meta.sessionId && input.pinned.has(meta.sessionId)),
			state,
			now: input.now,
		});
		const list = buckets.get(bucket) ?? [];
		list.push({ bucket, unread: isGtdUnread({ lastActivityAt: meta.lastActivityAt, viewedAt: state?.viewedAt }), row });
		buckets.set(bucket, list);
	}
	return GTD_BUCKET_ORDER.flatMap((bucket) => {
		const rows = buckets.get(bucket);
		return rows && rows.length > 0 ? [{ bucket, rows }] : [];
	});
}

/** 视图模式（侧栏 UI 偏好，不写 settings.json：它只影响侧栏怎么排，不影响任何会话）。 */
const GTG_MODE_KEY = "pideck:gtd-inbox";

export function readGtdMode(): boolean {
	try {
		return globalThis.localStorage?.getItem(GTG_MODE_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeGtdMode(enabled: boolean): void {
	try {
		if (enabled) globalThis.localStorage?.setItem(GTG_MODE_KEY, "1");
		else globalThis.localStorage?.removeItem(GTG_MODE_KEY);
	} catch {
		// localStorage 不可用：本次仍切视图，只是重启后回默认（传统视图）。
	}
}

/** 侧栏内部拖拽的 MIME（与分屏用的 SESSION_TAB_DRAG_MIME 分开，避免拖到聊天区边缘时被当成拆分）。 */
export const GTD_ROW_DRAG_MIME = "application/x-pideck-gtd-session";

/** 拖到「稍后提醒」时的默认时长：阶段 3 不做时间选择器，先给 1 小时。 */
export const GTD_SNOOZE_DEFAULT_MS = 60 * 60 * 1000;

/**
 * 拖到某个桶 = 写哪条意图（#546 阶段 3）。
 *
 * 只有用户可决定的桶能接住拖拽：
 * - settled → 结清；active → 撤销结清/取消稍后提醒（回到活跃）；
 * - snoozed → 1 小时后提醒；
 * - needs-you / working 由运行时决定、pinned 走 settings，均不可拖入（返回 null）。
 */
export function gtdDropIntent(bucket: GtdBucket, now: number): GtdStatePatch | null {
	switch (bucket) {
		case "settled":
			return { settledAt: now };
		case "active":
			return { settledAt: null, snoozeUntil: null };
		case "snoozed":
			return { snoozeUntil: now + GTD_SNOOZE_DEFAULT_MS };
		default:
			return null;
	}
}

/** 结清后 5 秒内可撤销：命中返回 sessionId（调用方吞掉这次 Ctrl+Z 并按 null 清除结清水位）。 */
export function undoSettleTarget(pending: { sessionId: string; at: number } | null | undefined, now: number, windowMs = 5000): string | undefined {
	if (!pending) return undefined;
	return now - pending.at <= windowMs ? pending.sessionId : undefined;
}

/** Ctrl/Cmd+Z 是否该被分诊撤销接管：输入框/可编辑区里的撤销必须留给浏览器。 */
export function shouldHandleGtdUndoKey(input: { key: string; ctrlKey: boolean; metaKey: boolean; targetTagName?: string; targetEditable?: boolean }): boolean {
	if (input.key.toLowerCase() !== "z" || !(input.ctrlKey || input.metaKey)) return false;
	if (input.targetEditable) return false;
	const tag = (input.targetTagName ?? "").toUpperCase();
	return tag !== "INPUT" && tag !== "TEXTAREA";
}
