import { open, readFile, stat } from "node:fs/promises";
import type { ChatMessage, ImageContent, PiSubagentEntry, SessionMessagePage, SessionTodoSnapshot } from "../../shared/types";
import { parseTodoSnapshotData } from "../../shared/sessionTodo";
import { deriveToolSubagentEntries } from "./derivedSubagents";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { RpcResponse } from "./PiRpcClient";
import type { AppLogger } from "../logging/AppLogger";

type SessionModelSelection = {
	provider: string;
	modelId: string;
};

type SessionHistoryMetadata = {
	model?: SessionModelSelection;
	thinkingLevel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

type SessionDisplayEntry = {
	id: string;
	parentId: string | null;
	type: string;
	offset: number;
	byteLength: number;
	hasMessage: boolean;
	/** model_change 的字段；模型回退按活动分支在 finishIndex() 中计算 */
	modelChangeProvider?: string;
	modelChangeId?: string;
	/** assistant 消息上的旧格式 provider/model 回退字段 */
	assistantModel?: SessionModelSelection;
	/** thinking_level_change 的最后值候选 */
	thinkingLevel?: string;
	/** custom 条目的 customType（subagents:record / pi-deck-todo 等）：按类型过滤时免读行 */
	customType?: string;
	/** 消息角色（user/assistant/…）：轮次分页按 user 消息切轮次边界，建索引时顺手捕获 */
	role?: string;
	/** 消息条目的 message.id：编辑/删除/重发缓存未命中时按 messageId 定位文件条目 */
	messageId?: string;
	summary?: string;
	firstKeptEntryId?: string;
	timestamp?: string;
	tokensBefore?: number;
};

type SessionDisplayIndex = {
	hostPath: string;
	size: number;
	mtimeMs: number;
	hasCompaction: boolean;
	/** 全量条目表（含非活跃分支）：增量追加与 fork/rewind 回溯用 */
	entries: Map<string, SessionDisplayEntry>;
	/** 活动分支（含 compaction 等非消息条目）：从最后 entry 沿 parentId 回溯 */
	activeBranch: SessionDisplayEntry[];
	/** 活动分支中的消息条目（分页/轮次计算用，派生自 activeBranch） */
	activeMessageEntries: SessionDisplayEntry[];
	/** 活动分支模型与思考档位；与索引一起生成，避免历史页读取后再次扫描摘要 */
	metadata: SessionHistoryMetadata;
	/** 构建时文件是否以完整行（\n）结尾：false 时禁止增量追加（旧最后一行可能被拼接污染） */
	endsWithNewline: boolean;
};

export type SessionArchiveData = {
	compactions: Array<{
		id: string;
		summary: string;
		timestamp: string;
		firstKeptEntryId?: string;
		tokensBefore?: number;
	}>;
};

export type SessionHistoryReaderDeps = {
	toHostPath: (sessionPath: string) => string;
	convertMessages: (
		agentId: string,
		rawMessages: unknown[],
		activeEntryIds?: string[],
	) => ChatMessage[];
	trimMessages: (rawMessages: unknown[], maxTurns?: number) => unknown[];
	translate: (
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	) => string;
	logger?: Pick<AppLogger, "info" | "warn">;
};

/**
 * 轮次分页起点计算（纯函数，2026-08 激活分页）。
 *
 * 业界 turn 定义（发言权周期）：一轮 = 用户连续发言（可连发多条 user）→
 * AI 回应周期（assistant/tool/thinking 任意组合，直到下一条用户发言）。
 * 因此 turn 起点 = role==="user" 且「跳过中间的杂项消息（system/error/卡片）后，
 * 前一条真实消息不是 user」——连发 user 只有第一条是起点，其余并入同一轮；
 * 纯 user 无回复的会话整体算一轮（用户还没拿到回应，发言权未交还）。
 * 页边界永远对齐完整轮（折叠不会被切成半个回答）。
 *
 * 2026-09 统一轮次协议：字节预算已删除——单轮再大也整轮保留，
 * 页大小只以轮数计（用户看历史就是要看完整一轮，不静默丢内容）。
 */
export function findTurnPageStart(
	entries: ReadonlyArray<{ role?: string; byteLength: number }>,
	before: number,
	turnCount: number,
): number {
	if (before <= 0 || turnCount < 1) return 0;
	// 预扫描 turn 起点（一次遍历，规则见上方注释）：
	// 起点 = user 且其前最近的 user/assistant 边界不是 user。
	const turnStartFlags = new Array<boolean>(before).fill(false);
	let prevUserOrAssistantRole: "user" | "assistant" | undefined;
	for (let i = 0; i < before; i += 1) {
		const role = entries[i].role;
		if (role === "user") {
			// 连发 user：只有前一条是 assistant（或无实质消息）时才算新轮起点。
			if (prevUserOrAssistantRole !== "user") turnStartFlags[i] = true;
			prevUserOrAssistantRole = "user";
		} else if (role === "assistant") {
			prevUserOrAssistantRole = "assistant";
		}
		// system/error/toolResult 等其他 role：不改变边界（发言权仍归上一方）。
	}

	// 从 before-1 向前数第 turnCount 个 turn 起点
	let turnsSeen = 0;
	let start = 0;
	for (let i = before - 1; i >= 0; i -= 1) {
		if (!turnStartFlags[i]) continue;
		turnsSeen += 1;
		if (turnsSeen === turnCount) {
			start = i;
			break;
		}
	}
	// 不足 turnCount 轮：从会话头起（开头的 system/碎片消息归入首轮）
	if (turnsSeen < turnCount) start = 0;
	// 起点之前已无 user 消息（落在首个轮次起点）：开头碎片并入本页，避免碎片单独成页
	else {
		let hasEarlierUser = false;
		for (let i = 0; i < start; i += 1) {
			if (entries[i].role === "user") { hasEarlierUser = true; break; }
		}
		if (!hasEarlierUser) start = 0;
	}
	return start;
}

/**
 * 从 pi 消息 content 提取「重发」回填内容：string 或 blocks 数组（text/image）。
 * 图片块格式：{ type: "image", source: { type: "base64", media_type, data } }。
 */
function extractResendContent(content: unknown): { text: string; images?: ImageContent[] } {
	if (typeof content === "string") return { text: content };
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		const images: ImageContent[] = [];
		for (const block of content) {
			const typed = block as {
				type?: string;
				text?: string;
				source?: { type?: string; media_type?: string; data?: string };
			} | null;
			if (!typed || typeof typed !== "object") continue;
			if (typed.type === "text" && typeof typed.text === "string") {
				textParts.push(typed.text);
			} else if (
				typed.type === "image" &&
				typed.source?.type === "base64" &&
				typeof typed.source.data === "string"
			) {
				images.push({
					type: "image",
					mimeType: typeof typed.source.media_type === "string" ? typed.source.media_type : "image/png",
					data: typed.source.data,
				});
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
function syntheticHistoryEntryId(messageId: string): string | undefined {
	const marker = "-history-";
	const index = messageId.lastIndexOf(marker);
	if (index < 0) return undefined;
	const entryId = messageId.slice(index + marker.length);
	return entryId || undefined;
}

function deriveSessionHistoryMetadata(
	activeBranch: readonly SessionDisplayEntry[],
): SessionHistoryMetadata {
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

	const model = modelProvider && modelId
		? { provider: modelProvider, modelId }
		: lastAssistantModel;
	if (thinkingLevel === undefined && model) thinkingLevel = "off";

	return {
		...(model ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	};
}

/**
 * Reads persisted Session JSONL without starting Pi. Runtime ownership remains in
 * AgentManager; this reader owns bounded display paging and compaction recovery.
 */
export class SessionHistoryReader {
	private readonly sessionDisplayIndexes = new Map<string, SessionDisplayIndex>();
	private static readonly SESSION_DISPLAY_INDEX_LIMIT = 32;
	/** 全量重建时每隔这么多行让出事件循环，避免几十 MB JSONL 同步 parse 卡死主进程。 */
	private static readonly INDEX_PARSE_YIELD_EVERY = 400;
	/** 完整消息文本 LRU 缓存（「查看完整输出」按需读取结果）：键 `${sessionPath}#${messageId}`。 */
	private readonly fullTextCache = new Map<string, string>();
	private static readonly FULL_TEXT_CACHE_LIMIT = 200;
	/**
	 * 轮次分页预取缓存（2026-09 上滚丝滑）：disk 路径翻页时在后台读取下一页
	 * 并暂存（键含文件版本/游标/页大小，pi 追加消息后自动失效），用户继续上滚时
	 * 命中缓存免磁盘 IO。只在「上一页已返回且还有下一页」时预取一页，不连锁递归。
	 */
	private readonly prefetchCache = new Map<string, SessionMessagePage>();
	private static readonly PREFETCH_CACHE_LIMIT = 2;
	/** 轮次分页默认/上限：默认最近一次激活带 3 轮，单页最多 10 轮（防恶意参数撑爆 IPC） */
	static readonly DEFAULT_TURN_PAGE_SIZE = 3;
	private static readonly MAX_TURN_PAGE_SIZE = 10;
	/**
	 * 子代理 start 锚点条目类型：pi-deck-subagents 桥接扩展在 subagents:created 时
	 * 落盘（写入侧见 resources/extensions/pi-deck-subagents.ts 的 START_ENTRY_TYPE）。
	 * 残留锚点（无更晚 record 覆盖）合成 stopped 条目，保留被重启终止子代理的审计痕迹。
	 */
	private static readonly SUBAGENT_START_ENTRY = "pi-deck-subagent-start";

	/** 单页轮次上限（AgentManager 缓存优先路径复用，避免翻页超预算） */
	static maxTurnPageSize(): number {
		return SessionHistoryReader.MAX_TURN_PAGE_SIZE;
	}

	constructor(private readonly deps: SessionHistoryReaderDeps) {}

	/**
	 * 不启动 pi 进程，直接从 JSONL 构造与运行态相同的时间线数据。
	 * Viewer 必须复用 AgentManager 的压缩归档与消息转换规则，避免维护第二套显示模型。
	 */
	async readMessageFullText(
		sessionPath: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		const cacheKey = `${sessionPath}#${messageId}`;
		const cached = this.fullTextCache.get(cacheKey);
		if (cached !== undefined) {
			// LRU 刷新：先删后插，保持 Map 迭代序 = 最近使用序
			this.fullTextCache.delete(cacheKey);
			this.fullTextCache.set(cacheKey, cached);
			return { text: cached };
		}
		// 走会 yield 的显示索引 + offset 读单行，禁止整文件 split+JSON.parse。
		const index = await this.getSessionDisplayIndex(sessionPath);
		const syntheticId = syntheticHistoryEntryId(messageId);
		const entry = index.activeMessageEntries.find((candidate) => {
			if (entryId && candidate.id === entryId) return true;
			if (candidate.messageId === messageId || candidate.id === messageId) return true;
			return syntheticId !== undefined && candidate.id === syntheticId;
		});
		if (!entry) {
			throw new Error(`Message ${messageId} not found in session file`);
		}
		const raw = await this.readIndexedSessionMessages(index.hostPath, [entry]);
		const text = extractEntryResultText(raw[0]);
		if (!text) {
			throw new Error(`Message ${messageId} has no extractable text content`);
		}
		if (this.fullTextCache.size >= SessionHistoryReader.FULL_TEXT_CACHE_LIMIT) {
			const oldest = this.fullTextCache.keys().next().value;
			if (oldest !== undefined) this.fullTextCache.delete(oldest);
		}
		this.fullTextCache.set(cacheKey, text);
		return { text };
	}

	async readSessionDisplayMessages(
		sessionPath: string,
		agentId = "_viewer",
		sessionContent?: string,
	): Promise<ChatMessage[]> {
		// 调用方未把全文放进内存时必须走会 yield 的索引 + offset 读，
		// 否则离线 Viewer 打开大会话会整文件 split+JSON.parse，主进程照样卡死。
		if (sessionContent === undefined) {
			const index = await this.getSessionDisplayIndex(sessionPath);
			const entries = index.activeMessageEntries;
			const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
			const entryIds = entries.map((entry) => entry.id);
			const finalRaw = this.insertCompactionSummaryRaw(index, rawMessages);
			return this.deps.convertMessages(agentId, finalRaw, entryIds);
		}
		const content = sessionContent;
		const entries: Array<{
			id: string;
			parentId: string | null;
			type: string;
			message?: unknown;
			summary?: string;
			firstKeptEntryId?: string;
			tokensBefore?: number;
			timestamp?: string;
		}> = [];

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
				entries.push({
					id: entry.id,
					parentId: typeof entry.parentId === "string" ? entry.parentId : null,
					type: typeof entry.type === "string" ? entry.type : "",
					message: entry.message,
					summary: typeof entry.summary === "string" ? entry.summary : undefined,
					firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
					tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				});
			} catch {
				// 单行损坏不应阻断整个 Viewer。
			}
		}
		if (entries.length === 0) return [];

		// JSONL 最后一个 entry 是 pi 当前叶节点；沿 parentId 回溯得到与 get_messages 一致的活动分支。
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const activeBranch: typeof entries = [];
		const seen = new Set<string>();
		let current: (typeof entries)[number] | undefined = entries[entries.length - 1];
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			activeBranch.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		activeBranch.reverse();

		const lastCompactionIndex = activeBranch.findLastIndex((entry) => entry.type === "compaction");
		const lastCompaction = lastCompactionIndex >= 0 ? activeBranch[lastCompactionIndex] : undefined;
		// 活动分支包含压缩点之前的全部消息（JSONL 保留完整历史）：
		// 压缩前历史直接作为正常对话流的一部分，由渲染层分页（往上翻）逐条可见；
		// 压缩卡片单独 prepend 在最前，翻页补前缀时自然落在归档消息之后（压缩点位置）。
		const currentEntries = activeBranch
			.filter((entry) => entry.type === "message" && entry.message);
		const rawMessages = currentEntries.map((entry) => entry.message);
		// Offline Session viewers must expose the complete active branch. The runtime
		// prompt-history cap belongs to Agent startup, while renderer pagination owns
		// how much of a historical Session is rendered at one time.
		const activeEntryIds = currentEntries.map((entry) => entry.id);

		let finalRaw: unknown[] = rawMessages;
		if (lastCompaction) {
			const compactionEntry = lastCompaction;
			// 压缩卡片只带元信息（摘要/次数/tokens）；归档消息全文由分页翻出，不注入内存
			const archiveData = await this.scanCompactions(sessionPath, content);
			const card = {
				role: "compactionSummary",
				summary: compactionEntry.summary || this.deps.translate("session.summaryPlaceholder"),
				timestamp: compactionEntry.timestamp ? Date.parse(compactionEntry.timestamp) : Date.now(),
				meta: {
					compactionId: compactionEntry.id,
					compactionCount: archiveData.compactions.length,
					firstKeptEntryId: compactionEntry.firstKeptEntryId,
					tokensBefore: compactionEntry.tokensBefore,
				},
			};
			// 卡片插在压缩点：firstKeptEntryId（保留起点）之前，即归档消息之后、保留消息之前；
			// 找不到锚点则插到压缩条目之后（activeBranch 中紧随其后的消息）。
			const firstKeptPos = compactionEntry.firstKeptEntryId
				? currentEntries.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId)
				: -1;
			const insertAt = firstKeptPos >= 0
				? firstKeptPos
				: lastCompactionIndex >= 0 && lastCompactionIndex < activeBranch.length
					? activeBranch.slice(0, lastCompactionIndex + 1).filter((entry) => entry.type === "message" && entry.message).length
					: rawMessages.length;
			finalRaw = [...rawMessages.slice(0, insertAt), card, ...rawMessages.slice(insertAt)];
		}

		return this.deps.convertMessages(agentId, finalRaw, activeEntryIds);
	}

	/**
	 * 轮次维度的显示分页：游标仍使用活动分支消息下标，页边界对齐完整轮次。
	 * 这样无论历史会话是否已经启动 Agent，时间线都不会切开一个 user/assistant 回合。
	 *
	 * 2026-09 上滚丝滑：读页后后台预取下一页存入 prefetchCache（LRU 2 页），
	 * 连续上滚时命中缓存零磁盘 IO；pi 持续追加消息时键版本失效自动重建。
	 */
	async readSessionDisplayTurnPage(
		sessionPath: string,
		agentId = "_viewer",
		before?: number,
		turnCount = SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE,
		beforeEntryId?: string,
	): Promise<SessionMessagePage> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		// beforeEntryId：渲染层以「运行时窗口首条消息的 entryId」作为首次补历史的游标，
		// 解析为该 entry 在活跃分支的绝对下标（运行时窗口与 JSONL 是两个下标空间，
		// entryId 是唯一的对齐锚点）。解析失败回退为 undefined（= 从尾部起页）。
		let resolvedBefore = before;
		if (beforeEntryId) {
			const position = index.activeMessageEntries.findIndex((entry) => entry.id === beforeEntryId);
			if (position >= 0) resolvedBefore = position;
		}
		const boundedBefore = Number.isSafeInteger(resolvedBefore)
			? Math.min(Math.max(0, resolvedBefore!), total)
			: total;
		const boundedTurnCount = Number.isFinite(turnCount)
			? Math.min(Math.max(1, Math.floor(turnCount)), SessionHistoryReader.MAX_TURN_PAGE_SIZE)
			: SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE;

		// 预取命中：直接返回缓存页（键 = 文件版本 + 游标 + 页大小，版本变化即失效）。
		const prefetchKey = this.buildPrefetchKey(sessionPath, index, boundedBefore, boundedTurnCount);
		if (prefetchKey) {
			const cached = this.prefetchCache.get(prefetchKey);
			if (cached) {
				// LRU 刷新：先删后插保持 Map 迭代序 = 最近使用序。
				this.prefetchCache.delete(prefetchKey);
				this.prefetchCache.set(prefetchKey, cached);
				return cached;
			}
		}

		const page = await this.readTurnPageCore(index, agentId, boundedBefore, boundedTurnCount);
		// 预取下一页（仅当还有更早历史）——不阻塞当前请求、失败静默。
		this.enqueuePrefetch(page, sessionPath, index, boundedTurnCount);
		return page;
	}

	/**
	 * 读单页核心实现（无缓存、不触发预取）：预取调用本方法而非公共分页方法，
	 * 保证「预取不再触发预取」，避免连锁递归读盘。
	 */
	private async readTurnPageCore(
		index: SessionDisplayIndex,
		agentId: string,
		boundedBefore: number,
		boundedTurnCount: number,
	): Promise<SessionMessagePage> {
		const total = index.activeMessageEntries.length;
		const start = findTurnPageStart(
			index.activeMessageEntries,
			boundedBefore,
			boundedTurnCount,
		);

		// 与普通轮次页一致：压缩会话的归档语义未游标化前走索引切片
		if (index.hasCompaction) {
			// 同一索引空间：索引切片 + 转换 + 页内卡片。
			const entries = index.activeMessageEntries.slice(start, boundedBefore);
			const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
			const messages = await this.convertCompactionPageMessages(
				index, agentId, rawMessages, entries.map((entry) => entry.id), start,
			);
			return {
				messages,
				total,
				nextBefore: start > 0 ? start : null,
				nextBeforeEntryId: start > 0 ? index.activeMessageEntries[start]?.id : undefined,
				indexVersion: `${index.mtimeMs}:${index.size}`,
				...index.metadata,
			};
		}

		const entries = index.activeMessageEntries.slice(start, boundedBefore);
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
		return {
			messages: this.deps.convertMessages(agentId, rawMessages, entries.map((entry) => entry.id)),
			total,
			nextBefore: start > 0 ? start : null,
			nextBeforeEntryId: start > 0 ? index.activeMessageEntries[start]?.id : undefined,
			indexVersion: `${index.mtimeMs}:${index.size}`,
			...index.metadata,
		};
	}

	/**
	 * 预取页缓存键：文件版本 + 页码游标 + 页大小。版本变化（pi 追加/外部重写）自动失效；
	 * 无文件（匿名会话）返回 undefined（不缓存也不预取）。
	 */
	private buildPrefetchKey(
		sessionPath: string,
		index: SessionDisplayIndex,
		before: number,
		turnCount: number,
	): string | undefined {
		if (!index.hostPath) return undefined;
		return `${sessionPath}|${index.mtimeMs}:${index.size}|${before}|${turnCount}`;
	}

	/**
	 * 后台预取下一页：当前页还有更早历史（nextBefore 非 null）时读取下一页
	 * 并存入 LRU（上限 PREFETCH_CACHE_LIMIT 页）。失败静默——预取是优化不是功能。
	 * 只预取一页不连锁（下一页到达时不再次触发预取），避免无限递归读盘。
	 */
	private enqueuePrefetch(
		page: SessionMessagePage,
		sessionPath: string,
		index: SessionDisplayIndex,
		turnCount: number,
	): void {
		if (page.nextBefore === null || page.nextBefore <= 0) return;
		const nextKey = this.buildPrefetchKey(sessionPath, index, page.nextBefore, turnCount);
		if (!nextKey || this.prefetchCache.has(nextKey)) return;
		// 后台读，不阻塞当前请求；单错不传播（预取失败下次点击仍可正常读盘）。
		// 走 readTurnPageCore 而不是公共分页方法：预取不再触发预取（无连锁递归）。
		void this.readTurnPageCore(
			index,
			"_prefetch",
			page.nextBefore,
			turnCount,
		).then((nextPage) => {
			this.prefetchCache.delete(nextKey);
			this.prefetchCache.set(nextKey, nextPage);
			this.trimPrefetchCache();
		}).catch(() => undefined);
	}

	/** 预取缓存 LRU 裁剪：超出上限丢最旧（Map 迭代序 = 插入序）。 */
	private trimPrefetchCache(): void {
		while (this.prefetchCache.size > SessionHistoryReader.PREFETCH_CACHE_LIMIT) {
			this.prefetchCache.delete(this.prefetchCache.keys().next().value!);
		}
	}

	/** entryId → 活动分支消息条目的绝对下标（文件下标空间）；不存在返回 undefined。 */
	async resolveEntryPosition(sessionPath: string, entryId: string): Promise<number | undefined> {
		if (!entryId) return undefined;
		const index = await this.getSessionDisplayIndex(sessionPath);
		const position = index.activeMessageEntries.findIndex((entry) => entry.id === entryId);
		return position >= 0 ? position : undefined;
	}

	/** 绝对下标（文件下标空间）→ entryId；越界/无条目返回 undefined。 */
	async resolveEntryIdAtPosition(sessionPath: string, position: number): Promise<string | undefined> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const entry = index.activeMessageEntries[position];
		return entry?.id;
	}

	/** 活动分支消息条目总数（SessionMessagePage.total 的文件口径）。 */
	async getActiveEntryCount(sessionPath: string): Promise<number> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		return index.activeMessageEntries.length;
	}

	/** 返回与当前历史索引一致的模型/思考元数据，调用方不得再次扫描 JSONL 摘要。 */
	async readSessionMetadata(sessionPath: string): Promise<SessionHistoryMetadata> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		return index.metadata;
	}

	/**
	 * 当前 JSONL 活动分支 leaf（最后一条带 id 的记录，含墓碑）。
	 * 编辑/删除/重发必须与 loadMessages 同口径：不要再走 get_entries，
	 * RPC leaf 可能与文件活动分支不一致，大历史还会把整棵 entry 树打成单行 JSON 冻窗。
	 */
	async getActiveLeafId(sessionPath: string): Promise<string | undefined> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const leaf = index.activeBranch.at(-1);
		return leaf?.id;
	}

	/**
	 * 取活动分支末尾 `messageCount` 条消息的 entryId（与 JSONL 尾部窗口一一对应）。
	 * loadMessages 用它代替 get_entries：pi 会把整棵 entry 树打成单行 JSON，同步 parse 会冻窗。
	 */
	async getRecentActiveEntryIds(sessionPath: string, messageCount: number): Promise<string[]> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		const count = Number.isFinite(messageCount) && messageCount > 0
			? Math.min(Math.floor(messageCount), total)
			: 0;
		if (count <= 0) return [];
		return index.activeMessageEntries.slice(total - count).map((entry) => entry.id);
	}

	/**
	 * 把最近一次压缩摘要插进 rawMessages（与离线 Viewer / loadMessages 同一插入点）。
	 * compactionSummary 不消费 entryId 槽位，插在 firstKeptEntryId 之前。
	 */
	private insertCompactionSummaryRaw(
		index: SessionDisplayIndex,
		rawMessages: unknown[],
	): unknown[] {
		const lastCompaction = index.activeBranch.findLast((entry) => entry.type === "compaction");
		if (!lastCompaction) return rawMessages;
		const firstKeptPos = lastCompaction.firstKeptEntryId
			? index.activeMessageEntries.findIndex((entry) => entry.id === lastCompaction.firstKeptEntryId)
			: -1;
		const lastCompactionIndex = index.activeBranch.findIndex((entry) => entry.id === lastCompaction.id);
		const insertAt = firstKeptPos >= 0
			? firstKeptPos
			: lastCompactionIndex >= 0
				? index.activeBranch.slice(0, lastCompactionIndex + 1)
					.filter((entry) => entry.type === "message" && entry.hasMessage).length
				: rawMessages.length;
		const card = {
			role: "compactionSummary",
			summary: lastCompaction.summary || this.deps.translate("session.summaryPlaceholder"),
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
	private async convertCompactionPageMessages(
		index: SessionDisplayIndex,
		agentId: string,
		rawMessages: unknown[],
		entryIds: string[],
		start: number,
	): Promise<ChatMessage[]> {
		const messages = this.deps.convertMessages(agentId, rawMessages, entryIds);
		const compactions = index.activeBranch.filter((entry) => entry.type === "compaction");
		const lastCompaction = compactions[compactions.length - 1];
		if (!lastCompaction) return messages;
		// insertAt（全量 activeMessageEntries 下标空间）：firstKeptEntryId 优先，
		// 缺省回退「压缩条目之后的消息数」（与 readSessionDisplayMessages 一致）。
		let insertAt = lastCompaction.firstKeptEntryId
			? index.activeMessageEntries.findIndex((entry) => entry.id === lastCompaction.firstKeptEntryId)
			: -1;
		if (insertAt < 0) {
			const compIdx = index.activeBranch.findIndex((entry) => entry.id === lastCompaction.id);
			insertAt = compIdx >= 0
				? index.activeBranch.slice(0, compIdx + 1).filter((entry) => entry.type === "message" && entry.hasMessage).length
				: index.activeMessageEntries.length;
		}
		const rel = insertAt - start;
		if (rel < 0 || rel > messages.length) return messages; // 卡片在本页之外
		const card: ChatMessage = {
			id: `${agentId}-meta-1`,
			agentId,
			role: "system",
			text: lastCompaction.summary || this.deps.translate("session.summaryPlaceholder"),
			timestamp: lastCompaction.timestamp ? Date.parse(lastCompaction.timestamp) : Date.now(),
			meta: {
				type: "compaction",
				tokensBefore: lastCompaction.tokensBefore,
				...(compactions.length > 0 ? { compactionCount: compactions.length } : {}),
			},
		};
		return [...messages.slice(0, rel), card, ...messages.slice(rel)];
	}

	/** 会话文件版本（mtime:size），与分页页面 indexVersion 同口径；供缓存命中页透传。 */
	async getSessionIndexVersion(sessionPath: string): Promise<string> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		return `${index.mtimeMs}:${index.size}`;
	}

	/**
	 * 按 messageId 在活动分支定位消息条目并读出其正文（编辑/删除/重发缓存未命中时的文件定位）。
	 * 返回 entryId（SessionFileEditor 精确定位锚点）+ 正文文本/图片（重发回填用）。
	 */
	async readMessageByMessageId(
		sessionPath: string,
		messageId: string,
		/** 渲染层消息携带的文件条目 id（meta.entryId）。流式期间消息 id 是 live randomUUID，
		 * 文件里没有对应关系；而投影后的消息带 entryId，必须优先按它定位，否则编辑/删除
		 * 会落空（delete 走 no-op、edit/resend 报 Message not found）。 */
		entryIdHint?: string,
	): Promise<{ entryId: string; role?: string; text: string; images?: ImageContent[] } | undefined> {
		if (!messageId) return undefined;
		let index: SessionDisplayIndex;
		try {
			index = await this.getSessionDisplayIndex(sessionPath);
		} catch (error) {
			// 生图 draft 会话在 catalog 里有 filePath 但从不落盘 pi JSONL（历史由 ImageSessionStore 兜底），
			// stat 不存在的文件会抛 ENOENT。重发/编辑/删除针对的是「会话里的消息」，文件不存在 = 消息不在文件里，
			// 按未命中处理（delete 走 no-op、edit/resend 走 MESSAGE_NOT_FOUND），而不是对外抛 ENOENT 崩溃。
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
				void this.deps.logger?.warn("session-history", "Message lookup on missing session file", {
					sessionPath,
					messageId,
				});
				return undefined;
			}
			throw error;
		}
		// 兼容三种命中：JSONL 原生 message.id、渲染层合成 ID（agentId-history-entryId）、
		// 裸 entryId（旧会话无 message.id 时渲染 ID 即 `${agentId}-history-${entryId}`）。
		// entryIdHint 优先：live 随机 ID 在文件里必然不存在，直接按文件条目 id 锚定。
		const syntheticId = syntheticHistoryEntryId(messageId);
		const entry = index.activeMessageEntries.find(
			(candidate) =>
				(entryIdHint !== undefined && candidate.id === entryIdHint) ||
				candidate.messageId === messageId ||
				candidate.id === messageId ||
				(syntheticId !== undefined && candidate.id === syntheticId),
		);
		if (!entry) return undefined;
		const raw = await this.readIndexedSessionMessages(index.hostPath, [entry]);
		const content = (raw[0] as { content?: unknown } | undefined)?.content;
		const extracted = extractResendContent(content);
		return {
			entryId: entry.id,
			role: entry.role,
			text: extracted.text,
			...(extracted.images?.length ? { images: extracted.images } : {}),
		};
	}

	private async getSessionDisplayIndex(sessionPath: string): Promise<SessionDisplayIndex> {
		const hostPath = this.deps.toHostPath(sessionPath);
		const version = await stat(hostPath);
		const cached = this.sessionDisplayIndexes.get(hostPath);
		if (cached && cached.size === version.size && cached.mtimeMs === version.mtimeMs) {
			this.sessionDisplayIndexes.delete(hostPath);
			this.sessionDisplayIndexes.set(hostPath, cached);
			return cached;
		}

		// 增量路径：文件变大且旧索引以完整行结尾 → 只读尾部新增字节并追加条目。
		// pi 运行中持续往 JSONL 追加行，运行中翻历史/看分页会反复触发索引失效；
		// 全量重建需要整文件 readFile + 逐行 parse，大会话（几十 MB）会造成可感知卡顿。
		// 前置条件 endsWithNewline：旧最后一行以 \n 结尾，追加内容与旧内容边界干净。
		if (cached && version.size > cached.size && cached.endsWithNewline) {
			const updated = await this.appendIndexFromTail(cached, hostPath, version);
			if (updated) {
				this.sessionDisplayIndexes.delete(hostPath);
				this.sessionDisplayIndexes.set(hostPath, updated);
				this.trimDisplayIndexCache();
				return updated;
			}
			// 增量失败（IO 异常/无新增完整行）：回退全量重建
		}

		const content = await readFile(hostPath, "utf8");
		const entries = new Map<string, SessionDisplayEntry>();
		let lastEntryId: string | undefined;
		let byteOffset = 0;
		// 文件是否以完整行（\n）结尾：决定后续 append 能否走增量索引
		const endsWithNewline = content.endsWith("\n");
		const lines = content.split("\n");
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const sourceLine = lines[lineIndex];
			const hasNewline = lineIndex < lines.length - 1;
			const byteLength = Buffer.byteLength(sourceLine, "utf8");
			const parsed = this.parseIndexLine(sourceLine, byteOffset, byteLength);
			if (parsed) {
				entries.set(parsed.id, parsed);
				lastEntryId = parsed.id;
			}
			byteOffset += byteLength + (hasNewline ? 1 : 0);
			// 大会话全量 rebuild 不能占满主线程：每 N 行让出一轮，IPC/窗口消息才能继续走。
			if ((lineIndex + 1) % SessionHistoryReader.INDEX_PARSE_YIELD_EVERY === 0) {
				await new Promise<void>((resolve) => {
					setImmediate(resolve);
				});
			}
		}
		const activeBranch = this.traceActiveBranch(entries, lastEntryId);
		const index = this.finishIndex(hostPath, version, entries, activeBranch, endsWithNewline);
		this.sessionDisplayIndexes.delete(hostPath);
		this.sessionDisplayIndexes.set(hostPath, index);
		this.trimDisplayIndexCache();
		return index;
	}

	/** 解析单行 JSONL 为索引条目；损坏行返回 null（不影响其他行）。 */
	private parseIndexLine(
		sourceLine: string,
		offset: number,
		byteLength: number,
	): SessionDisplayEntry | null {
		const jsonLine = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
		try {
			const parsed: unknown = JSON.parse(jsonLine);
			if (!isRecord(parsed) || typeof parsed.id !== "string") return null;
			const data = isRecord(parsed.data) ? parsed.data : undefined;
			const nestedMessage = isRecord(parsed.message)
				? parsed.message
				: data && isRecord(data.message)
					? data.message
					: undefined;
			const message = nestedMessage ?? (typeof parsed.role === "string" ? parsed : undefined);
			const type = typeof parsed.type === "string" ? parsed.type : "";
			const modelChangeProvider = type === "model_change"
				? readString(parsed, "provider") ?? readString(data, "provider")
				: undefined;
			const modelChangeId = type === "model_change"
				? readString(parsed, "modelId") ?? readString(data, "modelId")
				: undefined;
			const thinkingLevel = type === "thinking_level_change"
				? readString(parsed, "thinkingLevel") ?? readString(data, "thinkingLevel")
				: undefined;
			// custom 条目的 customType 在建索引时捕获：readSubagentRecords 等读者
			// 按 customType 过滤后只对目标行发起磁盘 IO，todo/om 等高频快照零读取。
			const customType = type === "custom" ? readString(parsed, "customType") : undefined;
			const assistantModel = message?.role === "assistant"
				? (() => {
					const provider = readString(message, "provider");
					const modelId = readString(message, "model");
					return provider && modelId ? { provider, modelId } : undefined;
				})()
				: undefined;
			return {
				id: parsed.id,
				parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
				type,
				customType,
				offset,
				byteLength,
				hasMessage: parsed.message !== undefined && parsed.message !== null,
				modelChangeProvider,
				modelChangeId,
				assistantModel,
				thinkingLevel,
				role: typeof message?.role === "string" ? message.role : undefined,
				messageId: typeof message?.id === "string" ? message.id : undefined,
				summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
				firstKeptEntryId: typeof parsed.firstKeptEntryId === "string"
					? parsed.firstKeptEntryId
					: undefined,
				timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
				tokensBefore: typeof parsed.tokensBefore === "number" ? parsed.tokensBefore : undefined,
			};
		} catch {
			return null;
		}
	}

	/** 从最后 entry 沿 parentId 回溯活动分支（与 JSONL 语义一致：leaf 沿父链到 root）。 */
	private traceActiveBranch(
		entries: Map<string, SessionDisplayEntry>,
		lastEntryId: string | undefined,
	): SessionDisplayEntry[] {
		const activeBranch: SessionDisplayEntry[] = [];
		const seen = new Set<string>();
		let current = lastEntryId ? entries.get(lastEntryId) : undefined;
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			activeBranch.push(current);
			current = current.parentId ? entries.get(current.parentId) : undefined;
		}
		activeBranch.reverse();
		return activeBranch;
	}

	/** 由分支 + 全量条目表组装最终索引（消息条目派生 + 压缩标记）。 */
	private finishIndex(
		hostPath: string,
		version: { size: number; mtimeMs: number },
		entries: Map<string, SessionDisplayEntry>,
		activeBranch: SessionDisplayEntry[],
		endsWithNewline: boolean,
	): SessionDisplayIndex {
		return {
			hostPath,
			size: version.size,
			mtimeMs: version.mtimeMs,
			// 分页索引包含压缩点之前的全部消息（JSONL 保留完整历史）：
			// 压缩前历史由翻页像正常对话流一样逐条可见（用户需求），不再从 firstKeptEntryId 截断。
			hasCompaction: activeBranch.some((entry) => entry.type === "compaction"),
			entries,
			activeBranch,
			activeMessageEntries: activeBranch.filter((entry) => entry.type === "message" && entry.hasMessage),
			metadata: deriveSessionHistoryMetadata(activeBranch),
			endsWithNewline,
		};
	}

	/**
	 * 增量索引：只读 [oldSize, newSize) 的新增字节，解析完整行后追加到既有索引。
	 * 新条目沿 parentId 回溯至旧分支节点（支持 fork/rewind 场景），旧分支保留。
	 * 返回 null 表示无可追加内容或 IO 失败（调用方回退全量重建）。
	 */
	private async appendIndexFromTail(
		cached: SessionDisplayIndex,
		hostPath: string,
		version: { size: number; mtimeMs: number },
	): Promise<SessionDisplayIndex | null> {
		const length = version.size - cached.size;
		if (length <= 0) return null;
		let tail: Buffer;
		try {
			const handle = await open(hostPath, "r");
			try {
				// 前置校验：SessionFileEditor.atomicReplace 会整文件重写（temp + rename），
				// 若重写使文件变大，仅凭 size 增长会被误判为 append，从旧 offset 读新内容会
				// 解析出半行 JSON（曾复现 SyntaxError: Unexpected token）。
				// 抽查旧索引首/末条目的 offset/byteLength 是否仍能解析出相同 id：
				// 纯 append 保证 [0, oldSize) 字节不变 → 校验通过；整文件重写必然破坏末条目（或首条目）
				// 的旧 offset 内容 → 返回 null，调用方回退全量重建。
				const entriesInOrder = [...cached.entries.values()];
				const probes = [entriesInOrder[0], entriesInOrder[entriesInOrder.length - 1]];
				for (const probe of probes) {
					if (!probe) continue;
					const probeBuffer = Buffer.allocUnsafe(probe.byteLength);
					const probeRead = await handle.read(probeBuffer, 0, probe.byteLength, probe.offset);
					if (probeRead.bytesRead !== probe.byteLength) return null;
					try {
						const parsed = JSON.parse(
							probeBuffer.toString("utf8").replace(/\r$/, ""),
						) as { id?: unknown };
						if (parsed.id !== probe.id) return null;
					} catch {
						return null;
					}
				}
				tail = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(tail, 0, length, cached.size);
				if (bytesRead !== length) return null;
			} finally {
				await handle.close();
			}
		} catch {
			return null;
		}
		const tailText = tail.toString("utf8");
		// 只解析完整行（以 \n 结尾）；尾部残行（pi 正在写）留给下一次 append/重建
		const completeLines = tailText.split("\n").slice(0, -1);
		const entries = new Map(cached.entries);
		const newEntries: SessionDisplayEntry[] = [];
		let byteOffset = cached.size;
		for (const sourceLine of completeLines) {
			const byteLength = Buffer.byteLength(sourceLine, "utf8");
			const parsed = this.parseIndexLine(sourceLine, byteOffset, byteLength);
			if (parsed) {
				entries.set(parsed.id, parsed);
				newEntries.push(parsed);
			}
			byteOffset += byteLength + 1; // 完整行必然带 \n
		}
		// 无新增完整行（文件还在写）：保持旧索引，下次 mtime 变化再试
		if (newEntries.length === 0) return null;

		// 从最后一个新条目沿 parentId 回溯到旧分支内的锚点；新链挂到锚点之后。
		const branchSet = new Set(cached.activeBranch.map((entry) => entry.id));
		const chain: SessionDisplayEntry[] = [];
		let current: SessionDisplayEntry | undefined = newEntries[newEntries.length - 1];
		while (current && !branchSet.has(current.id) && !chain.some((entry) => entry.id === current?.id)) {
			chain.push(current);
			current = current.parentId ? entries.get(current.parentId) : undefined;
		}
		chain.reverse();
		const pivotIndex = current
			? cached.activeBranch.findIndex((entry) => entry.id === current.id)
			: -1;
		const baseBranch = pivotIndex >= 0
			? cached.activeBranch.slice(0, pivotIndex + 1)
			: cached.activeBranch;
		const nextBranch = [...baseBranch, ...chain];
		return this.finishIndex(hostPath, version, entries, nextBranch, tailText.endsWith("\n"));
	}

	/** 索引 LRU 上限裁剪：超出上限丢最旧（Map 迭代序 = 插入序）。 */
	private trimDisplayIndexCache() {
		while (this.sessionDisplayIndexes.size > SessionHistoryReader.SESSION_DISPLAY_INDEX_LIMIT) {
			this.sessionDisplayIndexes.delete(this.sessionDisplayIndexes.keys().next().value!);
		}
	}

	private async readIndexedSessionMessages(
		hostPath: string,
		entries: SessionDisplayEntry[],
	): Promise<unknown[]> {
		const handle = await open(hostPath, "r");
		try {
			return await Promise.all(entries.map(async (entry) => {
				const buffer = Buffer.allocUnsafe(entry.byteLength);
				await handle.read(buffer, 0, buffer.length, entry.offset);
				const line = buffer.toString("utf8").replace(/\r$/, "");
				return (JSON.parse(line) as { message?: unknown }).message;
			}));
		} finally {
			await handle.close();
		}
	}
	/**
	 * 与 readIndexedSessionMessages 同 IO 模式，但返回整行解析后的 JSON 对象
	 *（而非仅 .message）。供 readSubagentRecords 等需要完整自定义条目的读者使用。
	 */
	private async readIndexedRawLines(
		hostPath: string,
		entries: SessionDisplayEntry[],
	): Promise<unknown[]> {
		const handle = await open(hostPath, "r");
		try {
			return await Promise.all(entries.map(async (entry) => {
				const buffer = Buffer.allocUnsafe(entry.byteLength);
				await handle.read(buffer, 0, buffer.length, entry.offset);
				const line = buffer.toString("utf8").replace(/\r$/, "");
				return JSON.parse(line);
			}));
		} finally {
			await handle.close();
		}
	}



	/**
	 * 直接从历史会话 JSONL 读取最近 N 轮对话。
	 * 必须走会 yield 的显示索引：attach 时若再整文件 split + JSON.parse，
	 * 主进程事件循环会被堵住，窗口关闭/最小化都点不了（pi 会话卡死、DSH 没事）。
	 * 返回兼容 get_messages 的 RpcResponse，供 loadMessages 复用。
	 */
	async readRecentMessages(
		sessionPath: string,
		maxTurns: number,
	): Promise<RpcResponse> {
		const t0 = Date.now();
		const index = await this.getSessionDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		const boundedTurns = Number.isFinite(maxTurns) && maxTurns > 0
			? Math.max(1, Math.floor(maxTurns))
			: SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE;
		// 启动窗口要完整保留最近 N 轮（分页页边界统一按轮计，无字节裁剪）。
		const start = findTurnPageStart(
			index.activeMessageEntries,
			total,
			boundedTurns,
		);
		const entries = index.activeMessageEntries.slice(start);
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
		const trimmed = this.deps.trimMessages(rawMessages, boundedTurns);
		const t1 = Date.now();

		void this.deps.logger?.info("agent", "Recent messages read from session file", {
			sessionPath,
			activeMessages: total,
			messageEntries: rawMessages.length,
			trimmedTurns: boundedTurns,
			trimmedMessages: trimmed.length,
			readMs: t1 - t0,
		});

		return {
			type: "response" as const,
			command: "get_messages",
			success: true,
			data: { messages: trimmed },
		};
	}

	/**
	 * 轻量扫描会话文件中的压缩（compaction）记录。
	 * 只返回压缩条目元信息（摘要/时间/保留起点/tokens），不收集归档消息全文——
	 * 压缩前的归档消息由分页按正常对话流逐条翻出（JSONL 保留完整历史），
	 * 卡片展开展示的是压缩摘要本身（产品意图：看摘要，不看归档）。
	 * 用途：1) 时间线补回"压缩摘要"卡片（与 pi 行为一致）；2) 统计压缩次数供"已压缩 N 次"展示。
	 */
	async scanCompactions(
		sessionPath: string,
		sessionContent?: string,
	): Promise<{
		compactions: Array<{ id: string; summary: string; timestamp: string; firstKeptEntryId?: string; tokensBefore?: number }>;
	}> {
		// 调用方已把全文放进内存时（离线 viewer）沿用传入字符串，避免再走一遍索引。
		// attach / loadMessages 不传 content：必须复用会 yield 的显示索引，
		// 否则刚读完最近 N 轮又整文件 parse 一次，主进程照样卡死。
		if (sessionContent !== undefined) {
			return { compactions: collectCompactionsFromJsonl(sessionContent) };
		}
		try {
			const index = await this.getSessionDisplayIndex(sessionPath);
			return {
				compactions: index.activeBranch
					.filter((entry) => entry.type === "compaction")
					.map((entry) => ({
						id: entry.id,
						summary: entry.summary ?? "",
						timestamp: entry.timestamp ?? "",
						firstKeptEntryId: entry.firstKeptEntryId,
						tokensBefore: entry.tokensBefore,
					})),
			};
		} catch (error) {
			void this.deps.logger?.warn("agent", "Failed to read session file for archive parsing", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return { compactions: [] };
		}
	}
	/**
	 * 从会话文件读取 pi-subagents 插件持久化的子代理记录。
	 *
	 * sit downAppendEntry("subagents:record", data) 写入的条目格式为
	 * {type:"custom", customType:"subagents:record", data:{id, type, description, status, …}}。
	 *
	 * 子代理记录是会话级运行审计，不随对话分支回退而丢失：fork/编辑重发后，
	 * 旁支上已完成的 record 会掉出 activeBranch（2026-08-28 实测：会话有 2 个子代理，
	 * fork 后面板只剩 1 个）。因此这里扫全量条目表（含非活跃分支），而非 activeBranch。
	 *
	 * 同时读取 pi-deck-subagents 桥接扩展落盘的 start 锚点（pi-deck-subagent-start）：
	 * 运行中被会话重启终止的子代理没有 record（插件只在完成时写），无锚点则重启后
	 * 从面板彻底消失。锚点残留（同 id 无更晚的 record 覆盖）合成 stopped 条目。
	 *
	 * IO 约束：customType 已在建索引时捕获，只对目标两类行发起磁盘读，
	 * pi-deck-todo / om.* 等高频 custom 快照零读取，IO 量恒等于目标行数（每次
	 * 子代理创建/完成才写一条）。同一子代理 id 多条时按文件 offset 升序
	 * （= 写入顺序）后写覆盖先写：start 锚点（spawn 时写）自然被 record（完成时写）
	 * 覆盖。status 不在白名单的 record 条目丢弃并记日志。
	 */
	async readSubagentRecords(sessionPath: string): Promise<PiSubagentEntry[]> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const recordEntries = [...index.entries.values()]
			.filter((entry) => entry.type === "custom"
				&& (entry.customType === "subagents:record"
					|| entry.customType === SessionHistoryReader.SUBAGENT_START_ENTRY))
			.sort((a, b) => a.offset - b.offset);
		if (recordEntries.length === 0) return [];

		const rawLines = await this.readIndexedRawLines(index.hostPath, recordEntries);
		const validStatuses = new Set<string>([
			"queued", "running", "completed", "steered", "aborted", "stopped", "error",
		]);
		const byAgentId = new Map<string, PiSubagentEntry>();
		for (let i = 0; i < rawLines.length; i++) {
			const parsed = rawLines[i];
			try {
				if (!isRecord(parsed)) continue;
				const data = isRecord(parsed.data) ? parsed.data : parsed;
				const agentId = String(data.id ?? "");
				if (!agentId) continue;
				// start 锚点无 status 字段：残留（未被更晚的 record 覆盖）说明子代理
				// 运行中被会话重启终止，合成 stopped；record 条目沿用真实 status。
				const isStartAnchor = recordEntries[i].customType === SessionHistoryReader.SUBAGENT_START_ENTRY;
				const status = isStartAnchor ? "stopped" : String(data.status ?? "");
				if (!validStatuses.has(status)) {
					void this.deps.logger?.warn("agent", "Invalid subagent status in subagents:record, skipped", {
						sessionPath,
						entryId: recordEntries[i].id,
						status,
					});
					continue;
				}
				// 同 id 后写覆盖先写：文件 offset 升序遍历，循环尾的 set 自然保留最新一条
				byAgentId.set(agentId, {
					id: agentId,
					type: String(data.type ?? ""),
					description: String(data.description ?? ""),
					status: status as PiSubagentEntry["status"],
					result: typeof data.result === "string" ? data.result : undefined,
					error: typeof data.error === "string" ? data.error : undefined,
					startedAt: typeof data.startedAt === "number" ? data.startedAt : undefined,
					completedAt: typeof data.completedAt === "number" ? data.completedAt : undefined,
					// via：acp_delegate 委托桥接落盘的 record 携带，渲染层据此展示来源提示
					via: data.via === "acp-delegate" ? "acp-delegate" : undefined,
					source: "record",
				});
			} catch {
				void this.deps.logger?.warn("agent", "Failed to parse subagents:record, skipped", {
					sessionPath,
					entryId: recordEntries[i].id,
				});
			}
		}
		return [...byAgentId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	}

	/**
	 * 流式扫描会话文件全量条目，推导不走 record/事件链的子代理运行
	 * （acp_delegate：billion-context-pi；subagent 工具：nicobailon pi-subagents）。
	 *
	 * 这些插件不落 subagents:record / start 锚点，读取侧无法像 record 那样按
	 * customType 走索引定向读，只能全量扫描。行级预检：相关条目必然包含
	 * "acp_delegate" 或带引号的 "subagent" 字样，不含两者的行直接跳过
	 * JSON.parse，纯 record 会话的扫描成本接近纯文本搜索。损坏行忽略。
	 */
	async readDerivedSubagentEntries(sessionPath: string): Promise<PiSubagentEntry[]> {
		const hostPath = this.deps.toHostPath(sessionPath);
		let content: string;
		try {
			content = await readFile(hostPath, "utf8");
		} catch (error) {
			void this.deps.logger?.warn("agent", "Failed to read session for subagent derivation", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
		const rawEntries: unknown[] = [];
		const lines = content.split("\n");
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const sourceLine = lines[lineIndex];
			const jsonLine = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
			if (jsonLine.includes("acp_delegate") || jsonLine.includes("\"subagent\"")) {
				try {
					const parsed: unknown = JSON.parse(jsonLine);
					if (isRecord(parsed)) rawEntries.push(parsed);
				} catch {
					// 损坏行忽略
				}
			}
			// 与索引重建同一节拍让出主线程，大会话扫描不阻塞 IPC/窗口消息
			if ((lineIndex + 1) % SessionHistoryReader.INDEX_PARSE_YIELD_EVERY === 0) {
				await new Promise<void>((resolve) => {
					setImmediate(resolve);
				});
			}
		}
		return deriveToolSubagentEntries(rawEntries);
	}

	/**
	 * 读取会话分支上最新的 pi-deck-todo 快照（todo 工具变更时 appendEntry 持久化）。
	 * 只取最后一条：分支顺序即变更顺序，末条即当前计划；clear 后的快照无 activePlan → undefined。
	 */
	async readTodoSnapshot(sessionPath: string): Promise<SessionTodoSnapshot | undefined> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		// 从尾部向前找，避免读出全部 custom 行只为取最后一条
		const customEntries = [...index.activeBranch].reverse().filter((entry) => entry.type === "custom");
		for (const entry of customEntries) {
			const rawLines = await this.readIndexedRawLines(index.hostPath, [entry]);
			const parsed = rawLines[0];
			try {
				if (!isRecord(parsed)) continue;
				if (parsed.customType !== "pi-deck-todo") continue;
				return parseTodoSnapshotData(parsed.data);
			} catch {
				void this.deps.logger?.warn("agent", "Failed to parse pi-deck-todo snapshot, skipped", {
					sessionPath,
					entryId: entry.id,
				});
			}
		}
		return undefined;
	}



}

/** 离线 viewer 已持有全文时扫描 compaction，避免再走一遍索引。 */
function collectCompactionsFromJsonl(content: string): Array<{
	id: string;
	summary: string;
	timestamp: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
}> {
	const compactions: Array<{
		id: string;
		summary: string;
		timestamp: string;
		firstKeptEntryId?: string;
		tokensBefore?: number;
	}> = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (!entry || typeof entry !== "object" || entry.type !== "compaction") continue;
			compactions.push({
				id: typeof entry.id === "string" ? entry.id : "",
				summary: typeof entry.summary === "string" ? entry.summary : "",
				timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
				firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
				tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
			});
		} catch {
			// 跳过单行解析失败
		}
	}
	return compactions;
}

/**
 * 从 JSONL message entry 提取展示文本（「查看完整输出」用）。
 * 与 AgentMessageProjector.extractToolResultText 同格式约定（content 数组的 text 拼接），
 * 额外兼容 content 为字符串的旧格式；改动时两边保持同步。
 */
function extractEntryResultText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => (typeof item?.text === "string" ? item.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}
