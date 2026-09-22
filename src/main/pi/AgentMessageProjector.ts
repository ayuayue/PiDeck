import type { ChatMessage, ImageContent } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { extractToolResultText as extractSharedToolResultText, formatToolDetail as formatSharedToolDetail, safeJson as sharedSafeJson, truncateDetailWithMeta as truncateSharedDetailWithMeta, truncateForDetail as truncateSharedForDetail } from "../../shared/formatToolDetail";
import { extractMessageText } from "./messageContent";
import { isRoleMessageRole, takeActiveEntryId } from "./sessionEntryIds";

export type AgentMessageProjectorDeps = {
	translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	isAskAborted: (agentId: string) => boolean;
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function buildActiveBranchEntryIds(entries: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>, leafId: string): string[] {
	const entryById = new Map<string, { id: string; parentId: string | null; type?: string; message?: { role?: string } }>();
	for (const entry of entries) {
		entryById.set(entry.id, entry);
	}

	// 从 leafId 回溯到 root，只保留消费 entryId 槽位的角色 message 条目。
	// pi 0.86 起分支上还会出现 role:"system" 的 prompt/tool 更新条目（以及历史上无
	// message 载荷的异常条目），它们不参与消息投影；若不过滤会让后续 id 整体错位。
	const allBranchIds: string[] = [];
	let currentId: string | null = leafId;
	while (currentId) {
		allBranchIds.unshift(currentId);
		const entry = entryById.get(currentId);
		currentId = entry?.parentId ?? null;
	}
	return allBranchIds.filter((id) => {
		const entry = entryById.get(id);
		if (!entry || entry.type !== "message") return false;
		return isRoleMessageRole(entry.message?.role);
	});
}

/**
 * Converts persisted Pi/RPC history into renderer ChatMessage records. It has no
 * process, window, or Session ownership; AgentManager supplies the live state
 * query needed to preserve cancelled ask_question cards.
 */
export class AgentMessageProjector {
	constructor(private readonly deps: AgentMessageProjectorDeps) {}

	convert(agentId: string, rawMessages: unknown[], activeEntryIds?: string[]): ChatMessage[] {
		const historicalToolCalls = this.collectHistoricalToolCalls(rawMessages);
		const historicalOriginalContentByPath = this.collectHistoricalOriginalContentByPath(rawMessages, historicalToolCalls);
		// 用于生成元消息 id（compaction/branchSummary）的计数器
		let metaSeq = 0;
		// entryId 按 active branch 顺序与 rawMessages 一一对应。
		// 注意：entryIndex 只在 user/assistant/toolResult 时递增，因为
		// compactionSummary/branchSummary 在 get_entries 中无对应 entry，而 activeEntryIds 也只
		// 含消费槽位的角色 message 条目（buildActiveBranchEntryIds / getRecentActiveEntryIds
		// 都按 isRoleMessageRole 过滤，pi 0.86 的 role:"system" 条目不算）。
		// 因此 currentEntryId 的读取必须放在各个角色块内部，不能在所有条目前统一读取，
		// 否则非用户/助手/工具条目会提前消费 entryIndex 槽位。
		let entryIndex = 0;
		return (
			rawMessages
				.flatMap<ChatMessage>((message, index) => {
					if (!message || typeof message !== "object") return [];
					const typed = message as any;

					if (typed.role === "user") {
						// 先消费 activeEntryIds 槽位，再决定是否渲染。
						// 边界：空文本 user 不展示，但 get_entries 仍有对应 entry，
						// 若不推进 index，后续消息 entryId 会整体前移错位。
						const taken = takeActiveEntryId(activeEntryIds, entryIndex);
						entryIndex = taken.nextIndex;
						const currentEntryId = taken.entryId;
						const images = this.extractImages(typed.content);
						const text = this.extractText(typed.content) || (images.length > 0 ? this.deps.translate("session.imagePlaceholder") : "");
						if (!text.trim()) return [];
						return [
							{
								id: `${agentId}-history-${currentEntryId ?? index}`,
								agentId,
								role: "user" as const,
								text,
								timestamp: typed.timestamp ?? Date.now(),
								meta: {
									...(currentEntryId ? { entryId: currentEntryId } : {}),
									// 保留 _piDeckMsgSeq 作为旧版本回退兼容
									_piDeckMsgSeq: index,
								},
								...(images.length > 0 ? { images } : {}),
							},
						];
					}
					if (typed.role === "assistant") {
						// 工具调用回合常见「assistant 仅含 toolCall、无可见文本」：
						// 这时不能直接跳过，因为可能包含 thinking 内容。如果 thinking 也被丢掉，
						// 渲染时多步思考会混入下一个回答块，用户在历史会话中看到的信息不完整。
						// 提取 thinking，即使 text 为空也保留消息，由 renderer 端 groupToolMessages
						// 的 isThinkingOnly 判断逻辑统一处理。
						const taken = takeActiveEntryId(activeEntryIds, entryIndex);
						entryIndex = taken.nextIndex;
						const currentEntryId = taken.entryId;
						const thinking = this.extractThinking(typed.content);
						// 生图等 PiDeck 本地落盘的 assistant 消息可能只有图片块、没有文本。
						const images = this.extractImages(typed.content);
						// SessionFileEditor 将持久化 extra 展开到 assistant 消息顶层，
						// 因此历史生图标识位于 typed.api / typed.imageGen。
						const extraRecord = typed;
						const imageGen = extraRecord?.imageGen;
						const imageGenMeta = imageGen && typeof imageGen === "object" ? (imageGen as Record<string, unknown>) : undefined;
						// 兼容首批生图历史：旧记录只有 extra.api，没有 imageGen 元数据；
						// 用前一条 user 消息恢复 prompt，避免旧图片失去复制/保存入口。
						const isLegacyImageGen = extraRecord?.api === "openai-images";
						const legacyPrompt = isLegacyImageGen
							? rawMessages
									.slice(0, index)
									.reverse()
									.find((candidate) => {
										if (!candidate || typeof candidate !== "object") return false;
										const role = (candidate as Record<string, unknown>).role;
										return role === "user";
									})
							: undefined;
						const prompt = legacyPrompt && typeof legacyPrompt === "object" ? this.extractText((legacyPrompt as Record<string, unknown>).content) : "";
						const recoveredImageGen = imageGenMeta && typeof imageGenMeta.prompt === "string" ? imageGenMeta : isLegacyImageGen ? { status: "complete", prompt: prompt || this.deps.translate("session.imagePlaceholder") } : undefined;
						const text = this.extractText(typed.content) || (recoveredImageGen ? this.deps.translate("session.imagePlaceholder") : "");
						// 无文本、无 thinking、无图片时才是真正的空消息，跳过。
						if (!text.trim() && !thinking?.trim() && images.length === 0) return [];
						// stopReason（provider 归一化）：历史 JSONL 已持久化，
						// 渲染层据此精确区分中间/最终回复（与 live 路径同源）。
						const stopReason = typeof typed.stopReason === "string" && typed.stopReason ? typed.stopReason : undefined;
						return [
							{
								id: `${agentId}-history-${currentEntryId ?? index}`,
								agentId,
								role: "assistant" as const,
								text,
								timestamp: typed.timestamp ?? Date.now(),
								meta: {
									...(currentEntryId ? { entryId: currentEntryId } : {}),
									_piDeckMsgSeq: index,
									...(recoveredImageGen && (recoveredImageGen.status === "complete" || recoveredImageGen.status === "generating" || recoveredImageGen.status === "error") ? { imageGen: recoveredImageGen } : {}),
								},
								...(thinking ? { thinking } : {}),
								...(images.length > 0 ? { images } : {}),
								...(stopReason ? { stopReason } : {}),
							},
						];
					}
					if (typed.role === "toolResult") {
						const taken = takeActiveEntryId(activeEntryIds, entryIndex);
						entryIndex = taken.nextIndex;
						const currentEntryId = taken.entryId;
						const toolCallId = String(typed.toolCallId ?? `history-tool-${index}`);
						const historicalCall = historicalToolCalls.get(toolCallId);
						const toolName = String(typed.toolName ?? historicalCall?.name ?? "tool");
						const isError = Boolean(typed.isError);
						const startedAt = typeof typed.startedAt === "number" ? typed.startedAt : historicalCall?.timestamp;
						const durationMs = typeof typed.durationMs === "number" ? typed.durationMs : typeof startedAt === "number" && typeof typed.timestamp === "number" ? Math.max(0, typed.timestamp - startedAt) : undefined;
						const result = {
							content: typed.content,
							details: typed.details,
						};
						const filePath = this.getToolPathFromArgs(historicalCall?.args);
						const piDeckOriginalContent = typed.details?._piDeckOriginalContent as string | undefined;
						const originalContent = piDeckOriginalContent ?? (filePath ? historicalOriginalContentByPath.get(filePath) : undefined);
						const detailText = this.formatToolDetail(toolName, historicalCall?.args, result, isError);
						// detailText 整体截断（拼接后可能超单段上限）并标记 truncated/fullLength，
						// 渲染层据此提供「查看完整输出」按需加载（sessionsCatalogReadMessageFullText）。
						const detailDelivery = this.truncateDetailWithMeta(detailText);
						// 从历史工具结果中提取 ask_question 详情，用于渲染提问卡片（支持单问题和批量格式）。
						const askCard = (() => {
							if (toolName !== "ask_question" || !typed.details) return undefined;
							// abort 时发 value:null 导致 answer 为 null，但 pi 可能已默认选了第一选项。
							// 覆写 answer 为 null、answered 为 false，确保卡片显示"已取消"。
							const aborted = this.deps.isAskAborted(agentId);
							// 单问题格式：details.question (string), details.answer
							if (typed.details.question) {
								return {
									question: typed.details.question,
									type: typed.details.type,
									answered: aborted ? false : typed.details.answered,
									answer: aborted ? null : typed.details.answer,
									answerLabel: aborted ? undefined : typed.details.answerLabel,
									options: typed.details.options,
								};
							}
							// 批量格式：details.questions / details.answers 数组，取第一组问答
							if (Array.isArray(typed.details.answers) && typed.details.answers.length > 0) {
								const firstQuestion = Array.isArray(typed.details.questions) ? typed.details.questions[0] : undefined;
								const firstAnswer = typed.details.answers[0];
								return {
									question: firstQuestion?.question ?? String(firstAnswer.id ?? ""),
									type: firstAnswer.type ?? firstQuestion?.type ?? "input",
									answered: !typed.details.cancelled && firstAnswer.value !== null,
									answer: firstAnswer.value,
									answerLabel: firstAnswer.label,
									options: firstQuestion?.options,
								};
							}
							return undefined;
						})();
						// entryIndex 已在上方 takeActiveEntryId 推进
						return [
							{
								id: `${agentId}-history-${currentEntryId ?? index}`,
								agentId,
								role: "tool" as const,
								text: `${isError ? "✗" : "✓"} ${toolName}`,
								timestamp: typed.timestamp ?? Date.now(),
								meta: {
									...(currentEntryId ? { entryId: currentEntryId } : {}),
									_piDeckMsgSeq: index,
									status: isError ? "error" : "done",
									toolName,
									toolCallId,
									...(startedAt !== undefined ? { startedAt } : {}),
									...(durationMs !== undefined ? { durationMs } : {}),
									args: this.truncateForDetail(this.safeJson(historicalCall?.args)),
									result: this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result)),
									isError,
									detailText: detailDelivery.text,
									...(detailDelivery.truncated ? { truncated: true, fullLength: detailDelivery.fullLength } : {}),
									// 历史会话不保存 originalContent（full file），diff 使用工具参数
									//（oldText/newText）展示变动区域，避免会话文件体积膨胀。
									...(askCard ? { _askCard: askCard } : {}),
								},
							},
						];
					}
					// 压缩/分支摘要等元消息：显示在时间线上，不参与 _piDeckMsgSeq 计数
					if (typed.role === "compactionSummary" || typed.role === "branchSummary") {
						const isCompaction = typed.role === "compactionSummary";
						metaSeq++;
						return [
							{
								id: `${agentId}-meta-${metaSeq}`,
								agentId,
								role: "system" as const,
								text: typed.summary ?? (isCompaction ? "Session compacted" : "Branch summarized"),
								timestamp: typeof typed.timestamp === "number" ? typed.timestamp : Date.now(),
								meta: {
									type: isCompaction ? "compaction" : "branchSummary",
									tokensBefore: typed.tokensBefore,
									// 保留压缩次数（桌面端从会话文件解析得到），供前端展示“已压缩 N 次”
									...(isCompaction && typed.meta?.compactionCount != null ? { compactionCount: typed.meta.compactionCount } : {}),
								},
							},
						];
					}
					return [];
				})
				// thinking-only assistant turns intentionally carry an empty visible text field.
				// Keep them so renderer grouping can render the reasoning between tool steps.
				// 生图等本地落盘的纯图片 assistant 消息（无 text/thinking 但有 images）同样保留。
				.filter((message: ChatMessage) => Boolean(message.text.trim() || message.thinking?.trim() || (message.images?.length ?? 0) > 0))
		);
	}

	private collectHistoricalToolCalls(rawMessages: unknown[]) {
		const calls = new Map<string, { name: string; args: unknown; timestamp?: number }>();
		for (const message of rawMessages) {
			if (!message || typeof message !== "object") continue;
			const typed = message as any;
			if (typed.role !== "assistant" || !Array.isArray(typed.content)) continue;
			for (const block of typed.content) {
				if (!block || typeof block !== "object") continue;
				const toolCall = block as any;
				if (toolCall.type !== "toolCall" || !toolCall.id) continue;
				// pi 的历史文件把工具参数保存在 assistant.content 的 toolCall 块中，
				// toolResult 只带结果；恢复历史详情时必须先建立 toolCallId → 参数映射。
				calls.set(String(toolCall.id), {
					name: String(toolCall.name ?? "tool"),
					args: toolCall.arguments,
					// 旧会话没有 durationMs，只能用发起 toolCall 的 assistant 时间戳作为兜底起点；
					// 同一条 assistant 内并发多个工具时精度有限，但比完全不显示耗时更接近历史行为。
					timestamp: typeof typed.timestamp === "number" ? typed.timestamp : undefined,
				});
			}
		}
		return calls;
	}

	private collectHistoricalOriginalContentByPath(rawMessages: unknown[], historicalToolCalls: Map<string, { name: string; args: unknown }>) {
		const originals = new Map<string, string>();
		for (const message of rawMessages) {
			if (!message || typeof message !== "object") continue;
			const typed = message as any;
			if (typed.role !== "toolResult") continue;
			const toolCallId = String(typed.toolCallId ?? "");
			const historicalCall = historicalToolCalls.get(toolCallId);
			if (!historicalCall || historicalCall.name !== "read") continue;
			const filePath = this.getToolPathFromArgs(historicalCall.args);
			if (!filePath) continue;
			// 旧历史会话没有保存 originalContent；同一轮写入前通常会先 read 目标文件，
			// 用最近一次 read 结果作为后续 write/edit/patch 的 diff 基准。
			const content = this.extractText(typed.content);
			if (content) originals.set(filePath, content);
		}
		return originals;
	}

	private getToolPathFromArgs(args: unknown) {
		if (!args || typeof args !== "object") return "";
		const typed = args as any;
		return String(typed.path ?? typed.filePath ?? typed.file ?? typed.target_file ?? typed.targetFile ?? "");
	}

	formatToolDetail(toolName: string, args: unknown, result: unknown, isError: boolean) {
		return formatSharedToolDetail(toolName, args, result, isError, this.deps.translate);
	}

	/** 对超长工具文本做首尾截断，保留头部和尾部以兼顾开头信息和错误堆栈。 */
	truncateForDetail(text: unknown): string {
		return truncateSharedForDetail(text, this.deps.translate);
	}

	/**
	 * 与 truncateForDetail 同规则的整体截断，但额外返回是否截断与原始长度，
	 * 供下发 meta 标记 truncated/fullLength（渲染层据此提供「查看完整输出」按需加载入口）。
	 * 用于 detailText 的整体上限：formatToolDetail 拼接 args/result/details 三段后可能超过单段上限。
	 */
	truncateDetailWithMeta(text: string): { text: string; truncated: boolean; fullLength: number } {
		return truncateSharedDetailWithMeta(text, this.deps.translate);
	}

	extractToolResultText(result: unknown) {
		return extractSharedToolResultText(result);
	}

	safeJson(value: unknown) {
		return sharedSafeJson(value);
	}

	extractText(content: unknown): string {
		return extractMessageText(content);
	}

	/** 从 pi 历史消息 content 中恢复图片附件，用于历史会话重新打开后的图片展示。
	 *  兼容两种图片块：
	 *  - 直接块 { type:"image", data, mimeType }（PiDeck 落盘旧格式）
	 *  - Anthropic 风格 { type:"image", source:{ type:"base64", media_type, data } }
	 *    （pi jsonl / SessionHistoryReader.extractResendContent 同协议） */
	private extractImages(content: unknown): ImageContent[] {
		if (!Array.isArray(content)) return [];
		return content.flatMap<ImageContent>((item) => {
			if (!item || typeof item !== "object") return [];
			const typed = item as any;
			if (typed.type !== "image") return [];
			const data = typeof typed.data === "string" ? typed.data : typeof typed.source?.data === "string" ? typed.source.data : "";
			const mimeType = typeof typed.mimeType === "string" ? typed.mimeType : typeof typed.mime_type === "string" ? typed.mime_type : typeof typed.source?.media_type === "string" ? typed.source.media_type : "image/png";
			return data ? [{ type: "image", data, mimeType }] : [];
		});
	}

	/** 从历史消息 content 数组中提取 thinking 内容块的文本，清理 ANSI 转义码 */
	extractThinking(content: unknown): string {
		if (!Array.isArray(content)) return "";
		const raw = content
			.map((item) => {
				if (!item || typeof item !== "object") return "";
				const typed = item as any;
				if (typed.type !== "thinking") return "";
				return String(typed.thinking ?? typed.text ?? "");
			})
			.filter(Boolean)
			.join("\n");
		return stripAnsi(raw);
	}
}
