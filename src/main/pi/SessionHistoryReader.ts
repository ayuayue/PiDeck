import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage, ImageContent, PiSubagentEntry, SessionBranchNode, SessionBranchTree, SessionMessagePage, SessionTodoSnapshot } from "../../shared/types";
import { isSubagentDerivationInput } from "./derivedSubagents";
import { scanJsonlLines } from "../sessions/jsonlLineStream";
import { readBoundedEntryPage } from "../sessions/boundedEntryPage";
import type { HostPluginEntriesPage, HostPluginEntryCursor } from "../../shared/types/hostPlugin";
import type { SessionOutlineEntry, SessionOutlineSnapshot } from "../../shared/types/outline";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { RpcResponse } from "./PiRpcClient";
import type { AppLogger } from "../logging/AppLogger";
import { stoppedMessageFingerprint, type StoppedMessageIdentity } from "./stoppedMessageIdentity";
import { isRoleMessageRole } from "./sessionEntryIds";
import { applySessionContextEdits, collectSessionContextEdits, deriveSessionHistoryMetadata, extractResendContent, messageIndexFromEntryOffset, type SessionContextEditsDetail, type SessionContextEditsSummary, syntheticHistoryEntryId } from "./sessionReader/sessionMessageProjection";
import { contextEditTextOf, customEntryHeadline, INDEX_PREVIEW_MAX_CHARS, extractMessagePreviewFromLine, indexPreviewOf, isDisplayableCustomEntryType, isRecord, parseIndexTableRows, readString, type SessionDisplayReadOptions, stripLeadingRefBlocks } from "./sessionReader/sessionEntryParsing";
import { boundTurnWindowStart, clampTurnWindowStart, findTurnPageStart, resolveTurnPageBefore } from "./sessionReader/sessionTurnWindow";
import { SessionSubagentProjection } from "./sessionReader/sessionSubagentProjection";
import { SessionCardProjector } from "./sessionReader/sessionCardProjection";
import { SessionDisplayPaging } from "./sessionReader/sessionDisplayPaging";

export {
	applySessionContextEdits,
	boundTurnWindowStart,
	clampTurnWindowStart,
	collectSessionContextEdits,
	customEntryHeadline,
	extractMessagePreviewFromLine,
	findTurnPageStart,
	INDEX_PREVIEW_MAX_CHARS,
	indexPreviewOf,
	isDisplayableCustomEntryType,
	messageIndexFromEntryOffset,
	resolveTurnPageBefore,
	type SessionContextEditsDetail,
	type SessionContextEditsSummary,
	type SessionDisplayReadOptions,
	stripLeadingRefBlocks,
};

export type SessionModelSelection = {
	provider: string;
	modelId: string;
};

export type SessionHistoryMetadata = {
	model?: SessionModelSelection;
	thinkingLevel?: string;
};

export type SessionDisplayEntry = {
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
	/** 子代理推导候选行：保留消息体定向读取，不按 activeBranch 过滤。 */
	subagentCandidate?: boolean;
	/** 消息条目的 message.id：编辑/删除/重发缓存未命中时按 messageId 定位文件条目 */
	messageId?: string;
	/** 停止后 live ID 的安全回查窗口；只读时间邻近条目，避免整段历史按正文扫描。 */
	messageTimestamp?: number;
	/** 超长行降级条目：正文未解析（hasMessage 恒 false），只为维持 parentId 链而保留。 */
	oversized?: true;
	/**
	 * 用户消息首段文本（空白压成单空格，≤INDEX_PREVIEW_MAX_CHARS 码点）。
	 *
	 * 为什么建索引时顺手带走：整行本来就要 JSON.parse（正文已在内存），事后再为
	 * 导轨标题回读同一行是纯浪费。持久化进条目表后，未加载的历史也能显示真实提问文本
	 * （对齐 dsh session-turn-outline 的 prompt 预览口径；Go 侧镜像见 table.go）。
	 */
	preview?: string;
	summary?: string;
	firstKeptEntryId?: string;
	timestamp?: string;
	tokensBefore?: number;
	/** session 头条目的 parentSession 指针：pi fork 产物只存增量，历史在祖先文件里。 */
	parentSession?: string;
	/** fork 链合并索引中，本条目 offset 所属的文件（祖先条目非宿主文件）。 */
	chainHostPath?: string;
	/**
	 * context_edit 条目的编辑目标与替换文本。
	 *
	 * 为何要存改写文本：编辑后时间线必须显示用户刚写的新内容（否则一次编辑看起来
	 * 什么都没发生）。原文仍在文件里，展示层把它放进 meta 供查看。
	 * 注释、代码、大段正文都是用户手写的，体积远小于一次完整会话；
	 * 真正的内存红线是「为建索引把每条消息正文都读进来」，这里不是那条路。
	 */
	contextEditTargetId?: string;
	contextEditExcludes?: boolean;
	contextEditText?: string;
};

export type SessionDisplayIndex = {
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
	/** 活动分支上生效的 context_edit（pi 原生移除/改写记录）汇总（含改写文本，供展示替换正文）。 */
	contextEdits: SessionContextEditsDetail;
	/** 构建时文件是否以完整行（\n）结尾：false 时禁止增量追加（旧最后一行可能被拼接污染） */
	endsWithNewline: boolean;
	/**
	 * fork 链合并索引的祖先版本指纹（含祖先自身的链）：缓存命中时逐个 stat 校验，
	 * 祖先文件变化（罕见：supersede 后旧会话冻结）则回退全量重建。
	 */
	chainSources?: Array<{ hostPath: string; size: number; mtimeMs: number }>;
};

/** 索引来源（仅诊断日志用）：缓存命中 / 尾部增量 / sidecar 条目表 / TS 全量重建。 */
type DisplayIndexSource = "cache" | "append" | "sidecar" | "rebuild";

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
	/**
	 * 可选：向 session-store sidecar 索取条目表（Wave 2）。
	 *
	 * 返回 `unknown`（子进程输出不可信，由本模块的 validator 收窄）；
	 * 返回 null 表示 sidecar 不可用/失败，调用方回退逐行扫描。
	 */
	readIndexTable?: (hostPath: string, version: { size: number; mtimeMs: number }) => Promise<unknown>;
};

/**
 * 从 pi 消息 content 提取「重发」回填内容：string 或 blocks 数组（text/image）。
 * 图片同时兼容 pi flat data/mimeType 与 Anthropic source.data/media_type，和消息投影一致。
 */

/**
 * Reads persisted Session JSONL without starting Pi. Runtime ownership remains in
 * AgentManager; this reader owns bounded display paging and compaction recovery.
 */
/**
 * 会话路径不可寻址：不是「新会话文件尚未落盘」，而是这个路径本身不可能指向
 * 一个会话文件（错根/坏分隔符/父目录不存在）。
 *
 * 背景（2026-10-08 fork/copy 现场）：路径解析 bug 产出 `\home\…`（POSIX 不可寻址），
 * 读盘 ENOENT 被当「新会话竞态」静默返回空历史 → 运行时下发 0 条 → 渲染层把空缓存
 * 当已加载，时间线永久停在「正在加载会话历史」。空历史是正常态、错误是异常态，
 * 二者必须可区分，否则路径层 bug 永远隐身。
 */
export class SessionHistoryUnreachablePathError extends Error {
	readonly sessionPath: string;

	constructor(sessionPath: string, cause?: unknown) {
		super(`Session path is unreachable (parent directory does not exist): ${sessionPath}`);
		this.name = "SessionHistoryUnreachablePathError";
		this.sessionPath = sessionPath;
		if (cause !== undefined) {
			this.cause = cause;
		}
	}
}

/**
 * 宿主插件历史读取的边界守卫：只在 readPluginEntries 链路生效，桌面历史读取不受影响。
 * - authorizeSource：fork 祖先链每一跳读取前授权（跨项目 fork 不能借祖先链读到其他项目消息）；
 * - 预算：单次请求（含祖先链全部文件）的扫描字节与条目上限，超限拋稳定错误码显式拒绝；
 * - summary 截断：索引内存不保留超长 compaction summary；分页读原始字节不受影响。
 */
export type PluginHistoryGuard = {
	authorizeSource: (hostPath: string) => boolean | Promise<boolean>;
	maxScanBytes: number;
	maxEntries: number;
	maxSummaryChars: number;
	remaining: { bytes: number; entries: number };
};

export type SessionFactEntry = {
	id: string;
	parentId: string | null;
	type: string;
	role?: string;
	offset: number;
	byteLength: number;
	chainHostPath?: string;
	oversized?: true;
	// 以下元数据来自索引：事实读取不再为了普通事件读正文。
	timestamp?: string;
	summary?: string;
	customType?: string;
	modelChangeProvider?: string;
	modelChangeId?: string;
	thinkingLevel?: string;
	tokensBefore?: number;
};

/** 事实读取所需的只读索引视图：活动父链条目（文件序）+ 版本指纹。 */
export type SessionFactIndexSnapshot = {
	hostPath: string;
	size: number;
	mtimeMs: number;
	entries: SessionFactEntry[];
	chainSources?: Array<{ hostPath: string; size: number; mtimeMs: number }>;
	/** 会话头声明的 fork 来源；存在但 chainSources 缺失 = 祖先未合并。 */
	headerParentSession?: string;
};

export class SessionHistoryReader {
	private readonly sessionDisplayIndexes = new Map<string, SessionDisplayIndex>();
	/** 宿主插件读取的单槽索引缓存：预算截断后的专用投影，与桌面 LRU 隔离，避免无总量上限的堆积。 */
	private pluginIndex: { hostPath: string; index: SessionDisplayIndex } | undefined;
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
	/** 导轨目录上限：单次响应 10,000 项（2MiB 载荷的保守对应值）。 */
	static readonly MAX_OUTLINE_ENTRIES = 10_000;
	/** 标题展示长度（与 chip 标题同口径）。 */
	static readonly OUTLINE_TITLE_CHARS = 80;
	/**
	 * 轮次分页默认值：最近一次激活带 3 轮。
	 */
	static readonly DEFAULT_TURN_PAGE_SIZE = 3;
	/**
	 * 单页轮数上限。
	 *
	 * 曾经是 10：那时唯一的翻页路径是滚动（一次一屏），10 轮够用。
	 * 现在多了「点刻度从底部跳到顶部」：两次点击之间可能隔着上百轮，逐页 10 轮要补十几次，
	 * 每次一次 IPC + 一次文件解析（本机实测约 0.5s），用户看到的是「一直在加载」
	 * （2026-11 真机，156 轮会话）。
	 *
	 * 取值 200 的来历（可复算）：本机一份 156 轮会话 = 5156 条消息条目，即每轮约 33 条；
	 * 200 轮 ≈ 6600 条 ≈ 13-26MB 单页负载，落在渲染层 DISK_HISTORY_MESSAGE_LIMIT(8000)
	 * 之内，所以「一次读满一整份 156 轮会话」是可能的 —— 这正是用户要的「点一次就到位」。
	 * 再大的意义在于覆盖更长的会话，但单页负载会超过渲染层预算（超了就被整页丢弃，
	 * 反而跳不到），所以上限停在 200 轮 / PAGE_WINDOW_ENTRIES 条。
	 */
	private static readonly MAX_TURN_PAGE_SIZE = 200;
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
	 * 翻页单页的条目预算（轮数上界之上叠的条目硬上限）。
	 * 防御「上滚翻页反而把渲染进程撑爆」——轮数受 MAX_TURN_PAGE_SIZE 限制，但单轮可能有
	 * 数百条工具调用，200 轮照样能超。取 8000：与渲染层 DISK_HISTORY_MESSAGE_LIMIT
	 * 同一预算（200 轮 × 33 条 ≈ 6600 条，留约 20% 余量），页再大就会被渲染层整页丢弃；
	 * 单轮自身超预算时只能整轮保留。
	 */
	private static readonly MAX_PAGE_WINDOW_ENTRIES = 8000;

	/** 启动加载窗口条目预算（供 AgentManager 对齐窗口口径）。 */
	static maxLoadWindowEntries(): number {
		return SessionHistoryReader.MAX_LOAD_WINDOW_ENTRIES;
	}

	/** 翻页单页条目预算（供 AgentManager 缓存分页对齐口径）。 */
	static maxPageWindowEntries(): number {
		return SessionHistoryReader.MAX_PAGE_WINDOW_ENTRIES;
	}

	/** 子代理/待办投影：记录与派生扫描（协作者持有自己的增量缓存）。 */
	private readonly subagents: SessionSubagentProjection;
	/** 显示窗口的合成卡片：通知卡 / 扩展输出卡 / 压缩摘要卡的投影与插入。 */
	private readonly cards: SessionCardProjector;
	/** 三个显示读入口（整分支/窗口/轮次页）与轮次页预取。 */
	private readonly paging: SessionDisplayPaging;

	constructor(private readonly deps: SessionHistoryReaderDeps) {
		this.cards = new SessionCardProjector({
			readRawLines: (hostPath, entries) => this.readIndexedRawLines(hostPath, entries),
			convertMessages: (agentId, rawMessages, activeEntryIds) => this.deps.convertMessages(agentId, rawMessages, activeEntryIds),
			translate: (key, params) => this.deps.translate(key, params),
		});
		this.paging = new SessionDisplayPaging({
			getDisplayIndex: (sessionPath) => this.getSessionDisplayIndex(sessionPath),
			convertMessages: (agentId, rawMessages, activeEntryIds) => this.deps.convertMessages(agentId, rawMessages, activeEntryIds),
			readSessionMessages: (hostPath, entries) => this.readIndexedSessionMessages(hostPath, entries),
			scanCompactions: (sessionPath, sessionContent) => this.scanCompactions(sessionPath, sessionContent),
			cards: this.cards,
			translate: (key) => this.deps.translate(key),
			defaultTurnPageSize: SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE,
			maxTurnPageSize: SessionHistoryReader.MAX_TURN_PAGE_SIZE,
			maxLoadWindowEntries: SessionHistoryReader.MAX_LOAD_WINDOW_ENTRIES,
			maxPageWindowEntries: SessionHistoryReader.MAX_PAGE_WINDOW_ENTRIES,
		});
		this.subagents = new SessionSubagentProjection({
			getDisplayIndex: (sessionPath) => this.getSessionDisplayIndex(sessionPath),
			readRawLines: (hostPath, entries) => this.readIndexedRawLines(hostPath, entries),
			toHostPath: (sessionPath) => this.deps.toHostPath(sessionPath),
			scanLines: scanJsonlLines,
			scanDerivedSubagentEntriesFromIndex: (sessionPath, version) => this.scanDerivedSubagentEntriesFromIndex(sessionPath, version),
			yieldEveryLines: SessionHistoryReader.INDEX_PARSE_YIELD_EVERY,
			logger: this.deps.logger,
		});
	}

	/**
	 * 轨迹事实的只读索引视图：只返回活动父链的条目元数据（无正文）。
	 * 调用方按类型选候选后再用 readSessionFactLines 小批读，正文读取量与实际需要成正比。
	 */
	async getSessionFactIndex(sessionPath: string): Promise<SessionFactIndexSnapshot> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const header = [...index.entries.values()].find((entry) => entry.type === "session");
		return {
			hostPath: index.hostPath,
			size: index.size,
			mtimeMs: index.mtimeMs,
			entries: index.activeBranch.map((entry) => ({
				id: entry.id,
				parentId: entry.parentId,
				type: entry.type,
				role: entry.role,
				offset: entry.offset,
				byteLength: entry.byteLength,
				...(entry.chainHostPath ? { chainHostPath: entry.chainHostPath } : {}),
				...(entry.oversized ? { oversized: true as const } : {}),
				...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
				...(entry.summary ? { summary: entry.summary } : {}),
				...(entry.customType ? { customType: entry.customType } : {}),
				...(entry.modelChangeProvider ? { modelChangeProvider: entry.modelChangeProvider } : {}),
				...(entry.modelChangeId ? { modelChangeId: entry.modelChangeId } : {}),
				...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
				...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
			})),
			...(index.chainSources ? { chainSources: index.chainSources.map((source) => ({ ...source })) } : {}),
			...(header?.parentSession ? { headerParentSession: header.parentSession } : {}),
		};
	}

	/**
	 * 用户检查点目录（右侧导轨）：活动消息索引派生，过滤 context_edit 移出的条目。
	 * 超预算时保留首个与最近检查点，并告诉调用方被裁剪（不静默丢历史）。
	 */
	async readSessionOutline(sessionPath: string, limit = SessionHistoryReader.MAX_OUTLINE_ENTRIES): Promise<SessionOutlineSnapshot> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const excluded = new Set(index.contextEdits.excludedEntryIds);
		const all: SessionOutlineEntry[] = [];
		let ordinal = 0;
		for (let messageIndex = 0; messageIndex < index.activeMessageEntries.length; messageIndex += 1) {
			const entry = index.activeMessageEntries[messageIndex];
			if (entry.type !== "message" || entry.role !== "user" || excluded.has(entry.id)) continue;
			// 改写过的用户消息以改写文本为准（与时间线展示一致），否则用建索引时带走的预览。
			const preview = index.contextEdits.replacementText.get(entry.id) ?? entry.preview;
			all.push({
				entryId: entry.id,
				messageIndex,
				turnOrdinal: ordinal,
				...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
				...(preview ? { preview: clipOutlinePreview(preview) } : {}),
			});
			ordinal += 1;
		}
		if (all.length <= limit) return { entries: all, total: all.length, truncated: false };
		// 保留首个 + 最近 (limit-1) 个：会话开头的问题与当下的上下文同样重要。
		return { entries: [all[0], ...all.slice(all.length - (limit - 1))], total: all.length, truncated: true };
	}

	/** 读指定条目正文（复用索引读取的并发/字节预算与 fork 来源配对）。 */
	async readSessionFactLines(sessionPath: string, entries: SessionFactEntry[]): Promise<string[]> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		return this.readIndexedLines(
			index.hostPath,
			entries.map((entry) => ({ ...entry, hasMessage: entry.type === "message" }) satisfies SessionDisplayEntry),
		);
	}

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

	/** 整条活动分支的显示消息（无字节上界；危险语义与调用约束见 sessionDisplayPaging）。 */
	async readSessionDisplayMessages(sessionPath: string, agentId = "_viewer", sessionContent?: string, options?: SessionDisplayReadOptions): Promise<ChatMessage[]> {
		return this.paging.readSessionDisplayMessages(sessionPath, agentId, sessionContent, options);
	}

	async readLoadWindow(sessionPath: string, agentId = "_viewer", turnCount = SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE, maxEntries = SessionHistoryReader.MAX_LOAD_WINDOW_ENTRIES, options?: SessionDisplayReadOptions): Promise<{ messages: ChatMessage[]; total: number; windowStart: number }> {
		return this.paging.readLoadWindow(sessionPath, agentId, turnCount, maxEntries, options);
	}

	async readSessionDisplayTurnPage(sessionPath: string, agentId = "_viewer", before?: number, turnCount = SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE, beforeEntryId?: string, options?: SessionDisplayReadOptions): Promise<SessionMessagePage> {
		return this.paging.readSessionDisplayTurnPage(sessionPath, agentId, before, turnCount, beforeEntryId, options);
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

	/** 分支树预览的上限（条数）与单行读取字节上限：树视图只需要导航级摘要，
	 * 超出预算的条目降级为无预览节点，避免大体量会话把全文件读进内存。 */
	private static readonly BRANCH_PREVIEW_MAX_ENTRIES = 1000;
	private static readonly BRANCH_PREVIEW_MAX_LINE_BYTES = 256 * 1024;

	/**
	 * 会话分支树（右侧抽屉「分支」面板数据源）。
	 *
	 * 为什么不用 pi get_tree RPC：pi 会把整棵树打成单行 JSON，PiRpcClient 在 stdout
	 * data 回调里同步 JSON.parse 会冻窗（与 loadMessages 禁用 get_messages 同因）；
	 * 这里复用 JSONL 索引（含 fork 链合并），只读条目行补预览文本，天然流式有界。
	 *
	 * leafId 取文件活动分支末端：与 getActiveLeafId 同口径。若用户在 TUI 里 /tree
	 * 移动了 leaf 而未追加新条目，此处不会反映（PiDeck 内的 fork/重发都靠追加，不受影响）。
	 */
	async readBranchTree(sessionPath: string): Promise<SessionBranchTree> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		// children 表：同父按文件 offset 排序（=追加顺序）；孤儿（父链断裂，如墓碑父被合并
		// 进 fork 链外）按 pi get_tree 同语义提升为根。
		const childrenOf = new Map<string, SessionDisplayEntry[]>();
		const roots: SessionDisplayEntry[] = [];
		for (const entry of index.entries.values()) {
			const parent = entry.parentId ? index.entries.get(entry.parentId) : undefined;
			if (parent) {
				const siblings = childrenOf.get(parent.id);
				if (siblings) siblings.push(entry);
				else childrenOf.set(parent.id, [entry]);
			} else {
				roots.push(entry);
			}
		}
		const byOffset = (a: SessionDisplayEntry, b: SessionDisplayEntry) => a.offset - b.offset || (a.chainHostPath ?? "").localeCompare(b.chainHostPath ?? "");
		roots.sort(byOffset);
		for (const siblings of childrenOf.values()) siblings.sort(byOffset);

		// 预览文本：只给 message 条目读行；压缩/分支摘要用索引里的 summary，零 IO。
		const previewTargets: SessionDisplayEntry[] = [];
		for (const entry of index.entries.values()) {
			if (entry.type === "message" && entry.hasMessage && !entry.oversized && entry.byteLength <= SessionHistoryReader.BRANCH_PREVIEW_MAX_LINE_BYTES) {
				previewTargets.push(entry);
				if (previewTargets.length >= SessionHistoryReader.BRANCH_PREVIEW_MAX_ENTRIES) break;
			}
		}
		const previewLines = await this.readIndexedLines(index.hostPath, previewTargets);
		const previews = new Map<string, string>();
		for (let i = 0; i < previewTargets.length; i += 1) {
			const text = extractMessagePreviewFromLine(previewLines[i]);
			if (text) previews.set(previewTargets[i].id, text);
		}

		const toNode = (entry: SessionDisplayEntry): SessionBranchNode => ({
			id: entry.id,
			parentId: entry.parentId,
			role: entry.role === "user" || entry.role === "assistant" || entry.role === "system" ? entry.role : "other",
			entryType: entry.type,
			preview: previews.get(entry.id) ?? (entry.type === "compaction" || entry.type === "branch_summary" ? (entry.summary ?? "") : ""),
			label: entry.summary,
			timestamp: entry.timestamp ?? "",
			children: (childrenOf.get(entry.id) ?? []).map(toNode),
		});
		return {
			roots: roots.map(toNode),
			leafId: index.activeBranch.at(-1)?.id ?? null,
		};
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
	 * 活动分支上最终生效的 context_edit（含改写文本），供运行态窗口做与停止态一致的投影。
	 *
	 * 删除/编辑只向文件追加 `context_edit`，原文行仍在尾部窗口里（readRecentMessages
	 * 返回的是原始行）；运行态不应用这份过滤，启动 Agent 后被删消息就会「复活」（issue #482）。
	 * 只读索引缓存，不额外解析文件。
	 */
	async getSessionContextEdits(sessionPath: string): Promise<SessionContextEditsDetail> {
		return (await this.getSessionDisplayIndex(sessionPath)).contextEdits;
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
		// 编辑后的消息：显示/回填用的是有效文本（context_edit 的替换内容），不是文件里的原文。
		// 否则「编辑→再编辑」会把原文当成当前值回填，用户看到自己的上一次修改消失了。
		const replacement = index.contextEdits.replacementText.get(entry.id);
		return {
			entryId: entry.id,
			role: entry.role,
			text: replacement !== undefined ? replacement : extracted.text,
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

	/** 链深上限：重发/编辑可能连续 fork 多代；超深降级单文件读（丢祖先前缀，不阻塞打开）。 */
	private static readonly MAX_CHAIN_DEPTH = 8;

	/** Plugin history is the active branch, including compactions/custom entries, not provider input. */
	async readPluginEntries(sessionPath: string, cursor?: HostPluginEntryCursor, guard?: PluginHistoryGuard): Promise<HostPluginEntriesPage> {
		// 预算按次请求重置：同一 guard 不得跨请求累积剩余额度。
		if (guard) guard.remaining = { bytes: guard.maxScanBytes, entries: guard.maxEntries };
		const index = await this.getSessionDisplayIndexInner(sessionPath, 0, new Set(), guard);
		const version = JSON.stringify([index.mtimeMs, index.size, ...(index.chainSources ?? []).map((source) => [source.mtimeMs, source.size])]);
		const page = await readBoundedEntryPage(index.hostPath, index.activeBranch, version, cursor);
		// A rewrite/append during IO invalidates the whole page, not just its next cursor.
		const current = await stat(index.hostPath);
		if (current.mtimeMs !== index.mtimeMs || current.size !== index.size || !(await this.chainSourcesUnchanged(index))) throw new Error("history-changed");
		return page;
	}

	private async getSessionDisplayIndex(sessionPath: string, source?: { value: DisplayIndexSource }): Promise<SessionDisplayIndex> {
		// toHostPath 只在 inner 解析一次：调用次数是可观测契约（诊断测试按调用序断言）
		return this.getSessionDisplayIndexInner(sessionPath, 0, new Set(), undefined, source);
	}

	private async getSessionDisplayIndexInner(sessionPath: string, depth: number, visited: Set<string>, guard?: PluginHistoryGuard, source?: { value: DisplayIndexSource }): Promise<SessionDisplayIndex> {
		const hostPath = this.deps.toHostPath(sessionPath);
		const version = await stat(hostPath);
		// 插件读取走单槽缓存：不进桌面 LRU（32 文件无总量上限），内存只随最后一个会话 bounded。
		const cached = guard ? (this.pluginIndex?.hostPath === hostPath ? this.pluginIndex.index : undefined) : this.sessionDisplayIndexes.get(hostPath);
		if (cached && cached.size === version.size && cached.mtimeMs === version.mtimeMs && (await this.chainSourcesUnchanged(cached))) {
			if (!guard) {
				this.sessionDisplayIndexes.delete(hostPath);
				this.sessionDisplayIndexes.set(hostPath, cached);
			}
			if (source) source.value = "cache";
			return cached;
		}

		// 增量路径：文件变大且旧索引以完整行结尾 → 只读尾部新增字节并追加条目。
		// pi 运行中持续往 JSONL 追加行，运行中翻历史/看分页会反复触发索引失效；
		// 全量重建成本随文件线性增长，大会话（几十 MB 以上）会造成可感知卡顿。
		// 前置条件 endsWithNewline：旧最后一行以 \n 结尾，追加内容与旧内容边界干净。
		if (cached && version.size > cached.size && cached.endsWithNewline) {
			const updated = await this.appendIndexFromTail(cached, hostPath, version, guard);
			if (updated) {
				if (guard) this.pluginIndex = { hostPath, index: updated };
				else {
					this.sessionDisplayIndexes.delete(hostPath);
					this.sessionDisplayIndexes.set(hostPath, updated);
					this.trimDisplayIndexCache();
				}
				if (source) source.value = "append";
				return updated;
			}
			// 增量失败（IO 异常/无新增完整行）：回退全量重建
		}

		// Wave 2：TS 缓存未命中时先问 session-store sidecar（Go 侧 get-index）：同一份 JSONL 的
		// 条目表在 Go 侧解析一次即落快照，重复打开不必再逐行 JSON.parse（大会话实测全量重建
		// 87–165ms，快照命中降到个位数 ms）。行数据来自外部进程，形状不符即整体弃用，下面照旧
		// 回退 TS 逐行重建；末尾无完整行的文件也走 TS 路径（残行口径两侧不同，见 requestIndexTable）。
		const sidecarTable = this.parseIndexTable(await this.requestIndexTable(hostPath, version), hostPath);
		if (sidecarTable) {
			const sidecarEntries = new Map<string, SessionDisplayEntry>();
			let sidecarLastEntryId: string | undefined;
			for (const entry of sidecarTable.entries) {
				this.chargePluginGuard(guard, entry.byteLength, entry);
				sidecarEntries.set(entry.id, entry);
				sidecarLastEntryId = entry.id;
			}
			const sidecarBranch = this.traceActiveBranch(sidecarEntries, sidecarLastEntryId);
			const sidecarIndex = await this.mergeForkChain(hostPath, version, this.finishIndex(hostPath, version, sidecarEntries, sidecarBranch, sidecarTable.endsWithNewline), depth, visited, guard);
			if (source) source.value = "sidecar";
			return this.storeDisplayIndex(hostPath, guard, sidecarIndex);
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
					this.chargePluginGuard(guard, context.byteLength, parsed);
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
						this.chargePluginGuard(guard, info.byteLength);
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
		const index = await this.mergeForkChain(hostPath, version, this.finishIndex(hostPath, version, entries, activeBranch, endsWithNewline), depth, visited, guard);
		if (source) source.value = "rebuild";
		return this.storeDisplayIndex(hostPath, guard, index);
	}

	/** 索引落位：插件读取走独立槽位（预算口径），普通读取进 LRU 缓存。 */
	private storeDisplayIndex(hostPath: string, guard: PluginHistoryGuard | undefined, index: SessionDisplayIndex): SessionDisplayIndex {
		if (guard) this.pluginIndex = { hostPath, index };
		else {
			this.sessionDisplayIndexes.delete(hostPath);
			this.sessionDisplayIndexes.set(hostPath, index);
			this.trimDisplayIndexCache();
		}
		return index;
	}

	/**
	 * 向 session-store 索取条目表（Wave 2）。没注入 / 未就绪 / 抛错 / 形状不符都返回 null，
	 * 让调用方回退 TS 逐行扫描：sidecar 是加速器，不是必需品。
	 *
	 * 末尾没有换行的文件不用 sidecar 的表：TS 的逐行流会把末尾残行也交给 parseIndexLine
	 * （jsonlLineStream 的尾块语义），而 sidecar 只提交完整行，两侧条目集合会差最后一条。
	 */
	private async requestIndexTable(hostPath: string, version: { size: number; mtimeMs: number }): Promise<unknown> {
		const read = this.deps.readIndexTable;
		if (!read) return null;
		try {
			const table = await read(hostPath, version);
			if (isRecord(table) && table.endsWithNewline === false) return null;
			return table;
		} catch (error) {
			this.deps.logger?.warn("session-history", "Sidecar index table unavailable", { hostPath, error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	/** 校验 sidecar 行数据（外部进程输出不可信）：形状不符即整体弃用，不修不猜。 */
	private parseIndexTable(value: unknown, hostPath: string): { entries: SessionDisplayEntry[]; lastEntryId?: string; endsWithNewline: boolean } | null {
		if (value === null || value === undefined) return null;
		const table = parseIndexTableRows(value);
		if (!table) this.deps.logger?.warn("session-history", "Sidecar index table rejected", { hostPath });
		return table;
	}

	/** 插件读取的预算扣减与 summary 截断：超限拋稳定错误码；截断只影响索引内存，分页仍读原始字节。 */
	private chargePluginGuard(guard: PluginHistoryGuard | undefined, byteLength: number, entry?: SessionDisplayEntry): void {
		if (!guard) return;
		if (entry?.summary && entry.summary.length > guard.maxSummaryChars) entry.summary = `${entry.summary.slice(0, guard.maxSummaryChars)}…`;
		guard.remaining.bytes -= byteLength;
		if (entry) guard.remaining.entries -= 1;
		if (guard.remaining.bytes < 0 || guard.remaining.entries < 0) throw new Error("history-too-large");
	}

	/**
	 * parentSession 是 fork 来源标记，不代表子文件一定只含增量。共享 message id
	 * 表示子文件已复制活动前缀，以子文件为权威；仅增量文件才补祖先活动消息。
	 * 索引条目的 chainHostPath 与 offset/byteLength 成对保留，让时间线/分页/全文检索
	 * 从正确文件物化消息。此处只补展示层，不参与 pi 的模型上下文构建。
	 * 祖先缺失（被清理）或链超深/成环时降级为单文件索引：丢前缀但不阻塞打开。
	 */
	private async mergeForkChain(hostPath: string, version: { size: number; mtimeMs: number }, own: SessionDisplayIndex, depth: number, visited: Set<string>, guard?: PluginHistoryGuard): Promise<SessionDisplayIndex> {
		const parentSession = [...own.entries.values()].find((entry) => entry.type === "session")?.parentSession;
		if (!parentSession || depth >= SessionHistoryReader.MAX_CHAIN_DEPTH) return own;
		const parentHostPath = this.deps.toHostPath(parentSession);
		// 自引用（损坏头）与已访问路径都直接降级单文件读；深度上限兜底
		if (parentHostPath === hostPath || visited.has(parentHostPath)) return own;
		// 插件读取：fork 祖先可能指向其他项目的会话文件，每一跳都必须通过当前项目授权；
		// 未授权降级单文件读，与祖先缺失同语义（不阻塞打开，也绝不合并外部项目消息）。
		if (guard && !(await guard.authorizeSource(parentHostPath))) return own;
		visited.add(parentHostPath);
		let parent: SessionDisplayIndex;
		try {
			parent = await this.getSessionDisplayIndexInner(parentSession, depth + 1, visited, guard);
		} catch (error) {
			void this.deps.logger?.info("session-history", "Fork parent session unavailable; reading child without ancestor prefix", {
				hostPath,
				parentSession,
				error: error instanceof Error ? error.message : String(error),
			});
			return own;
		}
		// pi 的完整 fork 已复制活动前缀（沿用 entry id），子文件就是分支权威；
		// 再拼父分支不但重复消息，还会混入 fork 点之后/父会话后续追加的轮次。
		if (own.activeMessageEntries.some((entry) => parent.entries.has(entry.id))) return { ...own, chainSources: own.chainSources ?? [] };
		// 增量 fork 才补祖先消息；offset/byteLength 必须与原始来源文件配对，
		// 二级及以上的继承条目不能被重定向到直接父文件。
		const inherited = parent.activeMessageEntries.map((entry) => ({ ...entry, chainHostPath: entry.chainHostPath ?? parent.hostPath }));
		const entries = new Map<string, SessionDisplayEntry>();
		for (const entry of inherited) entries.set(entry.id, entry);
		for (const entry of own.entries.values()) entries.set(entry.id, entry);
		const activeBranch = [...inherited, ...own.activeBranch];
		return {
			hostPath: own.hostPath,
			size: version.size,
			mtimeMs: version.mtimeMs,
			hasCompaction: activeBranch.some((entry) => entry.type === "compaction"),
			entries,
			activeBranch,
			activeMessageEntries: activeBranch.filter((entry) => entry.type === "message" && entry.hasMessage),
			metadata: deriveSessionHistoryMetadata(activeBranch),
			contextEdits: collectSessionContextEdits(activeBranch),
			endsWithNewline: own.endsWithNewline,
			chainSources: [...(parent.chainSources ?? []), { hostPath: parent.hostPath, size: parent.size, mtimeMs: parent.mtimeMs }],
		};
	}

	/** 合并索引缓存命中时校验祖先文件指纹：祖先变化（罕见，supersede 后旧文件冻结）则回退重建。 */
	private async chainSourcesUnchanged(index: SessionDisplayIndex): Promise<boolean> {
		if (!index.chainSources?.length) return true;
		for (const source of index.chainSources) {
			try {
				const sourceVersion = await stat(source.hostPath);
				if (sourceVersion.size !== source.size || sourceVersion.mtimeMs !== source.mtimeMs) return false;
			} catch {
				return false;
			}
		}
		return true;
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
			// context_edit：pi 原生「把某条消息移出/改写模型上下文」的追加记录。
			// 建索引时只抢 targetId 与「是否排除」（replacement === null），正文不 materialize。
			const isContextEdit = type === "context_edit";
			const contextEditTargetId = isContextEdit ? (readString(parsed, "targetId") ?? readString(data, "targetId")) : undefined;
			const contextEditExcludes = isContextEdit && "replacement" in parsed && parsed.replacement === null ? true : undefined;
			// 替换文本：replacement.content 可能是字符串或内容块数组；只取可见文本，
			// 内容块数组里的图片等其它块在时间线上仍按原文展示（模型侧由 pi 投影）。
			const contextEditText =
				isContextEdit && contextEditExcludes !== true
					? (() => {
							const replacement = isRecord(parsed.replacement) ? parsed.replacement : undefined;
							const content = replacement?.content;
							if (typeof content === "string") return content;
							return Array.isArray(content) ? contextEditTextOf(content) : undefined;
						})()
					: undefined;
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
				subagentCandidate: isSubagentDerivationInput(parsed),
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
				// 预览只取用户消息：助手/工具正文可能几十 KB，导轨也用不到。
				preview: message?.role === "user" ? indexPreviewOf(message) : undefined,
				summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
				firstKeptEntryId: typeof parsed.firstKeptEntryId === "string" ? parsed.firstKeptEntryId : undefined,
				timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
				tokensBefore: typeof parsed.tokensBefore === "number" ? parsed.tokensBefore : undefined,
				// fork 子会话的 session 头携带 parentSession 指针：链式索引靠它找祖先文件
				parentSession: type === "session" ? (readString(parsed, "parentSession") ?? undefined) : undefined,
				...(contextEditTargetId ? { contextEditTargetId } : {}),
				...(contextEditExcludes !== undefined ? { contextEditExcludes } : {}),
				...(contextEditText !== undefined ? { contextEditText } : {}),
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
			contextEdits: collectSessionContextEdits(activeBranch),
			endsWithNewline,
		};
	}

	/**
	 * 增量索引：只读 [oldSize, newSize) 的新增字节，解析完整行后追加到既有索引。
	 * 新条目沿 parentId 回溯至旧分支节点（支持 fork/rewind 场景），旧分支保留。
	 * 返回 null 表示无可追加内容或 IO 失败（调用方回退全量重建）。
	 */
	private async appendIndexFromTail(cached: SessionDisplayIndex, hostPath: string, version: { size: number; mtimeMs: number }, guard?: PluginHistoryGuard): Promise<SessionDisplayIndex | null> {
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
				// 合并索引（fork 链）首条目可能来自祖先文件：探针只取宿主自身条目，
				// 否则用宿主句柄读祖先 offset 必然 id 不匹配 → 每次都误判回退全量重建。
				// 探针只取首/末两条宿主条目：`[...cached.entries.values()]` 每次 append 都要复制
				// 整张条目表（万级条目），而下面只用到两条（#483）。
				const hostEntries = { first: undefined as SessionDisplayEntry | undefined, last: undefined as SessionDisplayEntry | undefined };
				for (const entry of cached.entries.values()) {
					if (entry.chainHostPath) continue;
					hostEntries.first ??= entry;
					hostEntries.last = entry;
				}
				const probes = [hostEntries.first, hostEntries.last];
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
					this.chargePluginGuard(guard, context.byteLength, parsed);
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
					this.chargePluginGuard(guard, info.byteLength);
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
		// finishIndex 不感知 fork 链：增量追加不改变祖先集，保留合并索引的链指纹，
		// 否则缓存命中路径会跳过祖先文件变化校验。
		return { ...this.finishIndex(hostPath, version, entries, nextBranch, scan.endsWithNewline), chainSources: cached.chainSources };
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
		// fork 链合并索引里，祖先条目的 offset 属于祖先文件（chainHostPath）：
		// 按连续段分组、各自开句柄读，段内沿用并发+字节预算，段序 = 条目序。
		let cursor = 0;
		while (cursor < entries.length) {
			const sourcePath = entries[cursor].chainHostPath ?? hostPath;
			let end = cursor + 1;
			while (end < entries.length && (entries[end].chainHostPath ?? hostPath) === sourcePath) end += 1;
			await this.readIndexedLinesFrom(sourcePath, entries, cursor, end, lines);
			cursor = end;
		}
		return lines;
	}

	/** 读取 [start, end) 区间的条目字节（同一源文件）；结果按原下标写回 lines。 */
	private async readIndexedLinesFrom(sourcePath: string, entries: SessionDisplayEntry[], start: number, end: number, lines: string[]): Promise<void> {
		const handle = await open(sourcePath, "r");
		const readOne = async (index: number): Promise<void> => {
			const entry = entries[index];
			if (entry.oversized) return;
			const buffer = Buffer.allocUnsafe(entry.byteLength);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
			lines[index] = buffer.subarray(0, bytesRead).toString("utf8").replace(/\r$/, "");
		};
		try {
			let cursor = start;
			while (cursor < end) {
				// 组一批：并发数上限 + 字节预算，两者先到者为准
				const batch: number[] = [];
				let batchBytes = 0;
				while (cursor + batch.length < end && batch.length < SessionHistoryReader.INDEXED_READ_CONCURRENCY) {
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
		const indexSource: { value: DisplayIndexSource } = { value: "cache" };
		let index: Awaited<ReturnType<SessionHistoryReader["getSessionDisplayIndex"]>>;
		try {
			index = await this.getSessionDisplayIndex(sessionPath, indexSource);
		} catch (error) {
			// 新会话竞态：创建空白会话后 pi 立即返回 sessionFile，但 JSONL 要到首条
			// 消息才落盘——此刻读取 ENOENT 是「空历史」而不是加载失败（2026-09-14
			// 用户环境诊断：16:02:01 "Agent recent history file load failed" 即此形态，
			// 16:02:19 首轮完成后同一读取自然成功）。按空历史返回，不落错误卡片。
			//
			// 但 ENOENT 兜底只允许这种竞态：pi 打开持久会话时会 mkdirSync(recursive)
			// 会话目录（SessionManager 构造），所以「父目录存在、文件未落盘」是合法竞态；
			// 「父目录不存在」意味着路径本身不可寻址（错根/坏分隔符），文件永远不可能
			// 出现。此时继续按空历史返回会把加载失败伪装成空会话——现场表现是运行时
			// 下发 0 条 + 渲染层把空缓存当已加载，时间线永久停在「正在加载会话历史」
			// （2026-10-08 fork/copy 现场）。必须如实抛出，让错误卡片接手。
			const code = (error as NodeJS.ErrnoException | null)?.code;
			if (code === "ENOENT" || /ENOENT/.test(error instanceof Error ? error.message : String(error))) {
				const parentDir = dirname(this.deps.toHostPath(sessionPath));
				const parentExists = await stat(parentDir)
					.then((info) => info.isDirectory())
					.catch(() => false);
				if (parentExists) {
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
				void this.deps.logger?.warn("agent", "Session path is unreachable; not faking empty history", {
					sessionPath,
					parentDir,
				});
				throw new SessionHistoryUnreachablePathError(sessionPath, error);
			}
			throw error;
		}
		const total = index.activeMessageEntries.length;
		const boundedTurns = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.max(1, Math.floor(maxTurns)) : SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE;
		const indexEndedAt = Date.now();
		// 启动窗口要完整保留最近 N 轮（分页页边界统一按轮计，无字节裁剪），
		// 但极端会话里单轮可能有上千条，再叠一层条目预算（#213：2162 条一次下发 → 渲染 OOM）。
		const start = boundTurnWindowStart(index.activeMessageEntries, total, boundedTurns, SessionHistoryReader.MAX_LOAD_WINDOW_ENTRIES);
		const entries = index.activeMessageEntries.slice(start);
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
		const windowEndedAt = Date.now();
		const trimmed = this.deps.trimMessages(rawMessages, boundedTurns);
		const t1 = Date.now();

		// 分阶段计时（#483）：readMs 单个数字分不清「索引重建 / 窗口读盘解析 / 投影裁剪」，
		// 三者量级差一个数量级、修法完全不同，分开落日志才能定位下一次的成本回升。
		void this.deps.logger?.info("agent", "Recent messages read from session file", {
			sessionPath,
			activeMessages: total,
			messageEntries: rawMessages.length,
			trimmedTurns: boundedTurns,
			trimmedMessages: trimmed.length,
			indexMode: indexSource.value,
			indexMs: indexEndedAt - t0,
			windowMs: windowEndedAt - indexEndedAt,
			trimMs: t1 - windowEndedAt,
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
	async readSubagentRecords(sessionPath: string, options?: { liveRuntimeStartedAt?: number }): Promise<PiSubagentEntry[]> {
		return this.subagents.readSubagentRecords(sessionPath, options);
	}

	async readDerivedSubagentEntries(sessionPath: string): Promise<PiSubagentEntry[]> {
		return this.subagents.readDerivedSubagentEntries(sessionPath);
	}

	/**
	 * session-store 已经定位派生器所需的消息。
	 *
	 * 留在宿主：它读的是 display index（缓存 + 版本校对），并通过可替换的实例方法
	 * 暴露给子代理投影（调用方可换掉索引候选路径，只跑尾部扫描）。
	 */
	private async scanDerivedSubagentEntriesFromIndex(sessionPath: string, version: { size: number; mtimeMs: number } | null): Promise<{ rawEntries: unknown[]; bytesScanned: number; endsWithNewline: boolean } | null> {
		if (!version) return null;
		try {
			const index = await this.getSessionDisplayIndex(sessionPath);
			const entries = [...index.entries.values()];
			if (index.size !== version.size || index.mtimeMs !== version.mtimeMs || !index.endsWithNewline || entries.some((entry) => typeof entry.subagentCandidate !== "boolean")) return null;
			const candidates = entries.filter((entry) => entry.subagentCandidate && !entry.oversized).sort((a, b) => a.offset - b.offset);
			const rawEntries = (await this.readIndexedRawLines(index.hostPath, candidates)).filter(isSubagentDerivationInput);
			return { rawEntries, bytesScanned: version.size, endsWithNewline: true };
		} catch (error) {
			this.deps.logger?.warn("session-history", "Subagent candidate index unavailable", { sessionPath, error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	/**
	 * 读取会话分支上最新的 pi-deck-todo 快照（todo 工具变更时 appendEntry 持久化）。
	 * 只取最后一条：分支顺序即变更顺序，末条即当前计划；clear 后的快照无 activePlan → undefined。
	 */
	async readTodoSnapshot(sessionPath: string): Promise<SessionTodoSnapshot | undefined> {
		return this.subagents.readTodoSnapshot(sessionPath);
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

/** 索引预览 → 导轨卡片文本：压空白 + 截 80 字（卡片只有一行，全文留在账本/时间线里）。 */
function clipOutlinePreview(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > SessionHistoryReader.OUTLINE_TITLE_CHARS ? `${compact.slice(0, SessionHistoryReader.OUTLINE_TITLE_CHARS)}…` : compact;
}
