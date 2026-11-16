import { randomUUID } from "node:crypto";
import type { ChatMessage, ImageContent } from "../../shared/types";
import { extractPiToolTruncation } from "../../shared/formatToolDetail";
import { hasPiToolCallBlock, normalizePiStopReason, type AgentMessageProjector } from "./AgentMessageProjector";
import { chatUsageFromPiUsage } from "./messageUsage";
import { asRecord, nonEmptyString } from "./agentUtils";

/** 工具完整结果 LRU 上限（见 toolFullTextByMessageId）。 */
const TOOL_FULL_TEXT_LRU_LIMIT = 200;
/**
 * 工具完整结果总字节预算（2026 内存排查）：单条可达数百 KB，
 * 200 条全是大结果时仍可驻留数十 MB；超预算时按最旧先淘汰。
 */
const TOOL_FULL_TEXT_MAX_BYTES = 32 * 1024 * 1024;

/** 从 RPC 返回的未知 ask 记录中安全读取字段，避免批量答案转换扩散 any 强转。 */
function readAskField(input: unknown, key: string): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	return Reflect.get(input, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** ask_question 结果（result.details 嵌套或 result 顶层）的最小结构，仅声明渲染卡片消费的字段。 */
interface AskDetailsLike {
	question?: unknown;
	type?: unknown;
	options?: unknown[];
	answers?: unknown[];
	questions?: unknown[];
	answer?: unknown;
	answerLabel?: unknown;
	answered?: boolean;
	cancelled?: boolean;
}

/** 装配协作方的窄接口：宿主只交出「消息列表 + 进行中身份 + 落盘/节流入口」，装配规则收在本模块。 */
export interface ToolMessageAssemblerHost {
	readonly messages: Map<string, ChatMessage[]>;
	/** pi 的 toolCallId 贯穿 start/update/end；映射本体归宿主（rebindInFlightMessages 与其共用）。 */
	readonly toolMessageIds: Map<string, Map<string, string>>;
	readonly messageProjector: AgentMessageProjector;
	/** 同一条 pi 消息的既有副本定位（宿主与思考终态共用一份实现）。 */
	findSameMessageIndex(list: ChatMessage[], role: ChatMessage["role"], text: string, toolCallId?: string): number;
	markMessagesDirtyFrom(agentId: string, index: number): void;
	scheduleMessageEmit(agentId: string, immediate?: boolean): void;
	activeAssistantMessageId(agentId: string): string | undefined;
	setActiveAssistantMessageId(agentId: string, messageId: string): void;
	consumeAskWaitMs(agentId: string): number;
	isAbortedDuringAsk(agentId: string): boolean;
	runtimeProjectId(agentId: string): string | undefined;
	isRemoteRuntime(projectId: string): boolean;
}

/** 工具/assistant 消息装配：tool_execution_* 工具卡与 message_* 流式回答块的 upsert（拆分第五刀）。 */
export class ToolMessageAssembler {
	/** 工具完整结果 LRU 缓存：截断下发后完整文本仅存于此（运行期「查看完整输出」走内存，
	 *  历史会话回退读会话文件）。键为 pi message id，agent 停止时随 clearAgentState 释放。 */
	private readonly toolFullTextByMessageId = new Map<string, string>();
	/** 已驻留完整文本的总字节数（字节预算 LRU 淘汰用）。 */
	private toolFullTextBytes = 0;

	constructor(private readonly host: ToolMessageAssemblerHost) {}

	upsertAssistantMessage(agentId: string, partialMessage?: unknown, fallbackDelta = "", options?: { allowEmpty?: boolean }) {
		const list = this.host.messages.get(agentId) ?? [];
		let messageId = this.host.activeAssistantMessageId(agentId);
		if (!messageId) {
			messageId = randomUUID();
			this.host.setActiveAssistantMessageId(agentId, messageId);
		}

		let existingIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：activeAssistantMessageIds 指向的运行期 id 在列表里已不存在
		// （loadMessages 替换为投影身份）。此时不能盲目 append——列表里可能已有同一条
		// pi 消息的投影版，append 会造出双份（同内容消息被用户消息切分到两个 run）。
		// 按内容指纹匹配既有消息：命中则更新它并把身份映射重定向到它，保持单份。
		if (existingIndex < 0) {
			const extractedTextForMatch = partialMessage && typeof partialMessage === "object" ? this.host.messageProjector.extractText(asRecord(partialMessage)?.content) : "";
			const rebindIndex = this.host.findSameMessageIndex(list, "assistant", extractedTextForMatch || fallbackDelta);
			if (rebindIndex >= 0) {
				existingIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				this.host.setActiveAssistantMessageId(agentId, messageId);
			}
		}
		const existing = existingIndex >= 0 ? list[existingIndex] : undefined;
		const extractedText = partialMessage && typeof partialMessage === "object" ? this.host.messageProjector.extractText(asRecord(partialMessage)?.content) : "";
		// stopReason（provider 归一化）：message_start 骨架为 pending，message_end 更新为
		// 真实值（stop/toolUse/aborted/error/length）。渲染层据此精确区分中间/最终回复。
		// pending 是骨架占位值：不持久化（new 分支）也不覆盖既有值（existing 分支），
		// 否则 message_end 缺 stopReason 时消息永远停 in pending，渲染层回退启发式失效。
		const extractedStopReason = partialMessage && typeof partialMessage === "object" ? (nonEmptyString(asRecord(partialMessage)?.stopReason) ?? "") : "";
		// 与历史投影同源归一：被打断的纯文本回复 pi 记 toolUse 但无 toolCall 块，按最终回复处理
		// （否则渲染层把它当中间回复折进「执行过程」，整段回复在空闲后仍不可见）。
		const finalStopReason = normalizePiStopReason(extractedStopReason && extractedStopReason !== "pending" ? extractedStopReason : undefined, hasPiToolCallBlock(partialMessage && typeof partialMessage === "object" ? asRecord(partialMessage)?.content : undefined));
		// 本条消息用的模型：message_end 的完整消息带 provider/model（message_start 骨架也有）。
		// 缺省不覆盖旧值——delta 路径的消息对象可能不带这两个字段。
		const messageRecord = partialMessage && typeof partialMessage === "object" ? asRecord(partialMessage) : undefined;
		const modelProvider = nonEmptyString(messageRecord?.provider);
		const modelId = nonEmptyString(messageRecord?.model);
		const extractedModel = modelProvider && modelId ? { provider: modelProvider, modelId } : undefined;
		// 用量/实测耗时：message_end 的完整消息带 usage 与 durationMs（timestamp = 请求开始）。
		// 轨迹账本的 token 列与真实区间依赖它们；缺失则不写（不补 0：未上报与 0 要可区分）。
		const extractedUsage = chatUsageFromPiUsage(messageRecord?.usage);
		const measuredDurationMs = typeof messageRecord?.durationMs === "number" && Number.isFinite(messageRecord.durationMs) ? messageRecord.durationMs : undefined;
		const startedAtMs = typeof messageRecord?.timestamp === "number" && messageRecord.timestamp > 0 ? messageRecord.timestamp : undefined;
		// 冻结耗时（轮末固定「回复耗时」）需要消息真正写完的时刻：pi 的 timestamp 是请求
		// 开始，结束后 run.endedAt 会与 startedAt 相等 → 轮末耗时恒为 0。优先用
		// 「请求开始 + 实测耗时」；模拟/远端后端没上报 durationMs 时，终态事件即写盘时刻。
		const endedAtMs = finalStopReason ? (startedAtMs !== undefined && measuredDurationMs !== undefined ? startedAtMs + measuredDurationMs : Date.now()) : undefined;
		const usageMeta = {
			...(extractedUsage ? { usage: extractedUsage } : {}),
			...(measuredDurationMs !== undefined ? { durationMs: measuredDurationMs } : {}),
			...(startedAtMs !== undefined && measuredDurationMs !== undefined ? { startedAt: startedAtMs } : {}),
			...(endedAtMs !== undefined ? { endedAt: endedAtMs } : {}),
		};

		if (existing) {
			// 已有骨架：有抽出文本才覆盖；fallbackDelta 仅作追加兜底（终态路径）。
			// thinking 不在此写入——仅 finalizeThinkingIntoMessage 在终态写一次。
			if (extractedText || fallbackDelta) {
				existing.text = extractedText || `${existing.text}${fallbackDelta}`;
			}
			// 终态（message_end）带真实 stopReason 时更新；骨架占位值（pending）不覆盖旧值。
			if (finalStopReason) {
				existing.stopReason = finalStopReason;
			}
			if (extractedModel) {
				existing.model = extractedModel;
			}
			if (Object.keys(usageMeta).length > 0) {
				existing.meta = { ...existing.meta, ...usageMeta };
			}
			// 保留原始时间戳，不随 delta 刷新。
			this.host.markMessagesDirtyFrom(agentId, existingIndex);
		} else {
			const text = extractedText || fallbackDelta;
			// 默认拒绝空消息；message_start 传 allowEmpty 以建立 Live 挂载点。
			if (!text && !options?.allowEmpty) return;
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text: text || "",
				timestamp: Date.now(),
				...(finalStopReason ? { stopReason: finalStopReason } : {}),
				...(extractedModel ? { model: extractedModel } : {}),
				...(Object.keys(usageMeta).length > 0 ? { meta: usageMeta } : {}),
			});
			this.host.markMessagesDirtyFrom(agentId, list.length - 1);
		}

		this.host.messages.set(agentId, list);
		// 远端事件时间与远端 JSONL 同源，保留作停止后的身份核对；不能拿本机时间跨时钟匹配。
		const projectId = this.host.runtimeProjectId(agentId);
		if (projectId !== undefined && this.host.isRemoteRuntime(projectId) && isRecord(partialMessage) && typeof partialMessage.timestamp === "number" && Number.isFinite(partialMessage.timestamp)) {
			const message = list.find((candidate) => candidate.id === messageId);
			if (message) message.meta = { ...message.meta, persistedTimestamp: partialMessage.timestamp };
		}
		// upsertAssistantMessage 被 text_start/end 等路径调用，走节流合并；
		// message_end 等终态调用方会在调用后显式 flush，保证最终状态及时。
		this.host.scheduleMessageEmit(agentId);
	}
	upsertToolMessage(agentId: string, event: Record<string, unknown>, status: "running" | "done" | "error") {
		const eventToolName = typeof event.toolName === "string" ? event.toolName : undefined;
		const toolCallId = String(event.toolCallId ?? `${eventToolName ?? "tool"}-${Date.now()}`);
		let agentTools = this.host.toolMessageIds.get(agentId);
		if (!agentTools) {
			agentTools = new Map<string, string>();
			this.host.toolMessageIds.set(agentId, agentTools);
		}

		let messageId = agentTools.get(toolCallId);
		if (!messageId) {
			messageId = randomUUID();
			agentTools.set(toolCallId, messageId);
		}

		const list = this.host.messages.get(agentId) ?? [];
		let existingToolIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：运行期工具 id 已不在列表（被投影身份替换）。按 toolCallId
		// （两通道同源）匹配既有工具消息，更新它并重定向身份，避免 append 双份。
		if (existingToolIndex < 0) {
			const rebindIndex = this.host.findSameMessageIndex(list, "tool", "", toolCallId);
			if (rebindIndex >= 0) {
				existingToolIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				agentTools.set(toolCallId, messageId);
			}
		}
		const existing = existingToolIndex >= 0 ? list[existingToolIndex] : undefined;
		// end/update 常只带 toolCallId；继承 start 的身份，避免完成态把 bash/read 降级成 tool。
		const toolName = eventToolName ?? (typeof existing?.meta?.toolName === "string" ? existing.meta.toolName : "tool");
		const isError = status === "error" || event.isError === true;
		const args = event.args ?? existing?.meta?.args;
		const startedAt = typeof existing?.meta?.startedAt === "number" ? existing.meta.startedAt : Date.now();
		// 工具耗时只能由 start/end 两个事件推导；start 时先保存 startedAt，end 时再写入 durationMs，
		// 避免使用消息 timestamp（会在 update/end 时刷新）导致历史恢复后耗时不可还原。
		// ask_question 工具耗时需扣除用户等待时长（exclude_wait）：等待期由 settleAskWait 累计在
		// askWaitMsByAgent，工具结束时减掉并清零，让 durationMs 只反映 agent 实际处理时间。
		// 注意扣除不只适用于 ask_question 自身：tool_execution_start 已清空累计值，因此任何工具
		// end 时残留的等待量只可能是「本工具运行期间结算的等待」——子代理委托工具（Agent /
		// acp_delegate 等）运行中，子代理转发的提问被回答时正是这种情况，若只对 ask_question
		// 扣除，该等待会在下一个工具 start 时被无痕清掉，委托工具卡时长仍虚高（用户反馈
		// 「代理的时间也有问题」）。
		let durationMs = status === "running" ? undefined : Math.max(0, Date.now() - startedAt);
		if (durationMs !== undefined) {
			const askWaitMs = this.host.consumeAskWaitMs(agentId);
			if (askWaitMs > 0) {
				durationMs = Math.max(0, durationMs - askWaitMs);
			}
		}
		const result = event.result ?? event.partialResult ?? event.output ?? existing?.meta?.result;
		// 工具结果可能带 image content（生图类扩展把生成图直接放进结果）：实时事件同样
		// 提取出来挂到消息上，否则只有文本会进时间线。无新图时保留上一轮的图。
		const resultContent = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>).content : undefined;
		const resultImages = this.host.messageProjector.extractImages(resultContent);
		const images = resultImages.length > 0 ? resultImages : existing?.images;
		// pi 侧截断（bash/powershell >1 MiB）：存在时才写 meta.resultTruncation，
		// 普通结果的 details 无 truncation 字段 → 不下发多余 meta。
		const piTruncation = extractPiToolTruncation(result);
		const detailText = this.host.messageProjector.formatToolDetail(toolName, args, result, status);
		// detailText 整体截断（拼接后可能超单段上限）并标记 truncated/fullLength；
		// 完整结果文本缓存在 toolFullTextByMessageId（LRU），供「查看完整输出」按需读取。
		const detailDelivery = this.host.messageProjector.truncateDetailWithMeta(detailText);
		if (detailDelivery.truncated) {
			const fullText = this.host.messageProjector.extractToolResultText(result) || this.host.messageProjector.safeJson(result);
			if (fullText) {
				// 字节 + 条数双预算：单条工具结果可达数百 KB，仅按条数封顶时
				// 200 条大结果仍可驻留数十 MB（2026 内存排查）。
				this.toolFullTextBytes += fullText.length;
				while (this.toolFullTextBytes > TOOL_FULL_TEXT_MAX_BYTES && this.toolFullTextByMessageId.size > 0) {
					const oldest = this.toolFullTextByMessageId.keys().next().value;
					if (oldest === undefined) break;
					const removed = this.toolFullTextByMessageId.get(oldest);
					if (removed !== undefined) this.toolFullTextBytes -= removed.length;
					this.toolFullTextByMessageId.delete(oldest);
				}
				this.toolFullTextByMessageId.set(messageId, fullText);
				if (this.toolFullTextByMessageId.size > TOOL_FULL_TEXT_LRU_LIMIT) {
					// LRU 淘汰最旧（Map 迭代序 = 插入序）
					const oldest = this.toolFullTextByMessageId.keys().next().value;
					if (oldest !== undefined) {
						const removed = this.toolFullTextByMessageId.get(oldest);
						if (removed !== undefined) this.toolFullTextBytes -= removed.length;
						this.toolFullTextByMessageId.delete(oldest);
					}
				}
			}
		}
		const icon = status === "running" ? "▶" : isError ? "✗" : "✓";
		const text = status === "running" ? `${icon} ${toolName}` : `${icon} ${toolName}`;
		// args 可能来自 event.args（对象）或 existing.meta.args（已序列化的 JSON 字符串）。
		// 如果是后者（如 tool_execution_end 不带 args），直接复用已有字符串避免 double encoding。
		// 文件类工具（write/edit/create/patch）不适用 8000 截断：它们的参数里带着被写文件内容，
		// 截断会把「已省略 N 字符」插进 JSON 字符串中间 → 不可解析 → 该文件从「修改的文件」清单
		// 及重开后的历史视图里静默消失（见 serializeToolArgsForDelivery）。
		const argsMeta = typeof args === "string" ? args : this.host.messageProjector.serializeToolArgs(toolName, args);
		// 提取 ask_question 详情用于渲染提问卡片；支持批量（questions 数组）和单问题两种格式。
		// pi RPC 返回格式可能为 result.details 嵌套 或 result 顶层（无 details 包装）
		const askDetails: AskDetailsLike | undefined = (() => {
			if (toolName !== "ask_question" || !result || typeof result !== "object") return undefined;
			const resultRecord = asRecord(result);
			const details = asRecord(resultRecord?.details);
			// 格式 1: result.details.question 或 result.details.answers（批量）
			if (details?.question || Array.isArray(details?.answers)) {
				return details;
			}
			// 格式 2: result.question（无 details 包装）
			if (resultRecord?.question) {
				return resultRecord;
			}
			// 格式 3: 从 args 回退读取提问内容（当 result 仅为简单值如选中项字符串时）
			let parsedArgs: unknown = args;
			if (typeof args === "string") {
				try {
					parsedArgs = JSON.parse(args);
				} catch {
					parsedArgs = undefined;
				}
			}
			const parsedRecord = asRecord(parsedArgs);
			if (parsedRecord?.question) {
				const answerValue = typeof result === "string" ? result : (resultRecord?.value ?? resultRecord?.answer);
				return {
					question: parsedRecord.question,
					options: parsedRecord.options,
					answer: answerValue,
					answered: true,
					answerLabel: answerValue,
				};
			}
			return undefined;
		})();
		const askCard = (() => {
			if (!askDetails) return undefined;
			// abort 时覆写 answer 为 null、answered 为 false，确保卡片显示"已取消"
			const aborted = this.host.isAbortedDuringAsk(agentId);
			// 单问题格式：details.question (string), details.answer
			if (askDetails.question) {
				return {
					question: askDetails.question,
					type: askDetails.type,
					answered: aborted ? false : askDetails.answered,
					answer: aborted ? null : askDetails.answer,
					answerLabel: aborted ? undefined : askDetails.answerLabel,
					options: askDetails.options,
				};
			}
			// 批量格式：保留完整问答列表，历史卡片才能同时展示每个问题与对应答案，
			// 不再只取第一题导致用户无法回看其余回答。
			if (Array.isArray(askDetails.answers) && askDetails.answers.length > 0) {
				const questions = Array.isArray(askDetails.questions) ? askDetails.questions : [];
				const batchQuestions = askDetails.answers.map((rawAnswer: unknown, index: number) => {
					const rawQuestion = questions[index];
					const questionText = typeof readAskField(rawQuestion, "question") === "string" ? String(readAskField(rawQuestion, "question")) : String(readAskField(rawAnswer, "id") ?? "");
					const rawType = readAskField(rawAnswer, "type") ?? readAskField(rawQuestion, "type");
					const rawOptions = readAskField(rawQuestion, "options");
					return {
						question: questionText,
						type: typeof rawType === "string" ? rawType : "input",
						answered: !askDetails.cancelled && readAskField(rawAnswer, "value") !== null,
						answer: readAskField(rawAnswer, "value"),
						answerLabel: typeof readAskField(rawAnswer, "label") === "string" ? String(readAskField(rawAnswer, "label")) : undefined,
						options: Array.isArray(rawOptions) ? rawOptions : undefined,
					};
				});
				const firstQuestion = batchQuestions[0];
				return {
					...firstQuestion,
					questions: batchQuestions,
				};
			}
			return undefined;
		})();
		const meta = {
			status,
			toolName,
			toolCallId,
			startedAt,
			...(durationMs !== undefined ? { durationMs } : {}),
			args: argsMeta,
			result: this.host.messageProjector.truncateForDetail(this.host.messageProjector.extractToolResultText(result) || this.host.messageProjector.safeJson(result)),
			isError,
			// pi 0.99 起 bash/powershell 结果 >1 MiB 时 truncated/details.fullOutputPath 单独下发，
			// 渲染层据此给出完整输出路径（不同于本文件上方的 truncated 展示层截断标记）。
			...(piTruncation ? { resultTruncation: piTruncation } : {}),
			detailText: detailDelivery.text,
			...(detailDelivery.truncated ? { truncated: true, fullLength: detailDelivery.fullLength } : {}),
			// originalContent 不再存储到消息中（full file 会使会话元数据体积过大）。
			// diff 使用工具参数（oldText/newText 等）展示变动区域，无需完整文件快照。

			...(askCard ? { _askCard: askCard } : {}),
		};

		if (existing) {
			existing.text = text;
			existing.timestamp = Date.now();
			if (images && images.length > 0) existing.images = images;
			// 合并而非替换：重定向到投影版时保留其身份字段（entryId/_piDeckMsgSeq），
			// 否则渲染层接缝去重与编辑/删除/重发定位会因 entryId 丢失而失效。
			existing.meta = { ...(existing.meta ?? {}), ...meta };
			this.host.markMessagesDirtyFrom(agentId, existingToolIndex);
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "tool",
				text,
				timestamp: Date.now(),
				meta,
				...(images && images.length > 0 ? { images } : {}),
			});
			this.host.markMessagesDirtyFrom(agentId, list.length - 1);
		}

		this.host.messages.set(agentId, list);
		this.host.scheduleMessageEmit(agentId);
	}

	readFullText(messageId: string): string | undefined {
		return this.toolFullTextByMessageId.get(messageId);
	}

	clearFullTextCache(): void {
		this.toolFullTextByMessageId.clear();
		this.toolFullTextBytes = 0;
	}
}
