import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_QUICK_MESSAGES } from "../../../shared/quickMessages";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { useQuickMessages } from "./useQuickMessages";

/** 打字合并成一次写盘的等待时间：太短会按字符写文件，太长会让「敲完就关」的落盘变迟。 */
const COMMIT_DEBOUNCE_MS = 400;

/**
 * 快捷消息条目维护的「编辑草稿」编排（设置页里那个管理弹框用，见 QuickMessagesDialog）。
 *
 * 从组件里抽出来的原因：它是一整套写盘时序（打字合并 + 结构性操作立即 + 卸载补写 + 外部改动重读），
 * 与渲染无关；留在组件里会让弹框组件同时承担状态机与排版两件事。
 *
 * 为什么要有本地 draft：主进程保存时会 normalize（去首尾空白/去重/截断），
 * 若每次按键都把清洗结果写回输入框，用户打的空格会被当场吃掉、光标乱跳。
 * 所以打字先进 draft（400ms 合并写盘），结构性操作（增删/排序/恢复默认）立即写盘，
 * 并在没有未落盘编辑时把界面交还给文件内容（显示清洗后的真实结果）。
 *
 * 空行是允许的编辑中间态（新增后还没填）：主进程 normalize 会丢弃，界面不为此报错。
 */
export function useQuickMessageEditor() {
	const { items, defaults, defaultsAvailable, filePath, loading, error, save, refresh, openFile } = useQuickMessages();
	// draft = 编辑中的原始文本；null = 未在编辑，界面直接跟随文件内容。
	const [draft, setDraft] = useState<string[] | null>(null);
	const pendingRef = useRef<string[] | null>(null);
	const timerRef = useRef<number | null>(null);

	const clearPending = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		pendingRef.current = null;
	}, []);

	// 组件卸载（关弹框、切 tab）或输入框失焦时，把还没落盘的打字补写一次，避免「敲完直接关」丢改动。
	const flushPending = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		const pending = pendingRef.current;
		pendingRef.current = null;
		if (pending) void save(pending);
	}, [save]);

	useEffect(() => () => flushPending(), [flushPending]);

	/** 结构性操作（增删/排序/恢复默认）：立刻写文件，并回读主进程清洗后的结果。 */
	const commitNow = useCallback(
		async (next: string[]) => {
			clearPending();
			setDraft(next);
			const ok = await save(next);
			if (!ok) return;
			// 期间用户又打字了就别抢回界面，继续用他的 draft。
			if (pendingRef.current === null) setDraft(null);
			showNotice(t("settings.quickMessagesSaved"), 2000);
		},
		[clearPending, save],
	);

	/** 打字：合并成一次写盘（成功不弹提示，避免逐字刷屏）。 */
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
		[save],
	);

	const rows = draft ?? items;

	/** 从配置文件重新读取（用户在外面用编辑器改完文件后点）：先把没落盘的打字写回去，再丢掉 draft 显示磁盘真实内容。 */
	const reload = useCallback(async () => {
		const pending = pendingRef.current;
		if (pending) {
			pendingRef.current = null;
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			await save(pending);
		}
		setDraft(null);
		await refresh();
	}, [refresh, save]);

	return {
		/** 界面上的行：编辑中优先，否则就是文件内容。 */
		rows,
		/** 已达条数上限（「添加」按钮据此禁用，并显示提示文案）。 */
		atLimit: rows.length >= MAX_QUICK_MESSAGES,
		defaults,
		defaultsAvailable,
		filePath,
		/** 首次读文件尚未返回。 */
		loading,
		error,
		/** 改某一行文本（合并写盘）。 */
		setItem: (index: number, text: string) => commitSoon(rows.map((item, current) => (current === index ? text : item))),
		/** 末尾追加一个空行（立即写盘；空行由主进程清洗时丢弃，因此只有真的填了字才落库）。 */
		addItem: () => void commitNow([...rows, ""]),
		removeItem: (index: number) => void commitNow(rows.filter((_, current) => current !== index)),
		/** 与相邻条目交换位置：越界直接忽略（首行上移 / 末行下移）。 */
		moveItem: (index: number, delta: -1 | 1) => {
			const target = index + delta;
			if (target < 0 || target >= rows.length) return;
			const next = [...rows];
			const [item] = next.splice(index, 1);
			next.splice(target, 0, item);
			void commitNow(next);
		},
		/** 用随包清单覆盖（资源文件缺失时按钮禁用，见 defaultsAvailable）。 */
		resetDefaults: () => void commitNow([...defaults]),
		reload,
		openFile,
		/** 输入框失焦时把未落盘的打字补写一次。 */
		flushPending,
	};
}
