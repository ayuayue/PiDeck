import { useEffect, useRef, useState } from "react";
import { usePersistedPanelWidth } from "./usePersistedPanelWidth";

// Keep the default workbench geometry aligned with the main dev branch. The
// Session-first change only affects when a runtime begins, not sidebar width.
export const DEFAULT_LIST_WIDTH = 221;
/** 侧栏可调宽度下限/上限（AppShell 布局约束同源，禁止两处漂移）。
 * 下限 208 而非 100：侧栏顶部分段是 活动/聊天/项目 三个等宽 pill tab，
 * 每个含图标(14px)+gap+中文两字(约 24px)+padding，三个约 180px，
 * 再加 TabsList padding 与 sidebar-body 左右 padding(16px)，
 * 低于 200px 时第三个 tab 会被挤出/遮挡，用户无法切换分段。 */
export const LIST_WIDTH_MIN = 208;
export const LIST_WIDTH_MAX = 440;
/** 侧栏宽度是全局布局偏好（与项目无关），不按项目拆分存储键。 */
export const LIST_WIDTH_STORAGE_KEY = "pid:list-width";

export type UseResizeOptions = {
	storage?: Pick<Storage, "getItem" | "setItem">;
	/** durable settings 读取器；localStorage 只作为首屏缓存/旧版本迁移来源。 */
	loadPersistedWidth?: () => Promise<unknown>;
	/** durable settings 写入器；失败不应影响拖拽布局。 */
	persistWidth?: (width: number) => void | Promise<unknown>;
};

/** 将外部设置中的侧栏宽度规范化到面板可拖拽范围；非法值返回 null。 */
export function parseListWidth(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, Math.round(value)));
}

/**
 * 读取持久化侧栏宽度：
 * - 无存储/损坏/越界一律回退默认值
 * - 强制 clamp 到 [LIST_WIDTH_MIN, LIST_WIDTH_MAX]——即使本地曾被写入 0（折叠态）
 *   或极小值，恢复后也至少是可拖拽的最小宽度，绝不出现“侧栏窄到拖不动”。
 */
export function readListWidth(storage: UseResizeOptions["storage"] | undefined): number {
	if (!storage) return DEFAULT_LIST_WIDTH;
	try {
		const raw = storage.getItem(LIST_WIDTH_STORAGE_KEY);
		if (raw === null) return DEFAULT_LIST_WIDTH;
		const width = Number(raw);
		if (!Number.isFinite(width)) return DEFAULT_LIST_WIDTH;
		return parseListWidth(width) ?? DEFAULT_LIST_WIDTH;
	} catch {
		return DEFAULT_LIST_WIDTH;
	}
}

/** 写入持久化侧栏宽度；存储不可用时静默跳过，布局功能不受影响。 */
export function writeListWidth(storage: UseResizeOptions["storage"] | undefined, width: number) {
	try {
		storage?.setItem(LIST_WIDTH_STORAGE_KEY, String(width));
	} catch {
		// Storage is a convenience; layout must keep working when it is unavailable.
	}
}

/**
 * 侧栏宽度/折叠状态（#115 U5 起拖拽交互由 react-resizable-panels 承担，
 * 本 hook 只保留状态与折叠切换；composer 拖拽逻辑已随布局换装删除）。
 *
 * 持久化约定：
 * - 只记忆展开宽度（拖拽提交路径回写，AppShell 拖拽折叠时不会调用 setListWidth），
 *   从不记忆折叠状态——重启后侧栏总是展开，避免“上次折叠成 0 → 这次找不到侧栏”。
 * - 初始宽度先从 localStorage 恢复（clamp 到可调范围），随后由应用设置异步校准；
 *   宽度变化同步更新缓存，并延迟写入 durable settings。
 */
export function useResize(options: UseResizeOptions = {}) {
	const storageRef = useRef(options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined));
	storageRef.current = options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
	const [listWidth, setListWidth] = useState(() => readListWidth(storageRef.current));
	const [listCollapsed, setListCollapsed] = useState(false);
	useEffect(() => {
		writeListWidth(storageRef.current, listWidth);
	}, [listWidth]);
	usePersistedPanelWidth({
		width: listWidth,
		setWidth: setListWidth,
		normalize: parseListWidth,
		loadPersistedWidth: options.loadPersistedWidth,
		persistWidth: options.persistWidth,
	});

	function toggleListCollapsed() {
		const nextCollapsed = !listCollapsed;
		if (nextCollapsed) {
			// 收起后焦点仍可能留在侧栏中的控件上；先释放，避免隐藏内容保留键盘焦点。
			(document.activeElement as HTMLElement | null)?.blur();
		}
		setListCollapsed(nextCollapsed);
	}

	return {
		listWidth,
		setListWidth,
		listCollapsed,
		setListCollapsed,
		DEFAULT_LIST_WIDTH,
		toggleListCollapsed,
	};
}
