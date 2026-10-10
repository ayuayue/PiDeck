import { useCallback, useEffect, useRef, useState } from "react";
import type { PiDesktopApi } from "../../../preload";
import type { TerminalShell, TerminalTab, TerminalTarget } from "../../../shared/types";
import type { TerminalConfirmCloseMode } from "../../../shared/types/settings";
import { t } from "../i18n";
import { shouldConfirmTerminalClose } from "../terminalDockState";
import { showNotice } from "../utils/notice";

type TabState = { tabs: TerminalTab[]; activeTabId: string };
type TabScope = {
	active: boolean;
	target: TerminalTarget;
	terminal: PiDesktopApi["terminal"];
	pendingCreates: number;
	hydrating: boolean;
	closeWhenEmpty: boolean;
};

type TerminalDockTabsOptions = {
	target: TerminalTarget;
	terminal: PiDesktopApi["terminal"];
	enabled: boolean;
	confirmClose: TerminalConfirmCloseMode;
	onHydrate: (tabs: TerminalTab[]) => void;
	onCreated: (tab: TerminalTab) => void;
	onClosed: (tabIds: string[]) => void;
	onClose: () => void;
	onExpand: () => void;
};

/** 回放内容由 xterm owner 单独保管，标签状态不重复持有大缓冲。 */
function stripReplayBuffer(tab: TerminalTab): TerminalTab {
	const { buffer: _buffer, ...rest } = tab;
	return rest;
}

/** 报错保留原因，并说明是创建还是关闭失败；不伪装成已成功完成。 */
function reportFailure(key: "terminal.createFailed" | "terminal.closeFailed", error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	showNotice(`${t(key)}: ${message}`, 4000, "error");
}

/** 终端标签唯一状态 owner：异步操作从实时快照裁决，失效 runtime/卸载后的结果不再影响新面板。 */
export function useTerminalDockTabs(options: TerminalDockTabsOptions) {
	const latest = useRef(options);
	latest.current = options;
	const [state, setState] = useState<TabState>({ tabs: [], activeTabId: "" });
	const stateRef = useRef(state);
	const scopeRef = useRef<TabScope | null>(null);
	const [loading, setLoading] = useState(false);
	const [pendingCloseTab, setPendingCloseTab] = useState<TerminalTab | null>(null);
	const [confirmCloseAllOpen, setConfirmCloseAllOpen] = useState(false);
	const pendingCloseAllRef = useRef<TerminalTab[] | null>(null);
	const { target, terminal, enabled } = options;
	const targetKey = target.kind === "agent" ? JSON.stringify([target.kind, target.sessionId, target.agentId, target.runtimeGeneration]) : JSON.stringify([target.kind, target.projectId, target.cwd]);

	// 同步更新快照：不能等 React 下一次 render，两个 IPC 可在同一渲染批次内完成。
	const commit = useCallback((next: TabState) => {
		stateRef.current = next;
		setState(next);
	}, []);

	useEffect(() => {
		const scope: TabScope = { active: enabled, target, terminal, pendingCreates: 0, hydrating: enabled, closeWhenEmpty: false };
		scopeRef.current = scope;
		// 新 owner 的 ensure 尚未返回时，旧标签及其回放不能继续留在新面板。
		commit({ tabs: [], activeTabId: "" });
		latest.current.onHydrate([]);
		pendingCloseAllRef.current = null;
		setPendingCloseTab(null);
		setConfirmCloseAllOpen(false);
		if (!enabled) {
			setLoading(false);
			return;
		}
		setLoading(true);
		async function loadTabs() {
			try {
				const tabs = await terminal.ensure(scope.target);
				if (!scope.active) return;
				latest.current.onHydrate(tabs);
				commit({ tabs: tabs.map(stripReplayBuffer), activeTabId: tabs[0]?.id ?? "" });
			} catch (error) {
				if (!scope.active) return;
				commit({ tabs: [], activeTabId: "" });
				const message = error instanceof Error ? error.message : String(error);
				// pending runtime 尚未注册时沿用静默降级，等待父级提供新 target。
				if (!/Agent not found/i.test(message)) showNotice(message, 4000, "error");
			} finally {
				scope.hydrating = false;
				if (scope.active) {
					if (scope.pendingCreates === 0) latest.current.onHydrate(stateRef.current.tabs);
					setLoading(false);
				}
			}
		}
		void loadTabs();
		return () => {
			scope.active = false;
		};
	}, [targetKey, terminal, enabled, commit]);

	/** 实时归属用于事件与 xterm cleanup，不能等 React 下一次渲染才知道标签已被关闭。 */
	const ownsTab = useCallback((tabId: string) => Boolean(scopeRef.current?.active) && stateRef.current.tabs.some((tab) => tab.id === tabId), []);

	/** IPC 返回 tab ID 前可能先收到首个提示符；仅在加载/创建窗口暂存未知标签，结算后裁剪。 */
	const acceptsTabEvent = useCallback(
		(tabId: string) => {
			const scope = scopeRef.current;
			return Boolean(scope?.active && (ownsTab(tabId) || scope.hydrating || scope.pendingCreates > 0));
		},
		[ownsTab],
	);

	/** pending create 尚未结算时不隐藏 dock，否则新 PTY 已创建却无法呈现。 */
	function closeIfEmpty(scope: TabScope) {
		if (!scope.active || !scope.closeWhenEmpty || scope.pendingCreates > 0 || stateRef.current.tabs.length > 0) return;
		scope.closeWhenEmpty = false;
		latest.current.onClose();
	}

	/** 只移除 IPC 已成功关闭、且仍在实时列表中的标签，保留期间新增的标签。 */
	function removeClosedTabs(scope: TabScope, tabIds: string[]) {
		if (!scope.active) return;
		const closed = new Set(tabIds);
		const current = stateRef.current;
		const tabs = current.tabs.filter((tab) => !closed.has(tab.id));
		if (tabs.length === current.tabs.length) return;
		latest.current.onClosed(tabIds);
		commit({ tabs, activeTabId: tabs.some((tab) => tab.id === current.activeTabId) ? current.activeTabId : (tabs.at(-1)?.id ?? "") });
		scope.closeWhenEmpty = tabs.length === 0;
		closeIfEmpty(scope);
	}

	const setActiveTabId = useCallback(
		(id: string) => {
			const current = stateRef.current;
			if (current.tabs.some((tab) => tab.id === id)) commit({ ...current, activeTabId: id });
		},
		[commit],
	);

	const markExited = useCallback(
		(tabId: string, exitCode?: number) => {
			if (!scopeRef.current?.active) return;
			const current = stateRef.current;
			if (!current.tabs.some((tab) => tab.id === tabId)) return;
			commit({ ...current, tabs: current.tabs.map((tab) => (tab.id === tabId ? { ...tab, exited: true, exitCode } : tab)) });
		},
		[commit],
	);

	async function addTab(shell?: TerminalShell) {
		const scope = scopeRef.current;
		if (!scope?.active) return;
		scope.pendingCreates++;
		try {
			const next = await scope.terminal.create(scope.target, shell);
			if (!scope.active) return;
			latest.current.onCreated(next);
			commit({ tabs: [...stateRef.current.tabs, stripReplayBuffer(next)], activeTabId: next.id });
			scope.closeWhenEmpty = false;
			latest.current.onExpand();
		} catch (error) {
			if (scope.active) reportFailure("terminal.createFailed", error);
		} finally {
			scope.pendingCreates--;
			if (scope.active && !scope.hydrating && scope.pendingCreates === 0) latest.current.onHydrate(stateRef.current.tabs);
			closeIfEmpty(scope);
		}
	}

	async function performCloseTab(tab: TerminalTab) {
		const scope = scopeRef.current;
		if (!scope?.active || !stateRef.current.tabs.some((item) => item.id === tab.id)) return;
		try {
			await scope.terminal.close(tab.id);
			removeClosedTabs(scope, [tab.id]);
		} catch (error) {
			if (scope.active) reportFailure("terminal.closeFailed", error);
		}
	}

	async function closeTab(tab: TerminalTab) {
		const scope = scopeRef.current;
		if (!scope?.active) return;
		const mode = latest.current.confirmClose;
		let frontProcess = tab.frontProcess;
		if (mode === "running") {
			try {
				const fresh = await scope.terminal.list(scope.target);
				frontProcess = fresh.find((item) => item.id === tab.id)?.frontProcess ?? frontProcess;
			} catch {
				// 前台进程探测失败沿用本地快照；真正关闭仍须等待 IPC 成功。
			}
		}
		if (!scope.active || !stateRef.current.tabs.some((item) => item.id === tab.id)) return;
		if (shouldConfirmTerminalClose(mode, frontProcess, tab.shell)) {
			setPendingCloseTab(tab);
			return;
		}
		await performCloseTab(tab);
	}

	function cancelCloseAll() {
		pendingCloseAllRef.current = null;
		setConfirmCloseAllOpen(false);
	}

	/** allSettled 保留失败标签，成功标签照常清理；不会因单个拒绝遗留幽灵标签或未处理 rejection。 */
	async function closeAllTabs(captured = pendingCloseAllRef.current ?? stateRef.current.tabs) {
		const scope = scopeRef.current;
		if (!scope?.active || captured.length === 0) return;
		cancelCloseAll();
		const results = await Promise.allSettled(captured.map((tab) => scope.terminal.close(tab.id)));
		if (!scope.active) return;
		const closed: string[] = [];
		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled") closed.push(captured[index].id);
			else reportFailure("terminal.closeFailed", result.reason);
		}
		removeClosedTabs(scope, closed);
	}

	/** 确认只覆盖请求时的标签快照，不把探测/弹窗等待期间新开的进程顺手关掉。 */
	async function requestCloseAllTabs() {
		const scope = scopeRef.current;
		const captured = stateRef.current.tabs;
		if (!scope?.active || captured.length === 0) return;
		const mode = latest.current.confirmClose;
		let fresh = captured;
		if (mode === "running") {
			try {
				const ids = new Set(captured.map((tab) => tab.id));
				fresh = (await scope.terminal.list(scope.target)).filter((tab) => ids.has(tab.id));
			} catch {
				// 探测失败沿用请求时的本地快照。
			}
		}
		if (!scope.active) return;
		if (mode === "always" || fresh.some((tab) => shouldConfirmTerminalClose(mode, tab.frontProcess, tab.shell))) {
			pendingCloseAllRef.current = captured;
			setConfirmCloseAllOpen(true);
			return;
		}
		await closeAllTabs(captured);
	}

	return {
		tabs: state.tabs,
		activeTab: state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0],
		loading,
		pendingCloseTab,
		confirmCloseAllOpen,
		setActiveTabId,
		setPendingCloseTab,
		markExited,
		addTab,
		closeTab,
		performCloseTab,
		requestCloseAllTabs,
		closeAllTabs,
		cancelCloseAll,
		ownsTab,
		acceptsTabEvent,
	};
}
