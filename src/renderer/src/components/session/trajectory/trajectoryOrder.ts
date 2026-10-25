import type { ChatMessage } from "../../../../../shared/types";
import type { TrajectoryRecord, TrajectoryRecordKind, TrajectoryTurn } from "./buildTrajectory";

/**
 * 墙钟归一：DSH SessionEvent.time 与 pi JSONL 都是 epoch ms。
 * 若误把秒当毫秒（~1e9），重试/过程事件会排到整段会话之前。
 */
export function wallTime(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	if (value > 1e9 && value < 1e11) return Math.round(value * 1000);
	return value;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 消息事件序号：meta.seq 优先，其次 dsh:${seq} 消息 id（投影器约定）。 */
export function seqOfMessage(message: ChatMessage): number | undefined {
	const fromMeta = asNumber(message.meta?.seq);
	if (fromMeta !== undefined) return fromMeta;
	const match = /^dsh:(\d+)$/.exec(message.id);
	if (!match) return undefined;
	const seq = Number(match[1]);
	return Number.isFinite(seq) ? seq : undefined;
}

/** 同 seq 时 thinking → assistant → tool，对齐 dsh-web expandAssistant 的展开顺序。 */
function kindTie(kind: TrajectoryRecordKind): number {
	if (kind === "systemPrompt") return 0;
	if (kind === "user") return 1;
	if (kind === "thinking") return 2;
	if (kind === "assistant") return 3;
	if (kind === "tool") return 4;
	if (kind === "process") return 5;
	if (kind === "error") return 6;
	return 7;
}

/**
 * 账本顺序 = dsh-web layoutEntryOrder：初始系统提示最先，其余按 seq；
 * 无 seq 时退回墙钟。JS sort 稳定，同键保留折叠时的相对顺序。
 *
 * 只有 **初始** 提示词固定最先：中途的提示词/工具更新（system/message 追加）
 * 是就地发生的记录，必须留在它真实发生的位置（否则「什么时候改了提示词」
 * 会被抹成「会话开头就改了」）。
 */
export function compareTrajectoryRecords(left: TrajectoryRecord, right: TrajectoryRecord): number {
	const leftInitial = left.kind === "systemPrompt" && left.promptKind === "initial";
	const rightInitial = right.kind === "systemPrompt" && right.promptKind === "initial";
	if (leftInitial && !rightInitial) return -1;
	if (rightInitial && !leftInitial) return 1;
	const leftSeq = left.seq;
	const rightSeq = right.seq;
	if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) {
		return leftSeq - rightSeq;
	}
	const leftTime = left.startedAt > 0 ? left.startedAt : Number.POSITIVE_INFINITY;
	const rightTime = right.startedAt > 0 ? right.startedAt : Number.POSITIVE_INFINITY;
	if (leftTime !== rightTime) return leftTime - rightTime;
	return kindTie(left.kind) - kindTie(right.kind);
}

export function sortTurnRecords(turn: TrajectoryTurn): void {
	turn.records.sort(compareTrajectoryRecords);
}
