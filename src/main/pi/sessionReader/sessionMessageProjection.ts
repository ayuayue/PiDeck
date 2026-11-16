import type { ChatMessage, ImageContent } from "../../../shared/types";
import { isRoleMessageRole } from "../sessionEntryIds";
import type { SessionDisplayEntry, SessionHistoryMetadata, SessionModelSelection } from "../SessionHistoryReader";
import { isRecord } from "./sessionEntryParsing";

/**
 * 消息投影侧的纯基元：context_edit 的汇总与应用、重发内容/合成 id 的解析、
 * 分支元数据派生，以及「条目下标 → 投影后消息下标」的换算。
 *
 * 全靠入参决定出参（不碰磁盘、不碰缓存）：宿主负责索引与 IO。时间线两条投影链
 * （停止态历史页与运行态窗口）必须调同一份规则，因此集中在同一模块。
 */

/**
 * 会话在「模型上下文」与「原始历史」两个视角下的差异（仅统计条目 id 级别的信息）。
 *
 * pi 自 1.0.x 起用 `context_edit` 追加记录来表达「把某条消息从模型上下文移除/
 * 改写」而不改写原始行（`replacement: null` = 不再送入模型）。因此同一会话存在
 * 两个真相：
 *   - 原始历史（文件里曾经发生过的）：永不减少，包括已被移出的消息与已发生的费用；
 *   - 有效上下文（模型下次会看到的）：受 context_edit 与最近一次 compaction 影响。
 * 展示层必须能把两者分开说清楚，否则「删了消息但历史还在」看起来像 bug。
 */
export type SessionContextEditsSummary = {
	/** 活动分支上最终被移出模型上下文的条目 id（同一目标多次编辑取最后一次）。 */
	excludedEntryIds: readonly string[];
	/** 活动分支上最终被改写内容的条目 id。 */
	replacedEntryIds: readonly string[];
};

/**
 * context_edit 汇总的内部结果：除页面契约需要的两个 id 列表外，
 * 额外带上「改写后的文本」供展示层替换正文（页面契约不包含它）。
 */
export type SessionContextEditsDetail = SessionContextEditsSummary & {
	/** targetId → 最终生效的替换文本（仅替换类编辑且能提取出文本时存在）。 */
	replacementText: ReadonlyMap<string, string>;
};

/**
 * context_edit 汇总所需的最小结构（离线 Viewer 的 inline 条目只建了这几个字段，
 * 用结构子集而非 SessionDisplayEntry，避免为汇总把索引字段都补齐）。
 */
type ContextEditSourceEntry = {
	type?: string;
	contextEditTargetId?: string;
	contextEditExcludes?: boolean;
	/** 改写后的可见文本（仅替换类编辑；建索引时从 replacement.content 提取）。 */
	contextEditText?: string;
};

/**
 * 从活动分支汇总「最终生效」的 context_edit（同一 targetId 后者覆盖前者，与 pi 一致）。
 *
 * 为何只算活动分支：编辑是树上的节点，只有落在当前 leaf 父链上的才作用于模型上下文。
 * 分叉后另一分支的编辑不得影响当前分支（否则切分支会看到别人的改写）。
 *
 * 为何只算「活动分支」而不先做压缩裁剪：这里回答的是「用户在这条分支上做过哪些操作」，
 * 而压缩裁不裁剪属于「模型最后看到什么」。两者混为一谈会让已被摘要替代的编辑凭空消失。
 */
export function collectSessionContextEdits(activeBranch: readonly ContextEditSourceEntry[]): SessionContextEditsDetail {
	const finalByTarget = new Map<string, { excluded: boolean; text?: string }>();
	for (const entry of activeBranch) {
		if (entry.type !== "context_edit" || !entry.contextEditTargetId) continue;
		const state: { excluded: boolean; text?: string } = { excluded: entry.contextEditExcludes === true };
		if (entry.contextEditText !== undefined) state.text = entry.contextEditText;
		finalByTarget.set(entry.contextEditTargetId, state);
	}
	const excludedEntryIds: string[] = [];
	const replacedEntryIds: string[] = [];
	const replacementText = new Map<string, string>();
	for (const [targetId, state] of finalByTarget) {
		if (state.excluded) {
			excludedEntryIds.push(targetId);
			continue;
		}
		replacedEntryIds.push(targetId);
		if (state.text !== undefined) replacementText.set(targetId, state.text);
	}
	return { excludedEntryIds, replacedEntryIds, replacementText };
}

/**
 * 应用当前分支上生效的上下文编辑（展示层过滤 + 正文替换）。
 *
 * - excluded（`replacement: null`）：**从时间线上直接去掉**，不显示、不标记、
 *   不折叠——用户按下删除就应当看不到它。
 * - replaced：正文换成改写后的内容（否则刚做完的编辑看起来没生效），不加任何标记。
 *
 * 文件里两种情况的原文都原样保留（pi 的 append-only 语义），只是不再参与展示；
 * 因此原始历史、导出与计费仍能看到它们，模型上下文也不再包含被移出的条目。
 * 原文只有在没有可见文本块（纯图片/工具块）时才不替换正文，避免把有内容的
 * 回答显示成空。
 *
 * 只认带 entryId 的消息：实时乐观消息 / 无 entryId 的系统卡片不参与。
 *
 * 展示层有两条投影链：停止态/历史页（readSessionDisplayMessages）与运行态窗口
 * （AgentManager.loadMessages 从 JSONL 尾部读原始行后投影）。两条必须调同一个函数——
 * 只在其中一条过滤，就会出现「删除后重启 Agent 消息又回来」（issue #482）。
 */
export function applySessionContextEdits(messages: ChatMessage[], contextEdits: SessionContextEditsDetail): ChatMessage[] {
	if (contextEdits.excludedEntryIds.length === 0 && contextEdits.replacedEntryIds.length === 0) return messages;
	const excluded = new Set(contextEdits.excludedEntryIds);
	const replaced = new Set(contextEdits.replacedEntryIds);
	const result: ChatMessage[] = [];
	for (const message of messages) {
		const entryId = typeof message.meta?.entryId === "string" ? message.meta.entryId : undefined;
		if (!entryId) {
			result.push(message);
			continue;
		}
		if (excluded.has(entryId)) continue;
		const replacementText = replaced.has(entryId) ? contextEdits.replacementText.get(entryId) : undefined;
		result.push(replacementText === undefined ? message : { ...message, text: replacementText });
	}
	return result;
}
export function extractResendContent(content: unknown): { text: string; images?: ImageContent[] } {
	if (typeof content === "string") return { text: content };
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		const images: ImageContent[] = [];
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			} else if (block.type === "image") {
				const source = isRecord(block.source) ? block.source : undefined;
				const data = typeof block.data === "string" ? block.data : typeof source?.data === "string" ? source.data : "";
				const mimeType = typeof block.mimeType === "string" ? block.mimeType : typeof block.mime_type === "string" ? block.mime_type : typeof source?.media_type === "string" ? source.media_type : "image/png";
				if (data) images.push({ type: "image", data, mimeType });
			}
		}
		return { text: textParts.join("\n"), ...(images.length > 0 ? { images } : {}) };
	}
	return { text: "" };
}

/**
 * 从渲染层合成消息 ID（`${agentId}-history-${entryId}`）解析出 entryId。
 * 与 SessionFileEditor.legacyEntryId 的格式约定一致：agentId/entryId 是 UUID，
 * 不含 "-history-" 分隔符；非合成格式返回 undefined。
 */
export function syntheticHistoryEntryId(messageId: string): string | undefined {
	const marker = "-history-";
	const index = messageId.lastIndexOf(marker);
	if (index < 0) return undefined;
	const entryId = messageId.slice(index + marker.length);
	return entryId || undefined;
}

export function deriveSessionHistoryMetadata(activeBranch: readonly SessionDisplayEntry[]): SessionHistoryMetadata {
	let modelProvider: string | undefined;
	let modelId: string | undefined;
	let lastAssistantModel: SessionModelSelection | undefined;
	let thinkingLevel: string | undefined;

	for (const entry of activeBranch) {
		if (entry.type === "model_change") {
			modelProvider = entry.modelChangeProvider ?? modelProvider;
			modelId = entry.modelChangeId ?? modelId;
		} else if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? thinkingLevel;
		}
		if (entry.assistantModel) lastAssistantModel = entry.assistantModel;
	}

	const model = modelProvider && modelId ? { provider: modelProvider, modelId } : lastAssistantModel;
	if (thinkingLevel === undefined && model) thinkingLevel = "off";

	return {
		...(model ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	};
}

/**
 * 按下标插入卡片（降序 splice，避免前一次插入把后一次的偏移推移）。
 *
 * `toArrayIndex` 把「绝对消息条目下标」映射成目标数组下标：必须经
 * {@link messageIndexFromEntryOffset} 只数角色条目（0.86 的 system 条目会破坏
 * 「条目与消息一一对应」），而压缩页里已经有一张压缩卡片占了槽位，落在它之后的
 * 卡片需要整体 +1 补偿（见 convertCompactionPageMessages）。
 */
export function spliceCardsByOffset<T>(items: T[], cards: ReadonlyArray<{ offset: number; card: T }>, toArrayIndex: (absoluteOffset: number) => number): T[] {
	if (cards.length === 0) return items;
	const next = [...items];
	const ordered = [...cards].sort((a, b) => b.offset - a.offset);
	for (const entry of ordered) {
		const index = Math.min(Math.max(toArrayIndex(entry.offset), 0), next.length);
		next.splice(index, 0, entry.card);
	}
	return next;
}

/**
 * 把「绝对消息条目下标」映射成「投影后消息数组下标」：只数会生成 ChatMessage 的
 * 角色条目（user/assistant/toolResult）。
 *
 * 为什么不能写 `offset - windowStart`：pi 0.86 起系统提示/工具清单变更也是
 * `type:"message"` 条目（role:"system"），它们不生成 ChatMessage、不占消息下标；
 * 直接按条目数相减会让卡片整体后移，offset 靠尾时还会被 clamp 到时间线末尾。
 * windowEntries 必须是从 windowStart 起、与投影输入同源的条目切片。
 */
export function messageIndexFromEntryOffset(windowEntries: ReadonlyArray<{ role?: string }>, absoluteOffset: number, windowStart: number): number {
	const bound = Math.min(Math.max(absoluteOffset - windowStart, 0), windowEntries.length);
	let count = 0;
	for (let position = 0; position < bound; position += 1) {
		if (isRoleMessageRole(windowEntries[position]?.role)) count += 1;
	}
	return count;
}

/**
 * 与投影器 entryId 槽位口径一致的条目 id 列表：只保留消费槽位的角色条目。
 * 0.86 的 role:"system" 条目混进来会让其后消息的 meta.entryId 整体前移。
 * 入参用结构子集：索引条目直接带 role，而「传了会话全文」的分支只有 message 载荷。
 */
export function roleMessageEntryIds(entries: ReadonlyArray<{ id: string; role?: string; message?: unknown }>): string[] {
	return entries.filter((entry) => isRoleMessageRole(entry.role ?? (isRecord(entry.message) ? entry.message.role : undefined))).map((entry) => entry.id);
}
