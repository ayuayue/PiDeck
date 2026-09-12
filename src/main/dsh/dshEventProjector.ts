import type { ChatMessage, ImageContent, TodoItem } from "../../shared/types";
import {
	defaultToolDetailTranslate,
	formatToolDetail,
	truncateDetailWithMeta,
	type ToolDetailTranslate,
} from "../../shared/formatToolDetail";

/**
 * DSH SessionEvent → PiDeck ChatMessage 投影（纯函数，无副作用，可单测）。
 *
 * 事件形状（PoC 实测）：SessionEvent = { type, seq, time, data }，正文在 data：
 * - user/message.data.content[]：内容块（{type:'text', text}）
 * - assistant/chunk.data.chunk：StreamChunk delta（text-delta / reasoning-delta / finish）
 * - assistant/message.data.message.content[]：组装后的完整内容块（终态权威）
 * - tool/call.data / tool/result.data：工具调用与结果
 * - turn/start / turn/end.data.reason：回合边界；reason.kind === 'error' 表示失败
 *
 * 设计约束：
 * - 消息 id 用事件 seq（稳定、可去重）；assistant 终态消息以 assistant/message 为准，
 *   delta 只用于流式提示（deltaText/deltaReasoning 信号）。
 * - 投影器不持 agentId；消息归属由调用方（DshAgentManager）传入。
 */
export type DshProjection = {
	messages: ChatMessage[];
	/** 累积中的 assistant 消息（流式 delta 期间存在；终态后清空）。 */
	pendingAssistantId?: string;
	pendingAssistantText: string;
	pendingAssistantThinking: string;
	/** 并行工具调用集合：toolCallId → toolName。tool/result 按 callId 精确收口，
	 *  避免多个并行工具的结果只更新最后一张卡、其余卡永远 running。 */
	activeToolCalls: Map<string, string>;
	/** 最近一次工具调用的名称（执行中，用于状态条展示）。 */
	executingTool?: string;
	isStreaming: boolean;
	model?: { provider: string; model: string };
	/** DSH 权限预设（permission/preset 事件最后值，last wins；缺失 = 未记录）。
	 *  值域：read-only / workspace-write / danger-full-access / custom（主机表外组合）。 */
	permissionPreset?: string;
	/** DSH plan 模式是否生效（plan/mode 事件最后值；缺失 = 关闭）。 */
	planModeActive: boolean;
	/** 最近一次 assistant 回合的 token 用量（G16：assistant/message 携带 adapter 报告
	 *  的 usage 时更新，latest wins；缺失 = 适配器未报告）。 */
	usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
	/** DSH 当轮真实系统提示（request/header 事件的 EpochHeader.system；last wins；
	 *  缺失 = 会话尚未发过请求头）。dsh-web 轨迹同源——DSH 的系统提示由 harness 按
	 *  persona + sections 在请求时组装，PiDeck 只能从请求头拿到文本。 */
	systemPrompt?: string;
	/** 路由上下文容量（request/context 事件携带的 contextWindow，adapter 上报时才有）：
	 *  上下文圆环的窗口数据源（dsh-web ContextMeter 同源；与 token-meter 的
	 *  contextPressure.contextWindow 互为补充，后者依赖投影帧推送）。 */
	contextWindow?: number;
	/** 当前 goal（G5：goal/change 事件 last-wins；clear 后为 undefined）。 */
	goal?: {
		refId: string;
		revision: number;
		objective: string;
		phase: "active" | "paused" | "blocked" | "complete";
		maxGoalRounds: number;
		roundsStarted: number;
	};
	/**
	 * 当前待办计划（官方 `todos` projection 的等价折叠：`todo/write` 整表 last-wins，
	 * `turn/start` 清为 null 的 standing-plan 语义）。undefined = 从未写入 / 无此能力；
	 * null = 已清空；数组 = 当前有效计划。history/backfill 重放据此恢复 UI 状态。
	 */
	todos?: TodoItem[] | null;
	/** 本条事件的增量信号（供调用方逐帧转发）。 */
	deltaText?: string;
	deltaReasoning?: string;
	/** 本条事件是否改变状态（调用方据此推 runtime-state）。 */
	stateChanged: boolean;
	/** 本条事件是否为回合结束。 */
	turnEnded: boolean;
	/** 本条事件是否改变消息数组（调用方据此 flush）。 */
	messagesChanged: boolean;
};

const TOOL_RESULT_MAX_CHARS = 2000;

/** 运行时收窄：仅当值是对象且非数组时返回（用于可选字段的安全读取）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 两版 TodoItem 列表是否等价（长度 + content/status 逐一比对，避免无谓的 stateChanged）。 */
function sameTodoList(left: TodoItem[] | null | undefined, right: TodoItem[] | null | undefined): boolean {
	if (left === right) return true;
	if (!Array.isArray(left) || !Array.isArray(right)) return false;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index].content !== right[index].content || left[index].status !== right[index].status) {
			return false;
		}
	}
	return true;
}

/**
 * DSH `todo/write` / `todos` projection 的整表解析（whole-value 规则）。
 * - null：显式清空（官方投影 init 与 turn/start 的取值）；
 * - 合法数组：逐项收窄 content（trim 后非空）+ 三态 status，返回归一化 TodoItem[]；
 * - 其余（非数组 / 任一项非法）：返回 undefined，调用方保持原值——脏数据不得把
 *   已有计划误清成空、也不得渲染半截列表（与官方 schema 的 fail-loud 等价语义）。
 */
export function parseDshTodoList(value: unknown): TodoItem[] | null | undefined {
	if (value === null) return null;
	if (!Array.isArray(value)) return undefined;
	const items: TodoItem[] = [];
	for (const raw of value) {
		if (!isRecord(raw)) return undefined;
		const content = typeof raw.content === "string" ? raw.content.trim() : "";
		const status = raw.status;
		if (!content) return undefined;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") {
			return undefined;
		}
		items.push({ content, status });
	}
	return items;
}

/** 按类型拆分内容块：text 与 reasoning 分开提取（两者不能混在同一条正文里）。 */
function splitBlocks(blocks: unknown): { text: string; reasoning: string } {
	if (!Array.isArray(blocks)) return { text: "", reasoning: "" };
	let text = "";
	let reasoning = "";
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const value = block as { type?: unknown; text?: unknown; reasoning?: unknown };
		if (value.type === "text" && typeof value.text === "string") text += value.text;
		if (value.type === "reasoning" && typeof value.reasoning === "string") reasoning += value.reasoning;
	}
	return { text, reasoning };
}

function textFromBlocks(blocks: unknown): string {
	return splitBlocks(blocks).text;
}

/**
 * 任意内容块 → 纯文本（递归处理 0.1.5 的 tool-result 包装）。
 *
 * 0.1.5 工具结果的消息体是 `[{ type: "tool-result", toolCallId, content, isError }]`
 * （见 dsh-llm createToolResultMessage），真正的文本嵌在 content 里，可能是字符串
 * 或再一层内容块数组。splitBlocks 只认 text/reasoning，直接用它提取会得到空串——
 * 工具卡因此「只有调用没有结果」。
 */
function toolResultBlocksToText(value: unknown, depth = 0): string {
	if (depth > 4) return "";
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	let text = "";
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "tool-result") {
			text += toolResultBlocksToText(block.content, depth + 1);
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			text += block.text;
			continue;
		}
		// 其他块（image/file 等）不进文本；其存在由渲染层/附件链路单独处理。
	}
	return text;
}

/** 工具结果事件的文本（结果消息体的 content 内层）。 */
function toolResultTextFromBlocks(blocks: unknown): string {
	return toolResultBlocksToText(blocks);
}

/**
 * 应用一次助手增量：累积到流式骨架（pendingAssistant*）。
 *
 * 三条来路共用同一套累积，避免形态漂移：
 *  - 会话日志的 `assistant/chunk`（chunk.type = text-delta / reasoning-delta）；
 *  - 打包行 `text-chunks` / `reasoning-chunks`（data.texts 是 token 增量数组）；
 *  - 0.1.5 opt-in 的实时 `assistant-stream` 帧（适配为 `assistant/live-chunk`）：
 *    增量不落会话日志（durable 只有 assistant/message 终态），骨架 id 由 attemptId
 *    派生，终态到达时按 pendingAssistantId 原地更新，Live→History 不 remount。
 */
function applyAssistantDelta(
	next: DshProjection,
	base: DshProjection,
	delta: { id: string; kind?: "text" | "reasoning"; text?: string },
): void {
	if (!delta.kind || typeof delta.text !== "string" || delta.text === "") return;
	next.pendingAssistantId ??= delta.id;
	if (delta.kind === "text") {
		next.pendingAssistantText = base.pendingAssistantText + delta.text;
		next.deltaText = delta.text;
	} else {
		next.pendingAssistantThinking = base.pendingAssistantThinking + delta.text;
		next.deltaReasoning = delta.text;
	}
	next.isStreaming = true;
	next.stateChanged = true;
}

/** DSH 持久化图片引用：host 把用户提交的图片字节提升为 attachment 服务里的 durable ref。 */
export type DshImageRef = {
	attachmentId: string;
	mediaType: string;
};

/** 从内容块中提取图片。兼容两种形态：
 *  - 内联 base64：{ type: "image", mediaType, data }（旧格式/直接落盘）；
 *  - DSH canonical ref：{ type: "image", attachment: { attachmentId, mediaType } }。
 * canonical ref 只投影引用，具体字节由 DshAgentManager 异步经 sessions.attachment 拉取。 */
function imagePartsFromContent(blocks: unknown): { images: ImageContent[]; refs: DshImageRef[] } {
	if (!Array.isArray(blocks)) return { images: [], refs: [] };
	const images: ImageContent[] = [];
	const refs: DshImageRef[] = [];
	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "image") continue;
		const data = block.data;
		const mediaType = block.mediaType;
		if (typeof data === "string" && data && typeof mediaType === "string" && mediaType) {
			images.push({ type: "image", data, mimeType: mediaType });
			continue;
		}
		const attachment = isRecord(block.attachment) ? block.attachment : undefined;
		const attachmentId = attachment?.attachmentId;
		const refMediaType = attachment?.mediaType;
		if (typeof attachmentId === "string" && attachmentId && typeof refMediaType === "string" && refMediaType) {
			refs.push({ attachmentId, mediaType: refMediaType });
		}
	}
	return { images, refs };
}

/** 归一化模型路由（request/context.data.provider + model）。 */
function modelFromEvent(event: { data?: unknown }): { provider: string; model: string } | undefined {
	const data = (event.data ?? {}) as { provider?: unknown; model?: unknown };
	if (typeof data.provider === "string" && typeof data.model === "string") {
		return { provider: data.provider, model: data.model };
	}
	return undefined;
}

/**
 * 幂等 append：同一消息 id 只入列一次。
 *
 * 为什么需要：0.1.5 的 session/follow 流打开时 host 先推一份 journal 尾部
 * snapshot（"complete opening snapshot"，paginate 取尾页），而 attach/fork
 * 路径已把同一段历史投影过一遍（messages 由投影器全程 append）。不去重会
 * 产出同 id 消息——渲染层时间线按 message.id 作 React key，重复 id 触发
 * duplicate-key 告警且条目重复（2026-09-12 实测 `dsh:9/91/100` 成对告警，
 * user 气泡显示两遍）。assistant 增量/终态本身按 id 原地更新（幂等），
 * 只有 append 位点需要挡重。
 */
function appendMessageOnce(base: ChatMessage[], message: ChatMessage): ChatMessage[] {
	return base.some((existing) => existing.id === message.id) ? base : [...base, message];
}

export function projectDshEvent(
	prev: DshProjection | undefined,
	event: { type?: string; seq?: number; seq0?: number; data?: unknown; time?: unknown; time0?: unknown } | undefined,
	agentId: string,
	/** host 为事件计算的下发 view（session/event 帧与 history 条目的 view 字段，
	 *  dsh-web 渲染工具卡片用的就是它；对 tool/call 投影进 meta.view）。 */
	view?: unknown,
	/** 投影选项（D8：用户主动停止后的迟到 turn/end 不追加 error 气泡——停止被显示为回合失败）。 */
	opts?: { skipErrorTurnEnd?: boolean; translate?: ToolDetailTranslate },
): DshProjection {
	const base: DshProjection = prev ?? {
		messages: [],
		pendingAssistantText: "",
		pendingAssistantThinking: "",
		isStreaming: false,
		activeToolCalls: new Map<string, string>(),
		planModeActive: false,
		stateChanged: false,
		turnEnded: false,
		messagesChanged: false,
	};
	if (!event) return { ...base, deltaText: undefined, deltaReasoning: undefined };
	const next: DshProjection = {
		...base,
		messages: base.messages,
		deltaText: undefined,
		deltaReasoning: undefined,
		stateChanged: false,
		turnEnded: false,
		messagesChanged: false,
	};
	const type = event.type ?? "?";
	const data = (event.data ?? {}) as Record<string, unknown>;
	const seq = typeof event.seq === "number" ? event.seq : 0;
	const translate = opts?.translate ?? defaultToolDetailTranslate;
	// 打包行（text-chunks / reasoning-chunks）的序号基准在 seq0（首个成员的 seq）。
	const seq0 = typeof event.seq0 === "number" ? event.seq0 : seq;

	switch (type) {
		case "user/message": {
			// DSH 会话模型把工作区上下文（AGENTS.md、runtime context、skills 清单等）也作为
			// user/message 注入会话日志，source.kind 区分：真实用户消息 = "user"（带 rpcId 对账），
			// 系统注入 = "agent-instructions"/"plugin" 等。注入上下文对用户无阅读价值且会造成
			// 「发一条消息冒出多条用户消息」的错觉，不投影进时间线；source 缺失时保守按真实
			// 用户消息投影（pre-react-loop 迁移的历史数据无 source 字段，不能丢消息）。
			const sourceKind = isRecord(data.source) ? data.source.kind : undefined;
			if (sourceKind !== undefined && sourceKind !== "user") break;
			const text = textFromBlocks(data.content);
			// G2：用户消息的图片块投影为 ChatMessage.images，历史浏览/重发时图片可恢复显示。
			// 内联 base64 直接可显示；DSH canonical attachment ref 先放 meta.dshImageRefs，
			// 由 DshAgentManager 异步拉取字节后回填 images（避免把投影器变成 async）。
			const { images, refs } = imagePartsFromContent(data.content);
			const imageMeta = refs.length > 0 ? { dshImageRefs: refs } : undefined;
			next.messages = appendMessageOnce(base.messages, {
					id: `dsh:${seq}`,
					agentId,
					role: "user",
					text,
					timestamp: eventTime(event.time),
					...(images.length > 0 ? { images } : {}),
					...(imageMeta ? { meta: imageMeta } : {}),
			});
			next.messagesChanged = true;
			break;
		}
		case "assistant/chunk": {
			const chunk = (data.chunk ?? {}) as { type?: string; text?: unknown };
			applyAssistantDelta(next, base, {
				id: `dsh:${seq0}`,
				kind: chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : undefined,
				text: typeof chunk.text === "string" ? chunk.text : undefined,
			});
			break;
		}
		case "assistant/live-chunk": {
			// 0.1.5 实时助手流（session/follow 的 assistant-stream 帧，需 opt-in）：
			// 适配层把帧翻成这个事件；data.liveId 由 attemptId 派生（同一次尝试稳定），
			// 使同一回合的 delta 落在同一骨架消息上。
			const chunk = (data.chunk ?? {}) as { type?: string; text?: unknown };
			const liveId = typeof data.liveId === "string" && data.liveId !== "" ? data.liveId : `dsh:live:${seq0}`;
			applyAssistantDelta(next, base, {
				id: liveId,
				kind: chunk.type === "text-delta" ? "text" : chunk.type === "reasoning-delta" ? "reasoning" : undefined,
				text: typeof chunk.text === "string" ? chunk.text : undefined,
			});
			break;
		}
		case "text-chunks":
		case "reasoning-chunks": {
			// 打包行形态（dsh-session packChunkRuns：连续同种 delta 合并成一行，
			// 载荷在 data.texts 数组，逐成员是 token 增量；mux 与 history 都可能出现，
			// 与 assistant/chunk 的 text-delta/reasoning-delta 是同一内容的两种形态，
			// 同一段 run 只会出现其中一种，不会双累积）。
			const texts = Array.isArray(data.texts)
				? data.texts.filter((entry): entry is string => typeof entry === "string")
				: [];
			applyAssistantDelta(next, base, {
				id: `dsh:${seq0}`,
				kind: type === "text-chunks" ? "text" : "reasoning",
				text: texts.length > 0 ? texts.join("") : undefined,
			});
			break;
		}
		case "assistant/message": {
			// 终态：以组装后的完整内容块为准（delta 可能因适配器差异与终态不完全一致）
			const message = (data.message ?? {}) as { content?: unknown };
			const { images: assistantImages, refs: assistantImageRefs } = imagePartsFromContent(message.content);
			const assistantImageMeta = assistantImageRefs.length > 0
				? { dshImageRefs: assistantImageRefs }
				: undefined;
			// G2：assistant 终态也必须保留图片块，避免终态更新流式骨架时把图片覆盖掉。
			const assistantImagesPresent = assistantImages.length > 0 || assistantImageRefs.length > 0;
			// G16：usage 统计——adapter 报告 token 用量时 assistant/message 携带 usage，
			// 投影进 projection（渲染层 runtime state 的 token/缓存指标），并写入本条
			// assistant 消息的 meta.usage（轨迹账本按消息展示 token 用量，dsh-web 同源）。
			const usageForMessage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined = (() => {
				if (!isRecord(data.message)) return undefined;
				const usage = (data.message as { usage?: unknown }).usage;
				if (!isRecord(usage)) return undefined;
				const u = usage as Record<string, unknown>;
				const inputTokens = typeof u.inputTokens === "number" ? u.inputTokens : 0;
				const outputTokens = typeof u.outputTokens === "number" ? u.outputTokens : 0;
				if (inputTokens > 0 || outputTokens > 0) {
					const result = {
						inputTokens,
						outputTokens,
						...(typeof u.cacheReadTokens === "number" ? { cacheReadTokens: u.cacheReadTokens } : {}),
						...(typeof u.cacheWriteTokens === "number" ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
					};
					next.usage = result;
					return result;
				}
				return undefined;
			})();
			const { text, reasoning } = splitBlocks(message.content);
			const finalText = text.trim() ? text : base.pendingAssistantText;
			// 终态内容可能暂时缺 image 块；保留流式骨架已有图片，避免更新时闪退。
			// 流式累积兜底：终态 content 缺失 thinking 时用已流式渲染的累积文本
			// （打包行/短 run 差异下终态块可能不含 reasoning）。
			const finalThinking = reasoning.trim() ? reasoning : base.pendingAssistantThinking;
			// 纯工具调用消息（模型只发 tool-call、无正文无思考）不落 assistant 气泡：
			// 否则时间线出现空白 assistant 行，终态由后续 tool/call 卡片承接。
			// 有流式骨架（reasoning/text delta 已渲染）时不在此列——骨架已在时间线
			// 挂载 Live 思考/正文，终态必须更新它而不是丢弃。
			// （splitBlocks 不抽 tool-call 块，text/reasoning 均为空即命中。）
			const hasToolCalls = Array.isArray(message.content) && message.content.some(
				(block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "tool-call",
			);
			if (hasToolCalls && !finalText.trim() && !finalThinking.trim() && !assistantImagesPresent && !base.pendingAssistantId) {
				next.pendingAssistantId = undefined;
				next.pendingAssistantText = "";
				next.pendingAssistantThinking = "";
				next.isStreaming = false;
				next.stateChanged = true;
				break;
			}
			if (base.pendingAssistantId) {
				// 更新流式骨架：同 id 保持 Live→History 不 remount
				// （渲染层 thinking group id = msg-thinking-<消息 id>，id 变化会拆掉重建）。
				const messages = [...base.messages];
				const skeletonIndex = messages.findIndex(
					(candidate) => candidate.id === base.pendingAssistantId && candidate.role === "assistant",
				);
				if (skeletonIndex >= 0) {
					const previous = messages[skeletonIndex];
					messages[skeletonIndex] = {
						id: base.pendingAssistantId,
						agentId,
						role: "assistant",
						text: finalText,
						thinking: finalThinking.trim() ? finalThinking : undefined,
						timestamp: eventTime(event.time),
						stopReason: "stop",
						...(assistantImages.length > 0 ? { images: assistantImages } : (previous.images ? { images: previous.images } : {})),
						// 思考耗时：终态时间作为结束点（startedAt 已在骨架创建时记录）
						...((finalThinking.trim() || previous.thinkingStartedAt !== undefined)
							? { thinkingEndedAt: eventTime(event.time) }
							: {}),
						...((previous.thinkingStartedAt !== undefined)
							? { thinkingStartedAt: previous.thinkingStartedAt }
							: {}),
						// 保留骨架已有 meta（工具视图等），并写入本条 usage（轨迹 token 用量）
						meta: {
							...(previous.meta ?? {}),
							...(assistantImageMeta ?? {}),
							...(usageForMessage ? { usage: usageForMessage } : {}),
						},
					};
					next.messages = messages;
				} else {
					// 骨架丢失（异常路径）：按终态正常 push，避免消息丢失
					next.messages = appendMessageOnce(messages, {
						id: `dsh:${seq}`,
						agentId,
						role: "assistant",
						text: finalText,
						thinking: finalThinking.trim() ? finalThinking : undefined,
						timestamp: eventTime(event.time),
						stopReason: "stop",
						...(assistantImages.length > 0 ? { images: assistantImages } : {}),
						...(assistantImageMeta || usageForMessage ? { meta: { ...(assistantImageMeta ?? {}), ...(usageForMessage ? { usage: usageForMessage } : {}) } } : {}),
					});
				}
				next.messagesChanged = true;
			} else {
				next.messages = appendMessageOnce(base.messages, {
					id: `dsh:${seq}`,
					agentId,
					role: "assistant",
					text: finalText,
					thinking: finalThinking.trim() ? finalThinking : undefined,
					timestamp: eventTime(event.time),
					stopReason: "stop",
					...(assistantImages.length > 0 ? { images: assistantImages } : {}),
					...(assistantImageMeta || usageForMessage ? { meta: { ...(assistantImageMeta ?? {}), ...(usageForMessage ? { usage: usageForMessage } : {}) } } : {}),
				});
				next.messagesChanged = true;
			}
			next.pendingAssistantId = undefined;
			next.pendingAssistantText = "";
			next.pendingAssistantThinking = "";
			next.isStreaming = false;
			next.stateChanged = true;
			break;
		}
		case "tool/call": {
			const toolName = typeof data.toolName === "string"
				? data.toolName
				: typeof data.name === "string"
					? data.name
					: "tool";
			const callId = typeof data.callId === "string" ? data.callId : undefined;
			// DSH 的 arguments 是 JSON 字符串（模型调用侧约定，host 侧 presentCall 也
			// JSON.parse 后消费）。解析成对象投影进 meta.args——PiDeck 工具卡片的
			// 副标题（command/path/pattern/query/url）、详情、文件 diff 与 SKILL 识别
			// 全部读 meta.args；解析失败时保留原始字符串（渲染层 parseToolArgs 双兼容）。
			const rawArgs = data.arguments;
			let args: unknown;
			if (typeof rawArgs === "string") {
				try {
					args = JSON.parse(rawArgs);
				} catch {
					args = rawArgs;
				}
			} else {
				args = rawArgs;
			}
			// 并行工具按 callId 登记；executingTool 只是状态条使用的“最近一个”，
			// 真正的收口依据是 activeToolCalls 集合。
			const activeToolCalls = new Map(base.activeToolCalls ?? new Map<string, string>());
			const toolId = callId ?? `dsh-tool-${seq}`;
			activeToolCalls.set(toolId, toolName);
			next.activeToolCalls = activeToolCalls;
			next.messages = appendMessageOnce(base.messages, {
					id: `dsh:${seq}`,
					agentId,
					role: "tool",
					text: toolName,
					timestamp: eventTime(event.time),
					// status=running 驱动渲染层工具卡片的旋转动画；tool/result 到达后清掉。
					meta: {
						toolCallId: toolId,
						toolName,
						status: "running",
						...(args !== undefined ? { args } : {}),
						...(view !== undefined ? { view } : {}),
					},
			});
			next.executingTool = toolName;
			next.messagesChanged = true;
			next.stateChanged = true;
			break;
		}
		case "tool/result": {
			const message = (data.message ?? {}) as { source?: unknown; content?: unknown };
			// 0.1.5 的结果文本嵌在 tool-result 块内（见 toolResultBlocksToText）。
			const fullText = toolResultTextFromBlocks(message.content);
			// 工具结果截断展示（渲染层工具卡展开区 2000 字符内），完整文本保留在
			// meta.fullText 供「查看完整输出」按需读取（A3：DSH 会话没有 pi 会话
			// 文件可定位，全文只能随投影消息走内存）。
			const truncated = fullText.length > TOOL_RESULT_MAX_CHARS;
			const text = fullText.slice(0, TOOL_RESULT_MAX_CHARS);
			// DSH 的 tool/result 在 message.source.callId 携带对应的工具调用 id。
			// 必须按 callId 精确匹配工具卡，不能更新“最后一条 tool”——并发/乱序
			// 结果下会把结果挂错卡，并把先到的卡永远留在 running。
			const source = isRecord(message.source) ? message.source : undefined;
			const resultCallId = typeof source?.callId === "string"
				? source.callId
				: typeof data.callId === "string"
					? data.callId
					: undefined;
			const activeToolCalls = new Map(base.activeToolCalls ?? new Map<string, string>());
			if (resultCallId) activeToolCalls.delete(resultCallId);

			const messages = [...base.messages];
			let targetIndex = -1;
			if (resultCallId) {
				for (let index = messages.length - 1; index >= 0; index -= 1) {
					const candidate = messages[index];
					if (candidate.role === "tool" && candidate.meta?.toolCallId === resultCallId) {
						targetIndex = index;
						break;
					}
				}
			}
			// 兼容无 callId 的异常/旧数据：退化为最后一条 tool，并同时从活跃集合摘除。
			if (targetIndex === -1) {
				for (let index = messages.length - 1; index >= 0; index -= 1) {
					if (messages[index].role === "tool") {
						targetIndex = index;
						break;
					}
				}
			}
			if (targetIndex >= 0) {
				const target = messages[targetIndex];
				// 无 callId 的 fallback 路径也要让活跃集合与卡片同步收口。
				const fallbackCallId = typeof target.meta?.toolCallId === "string"
					? target.meta.toolCallId
					: undefined;
				if (!resultCallId && fallbackCallId) activeToolCalls.delete(fallbackCallId);

				const resultTime = eventTime(event.time);
				const callTime = typeof target.timestamp === "number" ? target.timestamp : resultTime;
				const toolName = typeof target.meta?.toolName === "string" ? target.meta.toolName : "tool";
				// 与 PI 同一套 detailText（工具/状态/参数/结果）；结果正文用已截断的 text，
				// 超长仍走 meta.fullText + truncated，展开区「查看完整输出」契约不变。
				const detailText = formatToolDetail(
					toolName,
					target.meta?.args,
					text || undefined,
					false,
					translate,
				);
				const detailDelivery = truncateDetailWithMeta(detailText, translate);
				const keepFullText = truncated || detailDelivery.truncated;
				messages[targetIndex] = {
					...target,
					text: text ? `${target.text}: ${text}` : target.text,
					meta: target.meta
						? {
							...target.meta,
							status: "done",
							durationMs: Math.max(0, resultTime - callTime),
							detailText: detailDelivery.text,
							// host 为结果事件计算的下发 view（dsh-web 历史页同数据）：
							// 与 call 侧 meta.view 区分存放（resultView），供轨迹面板
							// 展示输出/退出码/实际 diff 等结果态信息。
							...(view !== undefined ? { resultView: view } : {}),
							// 截断标记与完整文本：渲染层 ToolCard 据此显示「查看完整输出」
							...(keepFullText ? { truncated: true as const, fullText } : {}),
						}
						: target.meta,
				};
				next.messages = messages;
				next.messagesChanged = true;
			}
			next.activeToolCalls = activeToolCalls;
			next.executingTool = Array.from(activeToolCalls.values()).at(-1);
			next.stateChanged = true;
			break;
		}
		case "turn/start": {
			// 新回合立刻清上一轮工具名：否则渲染层 isExecutingTool 会粘到本轮开头，
			// 状态条显示「工具调用中」而其实还在预热/等首 token（与 pi agent_start 对齐）。
			// 并行工具集合也一并重置，避免上一轮的残留 callId 影响新回合收口。
			next.activeToolCalls = new Map<string, string>();
			next.executingTool = undefined;
			next.isStreaming = true;
			// standing plan 语义（与官方 todos projection 单元的 turn/start 分支一致）：
			// 新一轮开始清掉上一轮的计划，turn/end 保留刚完成的清单作为本轮收尾展示。
			// 仅在确实有值时清（undefined = 从未写入，保持「能力未到达」与「已清空」可区分）。
			if (base.todos !== undefined && base.todos !== null) {
				next.todos = null;
			}
			next.stateChanged = true;
			break;
		}
		case "turn/end": {
			const reason = (data.reason ?? {}) as { kind?: string; error?: { message?: string } };
			// D8：用户主动停止（cancelled）后的迟到 turn/end 若报 error，不追加错误气泡——
			// 停止被显示为「回合失败」是误导；正常回合的错误仍照常投影。
			if (reason.kind === "error" && reason.error?.message && !opts?.skipErrorTurnEnd) {
				next.messages = appendMessageOnce(base.messages, {
					id: `dsh:${seq}`,
					agentId,
					role: "error",
					text: reason.error.message,
					timestamp: eventTime(event.time),
				});
				next.messagesChanged = true;
			}
			// 中断/异常收口：无 assistant/message 终态时（如被停止/出错），把流式累积
			// 写回骨架——已渲染的思考/正文不因 turn/end 清 pending 而丢失。
			if (base.pendingAssistantId && (base.pendingAssistantText || base.pendingAssistantThinking)) {
				const messages = [...base.messages];
				const skeletonIndex = messages.findIndex(
					(candidate) => candidate.id === base.pendingAssistantId && candidate.role === "assistant",
				);
				if (skeletonIndex >= 0) {
					const previous = messages[skeletonIndex];
					messages[skeletonIndex] = {
						...previous,
						text: base.pendingAssistantText,
						thinking: base.pendingAssistantThinking.trim() ? base.pendingAssistantThinking : undefined,
						// 思考结束时间 = turn/end 时间（startedAt 已在骨架创建时记录）
						...(base.pendingAssistantThinking.trim() ? { thinkingEndedAt: eventTime(event.time) } : {}),
					};
					next.messages = messages;
					next.messagesChanged = true;
				}
			}
			next.pendingAssistantId = undefined;
			next.pendingAssistantText = "";
			next.pendingAssistantThinking = "";
			// 回合结束时并行工具集合一律清空：turn/end 是工具阶段的终态边界。
			next.activeToolCalls = new Map<string, string>();
			next.executingTool = undefined;
			// D9：回合结束（含中断/停止）时，仍 running 的工具卡兜底收口——host 崩溃/取消后
			// tool/result 可能永远不来，卡片不能一直转圈；只清 running 状态不改文案。
			if (next.messages.some((m) => m.role === "tool" && m.meta?.status === "running")) {
				next.messages = next.messages.map((m) =>
					m.role === "tool" && m.meta?.status === "running"
						? { ...m, meta: { ...m.meta, status: "done" } }
						: m,
				);
				next.messagesChanged = true;
			}
			next.isStreaming = false;
			next.turnEnded = true;
			next.stateChanged = true;
			break;
		}
		case "todo/write": {
			// 官方 @deepseek-ai/dsh-tool-todo 的持久化快照（整表 last-wins）：
			// 不进消息时间线（避免与工具卡重复），只折叠成「当前计划」供 todo 条展示。
			// 非法数据返回 undefined → 保持原值，不误清已有计划（whole-value 规则）。
			const parsed = parseDshTodoList(data.todos);
			if (parsed !== undefined && !sameTodoList(base.todos, parsed)) {
				next.todos = parsed;
				next.stateChanged = true;
			}
			break;
		}
		case "request/context": {
			const model = modelFromEvent(event);
			if (model) {
				next.model = model;
				next.stateChanged = true;
			}
			// 路由上下文容量：adapter 上报时随 request/context 下发（contextWindow），
			// 上下文圆环的窗口数据源。last-wins；缺失不覆盖已有值。
			const ctxData = (event.data ?? {}) as { contextWindow?: unknown };
			const contextWindow = typeof ctxData.contextWindow === "number" && ctxData.contextWindow > 0
				? ctxData.contextWindow
				: undefined;
			if (contextWindow !== undefined && contextWindow !== base.contextWindow) {
				next.contextWindow = contextWindow;
				next.stateChanged = true;
			}
			break;
		}
		case "goal/change": {
			// G5：goal/change 携带完整 post-change 快照（last-wins）；clear 是 tombstone。
			const meta = data as { operation?: unknown; goal?: unknown; roundsStarted?: unknown; cleared?: unknown };
			if (meta.operation === "clear") {
				next.goal = undefined;
			} else if (isRecord(meta.goal)) {
				const g = meta.goal as Record<string, unknown>;
				const rawPhase = g.phase;
				const phase = rawPhase === "active" || rawPhase === "paused" || rawPhase === "blocked" || rawPhase === "complete"
					? rawPhase
					: "active";
				next.goal = {
					refId: typeof g.id === "string" ? g.id : "",
					revision: typeof g.revision === "number" ? g.revision : 0,
					objective: typeof g.objective === "string" ? g.objective : "",
					phase,
					maxGoalRounds: typeof g.maxGoalRounds === "number" ? g.maxGoalRounds : 0,
					roundsStarted: typeof meta.roundsStarted === "number" ? meta.roundsStarted : 0,
				};
			}
			next.stateChanged = true;
			break;
		}
		case "request/header": {
			// 当轮请求头（EpochHeader）：system 是 harness 组装的真实系统提示（persona +
			// sections 展开后的完整文本，dsh-web 轨迹展示同源）。同一会话可能因模型切换/
			// 权限变化多次发请求头，last wins；无 system 字段（低版本 host）不覆盖已有值。
			const header = isRecord(data.header) ? data.header : undefined;
			const system = header && typeof (header as { system?: unknown }).system === "string"
				? (header as { system: string }).system
				: undefined;
			if (system && system !== base.systemPrompt) {
				next.systemPrompt = system;
				next.stateChanged = true;
			}
			break;
		}
		case "permission/preset": {
			// DSH 权限预设切换（/permission 命令或创建时 pin）：last wins。
			// 会话底栏据此显示当前预设（read-only/workspace-write/danger-full-access）。
			const preset = typeof data.preset === "string" ? data.preset.trim() : "";
			if (preset && preset !== base.permissionPreset) {
				next.permissionPreset = preset;
				next.stateChanged = true;
			}
			break;
		}
		case "plan/mode": {
			// DSH plan 模式开关（/plan 命令）：last wins；选中态可能延迟到下一次
			// 被接受的 pre-step 才落盘（dsh-plan-mode 语义：idle 立即、回合中 pending）。
			const active = data.active === true;
			if (active !== base.planModeActive) {
				next.planModeActive = active;
				next.stateChanged = true;
			}
			break;
		}
		default:
			break;
	}
	// 流式骨架（Live 挂载点）：首个正文/思考增量出现时，把 pendingAssistant 以空文本
	// 骨架消息入列。渲染层 buildTurnDisplay 对空文本 assistant 生成 interim-answer
	// 挂载点，Live 思考（msg-thinking-<骨架 id>）与 Live 正文（会话级流式槽）都挂它；
	// 终态 assistant/message 再原位更新为完整内容（同 id，不 remount）。
	// 无骨架时渲染层没有可挂的 assistant 条目——思考/正文只能等终态一次性出现
	// （表现为「思考/中间回答不渲染，等十几秒直接显示最后回答」）。
	if (next.pendingAssistantId && !base.pendingAssistantId && !next.messagesChanged) {
		// 思考开始时间 = 首个增量时间（思考块耗时 endedAt - startedAt）。
		// 纯正文回合该字段无害（无 thinking 就不渲染思考块）；live 阶段主进程
		// 发的 startedAt 优先（atom），终态回退到消息字段。
		next.messages = [
			...base.messages,
			{
				id: next.pendingAssistantId,
				agentId,
				role: "assistant",
				text: "",
				timestamp: eventTime(event.time),
				stopReason: "pending",
				thinkingStartedAt: eventTime(event.time),
			},
		];
		next.messagesChanged = true;
	}
	return next;
}

function eventTime(time: unknown): number {
	return typeof time === "number" ? time : Date.now();
}
