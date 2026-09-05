import type { SessionProcessEvent } from "../../shared/types/trajectory";
import type { AgentRuntimeState } from "../../shared/types";

/**
 * DSH SessionEvent → 轨迹过程事件（纯函数，可单测）。
 *
 * pi 的轨迹账本有 JSONL 过程事件（session/model_change/compaction/custom），
 * DSH 会话没有会话文件，过程事件从 mux 事件流按语义收集：
 * - request/context（provider/model）→ modelChange（模型切换/首轮路由）；
 * - permission/preset → custom(permission)（权限预设切换）；
 * - plan/mode → custom(plan)（plan 模式开关）；
 * - goal/change → custom(goal)（目标创建/操作/clear）；
 * - user/message 且文本以 /compact 开头 → compaction（压缩命令回合）；
 * - llm/retry → retry（dsh-web 轨迹的 request-only 重试记录；不投影为聊天消息）。
 *
 * 只返回「相对上一条新增」的过程事件；调用方（DshAgentManager）按序追加并封顶，
 * 与 pi 的 parseSessionProcessEvents（MAX_EVENTS=240）同语义。
 */

export const DSH_PROCESS_EVENTS_LIMIT = 240;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventTime(time: unknown): number {
	return typeof time === "number" && Number.isFinite(time) ? time : Date.now();
}

/** dsh-web displayFailureMessage：AUTH 不把凭证投影进 UI。 */
function retryFailureMessage(failure: unknown): string | undefined {
	if (!isRecord(failure)) return undefined;
	if (failure.code === "AUTH") return "API key is invalid";
	return asString(failure.message);
}

/** user/message 正文拼接（与 dshEventProjector 的 textFromBlocks 同规则）。 */
function textFromBlocks(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	let text = "";
	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "text") continue;
		if (typeof block.text === "string") text += block.text;
	}
	return text;
}

/** request/context 的 provider/model（与 dshEventProjector 的 modelFromEvent 同规则）。 */
function modelFromEvent(event: { data?: unknown }): { provider: string; model: string } | undefined {
	const data = (event.data ?? {}) as { provider?: unknown; model?: unknown };
	if (typeof data.provider === "string" && typeof data.model === "string") {
		return { provider: data.provider, model: data.model };
	}
	return undefined;
}

/**
 * 从单条 SessionEvent 推导过程事件；无对应语义时返回 undefined。
 * prev 仅用于「同内容不重复记录」的幂等判断（如权限/plan 事件重复推送时跳过）。
 */
export function collectDshProcessEvent(
	prev: SessionProcessEvent[],
	event: { type?: string; seq?: number; data?: unknown; time?: unknown } | undefined,
): SessionProcessEvent | undefined {
	if (!event?.type) return undefined;
	const type = event.type;
	const seq = typeof event.seq === "number" ? event.seq : 0;
	const id = `dsh-process:${type}:${seq}`;
	const timestamp = eventTime(event.time);
	const data = (event.data ?? {}) as Record<string, unknown>;

	switch (type) {
		case "request/context": {
			const model = modelFromEvent(event);
			if (!model) return undefined;
			// 幂等：连续 request/context 同模型不重复记账（首轮路由 + 每轮请求都可能触发）。
			const last = prev[prev.length - 1];
			if (last?.kind === "modelChange" && last.provider === model.provider && last.modelId === model.model) {
				return undefined;
			}
			return {
				id,
				kind: "modelChange",
				timestamp,
				seq,
				summary: `${model.provider}/${model.model}`,
				detail: `${model.provider}/${model.model}`,
				provider: model.provider,
				modelId: model.model,
			};
		}
		case "permission/preset": {
			const preset = asString(data.preset);
			if (!preset) return undefined;
			const last = prev[prev.length - 1];
			if (last?.customType === "permission" && last.summary === `permission ${preset}`) return undefined;
			return {
				id,
				kind: "custom",
				timestamp,
				seq,
				summary: `permission ${preset}`,
				detail: `permission ${preset}`,
				customType: "permission",
			};
		}
		case "plan/mode": {
			const active = data.active === true;
			const summary = `plan ${active ? "on" : "off"}`;
			const last = prev[prev.length - 1];
			if (last?.customType === "plan" && last.summary === summary) return undefined;
			return {
				id,
				kind: "custom",
				timestamp,
				seq,
				summary,
				detail: summary,
				customType: "plan",
			};
		}
		case "goal/change": {
			const meta = data as { operation?: unknown; goal?: unknown; cleared?: unknown };
			const operation = asString(meta.operation);
			const objective = isRecord(meta.goal) ? asString((meta.goal as Record<string, unknown>).objective) : undefined;
			const summary = operation === "clear"
				? "goal cleared"
				: `goal ${operation ?? "changed"}${objective ? `: ${objective}` : ""}`;
			return {
				id,
				kind: "custom",
				timestamp,
				seq,
				summary,
				detail: summary,
				customType: "goal",
			};
		}
		case "user/message": {
			// /compact 命令回合：slash 桥把压缩指令作为 queue 消息发出，轨迹记一条压缩过程。
			const text = textFromBlocks(data.content).trim();
			if (!text.startsWith("/compact")) return undefined;
			const prompt = text.replace(/^\/compact\s*/, "").trim();
			const last = prev[prev.length - 1];
			if (last?.kind === "compaction" && timestamp - last.timestamp < 5_000) return undefined;
			return {
				id,
				kind: "compaction",
				timestamp,
				seq,
				summary: prompt ? `compact: ${prompt}` : "compact",
				detail: text,
			};
		}
		case "llm/retry": {
			// dsh-web layout.ts：失败/重试请求没有 assistant 消息时仍发 request-only cell。
			// PiDeck 聊天时间线不投影 llm/retry，轨迹账本单独收这条过程记录。
			const retry = asNumber(data.retry);
			if (retry === undefined) return undefined;
			const maxRetries = asNumber(data.maxRetries);
			const delayMs = asNumber(data.delayMs);
			const failureText = retryFailureMessage(data.failure);
			const countText = maxRetries !== undefined ? `${retry}/${maxRetries}` : String(retry);
			const summary = failureText
				? `retry ${countText}: ${failureText}`
				: `retry ${countText}`;
			return {
				id,
				kind: "retry",
				timestamp,
				seq,
				summary,
				detail: failureText,
				provider: asString(data.provider),
				retry,
				maxRetries,
				retryDelayMs: delayMs,
			};
		}
		default:
			return undefined;
	}
}

/** 追加一条过程事件并封顶（与 pi 的 MAX_EVENTS 同语义）。 */
export function pushDshProcessEvent(
	current: SessionProcessEvent[],
	next: SessionProcessEvent | undefined,
): SessionProcessEvent[] {
	if (!next) return current;
	const result = [...current, next];
	if (result.length > DSH_PROCESS_EVENTS_LIMIT) {
		return result.slice(result.length - DSH_PROCESS_EVENTS_LIMIT);
	}
	return result;
}

/**
 * 批量收集：按 seq 升序逐条 collect（attach/restart/backfill/history 重放共用）。
 * 幂等规则由 collectDshProcessEvent 内部保证（同模型/同预设连续不重复记账）。
 */
export function collectDshProcessEvents(
	prev: SessionProcessEvent[],
	events: ReadonlyArray<{ type?: string; seq?: number; data?: unknown; time?: unknown } | undefined>,
): SessionProcessEvent[] {
	let result = prev;
	for (const event of events) {
		if (!event) continue;
		result = pushDshProcessEvent(result, collectDshProcessEvent(result, event));
	}
	return result;
}

/**
 * 投影值两种来源的统一取形：
 * - attach/restart 的 sessions.list projections.values：`{ key: 单元值 }` 包装；
 * - mux session/projection 帧的 value：单元值本体（host 按 onChanged 原样下发，无包装）。
 * 规则：values 里存在同名 key 的记录时取该 key（包装形），否则把 values 本身当单元值（帧形）。
 */
function unwrapProjectionValue(values: unknown, key: string): unknown {
	if (!isRecord(values)) return undefined;
	return isRecord(values[key]) ? values[key] : values;
}

/** 解析 contextPressure 投影单元值（attach 的 values 包装形或 mux 帧的单元值形均可）。 */
export function parseContextPressureProjection(
	values: unknown,
): { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | undefined {
	const raw = unwrapProjectionValue(values, "contextPressure");
	if (!isRecord(raw)) return undefined;
	const result: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } = {};
	const pressureTokens = asNumber(raw.pressureTokens);
	const projectedTokens = asNumber(raw.projectedTokens);
	const contextWindow = asNumber(raw.contextWindow);
	if (pressureTokens !== undefined) result.pressureTokens = pressureTokens;
	if (projectedTokens !== undefined) result.projectedTokens = projectedTokens;
	if (contextWindow !== undefined) result.contextWindow = contextWindow;
	return Object.keys(result).length > 0 ? result : undefined;
}

/** 解析 contextBreakdown 投影单元值（attach 的 values 包装形或 mux 帧的单元值形均可）。 */
export function parseContextBreakdownProjection(
	values: unknown,
): { systemTokens: number; toolsTokens: number; messageTokens: number } | undefined {
	const raw = unwrapProjectionValue(values, "contextBreakdown");
	if (!isRecord(raw)) return undefined;
	const systemTokens = asNumber(raw.systemTokens);
	const toolsTokens = asNumber(raw.toolsTokens);
	const messageTokens = asNumber(raw.messageTokens);
	if (systemTokens === undefined && toolsTokens === undefined && messageTokens === undefined) return undefined;
	return {
		systemTokens: systemTokens ?? 0,
		toolsTokens: toolsTokens ?? 0,
		messageTokens: messageTokens ?? 0,
	};
}

/**
 * DSH host sessionStats 投影原始字段：整段日志的回合/步骤计数与墙钟汇总
 * （dsh-web StatsLine 同源；decode 段 = 首字之后到回复完成的输出阶段）。
 */
export type DshSessionStatsProjection = {
	turns: number;
	steps: number;
	llmMs: number;
	toolMs: number;
	ttftMs: number;
	ttftSteps: number;
	decodeMs: number;
	decodeTokens: number;
};

/** 解析 sessionStats 投影单元值（attach 的 values 包装形或 mux 帧的单元值形均可）。 */
export function parseSessionStatsProjection(values: unknown): DshSessionStatsProjection | undefined {
	const raw = unwrapProjectionValue(values, "sessionStats");
	if (!isRecord(raw)) return undefined;
	const turns = asNumber(raw.turns);
	const steps = asNumber(raw.steps);
	if (turns === undefined && steps === undefined) return undefined;
	return {
		turns: turns ?? 0,
		steps: steps ?? 0,
		llmMs: asNumber(raw.llmMs) ?? 0,
		toolMs: asNumber(raw.toolMs) ?? 0,
		ttftMs: asNumber(raw.ttftMs) ?? 0,
		ttftSteps: asNumber(raw.ttftSteps) ?? 0,
		decodeMs: asNumber(raw.decodeMs) ?? 0,
		decodeTokens: asNumber(raw.decodeTokens) ?? 0,
	};
}

/**
 * 由 host sessionStats 投影派生渲染层视图：平均首字延迟与生成速度
 * （无样本字段保持 undefined，UI 不渲染对应行）。
 */
export function deriveDshSessionStats(
	raw: DshSessionStatsProjection,
): AgentRuntimeState["dshSessionStats"] {
	return {
		turns: raw.turns,
		steps: raw.steps,
		llmMs: raw.llmMs,
		toolMs: raw.toolMs,
		ttftAvgMs: raw.ttftSteps > 0 ? raw.ttftMs / raw.ttftSteps : undefined,
		tokensPerSecond: raw.decodeMs > 0 ? raw.decodeTokens / (raw.decodeMs / 1000) : undefined,
	};
}

/** 会话累计 token 用量（tokenUsage 投影或最近一步 usage 的统一步骤）。 */
export type DshUsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
};

/** 解析 tokenUsage 投影单元值（attach 的 values 包装形或 mux 帧的单元值形均可）。
 *  host tokenUsage 投影 = 整段日志累计（uncachedInput 计入 input；dsh-web StatsLine 同源）。 */
export function parseTokenUsageProjection(values: unknown): DshUsageTotals | undefined {
	const raw = unwrapProjectionValue(values, "tokenUsage");
	if (!isRecord(raw)) return undefined;
	const inputTokens = asNumber(raw.uncachedInputTokens);
	const outputTokens = asNumber(raw.outputTokens);
	if (inputTokens === undefined && outputTokens === undefined) return undefined;
	const cacheReadTokens = asNumber(raw.cacheReadTokens);
	const cacheWriteTokens = asNumber(raw.cacheWriteTokens);
	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
	};
}

/** 缓存命中率：cacheRead ÷ (input + cacheRead + cacheWrite) × 100
 *  （与 pi 的会话文件口径、dsh-web 的 cacheHitPercent 同公式；无输入计费时 undefined）。 */
export function cacheHitPercentOf(usage: DshUsageTotals | undefined): number | undefined {
	if (!usage) return undefined;
	const denominator = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
	if (denominator <= 0) return undefined;
	return Math.min(100, Math.round(((usage.cacheReadTokens ?? 0) / denominator) * 100));
}

/**
 * 无 host sessionStats 投影时的 StatsLine 兜底（对齐 dsh-web deriveStats）。
 * 投影插件未挂载、冷缓存还没有该单元、或 mux 帧尚未到达时，用已投影消息估回合/步骤：
 * 每条 user 开轮，轮内出现 assistant 或 tool 卡片才算完成（dsh-web 按 assistant 节点
 * 计数；我们的投影会丢弃纯 tool-call 的 assistant 消息，故用 tool 卡片等价替代）；
 * 每条 assistant = 一步（被取消而未组装消息的步在投影中不可见，保持 0）。
 * 没有任何回合（无 user 也无产物）时返回 undefined。墙钟字段保持 0，UI 只渲染有数字的组。
 */
export function deriveSessionStatsFallback(
	messages: ReadonlyArray<{ role?: string }>,
): DshSessionStatsProjection | undefined {
	let turns = 0;
	let steps = 0;
	let pending = false;
	for (const message of messages) {
		if (message.role === "user") {
			pending = true;
		} else if (message.role === "assistant") {
			steps += 1;
			if (pending) {
				turns += 1;
				pending = false;
			}
		} else if (message.role === "tool") {
			if (pending) {
				turns += 1;
				pending = false;
			}
		}
	}
	if (steps <= 0 && turns <= 0) return undefined;
	return {
		turns,
		steps,
		llmMs: 0,
		toolMs: 0,
		ttftMs: 0,
		ttftSteps: 0,
		decodeMs: 0,
		decodeTokens: 0,
	};
}

/**
 * 对话消息 token 估算（与 pi 的 contextMessageTokens 同规则：文本字符数 ÷ 4）。
 * 无 host contextPressure 投影（token-meter 未挂载/adapter 未上报 usage）时的
 * 上下文圆环兜底占用——配合 request/context 的 contextWindow，dsh 会话在首个
 * 回合后即可显示圆环，与 pi 行为统一。
 */
export function estimateContextTokens(
	messages: ReadonlyArray<{ role?: string; text?: string }>,
): number {
	let chars = 0;
	for (const message of messages) {
		if (typeof message.text !== "string" || !message.text) continue;
		chars += message.text.length;
	}
	return Math.floor(chars / 4);
}
