import { open, stat } from "node:fs/promises";
import type { ChatMessage, ImageContent, PiSubagentEntry, SessionMessagePage, SessionTodoSnapshot } from "../../shared/types";
import { parseTodoSnapshotData } from "../../shared/sessionTodo";
import { isFileChangeToolName } from "../../shared/fileChanges";
import { deriveToolSubagentEntries } from "./derivedSubagents";
import { scanJsonlLines } from "../sessions/jsonlLineStream";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { RpcResponse } from "./PiRpcClient";
import type { AppLogger } from "../logging/AppLogger";
import { stoppedMessageFingerprint, type StoppedMessageIdentity } from "./stoppedMessageIdentity";
import { isRoleMessageRole } from "./sessionEntryIds";

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
	/** custom_message 条目的 display 标志：false = 内部上下文注入（不画卡片，但仍是回合边界） */
	customDisplay?: boolean;
	/** 消息角色（user/assistant/…）：轮次分页按 user 消息切轮次边界，建索引时顺手捕获 */
	role?: string;
	/** 消息条目的 message.toolName：文件汇总按「是否文件类工具」预判前先过滤掉大体量非文件工具结果 */
	toolName?: string;
	/** 消息条目的 message.id：编辑/删除/重发缓存未命中时按 messageId 定位文件条目 */
	messageId?: string;
	/** 停止后 live ID 的安全回查窗口；只读时间邻近条目，避免整段历史按正文扫描。 */
	messageTimestamp?: number;
	/** 超长行降级条目：正文未解析（hasMessage 恒 false），只为维持 parentId 链而保留。 */
	oversized?: true;
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
	convertMessages: (agentId: string, rawMessages: unknown[], activeEntryIds?: string[]) => ChatMessage[];
	trimMessages: (rawMessages: unknown[], maxTurns?: number) => unknown[];
	translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
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
 * 2026-09 统一轮次协议：页大小只以轮数计，不做字节裁剪
 *（用户看历史就是要看完整一轮，不静默丢内容）。
 *
 * 注：轮数窗口无法限制单轮体量。需要「一次最多多少条」的硬上限时
 * 在本函数之上再叠 boundTurnWindowStart（#213）。
 */
export function findTurnPageStart(entries: ReadonlyArray<{ role?: string; byteLength: number }>, before: number, turnCount: number): number {
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
			if (entries[i].role === "user") {
				hasEarlierUser = true;
				break;
			}
		}
		if (!hasEarlierUser) start = 0;
	}
	return start;
}

/** 收集 [0, before) 内的 turn 起点下标（升序），规则与 findTurnPageStart 一致。 */
function collectTurnStartIndices(entries: ReadonlyArray<{ role?: string; byteLength: number }>, before: number): number[] {
	const starts: number[] = [];
	let prevUserOrAssistantRole: "user" | "assistant" | undefined;
	for (let i = 0; i < before; i += 1) {
		const role = entries[i].role;
		if (role === "user") {
			// 连发 user：只有前一条是 assistant（或无实质消息）时才算新轮起点。
			if (prevUserOrAssistantRole !== "user") starts.push(i);
			prevUserOrAssistantRole = "user";
		} else if (role === "assistant") {
			prevUserOrAssistantRole = "assistant";
		}
	}
	return starts;
}

/**
 * 在「最近 N 轮」窗口上再叠一层条目预算（纯函数，2026-08 #213）。
 *
 * 为什么需要：轮数窗口限制不了单轮体量。上下文超限后的极端会话里一轮可以塞进上千条
 * 工具/思考条目，于是「12 轮」= 2000+ 条消息，一次读盘 + 投影 + 全量 IPC 下发就把
 * 渲染进程推到 OOM（#213：压缩失败后重载同一窗口，2162 条 payload）。
 *
 * 语义：从尾部向前并入**完整轮次**，累计条目数将超过 maxEntries 就停在已并入的最早轮起点。
 * 因此页边界仍然对齐轮次（不会切半个回答），预算只决定「一次展示多少轮」——
 * 更早历史依然能通过翻页读回，不静默丢内容。
 *
 * 边界：
 * - 至少保留最后一轮：单轮自身超预算也必须返回该轮起点，否则会返回空页/翻页死锁。
 * - 无 user 轮次边界（纯 assistant/system 片段）：不裁剪，退回轮数窗口结果。
 * - maxEntries 非有限值或 <= 0 = 未启用预算，行为与 findTurnPageStart 完全一致。
 */
export function boundTurnWindowStart(entries: ReadonlyArray<{ role?: string; byteLength: number }>, before: number, turnCount: number, maxEntries: number): number {
	const turnStart = findTurnPageStart(entries, before, turnCount);
	if (!Number.isFinite(maxEntries) || maxEntries <= 0) return turnStart;
	if (before - turnStart <= maxEntries) return turnStart;
	const starts = collectTurnStartIndices(entries, before);
	if (starts.length === 0) return turnStart;
	// 兜底 = 最后一轮起点（单轮超预算时也只能整轮保留，不能返回空页）。
	let bounded = starts[starts.length - 1];
	for (let i = starts.length - 1; i >= 0; i -= 1) {
		// 越过轮数窗口上界：不再向更早扩，保留轮数语义。
		if (starts[i] < turnStart) break;
		// 并入这一轮会突破预算：停在上一次已并入的起点。
		if (before - starts[i] > maxEntries) break;
		bounded = starts[i];
	}
	return bounded;
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
			} else if (typed.type === "image" && typed.source?.type === "base64" && typeof typed.source.data === "string") {
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

function deriveSessionHistoryMetadata(activeBranch: readonly SessionDisplayEntry[]): SessionHistoryMetadata {
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
function spliceCardsByOffset<T>(items: T[], cards: ReadonlyArray<{ offset: number; card: T }>, toArrayIndex: (absoluteOffset: number) => number): T[] {
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
function roleMessageEntryIds(entries: ReadonlyArray<{ id: string; role?: string; message?: unknown }>): string[] {
	return entries.filter((entry) => isRoleMessageRole(entry.role ?? (isRecord(entry.message) ? entry.message.role : undefined))).map((entry) => entry.id);
}

/**
 * Reads persisted Session JSONL without starting Pi. Runtime ownership remains in
 * AgentManager; this reader owns bounded display paging and compaction recovery.
 */
export class SessionHistoryReader {
	private readonly sessionDisplayIndexes = new Map<string, SessionDisplayIndex>();
	private static readonly SESSION_DISPLAY_INDEX_LIMIT = 32;
	/**
	 * 流式扫描每隔这么多行让出一次事件循环（见 jsonlLineStream.scanJsonlLines 的
	 * yieldEveryLines）：整文件同步 parse 会卡死主进程，IPC/窗口消息都得等它跑完。
	 */
	private static readonly INDEX_PARSE_YIELD_EVERY = 400;
	/** 完整消息文本 LRU 缓存（「查看完整输出」按需读取结果）：键 `${sessionPath}#${messageId}`。 */
	private readonly fullTextCache = new Map<string, string>();
	/** 已驻留完整文本的总字节数（字节预算 LRU 淘汰用，命中刷新不增减）。 */
	private fullTextCacheBytes = 0;
	private static readonly FULL_TEXT_CACHE_LIMIT = 200;
	/**
	 * 完整文本总字节预算（2026 内存排查）：单条工具结果可达数百 KB，
	 * 200 条全是大结果时仍可驻留数十 MB；超预算时按最旧先淘汰。
	 */
	private static readonly FULL_TEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
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

	/**
	 * 启动加载窗口的条目预算（12 轮窗口之上叠的硬上限）。
	 * 1600 相当于正常重工具会话（≈40-60 条/轮）的 2-3 倍余量，只有「单轮几百条」的
	 * 极端会话才会被缩窗口；缩窗口只影响一次展示多少轮，更早历史仍可翻页（#213）。
	 */
	private static readonly MAX_LOAD_WINDOW_ENTRIES = 1600;
	/**
	 * 翻页单页的条目预算（3 轮窗口之上叠的硬上限）。
	 * 防御「上滚翻页反而把渲染进程撑爆」——页大小本受 MAX_TURN_PAGE_SIZE 限制，
	 * 但 3 轮 × 数百条仍可超预算；单轮自身超预算时只能整轮保留。
	 */
	private static readonly MAX_PAGE_WINDOW_ENTRIES = 600;

	/**
	 * 文件汇总的条目预算（最新一轮 + 无 user 边界的兜底窗口）。
	 *
	 * 单轮条目数正常在几十条量级；给 1600 是防御「单轮上千条工具调用」的极端会话——
	 * 即便被截断，截断的也是同一轮里最旧的条目，横栏语义（本轮改了什么）仍然成立；
	 * 横栏只是汇总视图，不像时间线那样需要逐条可见。
	 */
	private static readonly MAX_FILE_CHANGE_ENTRIES = 1600;

	/**
	 * 轮次边界探测次数上限：只为跳过「空文本 user 条目」，正常第一条即命中。
	 * 超出上限时按索引 role 直接认定，避免异常数据把探测变成全量读盘。
	 */
	private static readonly FILE_CHANGE_BOUNDARY_PROBES = 4;

	/** 启动加载窗口条目预算（供 AgentManager 对齐窗口口径）。 */
	static maxLoadWindowEntries(): number {
		return SessionHistoryReader.MAX_LOAD_WINDOW_ENTRIES;
	}

	/** 翻页单页条目预算（供 AgentManager 缓存分页对齐口径）。 */
	static maxPageWindowEntries(): number {
		return SessionHistoryReader.MAX_PAGE_WINDOW_ENTRIES;
	}

	constructor(private readonly deps: SessionHistoryReaderDeps) {}

	/**
	 * 不启动 pi 进程，直接从 JSONL 构造与运行态相同的时间线数据。
	 * Viewer 必须复用 AgentManager 的压缩归档与消息转换规则，避免维护第二套显示模型。
	 */
	async readMessageFullText(sessionPath: string, messageId: string, entryId?: string): Promise<{ text: string }> {
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
		if (this.fullTextCache.size >= SessionHistoryReader.FULL_TEXT_CACHE_LIMIT || this.fullTextCacheBytes + text.length > SessionHistoryReader.FULL_TEXT_CACHE_MAX_BYTES) {
			// 条数/字节双预算：按最旧先淘汰（Map 迭代序 = 插入序）
			const oldest = this.fullTextCache.keys().next().value;
			if (oldest !== undefined) {
				const removed = this.fullTextCache.get(oldest);
				if (removed !== undefined) this.fullTextCacheBytes -= removed.length;
				this.fullTextCache.delete(oldest);
			}
		}
		this.fullTextCache.set(cacheKey, text);
		this.fullTextCacheBytes += text.length;
		return { text };
	}

	/**
	 * 整条活动分支的显示消息（**无字节上界**）。
	 *
	 * 危险：`sessionContent === undefined` 分支会把活动分支的每一行都读进内存并
	 * 逐条投影成显示对象——近 1 GiB 的会话足以顶爆主进程 384MB 老生代堆。
	 * 只有「确实需要完整时间线」的入口才可以用它；任何「先全量再切片」的用法
	 * 都必须改成有界读（窗口/分页，或像文件汇总那样按需定向读，
	 * 见 readFileChangeMessages）。2026-09 的「打开会话即闪退」就是这条路径被
	 * 「最近一轮修改的文件」借用导致的。
	 */
	async readSessionDisplayMessages(sessionPath: string, agentId = "_viewer", sessionContent?: string): Promise<ChatMessage[]> {
		// 调用方未把全文放进内存时必须走会 yield 的索引 + offset 读，
		// 否则离线 Viewer 打开大会话会整文件 split+JSON.parse，主进程照样卡死。
		if (sessionContent === undefined) {
			const index = await this.getSessionDisplayIndex(sessionPath);
			const entries = index.activeMessageEntries;
			const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
			// 投影器的 entryId 槽位只对应角色消息：0.86 的 role:"system" 条目不能进 id 列表，
			// 否则其后所有消息的 meta.entryId 整体前移（按 entryId 定位的编辑/重发会落错条目）。
			const entryIds = roleMessageEntryIds(entries);
			const finalRaw = this.insertCompactionSummaryRaw(index, rawMessages, 0);
			const messages = this.deps.convertMessages(agentId, finalRaw, entryIds);
			// 整条分支读取：通知卡片同样要补（Web/Viewer 与桌面时间线保持同一口径，
			// 否则同一会话在两处会呈现不同的回合切分）。
			const cards = await this.buildCustomMessageCards(index, agentId, {
				start: 0,
				end: entries.length,
				isTailWindow: true,
			});
			return this.applyCustomMessageCards(messages, cards, entries, 0, this.resolveCompactionInsertOffset(index));
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
		const currentEntries = activeBranch.filter((entry) => entry.type === "message" && entry.message);
		const rawMessages = currentEntries.map((entry) => entry.message);
		// Offline Session viewers must expose the complete active branch. The runtime
		// prompt-history cap belongs to Agent startup, while renderer pagination owns
		// how much of a historical Session is rendered at one time.
		// entryIds 只含角色条目：投影器不会为 0.86 的 role:"system" 条目分配槽位。
		const activeEntryIds = roleMessageEntryIds(currentEntries);

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
			const firstKeptPos = compactionEntry.firstKeptEntryId ? currentEntries.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId) : -1;
			const insertAt = firstKeptPos >= 0 ? firstKeptPos : lastCompactionIndex >= 0 && lastCompactionIndex < activeBranch.length ? activeBranch.slice(0, lastCompactionIndex + 1).filter((entry) => entry.type === "message" && entry.message).length : rawMessages.length;
			finalRaw = [...rawMessages.slice(0, insertAt), card, ...rawMessages.slice(insertAt)];
		}

		return this.deps.convertMessages(agentId, finalRaw, activeEntryIds);
	}

	/**
	 * 轮内过滤：只有 assistant（toolCall 参数在这里）与「可能是文件类工具」的
	 * toolResult 参与文件汇总，其余条目整行不进内存。
	 *
	 * 保守优先：toolName 没捕获到（老索引/异常行）或 role 未知时一律读入——
	 * 多读只是浪费一次 IO，漏读会让横栏少显示一个被改过的文件。
	 * 真正的判定仍在聚合侧（getToolDiffTarget 用同一份 FILE_CHANGE_TOOL_RE），
	 * 这里只是「要不要把这一行读进内存」的预判。
	 */
	private static isFileChangeSource(entry: SessionDisplayEntry): boolean {
		if (entry.role === "assistant") return true;
		if (entry.role === "toolResult") {
			// toolName 缺失时投影会回退到 assistant toolCall 的名字，无法预判 → 读。
			return !entry.toolName || isFileChangeToolName(entry.toolName);
		}
		return entry.role === undefined;
	}

	/**
	 * 定位「最新一轮」的起点：最后一个「可展示 user 消息」在活动分支里的下标。
	 *
	 * 索引里只捕获了 role，而显示投影会丢掉空文本无图片的 user 条目（那种条目在
	 * 时间线上不存在，渲染层 collectLatestTurnFileChanges 也不会把它当轮次边界）。
	 * 为对齐这个口径，对候选条目做单行探测（自尾向前，次数有上限）——正常会话
	 * 第一条就命中，只多读一行。
	 *
	 * 返回 -1 表示整条分支没有 user 边界（异常/老数据）。
	 */
	private async resolveFileChangeTurnBoundary(index: SessionDisplayIndex, entries: readonly SessionDisplayEntry[]): Promise<number> {
		let probes = 0;
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			if (entries[i].role !== "user") continue;
			if (probes >= SessionHistoryReader.FILE_CHANGE_BOUNDARY_PROBES) return i;
			probes += 1;
			const raw = await this.readIndexedSessionMessages(index.hostPath, [entries[i]]);
			const projected = this.deps.convertMessages("_viewer", raw, [entries[i].id]);
			if (projected.some((message) => message.role === "user")) return i;
		}
		return -1;
	}

	/**
	 * 「修改的文件」横栏的取数原语：**有界**返回最新一轮中可能产出 diff 的显示消息，
	 * 调用方用 shared/fileChanges 的 collectSessionFileChanges 聚合。
	 *
	 * 为什么不能复用 readSessionDisplayMessages：那条路径是「读整条活动分支 →
	 * 逐条投影成显示对象 → 再切出最后一轮」。对近 1 GiB 的会话，这等于让主进程
	 * 把整段历史再全量展开一次：读盘字节 = 历史总字节，投影对象再翻一倍，
	 * 直接顶爆主进程 384MB 老生代堆（用户表现为「一打开就闪退」）。
	 *
	 * 三层有界（全部由索引元数据决定，不靠正文）：
	 * 1. 轮次边界取自索引里已捕获的 role，不为找边界读全量正文；
	 * 2. 只读边界之后的条目 —— 读盘字节只与「一轮有多大」有关，与历史总长无关；
	 * 3. 轮内只读可能产出 diff 的条目（assistant + 文件类工具结果），
	 *    read/bash 等大体积工具结果整行不 materialize。
	 *
	 * 边界：没有 user 边界时回退聚合「尾部有界窗口」（见 MAX_FILE_CHANGE_ENTRIES），
	 * 结果与 collectLatestTurnFileChanges 的「无 user 消息 → 聚合全部」一致，
	 * 但不会因为异常数据退回全量展开。
	 *
	 * 已知取舍：toolCall 参数只在 assistant 行里，若有工具的 toolResult 落在边界之后、
	 * 而它的 assistant toolCall 落在边界之前（用户在一轮工具执行中插话），该条会因取不到
	 * 参数而被跳过。代价是多一个文件不出现在汇总横栏，不是数据丢失；为它把边界前的
	 * assistant 行也读进来不划算（那正是本方法要避免的全量展开）。
	 */
	async readFileChangeMessages(sessionPath: string, agentId = "_viewer"): Promise<ChatMessage[]> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const entries = index.activeMessageEntries;
		const boundary = await this.resolveFileChangeTurnBoundary(index, entries);
		const scope = boundary < 0 ? entries.slice(Math.max(0, entries.length - SessionHistoryReader.MAX_FILE_CHANGE_ENTRIES)) : entries.slice(boundary + 1);
		const readable = scope.filter((entry) => SessionHistoryReader.isFileChangeSource(entry));
		if (readable.length === 0) return [];
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, readable);
		// isFileChangeSource 是「要不要读进内存」的保守预判（role 未知也读），
		// 但 entryId 槽位必须严格按角色过滤：非角色条目会占位导致后续条目 id 错位。
		return this.deps.convertMessages(agentId, rawMessages, roleMessageEntryIds(readable));
	}

	/**
	 * 一次性读取「加载窗口」内的历史消息（**有界**，供 Web 接口 / 兼容的整量读入口使用）。
	 *
	 * 为什么不做全量：JSONL 保留完整历史，全量下发在大会话上同时顶爆主进程（投影 + IPC
	 * 序列化）与渲染层（#213），而「读完整历史」这个需求本身应该走轮次分页
	 * （readSessionDisplayTurnPage / Web 的 /messages/page）。这里返回与桌面启动窗口
	 * 同口径的尾部窗口 + total/windowStart，让调用方知道是否被截断、从哪继续翻。
	 */
	async readLoadWindow(sessionPath: string, agentId = "_viewer", turnCount = SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE, maxEntries = SessionHistoryReader.MAX_LOAD_WINDOW_ENTRIES): Promise<{ messages: ChatMessage[]; total: number; windowStart: number }> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		const windowStart = boundTurnWindowStart(index.activeMessageEntries, total, turnCount, maxEntries);
		const entries = index.activeMessageEntries.slice(windowStart);
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
		// 窗口 = 条目切片：压缩插入点（绝对下标）必须换算成本窗口内下标，
		// 否则压缩卡片会插进窗口内部靠前处/被挤到窗口末尾（readLoadWindow 是 Web 整量读入口）。
		const finalRaw = this.insertCompactionSummaryRaw(index, rawMessages, windowStart);
		// 加载窗口覆盖到文件尾部：末条通知（offset === total）也属于它
		const cards = await this.buildCustomMessageCards(index, agentId, {
			start: windowStart,
			end: total,
			isTailWindow: true,
		});
		const messages = this.deps.convertMessages(agentId, finalRaw, roleMessageEntryIds(entries));
		return {
			messages: this.applyCustomMessageCards(messages, cards, entries, windowStart, this.resolveCompactionInsertOffset(index)),
			total,
			windowStart,
		};
	}

	/**
	 * 轮次维度的显示分页：游标仍使用活动分支消息下标，页边界对齐完整轮次。
	 * 这样无论历史会话是否已经启动 Agent，时间线都不会切开一个 user/assistant 回合。
	 *
	 * 2026-09 上滚丝滑：读页后后台预取下一页存入 prefetchCache（LRU 2 页），
	 * 连续上滚时命中缓存零磁盘 IO；pi 持续追加消息时键版本失效自动重建。
	 */
	async readSessionDisplayTurnPage(sessionPath: string, agentId = "_viewer", before?: number, turnCount = SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE, beforeEntryId?: string): Promise<SessionMessagePage> {
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
		const boundedBefore = Number.isSafeInteger(resolvedBefore) ? Math.min(Math.max(0, resolvedBefore!), total) : total;
		const boundedTurnCount = Number.isFinite(turnCount) ? Math.min(Math.max(1, Math.floor(turnCount)), SessionHistoryReader.MAX_TURN_PAGE_SIZE) : SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE;

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
	private async readTurnPageCore(index: SessionDisplayIndex, agentId: string, boundedBefore: number, boundedTurnCount: number): Promise<SessionMessagePage> {
		const total = index.activeMessageEntries.length;
		const start = boundTurnWindowStart(index.activeMessageEntries, boundedBefore, boundedTurnCount, SessionHistoryReader.MAX_PAGE_WINDOW_ENTRIES);

		// 与普通轮次页一致：压缩会话的归档语义未游标化前走索引切片
		if (index.hasCompaction) {
			// 同一索引空间：索引切片 + 转换 + 页内卡片。
			const entries = index.activeMessageEntries.slice(start, boundedBefore);
			const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
			const messages = await this.convertCompactionPageMessages(index, agentId, rawMessages, roleMessageEntryIds(entries), start, entries);
			// 压缩页里已有一张压缩卡片占了槽位，通知卡片按同一插入点做 +1 补偿
			const cards = await this.buildCustomMessageCards(index, agentId, {
				start,
				end: boundedBefore,
				// 只有末页（游标已到文件尾部）才包含 offset === total 的尾部通知
				isTailWindow: boundedBefore >= total,
			});
			return {
				messages: this.applyCustomMessageCards(messages, cards, entries, start, this.resolveCompactionInsertOffset(index)),
				total,
				nextBefore: start > 0 ? start : null,
				nextBeforeEntryId: start > 0 ? index.activeMessageEntries[start]?.id : undefined,
				indexVersion: `${index.mtimeMs}:${index.size}`,
				...index.metadata,
			};
		}

		const entries = index.activeMessageEntries.slice(start, boundedBefore);
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
		// 通知卡片归属唯一一页：半开区间 [start, end) 不含 offset === end（那是下一页的开头）；
		// 末页例外——它后面没有更新的页，offset === total 的尾部通知属于它。
		const cards = await this.buildCustomMessageCards(index, agentId, {
			start,
			end: boundedBefore,
			isTailWindow: boundedBefore >= total,
		});
		return {
			messages: this.applyCustomMessageCards(this.deps.convertMessages(agentId, rawMessages, roleMessageEntryIds(entries)), cards, entries, start),
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
	private buildPrefetchKey(sessionPath: string, index: SessionDisplayIndex, before: number, turnCount: number): string | undefined {
		if (!index.hostPath) return undefined;
		return `${sessionPath}|${index.mtimeMs}:${index.size}|${before}|${turnCount}`;
	}

	/**
	 * 后台预取下一页：当前页还有更早历史（nextBefore 非 null）时读取下一页
	 * 并存入 LRU（上限 PREFETCH_CACHE_LIMIT 页）。失败静默——预取是优化不是功能。
	 * 只预取一页不连锁（下一页到达时不再次触发预取），避免无限递归读盘。
	 */
	private enqueuePrefetch(page: SessionMessagePage, sessionPath: string, index: SessionDisplayIndex, turnCount: number): void {
		if (page.nextBefore === null || page.nextBefore <= 0) return;
		const nextKey = this.buildPrefetchKey(sessionPath, index, page.nextBefore, turnCount);
		if (!nextKey || this.prefetchCache.has(nextKey)) return;
		// 后台读，不阻塞当前请求；单错不传播（预取失败下次点击仍可正常读盘）。
		// 走 readTurnPageCore 而不是公共分页方法：预取不再触发预取（无连锁递归）。
		void this.readTurnPageCore(index, "_prefetch", page.nextBefore, turnCount)
			.then((nextPage) => {
				this.prefetchCache.delete(nextKey);
				this.prefetchCache.set(nextKey, nextPage);
				this.trimPrefetchCache();
			})
			.catch(() => undefined);
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
	 * 取活动分支末尾 `messageCount` 条**消费 entryId 槽位的角色消息**的 entryId
	 * （与 JSONL 尾部窗口一一对应）。
	 * loadMessages 用它代替 get_entries：pi 会把整棵 entry 树打成单行 JSON，同步 parse 会冻窗。
	 *
	 * 为什么必须按角色过滤：activeMessageEntries 只按 `type === "message"` 收集，而 pi 0.86
	 * 起系统提示与工具清单变更也会落成 `type:"message"` + `role:"system"` 的条目
	 * （transcript-backed prompt/tool 更新，首个请求一条完整 sections、之后按 name 打补丁）。
	 * AgentMessageProjector 只给 user/assistant/toolResult 分配槽位；若这里直接对
	 * activeMessageEntries 尾部切片，窗口内夹着 system 条目时返回的 id 会整体错位
	 * （u1→a1、a1→u2 …），而 SessionFileEditor 按 id 定位，编辑/删除/重发将落到相邻条目上
	 * （重发另有 assertResendRootEntry 文本校验兜底，编辑/删除没有）。2026-09 适配 0.86。
	 */
	async getRecentActiveEntryIds(sessionPath: string, messageCount: number): Promise<string[]> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const entries = index.activeMessageEntries;
		const count = Number.isFinite(messageCount) && messageCount > 0 ? Math.min(Math.floor(messageCount), entries.length) : 0;
		if (count <= 0) return [];
		// 从尾部倒着收集，凑够 count 条即停：避免对上千条消息的会话做一次全量 filter 分配。
		const ids: string[] = [];
		for (let position = entries.length - 1; position >= 0 && ids.length < count; position -= 1) {
			const entry = entries[position];
			if (isRoleMessageRole(entry.role)) ids.push(entry.id);
		}
		return ids.reverse();
	}

	/**
	 * 把范围内的 custom_message 条目构造成时间线卡片（含插入偏移）。
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
	 * 偏移语义：offset = 该通知之前有多少条消息条目（即「下一条消息之前」），
	 * 与压缩卡片的 insertAt 同一（activeMessageEntries 绝对下标）空间。
	 * 范围取半开区间 [start, end)，只有尾部窗口/最新页才包含 offset === total
	 * 的「末条通知」——否则上下相邻两页会各自插一张，卡片重复出现。
	 *
	 * IO 约束：只对范围内真正要展示的几行发起磁盘读（与 readSubagentRecords 同模式）。
	 */
	private async buildCustomMessageCards(index: SessionDisplayIndex, agentId: string, options: { start: number; end: number; isTailWindow: boolean }): Promise<Array<{ offset: number; card: ChatMessage }>> {
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
			if (entry.type !== "custom_message") continue;
			if (!inRange(messageCount)) continue;
			placements.push({ entry, offset: messageCount });
		}
		if (placements.length === 0) return [];

		const rawLines = await this.readIndexedRawLines(
			index.hostPath,
			placements.map((item) => item.entry),
		);
		const cards: Array<{ offset: number; card: ChatMessage }> = [];
		for (let i = 0; i < placements.length; i++) {
			const parsed = rawLines[i];
			if (!isRecord(parsed)) continue;
			const content = typeof parsed.content === "string" ? parsed.content : "";
			// 空正文没有可展示信息：不占位（仍不影响回合边界——边界由 stopReason 兜底）
			if (!content.trim()) continue;
			const customType = readString(parsed, "customType") ?? placements[i].entry.customType;
			const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
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
	private resolveCompactionInsertOffset(index: SessionDisplayIndex): number | undefined {
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
	private applyCustomMessageCards(messages: ChatMessage[], cards: Array<{ offset: number; card: ChatMessage }>, windowEntries: ReadonlyArray<{ role?: string }>, windowStart: number, compactionInsertOffset?: number): ChatMessage[] {
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
	private insertCompactionSummaryRaw(index: SessionDisplayIndex, rawMessages: unknown[], windowStart: number): unknown[] {
		const lastCompaction = index.activeBranch.findLast((entry) => entry.type === "compaction");
		if (!lastCompaction) return rawMessages;
		// 与压缩页/通知卡片共用同一偏移口径（firstKeptEntryId 优先，回退压缩条目后的消息数）；
		// rawMessages 是窗口切片，绝对下标要减 windowStart 再 clamp（插在全量分支也成立）。
		const absoluteInsertAt = this.resolveCompactionInsertOffset(index) ?? windowStart + rawMessages.length;
		const insertAt = Math.min(Math.max(absoluteInsertAt - windowStart, 0), rawMessages.length);
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
	private async convertCompactionPageMessages(index: SessionDisplayIndex, agentId: string, rawMessages: unknown[], entryIds: string[], start: number, windowEntries: ReadonlyArray<SessionDisplayEntry>): Promise<ChatMessage[]> {
		const messages = this.deps.convertMessages(agentId, rawMessages, entryIds);
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
		stoppedIdentity?: StoppedMessageIdentity,
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
		const resolvedHint = entryIdHint ?? stoppedIdentity?.entryId;
		const entry =
			index.activeMessageEntries.find((candidate) => (resolvedHint !== undefined && candidate.id === resolvedHint) || candidate.messageId === messageId || candidate.id === messageId || (syntheticId !== undefined && candidate.id === syntheticId)) ??
			(resolvedHint === undefined && stoppedIdentity ? await this.findStoppedMessageEntry(index, stoppedIdentity) : undefined);
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

	/**
	 * 临时 ID 没有落盘：仅在同角色、5 秒邻近窗口内按完整可见内容摘要唯一匹配。
	 * 不按文本“找最近一条”：重复提示词、分支和未落盘消息必须宁可拒绝也不改错。
	 */
	private async findStoppedMessageEntry(index: SessionDisplayIndex, identity: StoppedMessageIdentity): Promise<SessionDisplayEntry | undefined> {
		if (!Number.isFinite(identity.timestamp)) return undefined;
		const candidates = index.activeMessageEntries.filter((entry) => entry.role === identity.role && entry.messageTimestamp !== undefined && Math.abs(entry.messageTimestamp - identity.timestamp) <= 5_000);
		// 这是异常身份的恢复路径，不允许为一次编辑读取无限正文/图片。
		if (candidates.length > 256 || candidates.reduce((size, entry) => size + entry.byteLength, 0) > 8 * 1024 * 1024) {
			return undefined;
		}
		const raw = await this.readIndexedSessionMessages(index.hostPath, candidates);
		const projected = this.deps.convertMessages(
			"_viewer",
			raw,
			candidates.map((entry) => entry.id),
		);
		const matches = projected.filter((message) => stoppedMessageFingerprint(message) === identity.fingerprint);
		if (matches.length !== 1) return undefined;
		return candidates.find((entry) => entry.id === matches[0].meta?.entryId);
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
		// 全量重建成本随文件线性增长，大会话（几十 MB 以上）会造成可感知卡顿。
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

		// 全量重建必须流式逐行：整文件 `readFile + split` 在大会话上要么撞 V8 单字符串
		// 上限（ERR_STRING_TOO_LONG），要么先建出几百 MB 字符串再撞主进程 384MB 堆上限
		// （V8 FatalProcessOutOfMemory → 主进程 abort，用户看到「打开大会话即闪退」）。
		// 见 src/main/sessions/jsonlLineStream.ts 的模块注释。
		const entries = new Map<string, SessionDisplayEntry>();
		let lastEntryId: string | undefined;
		const scan = await scanJsonlLines(
			hostPath,
			(line, context) => {
				const parsed = this.parseIndexLine(line, context.offset, context.byteLength);
				if (parsed) {
					entries.set(parsed.id, parsed);
					lastEntryId = parsed.id;
				}
			},
			{
				yieldEveryLines: SessionHistoryReader.INDEX_PARSE_YIELD_EVERY,
				onOversizedLine: (info) => {
					// 单行超过 64MiB（巨型内联 base64 附件等）：不 parse 正文，只从行首前缀
					// 抢出 id/parentId 保住 parentId 链（丢 id 会让 traceActiveBranch 从这里断链，
					// 整段更早历史都被判为「非活跃分支」而消失）。正文不进内存，也不进展示。
					const stub = this.parseOversizedIndexLine(info);
					if (stub) {
						entries.set(stub.id, stub);
						lastEntryId = stub.id;
					}
					void this.deps.logger?.warn("session-history", "Oversized JSONL line indexed without body", {
						hostPath,
						offset: info.offset,
						byteLength: info.byteLength,
						recoveredId: stub?.id,
					});
				},
			},
		);
		const endsWithNewline = scan.endsWithNewline;
		const activeBranch = this.traceActiveBranch(entries, lastEntryId);
		const index = this.finishIndex(hostPath, version, entries, activeBranch, endsWithNewline);
		this.sessionDisplayIndexes.delete(hostPath);
		this.sessionDisplayIndexes.set(hostPath, index);
		this.trimDisplayIndexCache();
		return index;
	}

	/**
	 * 超长行的降级索引条目：只从行首前缀里抢 id/parentId/type。
	 *
	 * 前缀用正则而不是 JSON.parse（正文根本没进内存）；pi 的 JSONL 由固定序列化器写出，
	 * 条目对象以 `{"type":…,"id":…,"parentId":…` 开头，所以**第一个** `"id"` 匹配即条目自身 id。
	 * 抢不到 id 时返回 null：此时无法维持 parentId 链，宁可丢这一条（已记日志），
	 * 也不编造一个会污染分支回溯的假 id。
	 */
	private parseOversizedIndexLine(info: { offset: number; byteLength: number; prefix: string }): SessionDisplayEntry | null {
		const id = /"id"\s*:\s*"([^"\\]{1,64})"/.exec(info.prefix)?.[1];
		if (!id) return null;
		const parentId = /"parentId"\s*:\s*"([^"\\]{1,64})"/.exec(info.prefix)?.[1];
		const type = /"type"\s*:\s*"([^"\\]{1,32})"/.exec(info.prefix)?.[1] ?? "";
		return {
			id,
			parentId: parentId ?? null,
			type,
			offset: info.offset,
			byteLength: info.byteLength,
			// body 未解析：不进 activeMessageEntries（不参与分页/展示），
			// 但保留在 entries 里维持 parentId 链与活动分支回溯。
			hasMessage: false,
			oversized: true,
		};
	}

	/** 解析单行 JSONL 为索引条目；损坏行返回 null（不影响其他行）。 */
	private parseIndexLine(sourceLine: string, offset: number, byteLength: number): SessionDisplayEntry | null {
		const jsonLine = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
		try {
			const parsed: unknown = JSON.parse(jsonLine);
			if (!isRecord(parsed) || typeof parsed.id !== "string") return null;
			const data = isRecord(parsed.data) ? parsed.data : undefined;
			const nestedMessage = isRecord(parsed.message) ? parsed.message : data && isRecord(data.message) ? data.message : undefined;
			const message = nestedMessage ?? (typeof parsed.role === "string" ? parsed : undefined);
			const type = typeof parsed.type === "string" ? parsed.type : "";
			const modelChangeProvider = type === "model_change" ? (readString(parsed, "provider") ?? readString(data, "provider")) : undefined;
			const modelChangeId = type === "model_change" ? (readString(parsed, "modelId") ?? readString(data, "modelId")) : undefined;
			const thinkingLevel = type === "thinking_level_change" ? (readString(parsed, "thinkingLevel") ?? readString(data, "thinkingLevel")) : undefined;
			// custom 条目的 customType 在建索引时捕获：readSubagentRecords 等读者
			// 按 customType 过滤后只对目标行发起磁盘 IO，todo/om 等高频快照零读取。
			// custom_message（pi 的扩展通知落盘形态，子代理完成唤醒父会话就走这条）
			// 一并捕获：正文在条目顶层 content 而不是 message 里，建索引阶段只记类型与
			// display，正文留给需要展示的那一页懒读（会话文件可能有上千条这类快照）。
			const isCustomMessage = type === "custom_message";
			const customType = type === "custom" || isCustomMessage ? readString(parsed, "customType") : undefined;
			const assistantModel =
				message?.role === "assistant"
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
				customDisplay: isCustomMessage ? parsed.display === true : undefined,
				offset,
				byteLength,
				hasMessage: parsed.message !== undefined && parsed.message !== null,
				modelChangeProvider,
				modelChangeId,
				assistantModel,
				thinkingLevel,
				role: typeof message?.role === "string" ? message.role : undefined,
				// toolName 同样在建索引时顺手捕获：文件汇总只需要 write/edit/create/patch
				// 的工具结果，有了它就不必把 read/bash 的大体积结果读进内存再丢弃。
				toolName: readString(message, "toolName"),
				messageId: typeof message?.id === "string" ? message.id : undefined,
				messageTimestamp: typeof message?.timestamp === "number" ? message.timestamp : typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : undefined,
				summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
				firstKeptEntryId: typeof parsed.firstKeptEntryId === "string" ? parsed.firstKeptEntryId : undefined,
				timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
				tokensBefore: typeof parsed.tokensBefore === "number" ? parsed.tokensBefore : undefined,
			};
		} catch {
			return null;
		}
	}

	/** 从最后 entry 沿 parentId 回溯活动分支（与 JSONL 语义一致：leaf 沿父链到 root）。 */
	private traceActiveBranch(entries: Map<string, SessionDisplayEntry>, lastEntryId: string | undefined): SessionDisplayEntry[] {
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
	private finishIndex(hostPath: string, version: { size: number; mtimeMs: number }, entries: Map<string, SessionDisplayEntry>, activeBranch: SessionDisplayEntry[], endsWithNewline: boolean): SessionDisplayIndex {
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
	private async appendIndexFromTail(cached: SessionDisplayIndex, hostPath: string, version: { size: number; mtimeMs: number }): Promise<SessionDisplayIndex | null> {
		const length = version.size - cached.size;
		if (length <= 0) return null;
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
						const parsed = JSON.parse(probeBuffer.toString("utf8").replace(/\r$/, "")) as { id?: unknown };
						if (parsed.id !== probe.id) return null;
					} catch {
						return null;
					}
				}
			} finally {
				await handle.close();
			}
		} catch {
			return null;
		}
		// 新增区间同样流式扫描：pi 长时间运行后一次性追加也可能很大（几十 MB 工具输出），
		// 整段 Buffer + toString 与全量重建是同一类堆风险。
		const entries = new Map(cached.entries);
		const newEntries: SessionDisplayEntry[] = [];
		const scan = await scanJsonlLines(
			hostPath,
			(line, context) => {
				// 只解析完整行（以 \n 结尾）；尾部残行（pi 正在写）留给下一次 append/重建
				if (!context.complete) return;
				const parsed = this.parseIndexLine(line, context.offset, context.byteLength);
				if (parsed) {
					entries.set(parsed.id, parsed);
					newEntries.push(parsed);
				}
			},
			{
				start: cached.size,
				end: version.size,
				yieldEveryLines: SessionHistoryReader.INDEX_PARSE_YIELD_EVERY,
				onOversizedLine: (info) => {
					if (!info.complete) return;
					const stub = this.parseOversizedIndexLine(info);
					if (!stub) return;
					entries.set(stub.id, stub);
					newEntries.push(stub);
				},
			},
		);
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
		const pivotIndex = current ? cached.activeBranch.findIndex((entry) => entry.id === current.id) : -1;
		const baseBranch = pivotIndex >= 0 ? cached.activeBranch.slice(0, pivotIndex + 1) : cached.activeBranch;
		const nextBranch = [...baseBranch, ...chain];
		return this.finishIndex(hostPath, version, entries, nextBranch, scan.endsWithNewline);
	}

	/** 索引 LRU 上限裁剪：超出上限丢最旧（Map 迭代序 = 插入序）。 */
	private trimDisplayIndexCache() {
		while (this.sessionDisplayIndexes.size > SessionHistoryReader.SESSION_DISPLAY_INDEX_LIMIT) {
			this.sessionDisplayIndexes.delete(this.sessionDisplayIndexes.keys().next().value!);
		}
	}

	/**
	 * 定向读盘的并发上限。
	 *
	 * 一页最多 600~1600 个条目，`Promise.all(entries.map(read))` 会同时申请同等数量的
	 * Buffer（单条工具结果可达数 MB），并把 libuv 线程池与文件句柄压满——大会话翻页时
	 * 表现为「内存尖峰 + 主进程 IO 队列打满」。改为固定 worker 池后，峰值内存
	 * = 并发数 × 单条大小，与页大小解耦。
	 */
	private static readonly INDEXED_READ_CONCURRENCY = 8;

	/**
	 * 单批定向读的字节预算：一批内所有条目的 byteLength 之和不超过该值。
	 *
	 * 并发数单独不够：8 条 × 单条 50MB 的消息行仍是 400MB 的 Buffer（再叠 JSON
	 * 字符串与解析对象就是堆上限级别的尖峰）。字节预算让峰值内存与「一页有多大」
	 * 解耦，只与预算有关；单条自身超预算时独占一批（不拆行，保正确性）。
	 */
	private static readonly INDEXED_READ_BATCH_BYTES = 16 * 1024 * 1024;

	/**
	 * 按 entry 的 offset/byteLength 精确定向读行（不整文件读）。
	 *
	 * 注意：`oversized` 降级条目（正文超 64MiB 未解析）会返回空串——调用方按
	 * 「损坏行」处理（各自 try/catch 跳过）。不要在此处按 byteLength 分配 buffer，
	 * 否则等于把当初拒绝进内存的巨型行又搬回来。
	 */
	private async readIndexedLines(hostPath: string, entries: SessionDisplayEntry[]): Promise<string[]> {
		const lines = new Array<string>(entries.length).fill("");
		if (entries.length === 0) return lines;
		const handle = await open(hostPath, "r");
		const readOne = async (index: number): Promise<void> => {
			const entry = entries[index];
			if (entry.oversized) return;
			const buffer = Buffer.allocUnsafe(entry.byteLength);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
			lines[index] = buffer.subarray(0, bytesRead).toString("utf8").replace(/\r$/, "");
		};
		try {
			let cursor = 0;
			while (cursor < entries.length) {
				// 组一批：并发数上限 + 字节预算，两者先到者为准
				const batch: number[] = [];
				let batchBytes = 0;
				while (cursor + batch.length < entries.length && batch.length < SessionHistoryReader.INDEXED_READ_CONCURRENCY) {
					const entry = entries[cursor + batch.length];
					if (batch.length > 0 && batchBytes + entry.byteLength > SessionHistoryReader.INDEXED_READ_BATCH_BYTES) break;
					batchBytes += entry.byteLength;
					batch.push(cursor + batch.length);
				}
				await Promise.all(batch.map((index) => readOne(index)));
				cursor += batch.length;
			}
		} finally {
			await handle.close();
		}
		return lines;
	}

	private async readIndexedSessionMessages(hostPath: string, entries: SessionDisplayEntry[]): Promise<unknown[]> {
		const lines = await this.readIndexedLines(hostPath, entries);
		return lines.map((line) => (JSON.parse(line) as { message?: unknown }).message);
	}
	/**
	 * 与 readIndexedSessionMessages 同 IO 模式，但返回整行解析后的 JSON 对象
	 *（而非仅 .message）。供 readSubagentRecords 等需要完整自定义条目的读者使用。
	 */
	private async readIndexedRawLines(hostPath: string, entries: SessionDisplayEntry[]): Promise<unknown[]> {
		const lines = await this.readIndexedLines(hostPath, entries);
		return lines.map((line) => JSON.parse(line));
	}

	/**
	 * 直接从历史会话 JSONL 读取最近 N 轮对话。
	 * 必须走会 yield 的显示索引：attach 时若再整文件 split + JSON.parse，
	 * 主进程事件循环会被堵住，窗口关闭/最小化都点不了（pi 会话卡死、DSH 没事）。
	 * 返回兼容 get_messages 的 RpcResponse，供 loadMessages 复用。
	 */
	async readRecentMessages(sessionPath: string, maxTurns: number): Promise<RpcResponse> {
		const t0 = Date.now();
		let index: Awaited<ReturnType<SessionHistoryReader["getSessionDisplayIndex"]>>;
		try {
			index = await this.getSessionDisplayIndex(sessionPath);
		} catch (error) {
			// 新会话竞态：创建空白会话后 pi 立即返回 sessionFile，但 JSONL 要到首条
			// 消息才落盘——此刻读取 ENOENT 是「空历史」而不是加载失败（2026-09-14
			// 用户环境诊断：16:02:01 "Agent recent history file load failed" 即此形态，
			// 16:02:19 首轮完成后同一读取自然成功）。按空历史返回，不落错误卡片。
			const code = (error as NodeJS.ErrnoException | null)?.code;
			if (code === "ENOENT" || /ENOENT/.test(error instanceof Error ? error.message : String(error))) {
				void this.deps.logger?.info("agent", "Session file not created yet; treating recent history as empty", {
					sessionPath,
				});
				return {
					type: "response" as const,
					command: "get_messages",
					success: true,
					data: { messages: [] },
				};
			}
			throw error;
		}
		const total = index.activeMessageEntries.length;
		const boundedTurns = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.max(1, Math.floor(maxTurns)) : SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE;
		// 启动窗口要完整保留最近 N 轮（分页页边界统一按轮计，无字节裁剪），
		// 但极端会话里单轮可能有上千条，再叠一层条目预算（#213：2162 条一次下发 → 渲染 OOM）。
		const start = boundTurnWindowStart(index.activeMessageEntries, total, boundedTurns, SessionHistoryReader.MAX_LOAD_WINDOW_ENTRIES);
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
		const recordEntries = [...index.entries.values()].filter((entry) => entry.type === "custom" && (entry.customType === "subagents:record" || entry.customType === SessionHistoryReader.SUBAGENT_START_ENTRY)).sort((a, b) => a.offset - b.offset);
		if (recordEntries.length === 0) return [];

		const rawLines = await this.readIndexedRawLines(index.hostPath, recordEntries);
		const validStatuses = new Set<string>(["queued", "running", "completed", "steered", "aborted", "stopped", "error"]);
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
		const rawEntries: unknown[] = [];
		try {
			// 流式扫描：本函数是「全量扫」语义（这些插件不落 customType，无法走索引定向读），
			// 整文件 readFile 在大会话上会撞字符串上限/堆上限（见 jsonlLineStream 模块注释）。
			// 行级预检保留：不含 "acp_delegate" / "\"subagent\"" 的行直接跳过 JSON.parse。
			await scanJsonlLines(
				hostPath,
				(line) => {
					const jsonLine = line.endsWith("\r") ? line.slice(0, -1) : line;
					if (!jsonLine.includes("acp_delegate") && !jsonLine.includes('"subagent"')) return;
					try {
						const parsed: unknown = JSON.parse(jsonLine);
						if (isRecord(parsed)) rawEntries.push(parsed);
					} catch {
						// 损坏行忽略
					}
				},
				{ yieldEveryLines: SessionHistoryReader.INDEX_PARSE_YIELD_EVERY },
			);
		} catch (error) {
			void this.deps.logger?.warn("agent", "Failed to read session for subagent derivation", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
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
		const customEntries = [...index.activeBranch].reverse().filter((entry) => entry.type === "custom" && !entry.oversized);
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
