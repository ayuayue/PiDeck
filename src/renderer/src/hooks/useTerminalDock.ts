import { useEffect, useRef, useState } from "react";
import { type TerminalDockOwner, type TerminalDockStateByOwner, setTerminalDockOpen, setTerminalDockCollapsed, pruneTerminalDockState, terminalOwnerKey, loadTerminalHeight, saveTerminalHeight, TERMINAL_HEIGHT_MIN } from "../terminalDockState";

const COMPOSER_DEFAULT_TERMINAL_HEIGHT = 220;
const TERMINAL_DOCK_MOTION_MS = 180;

/**
 * 终端 Dock 状态机（open / collapsed / 挂载动画）按 owner 隔离：
 * - 有 activeAgent → agent owner（`agent:<id>`）
 * - 引导页 / 未激活 agent / 历史会话 → project owner（`project:<id>`）
 * 切换项目或 agent 时，各 owner 的开关、折叠互不串台；
 * 挂载的 Dock 组件也只对「当前 owner」可见，切走即卸载（保留主进程 PTY 与回放）。
 *
 * 高度是全局一份（不按 owner 隔离）：与右侧抽屉宽度同策略，拖拽结果
 * 经 localStorage 持久化，跨重启恢复上次分屏大小。
 */
export function useTerminalDock(activeOwner: TerminalDockOwner | undefined) {
	const [terminalDockStateByOwner, setTerminalDockStateByOwner] = useState<TerminalDockStateByOwner>({});
	// 全局终端高度：首帧从 localStorage 读上次拖拽结果，读不到退回默认值
	const [terminalHeight, setTerminalHeightState] = useState(() => loadTerminalHeight(COMPOSER_DEFAULT_TERMINAL_HEIGHT));
	const [terminalDockMounted, setTerminalDockMounted] = useState(false);
	const [terminalDockClosing, setTerminalDockClosing] = useState(false);
	const [terminalDockOwnerKey, setTerminalDockOwnerKey] = useState<string>();
	const terminalDockCloseTimerRef = useRef<number | null>(null);

	const activeOwnerKey = activeOwner ? terminalOwnerKey(activeOwner) : undefined;
	// 兼容旧数据：早期版本曾把裸 agentId 当 key 写入，读取时原地兜底
	const terminalDockState = activeOwnerKey ? (terminalDockStateByOwner[activeOwnerKey] ?? terminalDockStateByOwner[activeOwner?.id ?? ""]) : undefined;
	const terminalOpen = Boolean(terminalDockState?.open);
	const terminalCollapsed = Boolean(terminalDockState?.collapsed);
	const terminalDockVisible = terminalDockMounted && terminalDockOwnerKey === activeOwnerKey;
	const terminalRowHeight = terminalHeight;

	// 轨道尺寸只在开关时变更一次，终端本身用 transform 完成合成动画。
	// 关闭时保留组件至动画结束，避免同步销毁 xterm 阻塞第一帧。
	// 切换 owner 时若新 owner 未打开，立即卸载，不把旧 owner 的关闭动画带到新上下文。
	useEffect(() => {
		if (terminalOpen && activeOwnerKey) {
			if (terminalDockCloseTimerRef.current != null) {
				window.clearTimeout(terminalDockCloseTimerRef.current);
				terminalDockCloseTimerRef.current = null;
			}
			setTerminalDockOwnerKey(activeOwnerKey);
			setTerminalDockClosing(false);
			setTerminalDockMounted(true);
			return;
		}
		if (!terminalDockMounted) return;
		if (terminalDockOwnerKey !== activeOwnerKey) {
			setTerminalDockMounted(false);
			return;
		}

		setTerminalDockClosing(true);
		terminalDockCloseTimerRef.current = window.setTimeout(() => {
			setTerminalDockMounted(false);
			setTerminalDockClosing(false);
		}, TERMINAL_DOCK_MOTION_MS);
		return () => {
			if (terminalDockCloseTimerRef.current != null) {
				window.clearTimeout(terminalDockCloseTimerRef.current);
				terminalDockCloseTimerRef.current = null;
			}
		};
	}, [activeOwnerKey, terminalDockOwnerKey, terminalDockMounted, terminalOpen]);

	/** 开关当前 owner 的终端（无 owner 时静默忽略，避免写坏 key） */
	function setTerminalOpenForOwner(open: boolean) {
		if (!activeOwnerKey) return;
		setTerminalOpenByOwnerKey(activeOwnerKey, open);
	}

	/** 折叠/展开当前 owner 的终端 */
	function setTerminalCollapsedForOwner(collapsed: boolean) {
		if (!activeOwnerKey) return;
		setTerminalCollapsedByOwnerKey(activeOwnerKey, collapsed);
	}

	/**
	 * 按 owner key 开关终端（分屏各栏解析自己的 owner 后调用）：
	 * 状态表本身按 owner 隔离，这里只是把「写哪个桶」的权交给调用方。
	 */
	function setTerminalOpenByOwnerKey(ownerKey: string, open: boolean) {
		setTerminalDockStateByOwner((current) => setTerminalDockOpen(current, ownerKey, open));
	}

	/** 按 owner key 折叠/展开终端（分屏各栏独立折叠互不串台） */
	function setTerminalCollapsedByOwnerKey(ownerKey: string, collapsed: boolean) {
		setTerminalDockStateByOwner((current) => setTerminalDockCollapsed(current, ownerKey, collapsed));
	}

	/**
	 * 回写终端分屏高度（分隔条拖拽 / 程序化 resize 共用入口）：
	 * 内存 state 驱动本帧布局，同时落 localStorage 跨重启恢复。
	 * clamp 到最小高度，避免拖拽异常值写坏布局。
	 */
	function setTerminalHeight(height: number) {
		const next = Math.max(TERMINAL_HEIGHT_MIN, Math.round(height));
		setTerminalHeightState((current) => (current === next ? current : next));
		saveTerminalHeight(next);
	}

	/**
	 * 清理已消失 owner 的终端开关状态：agent 键对照存活 agent 集合，project 键对照
	 * 存活项目集合，两个集合互不误删（流式事件只更新 agent 集合时不能清掉项目终端）。
	 * 高度已改为全局单份并持久化，不再参与 prune。
	 */
	function prune(liveAgentIds: Set<string>, liveProjectIds: Set<string>) {
		setTerminalDockStateByOwner((current) => pruneTerminalDockState(current, liveAgentIds, liveProjectIds));
	}

	return {
		terminalOpen,
		terminalCollapsed,
		terminalDockVisible,
		terminalDockClosing,
		terminalHeight,
		setTerminalOpenForOwner,
		setTerminalCollapsedForOwner,
		setTerminalHeight,
		setTerminalOpenByOwnerKey,
		setTerminalCollapsedByOwnerKey,
		terminalStatesByOwner: terminalDockStateByOwner,
		terminalDockMounted,
		terminalDockOwnerKey,
		prune,
	};
}
