import type { ChatMessage, SessionMessagePage } from "../../../shared/types";
import type { SessionArchiveData, SessionDisplayEntry, SessionDisplayIndex } from "../SessionHistoryReader";
import type { SessionCardProjector } from "./sessionCardProjection";
import type { SessionDisplayReadOptions } from "./sessionEntryParsing";
import { applySessionContextEdits, collectSessionContextEdits, roleMessageEntryIds } from "./sessionMessageProjection";
import { boundTurnWindowStart, clampTurnWindowStart, resolveTurnPageBefore } from "./sessionTurnWindow";

/**
 * 三个「显示读」入口与轮次页预取：整分支读取、加载窗口、轮次分页。
 *
 * 三者是同一件事的三个截面：把显示索引的一段条目读成 `ChatMessage[]`，再把合成
 * 卡片（通知/扩展输出/压缩摘要）按同一下标空间插回去。所以它们住在一起，共用
 * 卡片协作者与同一条插入点口径；索引、定向读行、投影器、压缩归档都属于宿主
 * （窄接口注入），本模块只决定「读哪一段、卡片插哪儿、下一页预不预取」。
 */

/** 宿主提供给显示分页的窄接口（只列这里真正读到的成员）。 */
export type SessionDisplayPagingHost = {
	/** 显示索引（含 fork 链合并）。 */
	getDisplayIndex: (sessionPath: string) => Promise<SessionDisplayIndex>;
	/** 原始消息 → 显示消息（运行时/离线共用同一投影器）。 */
	convertMessages: (agentId: string, rawMessages: unknown[], activeEntryIds?: string[]) => ChatMessage[];
	/** 按条目 offset/byteLength 定向读行并取 `message` 体（并发与字节预算由宿主统一）。 */
	readSessionMessages: (hostPath: string, entries: SessionDisplayEntry[]) => Promise<unknown[]>;
	/** 压缩归档扫描（离线 viewer 已持有全文时直接走全文分支）。 */
	scanCompactions: (sessionPath: string, sessionContent?: string) => Promise<SessionArchiveData>;
	/** 合成卡片（通知卡/扩展输出卡/压缩摘要卡）。 */
	cards: SessionCardProjector;
	translate: (key: "session.summaryPlaceholder") => string;
	/** 轮次分页默认值（宿主静态常量，调用方也用同一口径）。 */
	defaultTurnPageSize: number;
	/** 单页轮数上限。 */
	maxTurnPageSize: number;
	/** 启动加载窗口的条目预算。 */
	maxLoadWindowEntries: number;
	/** 翻页单页的条目预算。 */
	maxPageWindowEntries: number;
};

export class SessionDisplayPaging {
	/** 轮次分页预取缓存上限（页数）。 */
	private static readonly PREFETCH_CACHE_LIMIT = 2;
	/**
	 * 轮次分页预取缓存（2026-09 上滚丝滑）：disk 路径翻页时在后台读取下一页
	 * 并暂存（键含文件版本/游标/页大小，pi 追加消息后自动失效），用户继续上滚时
	 * 命中缓存免磁盘 IO。只在「上一页已返回且还有下一页」时预取一页，不连锁递归。
	 */
	private readonly prefetchCache = new Map<string, SessionMessagePage>();

	constructor(private readonly host: SessionDisplayPagingHost) {}

	/**
	 * 整条活动分支的显示消息（**无字节上界**）。
	 *
	 * 危险：`sessionContent === undefined` 分支会把活动分支的每一行都读进内存并
	 * 逐条投影成显示对象——近 1 GiB 的会话足以顶爆主进程 384MB 老生代堆。
	 * 只有「确实需要完整时间线」的入口才可以用它；任何「先全量再切片」的用法
	 * 都必须改成有界读（窗口/分页）。2026-09 的「打开会话即闪退」就是这条路径被
	 * 「最近一轮修改的文件」借用导致的（该入口已于 2027-02 随 files tab 一并下线）。
	 */
	async readSessionDisplayMessages(sessionPath: string, agentId: string, sessionContent: string | undefined, options?: SessionDisplayReadOptions): Promise<ChatMessage[]> {
		// 调用方未把全文放进内存时必须走会 yield 的索引 + offset 读，
		// 否则离线 Viewer 打开大会话会整文件 split+JSON.parse，主进程照样卡死。
		if (sessionContent === undefined) {
			const index = await this.host.getDisplayIndex(sessionPath);
			const entries = index.activeMessageEntries;
			const rawMessages = await this.host.readSessionMessages(index.hostPath, entries);
			// 投影器的 entryId 槽位只对应角色消息：0.86 的 role:"system" 条目不能进 id 列表，
			// 否则其后所有消息的 meta.entryId 整体前移（按 entryId 定位的编辑/重发会落错条目）。
			const entryIds = roleMessageEntryIds(entries);
			const finalRaw = this.host.cards.insertCompactionSummaryRaw(index, rawMessages, 0);
			const messages = this.host.convertMessages(agentId, finalRaw, entryIds);
			// 整条分支读取：通知卡片同样要补（Web/Viewer 与桌面时间线保持同一口径，
			// 否则同一会话在两处会呈现不同的回合切分）。
			const cards = await this.host.cards.buildCustomMessageCards(index, agentId, {
				start: 0,
				end: entries.length,
				isTailWindow: true,
				entryRendererTypes: options?.entryRendererTypes ?? [],
			});
			return applySessionContextEdits(this.host.cards.applyCustomMessageCards(messages, cards, entries, 0, this.host.cards.resolveCompactionInsertOffset(index)), index.contextEdits);
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
			const archiveData = await this.host.scanCompactions(sessionPath, content);
			const card = {
				role: "compactionSummary",
				summary: compactionEntry.summary || this.host.translate("session.summaryPlaceholder"),
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

		return applySessionContextEdits(this.host.convertMessages(agentId, finalRaw, activeEntryIds), collectSessionContextEdits(activeBranch));
	}

	/**
	 * 一次性读取「加载窗口」内的历史消息（**有界**，供 Web 接口 / 兼容的整量读入口使用）。
	 *
	 * 为什么不做全量：JSONL 保留完整历史，全量下发在大会话上同时顶爆主进程（投影 + IPC
	 * 序列化）与渲染层（#213），而「读完整历史」这个需求本身应该走轮次分页
	 * （readSessionDisplayTurnPage / Web 的 /messages/page）。这里返回与桌面启动窗口
	 * 同口径的尾部窗口 + total/windowStart，让调用方知道是否被截断、从哪继续翻。
	 */
	async readLoadWindow(sessionPath: string, agentId: string, turnCount: number, maxEntries: number, options?: SessionDisplayReadOptions): Promise<{ messages: ChatMessage[]; total: number; windowStart: number }> {
		const index = await this.host.getDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		const windowStart = boundTurnWindowStart(index.activeMessageEntries, total, turnCount, maxEntries);
		const entries = index.activeMessageEntries.slice(windowStart);
		const rawMessages = await this.host.readSessionMessages(index.hostPath, entries);
		// 窗口 = 条目切片：压缩插入点（绝对下标）必须换算成本窗口内下标，
		// 否则压缩卡片会插进窗口内部靠前处/被挤到窗口末尾（readLoadWindow 是 Web 整量读入口）。
		const finalRaw = this.host.cards.insertCompactionSummaryRaw(index, rawMessages, windowStart);
		// 加载窗口覆盖到文件尾部：末条通知（offset === total）也属于它
		const cards = await this.host.cards.buildCustomMessageCards(index, agentId, {
			start: windowStart,
			end: total,
			isTailWindow: true,
			entryRendererTypes: options?.entryRendererTypes ?? [],
		});
		const messages = this.host.convertMessages(agentId, finalRaw, roleMessageEntryIds(entries));
		return {
			messages: this.host.cards.applyCustomMessageCards(messages, cards, entries, windowStart, this.host.cards.resolveCompactionInsertOffset(index)),
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
	async readSessionDisplayTurnPage(sessionPath: string, agentId: string, before: number | undefined, turnCount: number, beforeEntryId: string | undefined, options?: SessionDisplayReadOptions): Promise<SessionMessagePage> {
		const index = await this.host.getDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		// beforeEntryId：渲染层以「运行时窗口首条消息的 entryId」作为首次补历史的游标，
		// 解析为该 entry 在活跃分支的绝对下标（运行时窗口与 JSONL 是两个下标空间，
		// entryId 是唯一的对齐锚点）。解析失败回退为 undefined（= 从尾部起页）。
		const boundedBefore = resolveTurnPageBefore(before, beforeEntryId, index.activeMessageEntries, total);
		// 锚点解析失败且没有数值游标：明确回「没有更早历史」，不能静默回退到尾部（#474）。
		if (boundedBefore === null) {
			return { messages: [], total, nextBefore: null, nextBeforeEntryId: undefined, indexVersion: `${index.mtimeMs}:${index.size}`, ...index.metadata };
		}
		const boundedTurnCount = Number.isFinite(turnCount) ? Math.min(Math.max(1, Math.floor(turnCount)), this.host.maxTurnPageSize) : this.host.defaultTurnPageSize;

		// 预取命中：直接返回缓存页（键 = 文件版本 + 游标 + 页大小，版本变化即失效）。
		const entryRendererTypes = options?.entryRendererTypes ?? [];
		const prefetchKey = this.buildPrefetchKey(sessionPath, index, boundedBefore, boundedTurnCount, entryRendererTypes);
		if (prefetchKey) {
			const cached = this.prefetchCache.get(prefetchKey);
			if (cached) {
				// LRU 刷新：先删后插保持 Map 迭代序 = 最近使用序。
				this.prefetchCache.delete(prefetchKey);
				this.prefetchCache.set(prefetchKey, cached);
				return cached;
			}
		}

		const page = await this.readTurnPageCore(index, agentId, boundedBefore, boundedTurnCount, entryRendererTypes);
		// 预取下一页（仅当还有更早历史）——不阻塞当前请求、失败静默。
		this.enqueuePrefetch(page, sessionPath, index, boundedTurnCount, entryRendererTypes);
		return page;
	}

	/**
	 * 读单页核心实现（无缓存、不触发预取）：预取调用本方法而非公共分页方法，
	 * 保证「预取不再触发预取」，避免连锁递归读盘。
	 */
	private async readTurnPageCore(index: SessionDisplayIndex, agentId: string, boundedBefore: number, boundedTurnCount: number, entryRendererTypes: readonly string[]): Promise<SessionMessagePage> {
		const total = index.activeMessageEntries.length;
		// 起点必须严格小于 boundedBefore，否则 slice 得空页而 nextBefore 仍等于它（#474 死循环）。
		const start = clampTurnWindowStart(boundTurnWindowStart(index.activeMessageEntries, boundedBefore, boundedTurnCount, this.host.maxPageWindowEntries), boundedBefore);

		// 与普通轮次页一致：压缩会话的归档语义未游标化前走索引切片
		if (index.hasCompaction) {
			// 同一索引空间：索引切片 + 转换 + 页内卡片。
			const entries = index.activeMessageEntries.slice(start, boundedBefore);
			const rawMessages = await this.host.readSessionMessages(index.hostPath, entries);
			const messages = await this.host.cards.convertCompactionPageMessages(index, agentId, rawMessages, roleMessageEntryIds(entries), start, entries);
			// 压缩页里已有一张压缩卡片占了槽位，通知卡片按同一插入点做 +1 补偿
			const cards = await this.host.cards.buildCustomMessageCards(index, agentId, {
				start,
				end: boundedBefore,
				// 只有末页（游标已到文件尾部）才包含 offset === total 的尾部通知
				isTailWindow: boundedBefore >= total,
				entryRendererTypes,
			});
			return {
				messages: applySessionContextEdits(this.host.cards.applyCustomMessageCards(messages, cards, entries, start, this.host.cards.resolveCompactionInsertOffset(index)), index.contextEdits),
				total,
				nextBefore: start > 0 ? start : null,
				nextBeforeEntryId: start > 0 ? index.activeMessageEntries[start]?.id : undefined,
				indexVersion: `${index.mtimeMs}:${index.size}`,
				...index.metadata,
			};
		}

		const entries = index.activeMessageEntries.slice(start, boundedBefore);
		const rawMessages = await this.host.readSessionMessages(index.hostPath, entries);
		// 通知卡片归属唯一一页：半开区间 [start, end) 不含 offset === end（那是下一页的开头）；
		// 末页例外——它后面没有更新的页，offset === total 的尾部通知属于它。
		const cards = await this.host.cards.buildCustomMessageCards(index, agentId, {
			start,
			end: boundedBefore,
			isTailWindow: boundedBefore >= total,
			entryRendererTypes,
		});
		return {
			messages: applySessionContextEdits(this.host.cards.applyCustomMessageCards(this.host.convertMessages(agentId, rawMessages, roleMessageEntryIds(entries)), cards, entries, start), index.contextEdits),
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
	private buildPrefetchKey(sessionPath: string, index: SessionDisplayIndex, before: number, turnCount: number, entryRendererTypes: readonly string[]): string | undefined {
		if (!index.hostPath) return undefined;
		// 注册集合参与键：用户改扩展配置后（类型集合变化），旧缓存页的扩展输出卡口径随之失效。
		return `${sessionPath}|${index.mtimeMs}:${index.size}|${before}|${turnCount}|${entryRendererTypes.join(",")}`;
	}

	/**
	 * 后台预取下一页：当前页还有更早历史（nextBefore 非 null）时读取下一页
	 * 并存入 LRU（上限 PREFETCH_CACHE_LIMIT 页）。失败静默——预取是优化不是功能。
	 * 只预取一页不连锁（下一页到达时不再次触发预取），避免无限递归读盘。
	 */
	private enqueuePrefetch(page: SessionMessagePage, sessionPath: string, index: SessionDisplayIndex, turnCount: number, entryRendererTypes: readonly string[]): void {
		if (page.nextBefore === null || page.nextBefore <= 0) return;
		const nextKey = this.buildPrefetchKey(sessionPath, index, page.nextBefore, turnCount, entryRendererTypes);
		if (!nextKey || this.prefetchCache.has(nextKey)) return;
		// 后台读，不阻塞当前请求；单错不传播（预取失败下次点击仍可正常读盘）。
		// 走 readTurnPageCore 而不是公共分页方法：预取不再触发预取（无连锁递归）。
		void this.readTurnPageCore(index, "_prefetch", page.nextBefore, turnCount, entryRendererTypes)
			.then((nextPage) => {
				this.prefetchCache.delete(nextKey);
				this.prefetchCache.set(nextKey, nextPage);
				this.trimPrefetchCache();
			})
			.catch(() => undefined);
	}

	/** 预取缓存 LRU 裁剪：超出上限丢最旧（Map 迭代序 = 插入序）。 */
	private trimPrefetchCache(): void {
		while (this.prefetchCache.size > SessionDisplayPaging.PREFETCH_CACHE_LIMIT) {
			this.prefetchCache.delete(this.prefetchCache.keys().next().value!);
		}
	}
}
