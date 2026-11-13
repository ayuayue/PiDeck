import { parseDshInboxProjection, parseDshTodoList } from "../dshEventProjector";
import { parseContextBreakdownProjection, parseContextPressureProjection, parseSessionStatsProjection, parseTokenUsageProjection, estimateContextTokens } from "../dshProcessEvents";
import { parseDshTeamProjection } from "../dshTeamProjection";
import type { DshAgentRuntime } from "./dshAgentRuntime";

export const DSH_PROJECTION_KEYS = ["contextPressure", "contextBreakdown", "tokenUsage", "sessionStats", "todos", "inbox", "agentTeam"];

/**
 * 投影帧宿主出口：帧只回写 runtime 投影缓存，唯一需要回调宿主的是 runtime-state 重发
 * （会话 map 等共享状态留在 DshAgentManager）。
 */
export type DshProjectionFrameHost = {
	emitRuntimeState(agentId: string): void;
};

/** 当前 runtime 是否已有可用于抵御零 usage 覆盖的上下文证据。 */
function hasKnownContext(runtime: DshAgentRuntime): boolean {
	const pressureValues = [runtime.contextPressure?.pressureTokens, runtime.contextPressure?.projectedTokens];
	if (pressureValues.some((value) => typeof value === "number" && value > 0)) return true;
	const breakdown = runtime.contextBreakdown;
	if (breakdown && (breakdown.systemTokens ?? 0) + (breakdown.toolsTokens ?? 0) + (breakdown.messageTokens ?? 0) > 0) return true;
	const usage = runtime.usageTotals;
	if (usage && usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0) return true;
	return estimateContextTokens(runtime.messages) > 0;
}

/** 失败重试可能带来两个 token 字段均为 0 的伪采样；空会话的真实 0 仍然有效。 */
function isZeroContextPressure(value: NonNullable<DshAgentRuntime["contextPressure"]>): boolean {
	const tokens = [value.pressureTokens, value.projectedTokens].filter((token): token is number => typeof token === "number");
	return tokens.length > 0 && tokens.every((token) => token === 0);
}

/** 对齐 DSH web ProjectionValueStore：每个 projection key 独立按 seq higher-seq-wins。 */
function acceptsDshProjectionFrame(runtime: DshAgentRuntime, key: string, rawSeq: unknown): boolean {
	const lastSeq = runtime.projectionSeq.get(key);
	if (rawSeq === undefined) return lastSeq === undefined;
	if (typeof rawSeq !== "number" || !Number.isSafeInteger(rawSeq) || rawSeq < 0) return false;
	if (lastSeq !== undefined && rawSeq <= lastSeq) return false;
	runtime.projectionSeq.set(key, rawSeq);
	return true;
}

/**
 * 投影帧 → runtime 投影缓存（上下文圆环/会话统计/待办的数据源）。
 *
 * 帧有三个来源，都汇到这一个入口：
 * - `session/control` 的 `{type:'projection', sessionId, key, value, seq}`
 *   （0.1.5 唯一实时来源，host 的 sessionProjections.onChanged 原样广播）；
 * - `session/follow` snapshot 里的 `projections`；
 * - 投影 baseline（`applyDshProjectionBaseline` 逐 key 拆开复用本方法）。
 *
 * 只消费本项目消费的投影单元（contextPressure/contextBreakdown/tokenUsage/
 * sessionStats/todos），其余键忽略——渲染层队列/后台任务展示（session/queue、
 * session/jobs）如需接入，在此扩展。
 * 帧的 value 是 host 按 onChanged 原样下发的单元值本体（无 {key: value} 包装）；
 * 解析器（parse*Projection）统一兼容包装形（attach projections.values）与单元值形（帧）。
 */
export function applyDshProjectionFrame(host: DshProjectionFrameHost, runtime: DshAgentRuntime, payload: { sessionId?: unknown; key?: unknown; value?: unknown; seq?: unknown }): void {
	const key = typeof payload.key === "string" ? payload.key : "";
	if (!DSH_PROJECTION_KEYS.includes(key)) return;
	if (!acceptsDshProjectionFrame(runtime, key, payload.seq)) return;
	if (key === "contextPressure") {
		const parsed = parseContextPressureProjection(payload.value);
		if (parsed !== undefined) {
			if (isZeroContextPressure(parsed) && hasKnownContext(runtime)) {
				// 仅更新独立的容量字段，保留最后一个有效分子；否则 retry 的零 usage 会让
				// 一个仍有 200K 对话内容的会话瞬间显示 0 / 1M。
				const previous = runtime.contextPressure;
				if (parsed.contextWindow !== undefined && parsed.contextWindow !== previous?.contextWindow) {
					runtime.contextPressure = {
						...(previous ?? {}),
						contextWindow: parsed.contextWindow,
					};
					host.emitRuntimeState(runtime.tab.id);
				}
				return;
			}
			runtime.contextPressure = parsed;
			host.emitRuntimeState(runtime.tab.id);
		}
		return;
	}
	if (key === "contextBreakdown") {
		const parsed = parseContextBreakdownProjection(payload.value);
		if (parsed !== undefined) {
			runtime.contextBreakdown = parsed;
			host.emitRuntimeState(runtime.tab.id);
		}
		return;
	}
	if (key === "tokenUsage") {
		const parsed = parseTokenUsageProjection(payload.value);
		if (parsed !== undefined) {
			runtime.usageTotals = parsed;
			host.emitRuntimeState(runtime.tab.id);
		}
		return;
	}
	if (key === "sessionStats") {
		const parsed = parseSessionStatsProjection(payload.value);
		if (parsed !== undefined) {
			runtime.sessionStats = parsed;
			host.emitRuntimeState(runtime.tab.id);
		}
		return;
	}
	if (key === "todos") {
		// 官方 tool-todo 的 todos 投影：整表快照（null = 清空）。seq 已在
		// acceptsDshProjectionFrame 做 higher-seq-wins；解析失败（undefined）保持原值。
		const parsed = parseDshTodoList(payload.value);
		if (parsed !== undefined) {
			runtime.todos = parsed;
			host.emitRuntimeState(runtime.tab.id);
		}
		return;
	}
	if (key === "inbox") {
		// 官方 inbox 投影：host 侧排队消息（next-turn/next-step 整值替换）。与本地
		// 排队队列（queuedPromptQueue，waitForIdle 前的客户端暂存）互补——覆盖的是已
		// 发出但 host 因运行中回合而滞留 inbox 的盲区；空数组是有效值（排队被消费）。
		const parsed = parseDshInboxProjection(payload.value);
		if (parsed !== undefined) {
			runtime.queuedMessages = parsed;
			host.emitRuntimeState(runtime.tab.id);
		}
		return;
	}
	if (key === "agentTeam") {
		// agent-team 实验预设的团队投影（成员/任务板整值替换；解析失败保持原值）。
		// 未启用预设的会话不会收到该 key，白名单已把它与其他会话的杂散帧隔开。
		const parsed = parseDshTeamProjection(payload.value);
		if (parsed !== undefined) {
			runtime.dshTeam = parsed;
			host.emitRuntimeState(runtime.tab.id);
		}
		return;
	}
}

/**
 * 消费投影 baseline（`{asOfSeq, values}` 块）——两个来源共用同一入口：
 * - `session.history` 尾页的 `projections`（attach/restart/重连补帧/崩溃恢复都拉
 *   同一尾页，是底层完整折叠，不受 200 条事件窗口截断影响）；
 * - `session/control` 首帧 `{type:'baseline', value:{projections}}` 里每会话一块
 *   （host 重连后重发，天然完成投影补齐）。
 *
 * 逐 key 判断是否存在：缺 key 的不动（保留现值），避免用 baseline 的“缺省”
 * 把已到达的实时值抹掉。与实时帧共用 acceptsDshProjectionFrame 的 higher-seq-wins，
 * 基线晚于实时帧到达时会被拒绝（不回退）。
 */
export function applyDshProjectionBaseline(host: DshProjectionFrameHost, runtime: DshAgentRuntime, block: unknown): void {
	if (block === null || typeof block !== "object") return;
	const record = block as { asOfSeq?: unknown; values?: unknown };
	if (record.values === null || typeof record.values !== "object") return;
	const values = record.values as Record<string, unknown>;
	const asOfSeq = typeof record.asOfSeq === "number" && Number.isSafeInteger(record.asOfSeq) && record.asOfSeq >= -1 ? record.asOfSeq : undefined;
	for (const key of DSH_PROJECTION_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
		applyDshProjectionFrame(host, runtime, { key, value: values[key], seq: asOfSeq });
	}
}

/** `session.history` 尾页 projections baseline 入口（语义见 applyDshProjectionBaseline）。 */
export function applyDshHistoryProjectionBaseline(host: DshProjectionFrameHost, runtime: DshAgentRuntime, projections: unknown): void {
	applyDshProjectionBaseline(host, runtime, projections);
}
