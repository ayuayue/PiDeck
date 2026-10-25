import type { TrajectoryRecord, TrajectoryTurn } from "./buildTrajectory";

/**
 * 轨迹账本的分轮/折叠规则（纯函数，可单测）。
 *
 * 背景：一条长会话 70 条记录里大多是一次次工具调用，滚起来全是噪音；
 * DSH 用「每轮摘要 + 长组折叠」把一轮压成几行。这里把规则抽离成纯函数，
 * 视图只负责渲染，折叠状态由组件持有。
 */

/** 连续工具记录超过这个条数就合并成一行（与聊天时间线的组折叠同思路，阈值更小）。 */
export const TRAJECTORY_STEP_GROUP_LIMIT = 8;

export type TrajectoryTurnSummary = {
	/** 记录条数（含系统/提示词记录）。 */
	steps: number;
	/** 工具调用条数。 */
	toolCalls: number;
	/** 本轮 assistant token 合计（没有 usage 时为 0）。 */
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	/** 本轮耗时（毫秒）；in-flight 或缺省时为 undefined。 */
	durationMs?: number;
};

export function summarizeTurn(turn: TrajectoryTurn | undefined, records: readonly TrajectoryRecord[]): TrajectoryTurnSummary {
	let toolCalls = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	for (const record of records) {
		if (record.kind === "tool") toolCalls += 1;
		if (record.usage) {
			inputTokens += record.usage.inputTokens;
			outputTokens += record.usage.outputTokens;
			reasoningTokens += record.usage.reasoningTokens ?? 0;
		}
	}
	return { steps: records.length, toolCalls, inputTokens, outputTokens, reasoningTokens, ...(turn?.durationMs !== undefined ? { durationMs: turn.durationMs } : {}) };
}

/** 一轮里需要渲染的条目：单条记录，或一段被折叠的连续工具调用。 */
export type TrajectoryLedgerItem = { type: "record"; key: string; record: TrajectoryRecord } | { type: "group"; key: string; records: TrajectoryRecord[]; toolCalls: number };

/**
 * 连续工具记录合并：同一轮内连续 tool 超过 `limit` 时压成一条组；
 * 未超过则原样输出（不为了折叠而折叠）。
 */
export function foldTurnRecords(records: readonly TrajectoryRecord[], limit = TRAJECTORY_STEP_GROUP_LIMIT): TrajectoryLedgerItem[] {
	const items: TrajectoryLedgerItem[] = [];
	let run: TrajectoryRecord[] = [];
	const flush = () => {
		if (run.length === 0) return;
		if (run.length > limit) {
			items.push({ type: "group", key: `group:${run[0].id}`, records: run, toolCalls: run.length });
		} else {
			for (const record of run) items.push({ type: "record", key: record.id, record });
		}
		run = [];
	};
	for (const record of records) {
		if (record.kind === "tool") {
			run.push(record);
			continue;
		}
		flush();
		items.push({ type: "record", key: record.id, record });
	}
	flush();
	return items;
}

/**
 * 默认折叠集合：除最后一轮外全部折叠。
 * 为什么最后一轮不折叠：用户打开轨迹时最关心「当前这轮正在干什么」。
 */
export function defaultFoldedTurns(turns: readonly TrajectoryTurn[]): number[] {
	return turns.slice(0, -1).map((turn) => turn.index);
}

/** 折叠后仍要露出的记录：该轮第一条用户消息（折叠行只显示摘要会失去「这轮在聊什么」）。 */
export function foldedTurnPeek(records: readonly TrajectoryRecord[]): TrajectoryRecord | undefined {
	return records.find((record) => record.kind === "user");
}
