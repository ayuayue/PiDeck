import type { SessionProcessEvent, SessionPromptSnapshot } from "../../shared/types/trajectory";
import { MAX_TRAJECTORY_PROMPT_TOOLS, promptSnapshotSummary, truncatePromptText } from "../../shared/trajectoryPrompt";
import type { AgentRuntimeState } from "../../shared/types";
import { calculateTokensPerSecond } from "../../shared/tps";
import { estimateTokensFromText } from "../tokenEstimate";

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

/** 当前生效的提示词状态（从最近一条 systemPrompt 事件倒推）。 */
type DshPromptState = { text: string; tools: string[] };

function priorPrompt(prev: SessionProcessEvent[]): DshPromptState | undefined {
	for (let index = prev.length - 1; index >= 0; index -= 1) {
		const prompt = prev[index].kind === "systemPrompt" ? prev[index].prompt : undefined;
		if (prompt) return { text: prompt.text, tools: prompt.tools };
	}
	return undefined;
}

/** request/header 的工具目录 → 工具名（非数组/无 name 的目录（含测试 fixture 的 `{{tools}}` 占位）忽略）。 */
function toolNamesFromHeader(header: Record<string, unknown> | undefined): string[] | undefined {
	const tools = header?.tools;
	if (!Array.isArray(tools)) return undefined;
	const names: string[] = [];
	for (const tool of tools) {
		if (isRecord(tool) && typeof tool.name === "string" && tool.name) names.push(tool.name);
	}
	return names.sort();
}

/** 上下文注入里的工具增删块（dsh 的 developer/message：tool-addition / tool-removal）。 */
function toolChangesFromBlocks(blocks: unknown): { added: string[]; removed: string[] } | undefined {
	if (!Array.isArray(blocks)) return undefined;
	const added: string[] = [];
	const removed: string[] = [];
	for (const block of blocks) {
		if (!isRecord(block) || typeof block.toolName !== "string" || !block.toolName) continue;
		if (block.type === "tool-addition") added.push(block.toolName);
		else if (block.type === "tool-removal") removed.push(block.toolName);
	}
	return added.length > 0 || removed.length > 0 ? { added, removed } : undefined;
}

function sameTools(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * 装载变化 → 提示词快照（无变化返回 undefined）。
 * 账本只需要「真的变了」的快照：dsh 每个请求都可能重发同一份提示词。
 */
function promptSnapshot(previous: DshPromptState | undefined, next: DshPromptState, options?: { fromStart?: boolean }): SessionPromptSnapshot | undefined {
	if (previous && previous.text === next.text && sameTools(previous.tools, next.tools)) return undefined;
	const clipped = truncatePromptText(next.text);
	const text = clipped.text;
	const tools = next.tools.slice(0, MAX_TRAJECTORY_PROMPT_TOOLS);
	if (!previous) {
		// 宿主页没覆盖会话开头时，首个可见提示词只是「窗口快照」，不能冒充会话初始装载。
		return {
			kind: options?.fromStart === false ? "snapshot" : "initial",
			text,
			tools,
			...(clipped.truncated ? { truncated: true } : {}),
		};
	}
	const added = tools.filter((name) => !previous.tools.includes(name));
	const removed = previous.tools.filter((name) => !tools.includes(name));
	return {
		kind: "update",
		text,
		tools,
		...(added.length > 0 ? { toolsAdded: added } : {}),
		...(removed.length > 0 ? { toolsRemoved: removed } : {}),
		...(clipped.truncated ? { truncated: true } : {}),
	};
}

/** 提示词快照 → 一条 systemPrompt 过程事件（账本据此在对应回合落位）。 */
function promptProcessEvent(id: string, seq: number, timestamp: number, prompt: SessionPromptSnapshot): SessionProcessEvent {
	return {
		id: `${id}:prompt`,
		kind: "systemPrompt",
		timestamp,
		seq,
		summary: promptSnapshotSummary(prompt),
		prompt,
	};
}

/** 压缩记录：summary 事件带摘要与用量，end 事件只在失败时补一条错误记录。 */
function compactionSummaryEvent(event: { seq?: number; time?: unknown; data?: unknown }, data: Record<string, unknown>): SessionProcessEvent | undefined {
	const seq = typeof event.seq === "number" ? event.seq : 0;
	const summaryText = asString(data.summary);
	const tokensBefore = asNumber(data.shadowedTokenCount);
	const usage = isRecord(data.usage) ? data.usage : undefined;
	// 用量字段两种口径都接受：dsh 是 `inputTokens/outputTokens/cacheReadTokens`，
	// pi 是 `input/output/cacheRead`（压缩条目也从 pi 侧兼容读取）。
	const usageText = usage
		? (
				[
					["input", "inputTokens"],
					["output", "outputTokens"],
					["cacheRead", "cacheReadTokens"],
					["cacheWrite", "cacheWriteTokens"],
				] as const
			)
				.flatMap(([label, key]) => {
					const value = asNumber(usage[key]) ?? asNumber(usage[label]);
					return value === undefined ? [] : [`${label} ${value}`];
				})
				.join(" · ")
		: undefined;
	const provider = asString(data.provider);
	const modelId = asString(data.model);
	const flat = summaryText?.replace(/\s+/g, " ").trim();
	return {
		id: `dsh-process:compaction/summary:${seq}`,
		kind: "compaction",
		timestamp: eventTime(event.time),
		seq,
		summary: flat && flat.length > 160 ? `${flat.slice(0, 159)}…` : (flat ?? "compaction"),
		detail: [summaryText, usageText].filter(Boolean).join("\n\n") || undefined,
		tokensBefore,
		provider,
		modelId,
		customType: "compaction",
	};
}

/**
 * 从单条 SessionEvent 推导过程事件；无对应语义时返回 undefined。
 * prev 仅用于「同内容不重复记录」的幂等判断（如权限/plan 事件重复推送时跳过）。
 */
export function collectDshProcessEvent(prev: SessionProcessEvent[], event: { type?: string; seq?: number; data?: unknown; time?: unknown } | undefined, options?: { fromStart?: boolean }): SessionProcessEvent | undefined {
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
			const summary = operation === "clear" ? "goal cleared" : `goal ${operation ?? "changed"}${objective ? `: ${objective}` : ""}`;
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
			// 注入上下文（source.kind !== "user"）：dsh 把工作区上下文/工具增删也走
			// user/message 注入会话日志。PiDeck 聊天时间线不投影它们（见 dshEventProjector），
			// 但轨迹账本需要看到「这一轮模型多/少了什么工具、注入了什么上下文」。
			const sourceKind = isRecord(data.source) ? asString((data.source as Record<string, unknown>).kind) : undefined;
			if (sourceKind !== undefined && sourceKind !== "user") {
				const toolChanges = toolChangesFromBlocks(data.content);
				if (toolChanges) {
					const previous = priorPrompt(prev);
					if (!previous) return undefined;
					const tools = [...new Set([...previous.tools.filter((name) => !toolChanges.removed.includes(name)), ...toolChanges.added])].sort();
					const snapshot = promptSnapshot(previous, { text: previous.text, tools });
					return snapshot ? promptProcessEvent(id, seq, timestamp, snapshot) : undefined;
				}
				const injected = textFromBlocks(data.content).replace(/\s+/g, " ").trim();
				if (!injected) return undefined;
				return {
					id,
					kind: "custom",
					timestamp,
					seq,
					summary: injected.length > 96 ? `${injected.slice(0, 95)}…` : injected,
					detail: textFromBlocks(data.content),
					customType: "context",
				};
			}
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
		case "developer/message": {
			// 开发者/插件注入的上下文（V4 起与 user/message 分开）：工具增删块优先折算成
			// 提示词装载变化，其余内容作为 context 过程记录（不进聊天时间线）。
			const blocks = isRecord(data.message) ? (data.message as Record<string, unknown>).content : data.content;
			const toolChanges = toolChangesFromBlocks(blocks);
			if (toolChanges) {
				const previous = priorPrompt(prev);
				if (!previous) return undefined;
				const tools = [...new Set([...previous.tools.filter((name) => !toolChanges.removed.includes(name)), ...toolChanges.added])].sort();
				const snapshot = promptSnapshot(previous, { text: previous.text, tools });
				return snapshot ? promptProcessEvent(id, seq, timestamp, snapshot) : undefined;
			}
			const injected = textFromBlocks(blocks).replace(/\s+/g, " ").trim();
			if (!injected) return undefined;
			return {
				id,
				kind: "custom",
				timestamp,
				seq,
				summary: injected.length > 96 ? `${injected.slice(0, 95)}…` : injected,
				detail: textFromBlocks(blocks),
				customType: "context",
			};
		}
		case "system/message": {
			// V4 系统提示表面：空 content 是明确清空，不能用 truthy 判断。
			const blocks = isRecord(data.message) ? (data.message as Record<string, unknown>).content : undefined;
			const text = textFromBlocks(blocks);
			const previous = priorPrompt(prev);
			// 首次且无内容 = 还没读到系统提示，不置假记录。
			if (!previous && !text) return undefined;
			const snapshot = promptSnapshot(previous, { text, tools: previous?.tools ?? [] }, options);
			return snapshot ? promptProcessEvent(id, seq, timestamp, snapshot) : undefined;
		}
		case "request/header": {
			// 请求头 = 当轮请求工具目录（+ 旧版 host 的 system 字段）。提示词文本以
			// system/message 为准，这里只补工具目录与旧版兼容；文本与工具都没变则不记账。
			const header = isRecord(data.header) ? (data.header as Record<string, unknown>) : undefined;
			const headerSystem = typeof header?.system === "string" ? header.system : undefined;
			const previous = priorPrompt(prev);
			if (!previous && headerSystem === undefined) return undefined;
			const tools = toolNamesFromHeader(header) ?? previous?.tools ?? [];
			const snapshot = promptSnapshot(previous, { text: headerSystem ?? previous?.text ?? "", tools }, options);
			return snapshot ? promptProcessEvent(id, seq, timestamp, snapshot) : undefined;
		}
		case "compaction/summary":
			return compactionSummaryEvent(event, data);
		case "compaction/end": {
			const failure = isRecord(data.error) ? asString((data.error as Record<string, unknown>).message) : asString(data.error);
			if (!failure) return undefined;
			return {
				id,
				kind: "compaction",
				timestamp,
				seq,
				summary: `compaction failed: ${failure}`,
				detail: failure,
				customType: "compaction",
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
			const summary = failureText ? `retry ${countText}: ${failureText}` : `retry ${countText}`;
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
export function pushDshProcessEvent(current: SessionProcessEvent[], next: SessionProcessEvent | undefined): SessionProcessEvent[] {
	if (!next) return current;
	// id 级去重：id 含 journal seq，会话内唯一。follow 泵打开时的首帧 journal 尾部
	// snapshot（0.1.5 "complete opening snapshot"）会把 attach 阶段已收集的事件重放，
	// collectDshProcessEvent 的内容幂等只比对「最后一条」，挡不住与末位不同的乱序重放
	// ——曾致轨迹列表 duplicate key（process:dsh-process:permission/preset:0 等成对）。
	if (current.some((existing) => existing.id === next.id)) return current;
	const result = [...current, next];
	if (result.length <= DSH_PROCESS_EVENTS_LIMIT) return result;
	// 封顶只淘汰普通过程记录：systemPrompt 快照是「会话开头是什么提示词」的唯一线索，
	// 长会话排到 240 条以后被裁掉就会出现「会话开头看不到初始提示词」（2026-10 补齐）。
	const overflow = result.length - DSH_PROCESS_EVENTS_LIMIT;
	const evictable = result.filter((entry) => entry.kind !== "systemPrompt").slice(0, overflow);
	if (evictable.length === 0) return result;
	const evicted = new Set(evictable);
	return result.filter((entry) => !evicted.has(entry));
}

/**
 * 批量收集：按 seq 升序逐条 collect（attach/restart/backfill/history 重放共用）。
 * 幂等规则由 collectDshProcessEvent 内部保证（同模型/同预设连续不重复记账）。
 */
export function collectDshProcessEvents(prev: SessionProcessEvent[], events: ReadonlyArray<{ type?: string; seq?: number; data?: unknown; time?: unknown } | undefined>, options?: { fromStart?: boolean }): SessionProcessEvent[] {
	let result = prev;
	for (const event of events) {
		if (!event) continue;
		result = pushDshProcessEvent(result, collectDshProcessEvent(result, event, options));
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
export function parseContextPressureProjection(values: unknown): { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | undefined {
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

/** 解析 contextBreakdown 投影单元值（attach 的 values 包装形或 mux 帧的单元值形均可）。
 *  只保留实际上报的字段：缺的字段保持 undefined（=「未知」），绝不补 0——
 *  补 0 会让只有 messageTokens 的投影在圆环上渲染成「系统 0 / 工具 0」的假数据。 */
export function parseContextBreakdownProjection(values: unknown): { systemTokens?: number; toolsTokens?: number; messageTokens?: number } | undefined {
	const raw = unwrapProjectionValue(values, "contextBreakdown");
	if (!isRecord(raw)) return undefined;
	const systemTokens = asNumber(raw.systemTokens);
	const toolsTokens = asNumber(raw.toolsTokens);
	const messageTokens = asNumber(raw.messageTokens);
	if (systemTokens === undefined && toolsTokens === undefined && messageTokens === undefined) return undefined;
	const result: { systemTokens?: number; toolsTokens?: number; messageTokens?: number } = {};
	if (systemTokens !== undefined) result.systemTokens = systemTokens;
	if (toolsTokens !== undefined) result.toolsTokens = toolsTokens;
	if (messageTokens !== undefined) result.messageTokens = messageTokens;
	return result;
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
 * 由 host sessionStats 投影派生渲染层视图：平均首字延迟与两种生成速度
 * （无样本字段保持 undefined，UI 显示 —）。
 *
 * 端到端分母取 ttftMs + decodeMs：官方折叠里有首 token 的 step，其 step/start →
 * assistant/message 恰好拆成这两段，相加即模型调用耗时（step 内自动重试的等待
 * 无论落在首 token 前后都在其中）。ttftMs 另含「有首 token 但无 usage」的 step（罕见），
 * 只会让端到端略偏低。没有解码样本时两种速度都不给，口径保持一致。
 */
export function deriveDshSessionStats(raw: DshSessionStatsProjection): AgentRuntimeState["dshSessionStats"] {
	return {
		turns: raw.turns,
		steps: raw.steps,
		llmMs: raw.llmMs,
		toolMs: raw.toolMs,
		ttftAvgMs: raw.ttftSteps > 0 ? raw.ttftMs / raw.ttftSteps : undefined,
		tokensPerSecond: calculateTokensPerSecond(raw.decodeTokens, raw.decodeMs),
		endToEndTokensPerSecond: raw.decodeMs > 0 ? calculateTokensPerSecond(raw.decodeTokens, raw.ttftMs + raw.decodeMs) : undefined,
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
export function deriveSessionStatsFallback(messages: ReadonlyArray<{ role?: string }>): DshSessionStatsProjection | undefined {
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
 * 对话消息 token 估算（与 pi 的 contextMessageTokens 同规则：CJK 加权，中文 ≈1.5 字/token，
 * 其余 ≈4 字符/token，见 src/main/tokenEstimate.ts）。
 * 无 host contextPressure 投影（token-meter 未挂载/adapter 未上报 usage）时的
 * 上下文圆环兜底占用——配合 request/context 的 contextWindow，dsh 会话在首个
 * 回合后即可显示圆环，与 pi 行为统一。
 */
export function estimateContextTokens(messages: ReadonlyArray<{ role?: string; text?: string }>): number {
	let tokens = 0;
	for (const message of messages) {
		if (typeof message.text !== "string" || !message.text) continue;
		tokens += estimateTokensFromText(message.text);
	}
	return tokens;
}
