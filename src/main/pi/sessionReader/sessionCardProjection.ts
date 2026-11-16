import type { MainProcessTranslationKey } from "../../../shared/i18n/mainProcessCopy";
import type { ChatMessage } from "../../../shared/types";
import type { SessionDisplayEntry, SessionDisplayIndex } from "../SessionHistoryReader";
import { CUSTOM_ENTRY_DATA_MAX_JSON_LENGTH, customEntryHeadline, isDisplayableCustomEntryType, isRecord, readString } from "./sessionEntryParsing";
import { messageIndexFromEntryOffset, spliceCardsByOffset } from "./sessionMessageProjection";

/**
 * 显示窗口的合成卡片：通知卡（custom_message）、扩展输出卡（custom）、压缩摘要卡。
 *
 * 三件事在同一个协作者里，因为它们共用**同一个下标空间**（activeMessageEntries 绝对
 * 下标）与同一套插入补偿：压缩卡在数组里占位却不消耗条目下标，落在它之后的通知要 +1。
 * 偏移口径（resolveCompactionInsertOffset）只有一份实现，加载窗口/轮次页/整分支读取
 * 都调它——两边各算一次偏移，迟早错位。
 *
 * 本协作者只做「条目 → 卡片」的投影与插入，索引与 IO 全在宿主侧（窄接口只列定向读行、
 * 消息投影器与文案三个成员）。
 */

/** 宿主提供给卡片投影的窄接口（只列这里真正读到的成员）。 */
export type SessionCardProjectionHost = {
	/** 按条目 offset/byteLength 定向读整行并解析（并发与字节预算由宿主统一）。 */
	readRawLines: (hostPath: string, entries: SessionDisplayEntry[]) => Promise<unknown[]>;
	/** 原始消息 → 显示消息（运行时/离线共用同一投影器）。 */
	convertMessages: (agentId: string, rawMessages: unknown[], activeEntryIds?: string[]) => ChatMessage[];
	translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
};

export class SessionCardProjector {
	constructor(private readonly host: SessionCardProjectionHost) {}

	/**
	 * 把范围内的 custom_message / custom 条目构造成时间线卡片（含插入偏移）。
	 *
	 * 为什么要在读侧合成：PiDeck 不写 pi 的会话文件（会话读写归 pi），而 pi 用
	 * custom_message 承载「扩展对用户的通知」——子代理后台任务完成时正是用这条消息
	 * 唤醒父会话（sendCustomMessage + triggerTurn）。projector 只识别
	 * user/assistant/toolResult，于是这条消息既不可见、也不构成回合边界：唤醒后的
	 * 回答会和上一轮并进同一个 run，上一轮「最终回答」退化成「中间回答」被折叠。
	 * 这里把它投影成 role="system" + meta.type="customMessage" 的消息，渲染层按
	 * customType 白名单决定是否画成通知卡（display:false 的内部上下文注入不画，
	 * 但仍参与回合边界判定）。
	 *
	 * type:"custom"（pi 的 appendEntry）在同一次扫描里投影成 meta.type="customEntry"
	 * 的扩展输出卡：RPC 模式下 pi 的 registerEntryRenderer 不工作，时间线卡片是扩展
	 * 输出唯一能到达用户的通道（issue #285，pi-plan 的 /btw 等）。内部记账类
	 * customType（subagents: / pi-deck- 前缀）不投影，高频快照不刷屏；custom 条目
	 * 不是回合边界，只做可见性补齐。
	 *
	 * 偏移语义：offset = 该通知之前有多少条消息条目（即「下一条消息之前」），
	 * 与压缩卡片的 insertAt 同一（activeMessageEntries 绝对下标）空间。
	 * 范围取半开区间 [start, end)，只有尾部窗口/最新页才包含 offset === total
	 * 的「末条通知」——否则上下相邻两页会各自插一张，卡片重复出现。
	 *
	 * IO 约束：只对范围内真正要展示的几行发起磁盘读（与 readSubagentRecords 同模式）。
	 */
	async buildCustomMessageCards(index: SessionDisplayIndex, agentId: string, options: { start: number; end: number; isTailWindow: boolean; entryRendererTypes: readonly string[] }): Promise<Array<{ offset: number; card: ChatMessage }>> {
		const { start, end } = options;
		const inRange = (offset: number) => offset >= start && (offset < end || (options.isTailWindow && offset === end));
		// 活动分支上按顺序累计消息条目数：custom_message 的位置就是「它之前有多少条消息」。
		const placements: Array<{ entry: SessionDisplayEntry; offset: number }> = [];
		let messageCount = 0;
		for (const entry of index.activeBranch) {
			if (entry.type === "message" && entry.hasMessage) {
				messageCount += 1;
				continue;
			}
			if (entry.type === "custom_message") {
				if (!inRange(messageCount)) continue;
				placements.push({ entry, offset: messageCount });
				continue;
			}
			// 扩展输出（appendEntry）：内部记账类与超长降级条目不投影（见 isDisplayableCustomEntryType）
			if (entry.type === "custom" && !entry.oversized && isDisplayableCustomEntryType(entry.customType, options.entryRendererTypes)) {
				if (!inRange(messageCount)) continue;
				placements.push({ entry, offset: messageCount });
			}
		}
		if (placements.length === 0) return [];

		const rawLines = await this.host.readRawLines(
			index.hostPath,
			placements.map((item) => item.entry),
		);
		const cards: Array<{ offset: number; card: ChatMessage }> = [];
		for (let i = 0; i < placements.length; i++) {
			const parsed = rawLines[i];
			if (!isRecord(parsed)) continue;
			const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
			if (placements[i].entry.type === "custom") {
				// 扩展输出卡：text 只服务折叠行预览，展开内容由 meta.data 驱动（渲染层格式化）
				const data = parsed.data;
				let serializedData = "";
				try {
					serializedData = data === undefined ? "" : (JSON.stringify(data) ?? "");
				} catch {
					serializedData = "";
				}
				const withinBudget = serializedData.length <= CUSTOM_ENTRY_DATA_MAX_JSON_LENGTH;
				cards.push({
					offset: placements[i].offset,
					card: {
						id: `${agentId}-customentry-${placements[i].entry.id}`,
						agentId,
						role: "system",
						text: customEntryHeadline(data),
						timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
						meta: {
							type: "customEntry",
							customType: placements[i].entry.customType,
							...(withinBudget ? { data } : { dataTruncated: true }),
							entryId: placements[i].entry.id,
						},
					},
				});
				continue;
			}
			const content = typeof parsed.content === "string" ? parsed.content : "";
			// 空正文没有可展示信息：不占位（仍不影响回合边界——边界由 stopReason 兜底）
			if (!content.trim()) continue;
			const customType = readString(parsed, "customType") ?? placements[i].entry.customType;
			cards.push({
				offset: placements[i].offset,
				card: {
					// 与投影消息同一套合成 id 风格；条目 id 稳定，跨页不重复
					id: `${agentId}-custom-${placements[i].entry.id}`,
					agentId,
					role: "system",
					text: content,
					timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
					meta: {
						type: "customMessage",
						...(customType ? { customType } : {}),
						display: placements[i].entry.customDisplay === true,
						entryId: placements[i].entry.id,
					},
				},
			});
		}
		return cards;
	}

	/**
	 * 压缩卡片在 activeMessageEntries 绝对下标空间里的插入点（无压缩条目时 undefined）。
	 *
	 * firstKeptEntryId 优先，缺省回退「压缩条目之后的消息数」。抽成单一入口是因为
	 * 加载窗口/轮次页的压缩卡片与通知卡片共用同一空间：两边各算一次偏移，迟早错位。
	 */
	resolveCompactionInsertOffset(index: SessionDisplayIndex): number | undefined {
		const lastCompaction = index.activeBranch.findLast((entry) => entry.type === "compaction");
		if (!lastCompaction) return undefined;
		const firstKeptPos = lastCompaction.firstKeptEntryId ? index.activeMessageEntries.findIndex((entry) => entry.id === lastCompaction.firstKeptEntryId) : -1;
		if (firstKeptPos >= 0) return firstKeptPos;
		const lastCompactionIndex = index.activeBranch.findIndex((entry) => entry.id === lastCompaction.id);
		if (lastCompactionIndex < 0) return index.activeMessageEntries.length;
		return index.activeBranch.slice(0, lastCompactionIndex + 1).filter((entry) => entry.type === "message" && entry.hasMessage).length;
	}

	/**
	 * 把通知卡片按绝对下标插进窗口消息。
	 *
	 * `compactionInsertOffset` 给定时说明本窗口还插了一张压缩卡片：卡片在数组里占位、
	 * 但不消耗条目下标，所以落在它之后的通知要 +1 补偿，否则会错位一格。
	 * （是否真的插了压缩卡片按消息 meta 实判，避免依赖调用方的假设。）
	 */
	applyCustomMessageCards(messages: ChatMessage[], cards: Array<{ offset: number; card: ChatMessage }>, windowEntries: ReadonlyArray<{ role?: string }>, windowStart: number, compactionInsertOffset?: number): ChatMessage[] {
		if (cards.length === 0) return messages;
		const hasCompactionCard = messages.some((message) => message.meta?.type === "compaction");
		return spliceCardsByOffset(messages, cards, (offset) => {
			const afterCompaction = hasCompactionCard && compactionInsertOffset !== undefined && offset >= compactionInsertOffset;
			return messageIndexFromEntryOffset(windowEntries, offset, windowStart) + (afterCompaction ? 1 : 0);
		});
	}

	/**
	 * 把最近一次压缩摘要插进 rawMessages（与离线 Viewer / loadMessages 同一插入点）。
	 * compactionSummary 不消费 entryId 槽位，插在 firstKeptEntryId 之前。
	 * windowStart = rawMessages 在 activeMessageEntries 里的起始下标（全量传 0）。
	 */
	insertCompactionSummaryRaw(index: SessionDisplayIndex, rawMessages: unknown[], windowStart: number): unknown[] {
		const lastCompaction = index.activeBranch.findLast((entry) => entry.type === "compaction");
		if (!lastCompaction) return rawMessages;
		// 与压缩页/通知卡片共用同一偏移口径（firstKeptEntryId 优先，回退压缩条目后的消息数）；
		// rawMessages 是窗口切片，绝对下标要减 windowStart 再 clamp（插在全量分支也成立）。
		const absoluteInsertAt = this.resolveCompactionInsertOffset(index) ?? windowStart + rawMessages.length;
		const insertAt = Math.min(Math.max(absoluteInsertAt - windowStart, 0), rawMessages.length);
		const card = {
			role: "compactionSummary",
			summary: lastCompaction.summary || this.host.translate("session.summaryPlaceholder"),
			timestamp: lastCompaction.timestamp ? Date.parse(lastCompaction.timestamp) : Date.now(),
			meta: {
				compactionId: lastCompaction.id,
				compactionCount: index.activeBranch.filter((entry) => entry.type === "compaction").length,
				firstKeptEntryId: lastCompaction.firstKeptEntryId,
				tokensBefore: lastCompaction.tokensBefore,
			},
		};
		return [...rawMessages.slice(0, insertAt), card, ...rawMessages.slice(insertAt)];
	}

	/**
	 * 压缩会话分页的消息转换：与 normal 分支同空间（页条目 → 原始消息 → 转换）。
	 * 页内包含压缩插入点时补一张压缩卡片（与 readSessionDisplayMessages 同语义：
	 * 卡片落在 firstKeptEntryId 之前，即归档消息之后、保留消息之前；卡片在页外不插）。
	 * 卡片 id 对齐 projector 的 `${agentId}-meta-N` 输出，保证与运行时窗口卡片去重一致。
	 */
	async convertCompactionPageMessages(index: SessionDisplayIndex, agentId: string, rawMessages: unknown[], entryIds: string[], start: number, windowEntries: ReadonlyArray<SessionDisplayEntry>): Promise<ChatMessage[]> {
		const messages = this.host.convertMessages(agentId, rawMessages, entryIds);
		const compactions = index.activeBranch.filter((entry) => entry.type === "compaction");
		const lastCompaction = compactions[compactions.length - 1];
		if (!lastCompaction) return messages;
		// insertAt（全量 activeMessageEntries 下标空间）：firstKeptEntryId 优先，
		// 缺省回退「压缩条目之后的消息数」（与 readSessionDisplayMessages 一致）。
		let insertAt = lastCompaction.firstKeptEntryId ? index.activeMessageEntries.findIndex((entry) => entry.id === lastCompaction.firstKeptEntryId) : -1;
		if (insertAt < 0) {
			const compIdx = index.activeBranch.findIndex((entry) => entry.id === lastCompaction.id);
			insertAt = compIdx >= 0 ? index.activeBranch.slice(0, compIdx + 1).filter((entry) => entry.type === "message" && entry.hasMessage).length : index.activeMessageEntries.length;
		}
		// 页外判断用条目空间；映射到消息数组下标必须跳过 system 等非角色条目
		// （0.86：它们不生成 ChatMessage），否则卡片整体后移或被挤到页尾。
		if (insertAt < start || insertAt > start + windowEntries.length) return messages; // 卡片在本页之外
		const rel = messageIndexFromEntryOffset(windowEntries, insertAt, start);
		const card: ChatMessage = {
			id: `${agentId}-meta-1`,
			agentId,
			role: "system",
			text: lastCompaction.summary || this.host.translate("session.summaryPlaceholder"),
			timestamp: lastCompaction.timestamp ? Date.parse(lastCompaction.timestamp) : Date.now(),
			meta: {
				type: "compaction",
				tokensBefore: lastCompaction.tokensBefore,
				...(compactions.length > 0 ? { compactionCount: compactions.length } : {}),
			},
		};
		return [...messages.slice(0, rel), card, ...messages.slice(rel)];
	}
}
