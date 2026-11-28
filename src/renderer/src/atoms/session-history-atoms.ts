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

import { boundHistoryWindow, entryIdOf, HISTORY_WINDOW_MESSAGE_LIMIT, HISTORY_WINDOW_BYTE_BUDGET } from "./session-history-window";
export const RUNTIME_HISTORY_MESSAGE_LIMIT = HISTORY_WINDOW_MESSAGE_LIMIT;
export const RUNTIME_HISTORY_BYTE_BUDGET = HISTORY_WINDOW_BYTE_BUDGET;

/** Live slideOut keeps the newest prefix; user paging separately keeps the requested edge. */
export function boundHistoryPrefix(input: NonNullable<SessionMessageCacheEntry["history"]>): NonNullable<SessionMessageCacheEntry["history"]> {
	const result = boundHistoryWindow(input.messages, { total: input.messages.length, nextBefore: input.nextBefore, nextBeforeEntryId: input.nextBeforeEntryId ?? undefined, indexVersion: input.version }, "newer");
	return { ...input, messages: result.messages, ...(result.messages !== input.messages ? { nextBefore: null, nextBeforeEntryId: undefined, recoveryBeforeEntryId: entryIdOf(result.messages[0]) } : {}) };
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
		if (!current || (current.source !== "disk" && current.source !== "remote") || current.revision !== input.expectedRevision || current.page?.nextBefore !== input.before) {
			return false;
		}
		const remotePage = current.source === "remote";
		// 远端非空页必须带版本；无版本的消息无法证明与已缓存内容同代。
		if (remotePage && input.page.messages.length > 0 && !input.page.indexVersion) return false;
		// 远端页按 inode、mtime 与体积识别代际：原子替换、同体积原位重写或截断都拒绝；普通追加允许继续。
		if (remotePage && current.page?.indexVersion && input.page.indexVersion && !isSameSessionFileGeneration(current.page.indexVersion, input.page.indexVersion)) return false;
		// 重叠防御：游标回退/并发翻页返回的页与已驻留段重复时按 entryId 滤掉页尾重叠部分
		// （正常路径无重叠，过滤是幂等保险）。
		const existingKeys = new Set(current.messages.map(messageEntryKey));
		const freshMessages = input.page.messages.filter((message) => !existingKeys.has(messageEntryKey(message)));
		const merged = [...freshMessages, ...current.messages];
		const bounded = boundHistoryWindow(merged, { ...input.page, nextAfterEntryId: current.page?.nextAfterEntryId }, "older");
		if (remotePage && bounded.messages !== merged) throw new Error("REMOTE_SESSION_WINDOW_SLIDE_UNSUPPORTED");
		const messages = bounded.messages;
		const nextBefore = bounded.page.nextBefore;
		releaseSessionOutlineProjection(input.sessionId);
		// Keep the file-provided continuation cursor unchanged. Renderer virtualization bounds DOM;
		// clipping this cumulative cache would make older history unreachable.
		const nextBeforeEntryId = bounded.page.nextBeforeEntryId;
		const indexVersion = input.page.indexVersion ?? current.page?.indexVersion;
		set(sessionMessagesCacheAtom, {
			...get(sessionMessagesCacheAtom),
			[input.sessionId]: {
				...current,
				revision: current.revision + 1,
				bytes: undefined,
				messages,
				page: {
					total: input.page.total,
					nextBefore,
					...(nextBefore !== null && nextBeforeEntryId !== undefined ? { nextBeforeEntryId } : {}),
					...(bounded.page.nextAfterEntryId ? { nextAfterEntryId: bounded.page.nextAfterEntryId } : {}),
					...(indexVersion !== undefined ? { indexVersion } : {}),
				},
				updatedAt: Date.now(),
				outlineRevision: allocateSessionMessageOutlineRevision(),
				outlineLastUserIndex: findLastUserMessageIndex(messages),
			},
		});
		return true;
	},
);
export const appendSessionMessagePageAtom = atom(null, (get, set, input: { sessionId: string; afterEntryId: string; expectedRevision: number; page: SessionMessagePage }) => {
	const current = get(sessionMessagesCacheAtom)[input.sessionId];
	const history = current?.source === "runtime" ? current.history : undefined;
	const cursor = history ? history.nextAfterEntryId : current?.page?.nextAfterEntryId;
	if (!current || current.revision !== input.expectedRevision || cursor !== input.afterEntryId) return false;
	const version = history?.version ?? current.page?.indexVersion;
	if (version && input.page.indexVersion && !isSameSessionFileGeneration(version, input.page.indexVersion)) return false;
	if (input.page.nextAfterEntryId === input.afterEntryId) return false;
	const base = history?.messages ?? current.messages;
	const seen = new Set(base.map(messageEntryKey));
	const merged = [
		...base,
		...input.page.messages.filter((message) => {
			const key = messageEntryKey(message);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	];
	const bounded = boundHistoryWindow(
		merged,
		{ total: input.page.total, nextBefore: history?.nextBefore ?? current.page?.nextBefore ?? null, nextBeforeEntryId: history?.nextBeforeEntryId ?? current.page?.nextBeforeEntryId ?? undefined, nextAfterEntryId: input.page.nextAfterEntryId, indexVersion: input.page.indexVersion ?? version },
		"newer",
	);
	const runtimeKeys = new Set(current.messages.map(messageEntryKey));
	const joined = Boolean(history && input.page.messages.some((message) => runtimeKeys.has(messageEntryKey(message))));
	const updatedHistory = history
		? { messages: bounded.messages.filter((message) => !joined || !runtimeKeys.has(messageEntryKey(message))), nextBefore: bounded.page.nextBefore, nextBeforeEntryId: bounded.page.nextBeforeEntryId, nextAfterEntryId: joined ? undefined : bounded.page.nextAfterEntryId, version: bounded.page.indexVersion }
		: undefined;
	releaseSessionOutlineProjection(input.sessionId);
	const messages = history ? current.messages : bounded.messages;
	set(sessionMessagesCacheAtom, {
		...get(sessionMessagesCacheAtom),
		[input.sessionId]: { ...current, revision: current.revision + 1, bytes: undefined, messages, ...(history ? { history: updatedHistory } : { page: bounded.page }), updatedAt: Date.now(), outlineRevision: allocateSessionMessageOutlineRevision(), outlineLastUserIndex: findLastUserMessageIndex(messages) },
	});
	return true;
});

/** 历史前缀/窗口段的去重键：优先 pi entryId（跨下标空间稳定），缺省回退消息 id。 */
function messageEntryKey(message: ChatMessage): string {
	const entryId = message.meta?.entryId;
	return typeof entryId === "string" && entryId ? `e:${entryId}` : `m:${message.id}`;
}

/**
 * 历史前缀是否仍与当前会话文件同代。
 *
 * 版本串：本机为 `mtime:size`，远端为 `remote:<inode>:<mtime>:<size>`。普通追加会增大体积并允许续页；远端 inode 变化、体积缩小，或同体积 mtime 变化时必须丢弃旧前缀。
 */
export function isSameSessionFileGeneration(prefixVersion: string | undefined, flushVersion: string | undefined): boolean {
	if (!flushVersion) return true;
	if (!prefixVersion) return false;
	if (prefixVersion === flushVersion) return true;
	const prefixRemote = prefixVersion.startsWith("remote:");
	const flushRemote = flushVersion.startsWith("remote:");
	const readSize = (version: string): number | undefined => {
		const size = Number(version.slice(version.lastIndexOf(":") + 1));
		return Number.isFinite(size) ? size : undefined;
	};
	const prefixSize = readSize(prefixVersion);
	const flushSize = readSize(flushVersion);
	if (prefixSize === undefined || flushSize === undefined) return false;
	if (prefixRemote && flushRemote) {
		const parseRemoteVersion = (version: string): { identity?: string; modifiedAt?: string; size: number } | undefined => {
			const parts = version.split(":").slice(1);
			if (parts.length < 1 || parts.length > 3 || !parts.slice(0, -1).every((part) => /^\d+$/.test(part))) return undefined;
			const size = Number(parts.at(-1));
			if (!Number.isSafeInteger(size)) return undefined;
			if (parts.length === 1) return { size };
			if (parts.length === 2) return { identity: parts[0], size };
			return { identity: parts[0], modifiedAt: parts[1], size };
		};
		const prefix = parseRemoteVersion(prefixVersion);
		const flush = parseRemoteVersion(flushVersion);
		if (!prefix || !flush) return false;
		if (prefix.identity !== undefined && flush.identity !== undefined && prefix.identity !== flush.identity) return false;
		if (prefix.size === flush.size && prefix.modifiedAt !== undefined && flush.modifiedAt !== undefined && prefix.modifiedAt !== flush.modifiedAt) return false;
	}
	if (!prefixRemote && !flushRemote && prefixSize === flushSize && prefixVersion !== flushVersion) return false;
	// 普通追加允许继续；同体积重写拒绝。
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
	// A detached reader window must not absorb live slideOut across an unloaded gap.
	if (history?.nextAfterEntryId) return history;
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
	// 无滑出轮且前缀未被触碰：保留原对象引用，避免无谓的 atom 更新
	const retainedMessages = messages;
	if (slideMessages.length === 0 && retainedMessages.length === (history?.messages.length ?? 0)) {
		return history;
	}
	// 仅 slideOut 重建前缀时，用滑出轮最旧条目作为可恢复边界。
	let nextBeforeEntryId = history?.nextBeforeEntryId;
	if (!history) {
		const slideAnchor = slideMessages.find((message) => typeof message.meta?.entryId === "string" && Boolean(message.meta.entryId));
		const slideAnchorEntryId = slideAnchor?.meta?.entryId;
		if (typeof slideAnchorEntryId === "string") nextBeforeEntryId = slideAnchorEntryId;
	}
	// The visible runtime window stays intact; only the prepend-only prefix is bounded.
	const bounded = boundHistoryPrefix({
		messages: retainedMessages,
		nextBefore: history?.nextBefore ?? null,
		nextBeforeEntryId,
		version: history?.version ?? fileVersion,
		recoveryBeforeEntryId: history?.recoveryBeforeEntryId,
	});
	return {
		...bounded,
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
 * 版本守卫：version 取磁盘页的 indexVersion（本机 `mtime:size`，远端 `remote:<inode>:<mtime>:<size>`）。普通追加
 * 不算重写；版本可识别时压缩/替换的旧前缀会整段丢弃——宁缺勿串。磁盘页没有版本时不冒险保留。
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
		...(current.page?.nextAfterEntryId ? { nextAfterEntryId: current.page.nextAfterEntryId } : {}),
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
			replace?: boolean;
			/** Continuation cursor; undefined denotes the first history page. */
			before?: number | null;
			page: SessionMessagePage;
		},
	) => {
		const current = get(sessionMessagesCacheAtom)[input.sessionId];
		if (input.replace && current && current.source === "disk" && current.revision === input.expectedRevision) {
			const bounded = boundHistoryWindow(input.page.messages, input.page, "newer");
			set(sessionMessagesCacheAtom, { ...get(sessionMessagesCacheAtom), [input.sessionId]: { ...current, ...bounded, revision: current.revision + 1, updatedAt: Date.now(), outlineRevision: allocateSessionMessageOutlineRevision(), outlineLastUserIndex: findLastUserMessageIndex(bounded.messages) } });
			return true;
		}
		if (!current || current.source !== "runtime" || current.revision !== input.expectedRevision) {
			return false;
		}
		if (!input.replace && current.history && current.history.nextBefore !== input.before) return false;
		// 首屏历史页的游标：pi 是「文件头/entryId 锚点」（before 缺省），ACP 没有会话文件，
		// 首屏游标就是投递窗口起点（数组下标）。两种都接受，其余数值一律拒绝，
		// 否则一次错游标会把「窗口前那段」以外的消息拼进来。
		if (!current.history && input.before !== undefined && input.before !== current.windowStart) return false;

		const segmentKeys = new Set(current.messages.map(messageEntryKey));
		const pageMessages = input.page.messages.filter((message) => !segmentKeys.has(messageEntryKey(message)));
		const stalePrefix = Boolean(current.history?.version && input.page.indexVersion && !isSameSessionFileGeneration(current.history.version, input.page.indexVersion));
		const baseMessages = stalePrefix || input.replace ? [] : (current.history?.messages ?? []);
		const baseKeys = new Set(baseMessages.map(messageEntryKey));
		const freshMessages = pageMessages.filter((message) => !baseKeys.has(messageEntryKey(message)));
		const merged = [...freshMessages, ...baseMessages];
		const window = boundHistoryWindow(
			merged,
			{ total: input.page.total, nextBefore: input.page.nextBefore, nextBeforeEntryId: input.page.nextBeforeEntryId, nextAfterEntryId: input.replace ? input.page.nextAfterEntryId : current.history?.nextAfterEntryId, indexVersion: input.page.indexVersion ?? current.history?.version },
			input.replace ? "newer" : "older",
		);
		const bounded = { messages: window.messages, nextBefore: window.page.nextBefore, nextBeforeEntryId: window.page.nextBeforeEntryId, nextAfterEntryId: window.page.nextAfterEntryId, version: window.page.indexVersion };
		releaseSessionOutlineProjection(input.sessionId);

		set(sessionMessagesCacheAtom, {
			...get(sessionMessagesCacheAtom),
			[input.sessionId]: {
				...current,
				revision: current.revision + 1,
				bytes: undefined,
				// 即使第一页只有隐藏的 system 条目（投影后为空），也要保存 nextBefore:null，
				// 否则窗口首条 entryId 在下一次渲染时仍会误报「还有更早历史」。
				history: bounded,
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
			revision: current.revision + 1,
			bytes: undefined,
			history: undefined,
			updatedAt: Date.now(),
			outlineRevision: allocateSessionMessageOutlineRevision(),
			outlineLastUserIndex: current.outlineLastUserIndex ?? findLastUserMessageIndex(current.messages),
		},
	});
	return true;
});
