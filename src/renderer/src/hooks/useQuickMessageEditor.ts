import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_QUICK_MESSAGES } from "../../../shared/quickMessages";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { appendMissingQuickMessages, reorderQuickMessages } from "../utils/quickMessageEditorModel";
import { useQuickMessages } from "./useQuickMessages";

/** 打字合并成一次写盘的等待时间：避免逐字写文件，失焦和卸载仍会补写。 */
const COMMIT_DEBOUNCE_MS = 400;

/**
 * 管理弹框的草稿与写盘编排：打字延迟保存，结构性操作立即保存。
 * 主进程会清洗空白/空行/重复项，因此补充和排序只改草稿结构，不把清洗回包塞回输入框。
 * refs 是命令的最新快照，state 只负责呈现：拖放、连续事件和刷新回包不能闭包旧 rows。
 */
export function useQuickMessageEditor() {
	const { items, defaults, defaultsAvailable, filePath, loading, error, save, refresh, openFile } = useQuickMessages();
	const [draft, setDraftState] = useState<string[] | null>(null);
	const [merging, setMerging] = useState(false);
	const draftRef = useRef<string[] | null>(null);
	const itemsRef = useRef(items);
	const defaultsRef = useRef({ items: defaults, available: defaultsAvailable });
	itemsRef.current = items;
	defaultsRef.current = { items: defaults, available: defaultsAvailable };
	const pendingRef = useRef<string[] | null>(null);
	const timerRef = useRef<number | null>(null);
	const mountedRef = useRef(true);
	const mergingRef = useRef(false);

	/** 同步更新命令快照，连续调用不必等待 React 下一帧。null 表示重新跟随磁盘。 */
	const setDraft = useCallback((next: string[] | null) => {
		draftRef.current = next;
		setDraftState(next);
	}, []);
	const getRows = useCallback(() => draftRef.current ?? itemsRef.current, []);

	/** 结构性保存已包含这些输入，只取消旧 debounce，不让它随后写回旧顺序。 */
	const clearPending = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		pendingRef.current = null;
	}, []);

	/** 失焦/卸载补写；即使已卸载也要发出保存，否则“敲完直接关”会丢最后几个字。 */
	const flushPending = useCallback(() => {
		const pending = pendingRef.current;
		clearPending();
		if (pending) void save(pending);
	}, [clearPending, save]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	useEffect(() => () => flushPending(), [flushPending]);

	/** keepDraft 用于补充/排序：保存不能顺带清掉仍在编辑的空行或首尾空白。 */
	const commitNow = useCallback(
		async (next: string[], keepDraft = false) => {
			clearPending();
			setDraft(next);
			const ok = await save(next);
			if (!ok || !mountedRef.current) return;
			// 合并期间即使一次结构性保存成功，也不能清空草稿：refresh 会先发布磁盘快照，
			// 必须让当前草稿继续作为个人顺序的权威来源，直到合并流程结束。
			if (!keepDraft && !mergingRef.current && draftRef.current === next) setDraft(null);
			showNotice(t("settings.quickMessagesSaved"), 2000);
		},
		[clearPending, save, setDraft],
	);

	/** 打字只更新草稿，后台写盘成功不弹提示，也不清洗正在输入的文本。 */
	const commitSoon = useCallback(
		(next: string[]) => {
			setDraft(next);
			pendingRef.current = next;
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => {
				timerRef.current = null;
				pendingRef.current = null;
				void save(next);
			}, COMMIT_DEBOUNCE_MS);
		},
		[save, setDraft],
	);

	/** 重读个人文件：保存或读取失败都保留草稿，等待期间的新输入也不能被回包清空。 */
	const reload = useCallback(async () => {
		const startingDraft = draftRef.current;
		const pending = pendingRef.current;
		if (pending) {
			clearPending();
			if (!(await save(pending)) || !mountedRef.current) return;
		}
		const snapshot = await refresh();
		if (snapshot && mountedRef.current && draftRef.current === startingDraft) setDraft(null);
	}, [clearPending, refresh, save, setDraft]);

	/**
	 * 补充不是恢复默认：读取最新随包清单，只追加当前个人草稿缺少的条目。
	 * 先固定当前行，防止 refresh 发布磁盘快照时挤掉个人顺序；成功前不碰 pending，
	 * 网络/IPC/资源读取失败时 debounce、失焦及卸载仍能照常保存原有输入。
	 */
	const mergeDefaults = useCallback(async () => {
		if (mergingRef.current || !mountedRef.current) return;
		mergingRef.current = true;
		setMerging(true);
		if (draftRef.current === null) setDraft([...getRows()]);
		try {
			const snapshot = await refresh();
			if (!snapshot || !mountedRef.current) return;
			if (!snapshot.defaultsAvailable) {
				showNotice(t("settings.quickMessagesDefaultsUnavailable"), 3000);
				return;
			}
			// 必须在 await 后取快照：读盘期间的输入、增删和排序都属于用户的最新意图。
			const current = getRows();
			const next = appendMissingQuickMessages(current, snapshot.defaults);
			if (next === current) {
				showNotice(t(current.length >= MAX_QUICK_MESSAGES ? "settings.quickMessagesLimit" : "settings.quickMessagesNothingToAdd", { max: MAX_QUICK_MESSAGES }), 2000);
				return;
			}
			await commitNow(next, true);
		} finally {
			mergingRef.current = false;
			if (mountedRef.current) setMerging(false);
		}
	}, [commitNow, getRows, refresh, setDraft]);

	/** 编辑命令均从 ref 取行；旧事件回调也只能基于最新草稿变换。 */
	const setItem = useCallback(
		(index: number, text: string) => {
			const current = getRows();
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return;
			commitSoon(current.map((item, row) => (row === index ? text : item)));
		},
		[commitSoon, getRows],
	);

	/** 空行只留在草稿中，填入内容后再落盘；不占用保存请求。 */
	const addItem = useCallback(() => {
		const current = getRows();
		if (current.length >= MAX_QUICK_MESSAGES) return;
		setDraft([...current, ""]);
	}, [getRows, setDraft]);

	const removeItem = useCallback(
		(index: number) => {
			const current = getRows();
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return;
			void commitNow(current.filter((_, row) => row !== index));
		},
		[commitNow, getRows],
	);

	/** 拖放与键盘上下移共用同一策略：非法下标和原地移动不写盘。 */
	const reorderItems = useCallback(
		(sourceIndex: number, targetIndex: number) => {
			const current = getRows();
			const next = reorderQuickMessages(current, sourceIndex, targetIndex);
			if (next !== current) void commitNow(next, true);
		},
		[commitNow, getRows],
	);
	const moveItem = useCallback((index: number, delta: -1 | 1) => reorderItems(index, index + delta), [reorderItems]);

	/** 显式恢复才整体覆盖个人清单，资源不可用不能误清空。 */
	const resetDefaults = useCallback(() => {
		if (defaultsRef.current.available) void commitNow([...defaultsRef.current.items]);
	}, [commitNow]);

	const rows = draft ?? items;
	return {
		rows,
		atLimit: rows.length >= MAX_QUICK_MESSAGES,
		defaults,
		defaultsAvailable,
		filePath,
		loading,
		error,
		merging,
		setItem,
		addItem,
		removeItem,
		moveItem,
		reorderItems,
		mergeDefaults,
		resetDefaults,
		reload,
		openFile,
		flushPending,
	};
}
