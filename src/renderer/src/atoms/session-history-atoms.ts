/**
 * 会话历史分页（disk 轮次页 / runtime 窗口前缀）与前缀调和规则。
 *
 * 从 `session-atoms.ts` 原样搬家而来（拆分，行为零变化）：两条翻页 atom、
 * 条数封顶与游标换算、文件同代判定（isSameSessionFileGeneration）、
 * 前缀去重与滑出轮并入（reconcileHistoryPrefix）、投影 id 稳定化
 *（stabilizeRuntimeMessageIds）、disk→runtime 交接（historyPrefixFromDiskPage）、
 * 回底清理（clearSessionHistoryAtom）。
 * 后三个函数被入口的运行时事件机调用，因此在此显式 export。
 * 入口 `session-atoms.ts` 用 `export *` 转出，所有既有 import 不变。
 */
import { atom } from "jotai";
import type { ChatMessage, SessionMessagePage } from "../../../shared/types";
import { releaseSessionOutlineProjection } from "./outlineProjectionCache";
import { findLastUserMessageIndex } from "./outlineRevision";
import type { SessionMessageCacheEntry } from "./session-atoms-types";
import { allocateSessionMessageOutlineRevision } from "./session-message-cache-atoms";
import { sessionMessagesCacheAtom } from "./session-state-atoms";

/**
 * disk 来源历史消息数组的驻留上限（2026 内存排查：浏览历史时 atom 数组无界增长）。
 * 预算口径是**消息条数**，不是轮数：一轮（提问 + 回答 + 工具调用）在本机长会话实测约 33 条
 * 消息（5156 条 / 156 轮），所以 2400 条只够 72 轮 —— 2026-11 真机一份 156 轮会话从底跳顶
 * 时必然撞墙。取 8000 条 ≈ 240 轮 ≈ 16-64MB 封顶（单条均值 2-8KB）；
 * 超限时丢弃最旧溢出部分并把数值游标前移（页内下标连续：nextBefore = 页最旧下标），
 * 被丢弃段仍可通过「显示更早」从主进程缓存/文件重新拉取。
 * DOM 窗口由 turnRenderWindow 独立控制（TIMELINE_MOUNTED_TURN_LIMIT），此处只管数据层封顶。
 */
export const DISK_HISTORY_MESSAGE_LIMIT = 8000;

/**
 * runtime 会话历史前缀（history.messages）的条数驻留上限，与 disk 路径同预算（2026-12
 * 内存排查根因 E：上翻页合并 merged=[...fresh,...base] 与 slideOut 长期累积均无上界，
 * 用户停在中途不回底时 clearSessionHistory 不会触发，前缀在 atom 缓存里无限增长）。
 * 超限同样从最旧端丢弃并校正续页游标：被丢段可经「显示更早」按新游标重新拉回，
 * 不产生永久丢失；两条翻页路径（disk / runtime）从此对称。
 */
export const RUNTIME_HISTORY_PREFIX_MESSAGE_LIMIT = DISK_HISTORY_MESSAGE_LIMIT;

/** 前缀最旧条目的 entryId（主进程缓存优先续页锚点）；整段无 entryId 时返回 undefined。 */
function firstHistoryEntryId(messages: ChatMessage[]): string | undefined {
	for (const message of messages) {
		const entryId = message.meta?.entryId;
		if (typeof entryId === "string" && entryId) return entryId;
	}
	return undefined;
}

export const prependSessionMessagePageAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			before: number;
			expectedRevision: number;
			page: SessionMessagePage;
		},
	) => {
		const current = get(sessionMessagesCacheAtom)[input.sessionId];
		if (!current || current.source !== "disk" || current.revision !== input.expectedRevision || current.page?.nextBefore !== input.before) {
			return false;
		}
		// 重叠防御：游标回退/并发翻页返回的页与已驻留段重复时按 entryId 滤掉页尾重叠部分
		// （正常路径无重叠，过滤是幂等保险）。
		const existingKeys = new Set(current.messages.map(messageEntryKey));
		const freshMessages = input.page.messages.filter((message) => !existingKeys.has(messageEntryKey(message)));
		const messages = [...freshMessages, ...current.messages];
		// 条数封顶：只允许丢弃新页头部（current 是用户当前视窗，不能截断）；
		// 游标换算：页内下标连续，部分丢弃 → 旧游标 + 丢弃数；整页丢弃 → 回到请求游标。
		let nextBefore = input.page.nextBefore;
		const overflow = messages.length - DISK_HISTORY_MESSAGE_LIMIT;
		if (overflow > 0 && freshMessages.length > 0) {
			const dropCount = Math.min(overflow, freshMessages.length);
			messages.splice(0, dropCount);
			if (overflow >= freshMessages.length) {
				// 整页都被预算丢掉：**不能**把游标退回请求游标 —— 退回去下次只会取到同一页，
				// 而同一页每次都会被同样丢掉，形成「一直在加载、永远加载不出来」的死循环
				// （2026-11 真机）。预算耗尽即更早的历史不可取，明确置空让「加载更多」消失。
				nextBefore = null;
			} else if (input.page.nextBefore !== null) {
				// 部分丢弃：保留段最旧一条 = 页最旧下标 + 丢弃条数
				nextBefore = input.page.nextBefore + dropCount;
			}
		}
		releaseSessionOutlineProjection(input.sessionId);
		set(sessionMessagesCacheAtom, {
			...get(sessionMessagesCacheAtom),
			[input.sessionId]: {
				...current,
				messages,
				page: { total: input.page.total, nextBefore },
				updatedAt: Date.now(),
				outlineRevision: allocateSessionMessageOutlineRevision(),
				outlineLastUserIndex: findLastUserMessageIndex(messages),
			},
		});
		return true;
	},
);
/** 历史前缀/窗口段的去重键：优先 pi entryId（跨下标空间稳定），缺省回退消息 id。 */
function messageEntryKey(message: ChatMessage): string {
	const entryId = message.meta?.entryId;
	return typeof entryId === "string" && entryId ? `e:${entryId}` : `m:${message.id}`;
}

/**
 * 历史前缀是否仍与当前会话文件同代。
 *
 * 版本串是 `mtime:size`（主进程 stat 与分页 indexVersion 同口径）。不能用「字符串不等」
 * 判异代：pi 每落盘一条消息都会**追加**写入，用户发一条消息 size 就会变——按不等即丢弃，
 * 已加载的历史前缀会在发送瞬间整段消失（2026-10-21 用户诊断包：历史只在回复结束后才回来）。
 * 同一分支的追加只会让文件变大；只有体积变小才说明历史被重写（压缩把历史换成摘要），
 * 此时前缀下标空间失效必须丢弃。版本缺失/无法解析一律按异代处理（宁缺勿串）。
 */
export function isSameSessionFileGeneration(prefixVersion: string | undefined, flushVersion: string | undefined): boolean {
	if (!flushVersion) return true;
	if (!prefixVersion) return false;
	if (prefixVersion === flushVersion) return true;
	const readSize = (version: string): number | undefined => {
		const size = Number(version.slice(version.lastIndexOf(":") + 1));
		return Number.isFinite(size) ? size : undefined;
	};
	const prefixSize = readSize(prefixVersion);
	const flushSize = readSize(flushVersion);
	if (prefixSize === undefined || flushSize === undefined) return false;
	// 追加：文件只会变大（mtime 变化不影响同代判定）。变小 = 被重写。
	return flushSize >= prefixSize;
}

/**
 * 运行时窗口段更新时调和 disk 历史前缀（2026-08 激活分页）：
 * - 文件被重写（体积变小，见 isSameSessionFileGeneration）→ 前缀绝对下标空间失效，整段丢弃；
 * - 窗口右移与前缀尾部重叠 → 按 entryId 去重（重叠部分以运行时窗口段为权威）；
 * - slideOut（trim 窗口右移滑出的旧窗口头部轮次）→ 并入前缀尾部，避免锚点轮空洞。
 */
export function reconcileHistoryPrefix(history: SessionMessageCacheEntry["history"], segment: ChatMessage[], fileVersion?: string, slideOut?: ChatMessage[]): SessionMessageCacheEntry["history"] {
	if (!history && (!slideOut || slideOut.length === 0)) return undefined;
	// 文件被重写（编辑/删除/压缩/外部变更导致体积缩小）时前缀内容可能已失效：
	// 编辑落在窗口外时，全量 flush 只带尾部窗口段，若旧前缀（尤其无 version 的异常前缀）
	// 继续拼回去，用户会看到「编辑了不刷新，再编一条才看到」。普通追加不算重写。
	if (fileVersion && !isSameSessionFileGeneration(history?.version, fileVersion)) {
		history = undefined;
	}
	const segmentKeys = new Set(segment.map(messageEntryKey));
	// 滑出轮与窗口段去重（防御：理论上不重叠），再与既有前缀去重，避免接缝重复
	const slideMessages = (slideOut ?? []).filter((message) => !segmentKeys.has(messageEntryKey(message)));
	const slideKeys = new Set(slideMessages.map(messageEntryKey));
	// 前缀同时按「窗口段」与「滑出轮」去重：窗口右移时前缀尾部与新段首部重叠，
	// 重叠部分以运行时窗口段为权威；滑出轮同理（不重叠时无操作）
	const dropKeys = new Set([...segmentKeys, ...slideKeys]);
	const prefixMessages = (history?.messages ?? []).filter((message) => !dropKeys.has(messageEntryKey(message)));
	const messages = [...prefixMessages, ...slideMessages];
	// 空页已经证明窗口前只有不投影的文件条目时，保留「已到头」游标；否则下次 flush
	// 丢掉空前缀，又会从窗口首条 entryId 反复请求同一空页。
	if (messages.length === 0) {
		if (history?.nextBefore === null && !history.nextBeforeEntryId) {
			return history.messages.length === 0 ? history : { ...history, messages: [] };
		}
		return undefined;
	}
	// 条数封顶（RUNTIME_HISTORY_PREFIX_MESSAGE_LIMIT）：slideOut 随窗口右移长期累积会把
	// 前缀推过上限——用户停在中途不上滑时 clearSessionHistory 不会触发，这里是唯一维护点。
	// 从最旧端丢弃：数值游标按丢弃量推进（前缀下标连续），entryId 锚点重算到保留段
	// 最旧条目，保证被丢段仍可经「显示更早」重新翻页拉回。
	const overflow = messages.length - RUNTIME_HISTORY_PREFIX_MESSAGE_LIMIT;
	const cappedMessages = overflow > 0 ? messages.slice(overflow) : messages;
	// 无滑出轮且前缀未被触碰：保留原对象引用，避免无谓的 atom 更新
	if (slideMessages.length === 0 && cappedMessages.length === (history?.messages.length ?? 0)) {
		return history;
	}
	// 仅 slideOut 重建前缀时，游标不是 null：下一页应从 slideOut 最旧消息继续向上翻。
	// 保留 nextBeforeEntryId（文件/主进程缓存路径都能消费），否则 historyHasMore 会把
	// 刚滑出的前缀误判为「已经到最早」，窗口右移后更早历史无法继续翻页。
	let nextBeforeEntryId = history?.nextBeforeEntryId;
	if (!history) {
		const slideAnchor = slideMessages.find((message) => typeof message.meta?.entryId === "string" && Boolean(message.meta.entryId));
		const slideAnchorEntryId = slideAnchor?.meta?.entryId;
		if (typeof slideAnchorEntryId === "string") nextBeforeEntryId = slideAnchorEntryId;
	}
	if (overflow > 0) {
		// 封顶丢弃后锚点必须重算：旧锚点指向被丢段时，缓存优先路径会从过期锚点继续翻页；
		// 保留段无 entryId 时退回旧锚点，维持 historyHasMore 的可见性。
		nextBeforeEntryId = firstHistoryEntryId(cappedMessages) ?? history?.nextBeforeEntryId;
	}
	return {
		nextBefore: overflow > 0 && typeof history?.nextBefore === "number" ? history.nextBefore + overflow : (history?.nextBefore ?? null),
		...(nextBeforeEntryId !== undefined ? { nextBeforeEntryId } : {}),
		version: history?.version ?? fileVersion,
		messages: cappedMessages,
	};
}

/**
 * 磁盘投影 → 运行时投影的消息 id 稳定化（2026-11 预热卡顿治理）。
 *
 * 同一条会话记录有两套投影 id：磁盘分页读（SessionHistoryReader，agentId 固定 "_viewer"）
 * 生成 `_viewer-history-<entryId>`；运行时全量 flush（AgentMessageProjector，agentId 为
 * 真实 agent）生成 `<agentId>-history-<entryId>`。会话静止时时间线读的是磁盘页，预热
 * （用户开始输入）启动 runtime 后首个全量 flush 会整体替换窗口段——若放任 id 前缀改写，
 * TurnRow 的 React key 逐条失配，可见轮次整体 remount（Markdown 重新解析 + 入场动画），
 * 布局跳动还会打断输入法合成（见 useTipTapComposerEditor 的 composition watchdog 注释），
 * 输入框焦点随之丢失。
 *
 * meta.entryId 跨投影稳定，是同一记录的权威身份：flush 到达时按 entryId 把窗口段 id
 * 重写回缓存里已有的显示 id，key 不变则轮次按内容复用，remount 消失。找不到映射
 * （新消息 / 缓存为空 / 无 entryId）时保留原 id；内容始终以运行时段为权威，只改身份
 * 不改内容。同 entryId 同时出现在前缀与窗口时以窗口 id 为准（与显示顺序一致）。
 */
export function stabilizeRuntimeMessageIds(current: SessionMessageCacheEntry | undefined, incoming: readonly ChatMessage[]): ChatMessage[] {
	if (!current || incoming.length === 0) return incoming as ChatMessage[];
	const idByEntryId = new Map<string, string>();
	for (const message of current.history?.messages ?? []) {
		const entryId = message.meta?.entryId;
		if (typeof entryId === "string" && entryId) idByEntryId.set(entryId, message.id);
	}
	for (const message of current.messages) {
		const entryId = message.meta?.entryId;
		if (typeof entryId === "string" && entryId) idByEntryId.set(entryId, message.id);
	}
	if (idByEntryId.size === 0) return incoming as ChatMessage[];
	let changed = false;
	const stabilized = incoming.map((message) => {
		const entryId = message.meta?.entryId;
		const stableId = typeof entryId === "string" ? idByEntryId.get(entryId) : undefined;
		if (stableId === undefined || stableId === message.id) return message;
		changed = true;
		return { ...message, id: stableId };
	});
	return changed ? stabilized : (incoming as ChatMessage[]);
}

/**
 * disk → runtime 交接：把「激活前时间线正在显示的磁盘页」转成 history 前缀。
 *
 * 为什么必须显式转（2026-10-21 用户诊断包）：会话停着时时间线读的是磁盘页
 * （source="disk"，历史就在 messages 里，没有 history 字段）。发送新消息触发 runtime
 * 恢复后，主进程按「激活分页」只下发尾部窗口段，全量 flush 分支只拿 current.history
 * 调和前缀——disk 条目没有这个字段，窗口段就整段替换掉磁盘历史，分页游标（page.nextBefore）
 * 同时丢失，表现为「历史全部消失、上滑没有加载入口」，只能等本轮结束后的下一次读盘才回来。
 * 首个 flush 若是 0 条空窗口（后台历史还没读出来 / 读取失败，日志里的
 * "Agent recent history file load failed"），画面更会直接变成空会话。
 *
 * 版本守卫：version 取磁盘页的 indexVersion（与主进程 flush 的 fileVersion 同口径
 * mtime:size）。普通追加（发消息落盘）不算重写；只有文件被重写（体积缩小，压缩把历史
 * 换成摘要）时 reconcileHistoryPrefix 才整段丢弃——宁缺勿串。磁盘页没有版本时不冒险
 * 保留（无法证明同代）。
 */
export function historyPrefixFromDiskPage(current: SessionMessageCacheEntry | undefined): SessionMessageCacheEntry["history"] | undefined {
	if (!current || current.source !== "disk" || current.messages.length === 0) return undefined;
	const version = current.page?.indexVersion;
	if (!version) return undefined;
	return {
		messages: current.messages,
		// 磁盘页到顶（null）就是到顶；否则沿用它的续页游标，上滑还能继续往更早翻。
		nextBefore: current.page?.nextBefore ?? null,
		...(current.page?.nextBeforeEntryId ? { nextBeforeEntryId: current.page.nextBeforeEntryId } : {}),
		version,
	};
}

/**
 * disk 轮次页 prepend（runtime 窗口会话的「加载更多对话」）。
 * 守卫：来源/revision/游标连续；版本漂移（压缩）时旧前缀整段作废、以新页为最新前缀起点。
 */
export const prependSessionHistoryPageAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			expectedRevision: number;
			/** Continuation cursor; undefined denotes the first history page. */
			before?: number | null;
			page: SessionMessagePage;
		},
	) => {
		const current = get(sessionMessagesCacheAtom)[input.sessionId];
		if (!current || current.source !== "runtime" || current.revision !== input.expectedRevision) {
			return false;
		}
		if (current.history && current.history.nextBefore !== input.before) return false;
		// 首屏历史页的游标：pi 是「文件头/entryId 锚点」（before 缺省），ACP 没有会话文件，
		// 首屏游标就是投递窗口起点（数组下标）。两种都接受，其余数值一律拒绝，
		// 否则一次错游标会把「窗口前那段」以外的消息拼进来。
		if (!current.history && input.before !== undefined && input.before !== current.windowStart) return false;

		const segmentKeys = new Set(current.messages.map(messageEntryKey));
		const pageMessages = input.page.messages.filter((message) => !segmentKeys.has(messageEntryKey(message)));
		const stalePrefix = Boolean(current.history?.version && input.page.indexVersion && current.history.version !== input.page.indexVersion);
		const baseMessages = stalePrefix ? [] : (current.history?.messages ?? []);
		const baseKeys = new Set(baseMessages.map(messageEntryKey));
		const freshMessages = pageMessages.filter((message) => !baseKeys.has(messageEntryKey(message)));
		const merged = [...freshMessages, ...baseMessages];
		// 条数封顶（RUNTIME_HISTORY_PREFIX_MESSAGE_LIMIT）：语义与 disk 路径的
		// prependSessionMessagePageAtom 一致——只允许丢新页头部（base 是用户已翻到的
		// 历史段不能截断）；整页丢弃时数值游标回退到请求游标（下次重取同页），部分丢弃时
		// 按页内连续下标推进 dropCount；entryId 锚点一律重算到保留段最旧条目。
		const overflow = merged.length - RUNTIME_HISTORY_PREFIX_MESSAGE_LIMIT;
		let cappedMessages = merged;
		let nextBefore: number | null = input.page.nextBefore;
		let nextBeforeEntryId: string | undefined = input.page.nextBeforeEntryId || undefined;
		if (overflow > 0 && freshMessages.length > 0) {
			const dropCount = Math.min(overflow, freshMessages.length);
			cappedMessages = merged.slice(dropCount);
			if (dropCount >= freshMessages.length) {
				// 同 disk 路径：整页丢弃时把游标退回请求值 = 重取同一页 = 死循环。置空为「没有更早」。
				nextBefore = null;
			} else if (input.page.nextBefore !== null) {
				nextBefore = input.page.nextBefore + dropCount;
			}
			nextBeforeEntryId = firstHistoryEntryId(cappedMessages);
		}
		releaseSessionOutlineProjection(input.sessionId);

		set(sessionMessagesCacheAtom, {
			...get(sessionMessagesCacheAtom),
			[input.sessionId]: {
				...current,
				// 即使第一页只有隐藏的 system 条目（投影后为空），也要保存 nextBefore:null，
				// 否则窗口首条 entryId 在下一次渲染时仍会误报「还有更早历史」。
				history: {
					messages: cappedMessages,
					nextBefore,
					...(nextBeforeEntryId !== undefined ? { nextBeforeEntryId } : {}),
					version: input.page.indexVersion ?? current.history?.version,
				},
				updatedAt: Date.now(),
				outlineRevision: allocateSessionMessageOutlineRevision(),
				outlineLastUserIndex: current.outlineLastUserIndex ?? findLastUserMessageIndex(current.messages),
			},
		});
		return true;
	},
);
/**
 * 回底清理临时历史（2026-11 轮次模型）：贴底稳定后把 runtime 会话翻过的历史前缀清掉，
 * 只保留运行时窗口段 —— atom 数据回到「最近 9 轮窗口」（DOM 3 / atom 9 / main 12 模型）；
 * 再次上翻走「atom → 主进程缓存 → 文件」三级递进重新拉取。
 * 仅窗口已有消息的 runtime 缓存生效；预热空窗口的历史是唯一内容，不能回收。disk 来源不清。
 */
export const clearSessionHistoryAtom = atom(null, (get, set, sessionId: string) => {
	const current = get(sessionMessagesCacheAtom)[sessionId];
	if (!current || current.source !== "runtime" || !current.history || current.messages.length === 0) return false;
	// 无可见历史消息的空前缀只作「文件头已确认」标记，回底不能清掉它。
	if (current.history.messages.length === 0 && current.history.nextBefore === null && !current.history.nextBeforeEntryId) return false;
	releaseSessionOutlineProjection(sessionId);
	set(sessionMessagesCacheAtom, {
		...get(sessionMessagesCacheAtom),
		[sessionId]: {
			...current,
			history: undefined,
			updatedAt: Date.now(),
			outlineRevision: allocateSessionMessageOutlineRevision(),
			outlineLastUserIndex: current.outlineLastUserIndex ?? findLastUserMessageIndex(current.messages),
		},
	});
	return true;
});
