import { TIMELINE_MOUNTED_STEP_LIMIT, boundMountedSteps } from "../timeline/turnMountBudget";
import type { TrajectoryLane, TrajectoryRecord } from "./buildTrajectory";

/**
 * 轨迹账本的渲染窗口（计划 §5 S3）。
 *
 * 为什么需要：15,000 条记录 = 15,000 个 DOM 节点，长会话打开即卡。
 * 规则复用聊天时间线已验证的口径 —— 尾部 3 轮 + 每次再滑 3 轮，
 * 单轮步数封顶 120（`TIMELINE_MOUNTED_STEP_LIMIT`），不新建虚拟滚动。
 */

/** 初始/步进的轮次数（与聊天时间线 turnRenderWindow 同口径）。 */
export const TRAJECTORY_TURN_COHORT = 3;
/** 单轮最多挂载的记录数。 */
export const TRAJECTORY_TURN_STEP_LIMIT = TIMELINE_MOUNTED_STEP_LIMIT;
/** 会话级/窗口外事实共享的额外额度（避免每个分组各加一份）。 */
export const TRAJECTORY_EXTRA_RECORD_BUDGET = TIMELINE_MOUNTED_STEP_LIMIT;

export type TrajectoryWindow = {
	/** 需要挂载的记录（保持原顺序）。 */
	records: TrajectoryRecord[];
	/** 窗口起止轮次（含）。 */
	startTurn: number;
	endTurn: number;
	/** 更早的轮次是否被折叠（有内容可继续加载）。 */
	hasEarlier: boolean;
	/** 窗口是否被轮次/步数预算裁过（用于提示）。 */
	trimmed: boolean;
};

/**
 * 取尾部 `turnCount` 轮的记录；同一轮内部再受 `stepLimit` 约束（超限只保留最新的部分，
 * 单轮自身超预算时也必须给出内容，不能整轮消失）。
 */
export function buildTrajectoryWindow(records: readonly TrajectoryRecord[], options: { turnCount?: number; stepLimit?: number } = {}): TrajectoryWindow {
	const turnCount = Math.max(1, Math.floor(options.turnCount ?? TRAJECTORY_TURN_COHORT));
	const stepLimit = Math.max(1, Math.floor(options.stepLimit ?? TRAJECTORY_TURN_STEP_LIMIT));
	if (records.length === 0) return { records: [], startTurn: 0, endTurn: 0, hasEarlier: false, trimmed: false };

	const endTurn = records[records.length - 1].turnIndex;
	const startTurn = Math.max(records[0].turnIndex, endTurn - turnCount + 1);
	const inWindow = records.filter((record) => record.turnIndex >= startTurn && record.turnIndex <= endTurn);

	// 按轮分组后再逐轮限步：一次晚加载的巨型轮不应把整份账本拖垮。
	const byTurn = new Map<number, TrajectoryRecord[]>();
	for (const record of inWindow) {
		const bucket = byTurn.get(record.turnIndex);
		if (bucket) bucket.push(record);
		else byTurn.set(record.turnIndex, [record]);
	}
	const kept: TrajectoryRecord[] = [];
	let trimmed = false;
	// 窗口外的「会话开头」必须保留：初始提示词、会话头这类记录 turnIndex 在窗口之前，
	// 但它们不是「更早的历史」，而是账本的起点（否则会话开头看不到系统提示词）。
	const head = records.filter((record) => record.turnIndex < startTurn).slice(0, TRAJECTORY_EXTRA_RECORD_BUDGET);
	kept.push(...head);
	for (const [, bucket] of [...byTurn.entries()].sort((left, right) => left[0] - right[0])) {
		const windowed = boundMountedSteps(bucket, stepLimit);
		if (windowed.hiddenCount > 0) trimmed = true;
		kept.push(...windowed.items);
	}
	return {
		records: kept,
		startTurn,
		endTurn,
		hasEarlier: startTurn > records[0].turnIndex,
		trimmed,
	};
}

export type OverviewTick = {
	/** 代表记录（点击定位用）：桶内最新一条。 */
	recordId: string;
	lane: TrajectoryLane;
	startedAt: number;
	/** 桶内记录数（>1 时概览显示数量而不是单个刻度）。 */
	count: number;
	/** 桶内是否包含当前选中项（保证选中项有刻度）。 */
	selected: boolean;
};

/**
 * 概览刻度聚合：按 lane + 像素桶合并，保证「每 lane ≤ min(250, ceil(width/4)) 个标记」。
 *
 * 为什么按像素而不是固定条数：概览宽 300px 时 250 个刻度已经叠成一团，
 * 聚合上限要跟实际宽度走，否则窄面板上点击目标小于 1px。
 */
export function bucketOverviewTicks(records: readonly TrajectoryRecord[], options: { lanes: readonly TrajectoryLane[]; width: number; selectedId?: string }): OverviewTick[] {
	const width = Number.isFinite(options.width) && options.width > 0 ? options.width : 600;
	const perLane = Math.max(1, Math.min(250, Math.ceil(width / 4)));
	const ticks: OverviewTick[] = [];
	for (const lane of options.lanes) {
		const laneRecords = records.filter((record) => record.lane === lane).sort((left, right) => left.startedAt - right.startedAt);
		if (laneRecords.length === 0) continue;
		const bucketCount = Math.min(perLane, laneRecords.length);
		const size = laneRecords.length / bucketCount;
		for (let index = 0; index < bucketCount; index += 1) {
			const slice = laneRecords.slice(Math.floor(index * size), Math.max(Math.floor(index * size) + 1, Math.floor((index + 1) * size)));
			const representative = slice[slice.length - 1];
			const selected = options.selectedId !== undefined && slice.some((record) => record.id === options.selectedId);
			ticks.push({ recordId: representative.id, lane, startedAt: representative.startedAt, count: slice.length, selected });
		}
	}
	// 选中项没有桶时补一个独立刻度（保证当前记录永远可见）。
	if (options.selectedId !== undefined && !ticks.some((tick) => tick.selected)) {
		const selectedRecord = records.find((record) => record.id === options.selectedId);
		if (selectedRecord) ticks.push({ recordId: selectedRecord.id, lane: selectedRecord.lane, startedAt: selectedRecord.startedAt, count: 1, selected: true });
	}
	return ticks;
}
