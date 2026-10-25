/**
 * 会话大纲 / 修改文件清单的派生 atom。
 *
 * 背景：这两份数据原本在 App 根组件里用 useMemo 计算，而 App 为了拿到消息数组
 * 直接订阅了 currentSessionMessagesAtom —— agent 活动期间每次消息 flush（50ms 节流）
 * 都会让 App 整棵树（含设置弹窗、文件抽屉等重组件）重渲染一次。把计算下沉为派生 atom 后，
 * 只有真正消费它们的组件（OutlinePanel / useFileEditor 事件路径）才订阅，
 * App 根组件只订阅「内容稳定」的派生结果，不再随消息流更新。
 *
 * 大纲投影按用户消息边界缓存：流式 assistant/tool 更新复用既有数组，只有新用户消息、
 * 历史前缀变化或低频重载才重建摘要，避免把 token 频率传导到右侧刻度。
 * 修改文件清单同样做内容投影缓存（见 modifiedFilesAtom）：字段全等时复用旧数组引用，
 * 否则 App 根会因每 50ms 一条新消息数组而全量重渲。
 */
import { atom, type Getter } from "jotai";
import { atomFamily } from "jotai/utils";
import { registerSessionFamilyForDisposal } from "./session-family-registry";
import type { ChatMessage } from "../../../shared/types";
import type { SessionModifiedFile } from "../components/app/AppParts";
import { buildOutline, getToolChangedLineCount, getToolFilePath, getToolNewContent } from "../components/app/AppUtils";
import { getSessionOutlineProjection, releaseSessionOutlineProjection, setSessionOutlineProjection, type SessionOutlineItems } from "./outlineProjectionCache";

import { currentSessionIdAtom, sessionMessagesCacheAtom, type SessionMessageCacheEntry } from "./session-atoms";

/** 从 tool 消息 meta 提取修改文件清单（纯计算，投影缓存命中时不重复执行）。 */
function computeModifiedFiles(messages: ChatMessage[]): SessionModifiedFile[] {
	const byPath = new Map<string, SessionModifiedFile>();
	for (const msg of messages) {
		if (msg.role !== "tool") continue;
		const toolName: string | undefined = msg.meta?.toolName as string | undefined;
		// 工具入参只可能是字符串或参数对象（导入器/投影器两路写入形态），先收窄再交给工具解析器
		const argsRaw: unknown = msg.meta?.args;
		const args = typeof argsRaw === "string" || (argsRaw && typeof argsRaw === "object") ? (argsRaw as string | Record<string, unknown>) : undefined;
		const status: string = String(msg.meta?.status ?? "done");
		// 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
		if (!toolName || !/write|edit|create|patch/i.test(toolName)) continue;
		const filePath = getToolFilePath(args);
		if (!filePath || !args) continue;
		const previous = byPath.get(filePath);
		// 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
		if (previous) byPath.delete(filePath);
		byPath.set(filePath, {
			path: filePath,
			toolName,
			status: status === "running" ? "running" : (previous?.status ?? status),
			changedLines: (previous?.changedLines ?? 0) + getToolChangedLineCount(toolName, args),
			originalContent: "",
			content: getToolNewContent(toolName, args) ?? previous?.content,
		});
	}
	return Array.from(byPath.values());
}

/** 两份清单内容是否一致（字段全比较；引用不同但语义相同时复用旧数组）。 */
function sameModifiedFiles(left: readonly SessionModifiedFile[], right: readonly SessionModifiedFile[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const previous = left[index];
		const next = right[index];
		if (previous.path !== next.path || previous.toolName !== next.toolName || previous.status !== next.status || previous.changedLines !== next.changedLines || previous.content !== next.content) return false;
	}
	return true;
}

/**
 * 修改文件清单投影缓存。
 *
 * 为什么需要（流式重渲染治理）：agent 活动期间主进程按 50ms 节流 flush 消息数组，
 * 每次 flush 都是新数组引用。若清单 atom 每次都返回新数组，订阅它的 App 根
 * 会以最高 20 次/秒重渲整棵组件树（文件抽屉挂几千行时就是持续性卡顿）。
 * 这里在内容未变时返回上一次的数组引用，jotai 的 Object.is 比较会让订阅者跳过渲染。
 */
const EMPTY_MODIFIED_FILES: SessionModifiedFile[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
let modifiedFilesProjection: {
	sessionId: string | undefined;
	messages: ChatMessage[] | undefined;
	result: SessionModifiedFile[];
} = { sessionId: undefined, messages: undefined, result: EMPTY_MODIFIED_FILES };

/**
 * 当前会话中 agent 修改过的文件（从 tool 消息 meta 中提取）。
 * 同一路径再次被修改时移到列表末尾，右侧修改清单按「最新修改」展示；
 * diff 展示使用工具参数（oldText/newText）计算变动区域。
 */
export const modifiedFilesAtom = atom((get) => {
	const sessionId = get(currentSessionIdAtom);
	const messages = sessionId ? (get(sessionMessagesCacheAtom)[sessionId]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
	if (modifiedFilesProjection.sessionId === sessionId && modifiedFilesProjection.messages === messages) {
		return modifiedFilesProjection.result;
	}
	const next = computeModifiedFiles(messages);
	// 会话切换/内容变化才允许产出新引用；内容相同必须复用旧数组，否则订阅者仍会被叫醒。
	const result = modifiedFilesProjection.sessionId === sessionId && sameModifiedFiles(modifiedFilesProjection.result, next) ? modifiedFilesProjection.result : next;
	modifiedFilesProjection = { sessionId, messages, result };
	return result;
});

/**
 * Projection values live in a cache keyed by the message-cache lifecycle rather
 * than in atom-family closures, so LRU eviction can release large histories.
 */
type OutlineItems = SessionOutlineItems;
type OutlineEntrySource = {
	sessionId: string;
	entry: SessionMessageCacheEntry | undefined;
};
const EMPTY_OUTLINE_ITEMS: OutlineItems = [];

function createOutlineItemsAtom(readEntry: (get: Getter) => OutlineEntrySource | undefined) {
	return atom((get) => {
		const source = readEntry(get);
		if (!source?.entry) {
			if (source) releaseSessionOutlineProjection(source.sessionId);
			return EMPTY_OUTLINE_ITEMS;
		}

		const { sessionId, entry } = source;
		if (entry.outlineRevision !== undefined) {
			const cached = getSessionOutlineProjection(sessionId, entry.outlineRevision);
			if (cached) return cached;
		}

		const messages = entry.history ? [...entry.history.messages, ...entry.messages] : entry.messages;
		const items = buildOutline(messages);
		if (entry.outlineRevision !== undefined) {
			setSessionOutlineProjection(sessionId, entry.outlineRevision, items);
		}
		return items;
	});
}
/** 当前聚焦会话的大纲条目（用户消息摘要），供右侧刻度定位轴展示。 */
export const outlineItemsAtom = createOutlineItemsAtom((get) => {
	const sessionId = get(currentSessionIdAtom);
	return sessionId ? { sessionId, entry: get(sessionMessagesCacheAtom)[sessionId] } : undefined;
});

/** 每个分屏会话自己的大纲条目，避免依赖当前聚焦会话。 */
export const outlineItemsBySessionIdAtomFamily = registerSessionFamilyForDisposal(
	atomFamily((sessionId: string) =>
		createOutlineItemsAtom((get) => ({
			sessionId,
			entry: get(sessionMessagesCacheAtom)[sessionId],
		})),
	),
);
