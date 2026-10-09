import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedPanelWidth } from "./usePersistedPanelWidth";
import type { BranchDiffResult, CommitDetail, CommitEntry, ExternalEditor, GitChangedFile, GitResourceGroupType, GitResourceGroups, GitWorkspaceFileDiff } from "../../../shared/types";

export const DRAWER_ANIMATION_MS = 120;
export const EDITOR_TAB_LIMIT = 5;
export const EDITOR_TAB_TEXT_BUDGET = 24 * 1024 * 1024;

/** rpcLog 是临时面板：绑定 agentId 的实时日志，关闭即还原打开前的面板，不参与项目持久化 */
export type WorkspaceDrawerPanel = "files" | "sessions" | "browser" | "git" | "trajectory" | "branchTree" | "rewind" | "scratchPad" | "rpcLog";
export type WorkspaceEditorMode = "view" | "diff";

export type WorkspaceEditorTab = {
	id: string;
	filePath: string;
	mode: WorkspaceEditorMode;
	originalContent: string;
	modifiedContent?: string;
	allowSave: boolean;
	tabKey?: string;
	label?: string;
	preserveDrawer?: boolean;
	lastAccess: number;
};

export type WorkspaceGitDiffSnapshot = GitWorkspaceFileDiff & {
	projectId: string;
	label: string;
};

export type GitDiffLifecycleState = {
	request: number;
	snapshot: WorkspaceGitDiffSnapshot | null;
	displayMode: "modal" | "drawer";
};

/** Closing or leaving Git invalidates both the snapshot and every in-flight response. */
export function invalidateGitDiffState(state: GitDiffLifecycleState): GitDiffLifecycleState {
	return {
		request: state.request + 1,
		snapshot: null,
		displayMode: "drawer",
	};
}

export function isCurrentGitDiffResponse(input: { request: number; currentRequest: number; responseProjectId: string; activeProjectId: string | null }) {
	return input.request === input.currentRequest && input.responseProjectId === input.activeProjectId;
}

/** The adapter deliberately mirrors GitPanel's resource boundary, without exposing renderer state. */
export type WorkspaceGitResourceAdapter = {
	commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) => Promise<CommitEntry[]>;
	commitDetail: (projectId: string, ref: string) => Promise<CommitDetail | null>;
	branchCompare: (projectId: string, base: string, target: string) => Promise<BranchDiffResult>;
	getStatus: (projectId: string) => Promise<GitResourceGroups>;
	stageFiles: (projectId: string, paths: string[]) => Promise<void>;
	unstageFiles: (projectId: string, paths: string[]) => Promise<void>;
	discardFile: (projectId: string, group: "workingTree" | "untracked", path: string) => Promise<void>;
	commit: (projectId: string, message: string) => Promise<void>;
	workspaceFileDiff: (projectId: string, group: GitResourceGroupType, path: string) => Promise<GitWorkspaceFileDiff | null>;
	commitFileDiff: (projectId: string, hash: string, path: string, originalPath?: string) => Promise<(GitWorkspaceFileDiff & { originalPath?: string }) | null>;
};

export type WorkspaceExternalEditorAdapter = {
	list: () => Promise<ExternalEditor[]>;
	openProject: (editor: ExternalEditor, projectPath: string) => Promise<void>;
};

export const DEFAULT_PINNED_DRAWER_PANELS: WorkspaceDrawerPanel[] = ["files", "git"];

export type WorkspacePanelOptions = {
	projectId?: string | null;
	git?: WorkspaceGitResourceAdapter;
	editors?: WorkspaceExternalEditorAdapter;
	storage?: Pick<Storage, "getItem" | "setItem">;
	drawerStoragePrefix?: string;
	/** durable settings 读取器；localStorage 只作为首屏缓存/旧版本迁移来源。 */
	loadPersistedWidth?: () => Promise<unknown>;
	/** durable settings 写入器；失败不应影响拖拽布局。 */
	persistWidth?: (width: number) => void | Promise<unknown>;
};

function readDrawerState(storage: WorkspacePanelOptions["storage"], key: string) {
	if (!storage) return null;
	try {
		const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
		if (!parsed || typeof parsed !== "object") return null;
		const value = parsed as { panel?: unknown; pinned?: unknown; pinnedPanels?: unknown; drawerPinned?: unknown };
		const panel = value.panel === "editor" ? "files" : value.panel;
		const validPanels = ["files", "sessions", "browser", "git", "trajectory", "branchTree", "rewind", "scratchPad"];
		const validPanel = panel === null || validPanels.includes(String(panel));
		const pinnedPanels = Array.isArray(value.pinnedPanels) ? value.pinnedPanels.filter((item): item is WorkspaceDrawerPanel => typeof item === "string" && validPanels.includes(item)) : typeof value.pinned === "boolean" && value.pinned && validPanel && panel ? [panel as WorkspaceDrawerPanel] : undefined;
		// drawerPinned（工作区钉住）只能来自显式持久化；旧存档无此字段 → false（见下方水合注释）。
		const drawerPinned = value.drawerPinned === true;
		return validPanel && Array.isArray(pinnedPanels) ? { panel: panel as WorkspaceDrawerPanel | null, pinnedPanels, drawerPinned } : null;
	} catch {
		return null;
	}
}

function writeDrawerState(storage: WorkspacePanelOptions["storage"], key: string, panel: WorkspaceDrawerPanel | null, pinnedPanels: readonly WorkspaceDrawerPanel[], drawerPinned: boolean) {
	try {
		// drawerPinned 仅在 true 时落盘：旧版本读到无此字段的存档会得到 false，天然向后兼容。
		storage?.setItem(key, JSON.stringify(drawerPinned ? { panel, pinnedPanels, drawerPinned: true } : { panel, pinnedPanels }));
	} catch {
		// Storage is a convenience; panel commands must continue working when it is unavailable.
	}
}

/** 抽屉宽度默认值与可调范围（AppShell 布局约束同源，禁止两处漂移）。
 * 下限 240：抽屉承载 Git 面板（repo 切换 + 文件状态列 + 提交区）、文件树、
 * 浏览器等密集内容，180px 时文件名被状态徽标/操作按钮挤压，面板标题也放不下；
 * 240 保证内容面板在最小宽度下仍可完整操作，与左侧分段下限（208）同思路。
 * pin 状态额外要求更宽（MIN_PINNED 220→260）：钉住时是常驻工作区，不能太窄。 */
export const DEFAULT_DRAWER_WIDTH = 320;
export const DRAWER_WIDTH_MIN = 240;
export const DRAWER_WIDTH_MIN_PINNED = 260;
export const DRAWER_WIDTH_MAX = 560;
/** 抽屉宽度是全局布局偏好（与项目无关），不按项目拆分存储键。 */
export const DRAWER_WIDTH_STORAGE_KEY = "pid:drawer-width";

/** 将外部设置中的抽屉宽度规范化到面板可拖拽范围；非法值返回 null。 */
export function parseDrawerWidth(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(value)));
}

/** 读取持久化抽屉宽度：无存储/损坏/越界一律回退默认值，并 clamp 到可调范围。 */
export function readDrawerWidth(storage: WorkspacePanelOptions["storage"]): number {
	if (!storage) return DEFAULT_DRAWER_WIDTH;
	try {
		const raw = storage.getItem(DRAWER_WIDTH_STORAGE_KEY);
		if (raw === null) return DEFAULT_DRAWER_WIDTH;
		const width = Number(raw);
		if (!Number.isFinite(width)) return DEFAULT_DRAWER_WIDTH;
		return parseDrawerWidth(width) ?? DEFAULT_DRAWER_WIDTH;
	} catch {
		return DEFAULT_DRAWER_WIDTH;
	}
}

/** 写入持久化抽屉宽度；存储不可用时静默跳过，布局功能不受影响。 */
export function writeDrawerWidth(storage: WorkspacePanelOptions["storage"], width: number) {
	try {
		storage?.setItem(DRAWER_WIDTH_STORAGE_KEY, String(width));
	} catch {
		// Storage is a convenience; layout must keep working when it is unavailable.
	}
}

export function useWorkspacePanels(options: WorkspacePanelOptions = {}) {
	const projectId = options.projectId ?? null;
	const projectIdRef = useRef(projectId);
	const gitRef = useRef(options.git);
	const editorsRef = useRef(options.editors);
	const storageRef = useRef(options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined));
	const drawerPrefixRef = useRef(options.drawerStoragePrefix ?? "pid:project-drawer:");
	projectIdRef.current = projectId;
	gitRef.current = options.git;
	editorsRef.current = options.editors;
	storageRef.current = options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);

	const [gitDiff, setGitDiff] = useState<WorkspaceGitDiffSnapshot | null>(null);
	const [gitDiffDisplayMode, setGitDiffDisplayMode] = useState<"modal" | "drawer">("drawer");
	const gitRequestRef = useRef(0);
	const invalidateGitDiff = useCallback(() => {
		const next = invalidateGitDiffState({
			request: gitRequestRef.current,
			snapshot: null,
			displayMode: "drawer",
		});
		gitRequestRef.current = next.request;
		setGitDiff(next.snapshot);
		setGitDiffDisplayMode(next.displayMode);
	}, []);

	const [drawer, setDrawer] = useState<WorkspaceDrawerPanel | null>(null);
	const [drawerCollapsed, setDrawerCollapsed] = useState(false);
	// RPC 日志临时面板：agentId 绑定 + 打开前的面板（关闭还原，见 openRpcLogPanel / closeRpcLogPanel）
	const [rpcLogAgentId, setRpcLogAgentId] = useState<string>();
	const rpcLogPreviousPanelRef = useRef<WorkspaceDrawerPanel | null>(null);
	// 抽屉宽度：全局布局偏好（与项目无关），先从 localStorage 恢复并 clamp，
	// 再由应用设置异步校准，解决开发 renderer origin 变化导致的缓存丢失。
	// 写入方：AppShell 只在用户拖拽/键盘调整完成后经 shouldCommitPanelPixels 回写。
	// 窗口/页面缩放不改变保存偏好，避免布局换算后的临时像素污染缓存。
	const [drawerWidth, setDrawerWidth] = useState(() => readDrawerWidth(storageRef.current));
	useEffect(() => {
		writeDrawerWidth(storageRef.current, drawerWidth);
	}, [drawerWidth]);
	usePersistedPanelWidth({
		width: drawerWidth,
		setWidth: setDrawerWidth,
		normalize: parseDrawerWidth,
		loadPersistedWidth: options.loadPersistedWidth,
		persistWidth: options.persistWidth,
	});
	const [drawerPinnedByProject, setDrawerPinnedByProject] = useState<Record<string, WorkspaceDrawerPanel>>({});
	const drawerRef = useRef<WorkspaceDrawerPanel | null>(null);
	const drawerPinnedByProjectRef = useRef<Record<string, WorkspaceDrawerPanel>>({});
	const [pinnedPanelsByProject, setPinnedPanelsByProject] = useState<Record<string, WorkspaceDrawerPanel[]>>({});
	const pinnedPanelsByProjectRef = useRef<Record<string, WorkspaceDrawerPanel[]>>({});
	const drawerPinnedPanel = projectId ? drawerPinnedByProject[projectId] : undefined;
	const drawerPinned = Boolean(drawerPinnedPanel && drawer === drawerPinnedPanel);
	const drawerPinnedRef = useRef(false);
	drawerRef.current = drawer;
	drawerPinnedByProjectRef.current = drawerPinnedByProject;
	drawerPinnedRef.current = drawerPinned;
	pinnedPanelsByProjectRef.current = pinnedPanelsByProject;

	const loadDrawerState = useCallback((id: string) => readDrawerState(storageRef.current, `${drawerPrefixRef.current}${id}`), []);
	const saveDrawerState = useCallback((id: string, panel: WorkspaceDrawerPanel | null, pinnedPanels: readonly WorkspaceDrawerPanel[], drawerPinned: boolean) => writeDrawerState(storageRef.current, `${drawerPrefixRef.current}${id}`, panel, pinnedPanels, drawerPinned), []);
	const pinnedPanels = projectId ? (pinnedPanelsByProject[projectId] ?? DEFAULT_PINNED_DRAWER_PANELS) : DEFAULT_PINNED_DRAWER_PANELS;

	// 项目上下文水合（null → 首个 projectId）不得视为「切换项目」：
	// 用户在水合完成前已手动打开的抽屉会被保存态重置误关（E2E 与快速操作均可复现）。
	// 仅 A → B 的真实项目切换才重置/恢复抽屉；首次水合只在抽屉仍为空时应用保存态。
	const prevProjectIdRef = useRef<string | null>(null);
	useEffect(() => {
		const prevProjectId = prevProjectIdRef.current;
		prevProjectIdRef.current = projectId;
		const isInitialHydration = prevProjectId === null;
		if (!projectId) {
			// 项目被移除/清空才重置；首次水合前的 null 阶段不动用户已打开的抽屉
			if (!isInitialHydration) {
				setDrawer(null);
				setDrawerCollapsed(false);
			}
			return;
		}
		const saved = loadDrawerState(projectId);
		const nextPinnedPanels = saved?.pinnedPanels?.length ? saved.pinnedPanels : DEFAULT_PINNED_DRAWER_PANELS;
		if (!isInitialHydration || !drawerRef.current) {
			setDrawer(saved?.panel ?? null);
			setDrawerCollapsed(false);
		}
		setPinnedPanelsByProject((current) => ({ ...current, [projectId]: nextPinnedPanels }));
		setDrawerPinnedByProject((current) => {
			const next = { ...current };
			// 工作区钉住只能恢复显式持久化的 drawerPinned 标志（toggleDrawerPinned 写入）。
			// 绝不能从「保存的面板 ∈ pinnedPanels」推断：files/git 恒在默认 pinnedPanels 里，
			// 推断会让每个曾打开过文件/Git 抽屉的项目在启动/切换时自动钉死抽屉——
			// closeDrawer/collapseDrawer/openDrawer(其他面板) 全部静默 no-op，表现为
			// 「抽屉开关按钮点击无反应、文件/Git tab 切换无反应」（2026-10 用户反馈）。
			const restoredPinned = saved?.drawerPinned === true && saved.panel && nextPinnedPanels.includes(saved.panel) ? saved.panel : undefined;
			if (restoredPinned) next[projectId] = restoredPinned;
			else delete next[projectId];
			return next;
		});
	}, [loadDrawerState, projectId]);

	const openDrawer = useCallback(
		(panel: WorkspaceDrawerPanel) => {
			const pinnedPanel = projectIdRef.current ? drawerPinnedByProjectRef.current[projectIdRef.current] : undefined;
			if (pinnedPanel && pinnedPanel !== panel) return;
			const next = drawerRef.current === panel && !drawerPinnedRef.current ? null : panel;
			if (next !== "git") invalidateGitDiff();
			if (projectIdRef.current) saveDrawerState(projectIdRef.current, next, pinnedPanelsByProjectRef.current[projectIdRef.current] ?? DEFAULT_PINNED_DRAWER_PANELS, drawerPinnedRef.current);
			setDrawer(next);
			setDrawerCollapsed(false);
		},
		[invalidateGitDiff, saveDrawerState],
	);

	/**
	 * 强制打开面板（不 toggle）：外部入口（如消息链接“在浏览器打开”）需要确保
	 * browser 面板打开；openDrawer 在已是同一面板且展开时会关闭抽屉，导致
	 * 首次点击关抽屉、二次点击才打开且 tab 重复入栈。
	 */
	const openDrawerForce = useCallback(
		(panel: WorkspaceDrawerPanel) => {
			const pinnedPanel = projectIdRef.current ? drawerPinnedByProjectRef.current[projectIdRef.current] : undefined;
			if (pinnedPanel && pinnedPanel !== panel) return;
			if (panel !== "git") invalidateGitDiff();
			if (projectIdRef.current) saveDrawerState(projectIdRef.current, panel, pinnedPanelsByProjectRef.current[projectIdRef.current] ?? DEFAULT_PINNED_DRAWER_PANELS, drawerPinnedRef.current);
			setDrawer(panel);
			setDrawerCollapsed(false);
		},
		[invalidateGitDiff, saveDrawerState],
	);

	/**
	 * 打开 RPC 日志面板（agent 绑定由调用方给出）。
	 *
	 * 与 openDrawer 的区别（两处都在服务「非模态查看日志」这个产品语义）：
	 * 1. 不写持久化：面板绑定 agentId，跨重启必然失效，不能成为项目的恢复态；
	 * 2. 记住打开前的面板，关闭时还原——日志是盖在工具箱上的一层临时视图，
	 *    看完应该回到用户原本在看的东西，而不是把抽屉清空；
	 * 3. 不参与 pin 守卫：日志入口是显式动作，允许临时盖过钉住的面板（关闭后仍还原）。
	 */
	const openRpcLogPanel = useCallback(
		(agentId: string) => {
			if (drawerRef.current !== "rpcLog") rpcLogPreviousPanelRef.current = drawerRef.current;
			// 日志面板不是 git：无条件作废在途 diff 快照，防止旧响应落到日志之后打开的 git 面板上
			invalidateGitDiff();
			setRpcLogAgentId(agentId);
			setDrawer("rpcLog");
			setDrawerCollapsed(false);
		},
		[invalidateGitDiff],
	);

	/**
	 * 关闭 RPC 日志面板并还原它打开前的面板（没有则关闭抽屉）。
	 * rpcLogAgentId 刻意保留：关闭动画期间面板仍会渲染一帧（WorkspaceDrawerHost 的 120ms
	 * 合成器契约），清掉 agentId 会让内容在抽屉滑出前先空掉；面板不可见后该 id 无副作用，
	 * 下次打开一定会被新 id 覆盖。
	 */
	const closeRpcLogPanel = useCallback(() => {
		const previous = rpcLogPreviousPanelRef.current;
		rpcLogPreviousPanelRef.current = null;
		setDrawer(previous ?? null);
	}, []);

	const closeDrawer = useCallback(() => {
		if (drawerPinnedRef.current) return;
		// 临时面板走还原语义（且不写存档），避免 closeDrawer 把 null 落到用户的常驻面板选择上
		if (drawerRef.current === "rpcLog") {
			closeRpcLogPanel();
			return;
		}
		invalidateGitDiff();
		if (projectIdRef.current) saveDrawerState(projectIdRef.current, null, pinnedPanelsByProjectRef.current[projectIdRef.current] ?? DEFAULT_PINNED_DRAWER_PANELS, false);
		setDrawer(null);
	}, [closeRpcLogPanel, invalidateGitDiff, saveDrawerState]);

	const collapseDrawer = useCallback(() => {
		if (!drawerPinnedRef.current) setDrawerCollapsed(true);
	}, []);

	const expandDrawer = useCallback(() => setDrawerCollapsed(false), []);

	const toggleDrawerPanelPinned = useCallback(
		(panel: WorkspaceDrawerPanel) => {
			const id = projectIdRef.current;
			if (!id || panel === "rpcLog") return;
			const current = pinnedPanelsByProjectRef.current[id] ?? DEFAULT_PINNED_DRAWER_PANELS;
			const wasPinned = current.includes(panel);
			const next = wasPinned ? current.filter((item) => item !== panel) : [...current, panel];
			if (next.length === 0) return;
			// X 的语义是「移除这个 tab 页」：取消钉住的面板正是当前展开的抽屉时同步收起抽屉，
			// 只从 rail 消失而面板继续展开会让用户以为关闭失效（2026-10 分支面板反馈）。
			// 抽屉整体被钉住（drawerPinned）时不收起，与 closeDrawer 同口径。
			const closingActive = wasPinned && drawerRef.current === panel && !drawerPinnedRef.current;
			if (closingActive) invalidateGitDiff();
			pinnedPanelsByProjectRef.current = { ...pinnedPanelsByProjectRef.current, [id]: next };
			setPinnedPanelsByProject((all) => ({ ...all, [id]: next }));
			if (closingActive) setDrawer(null);
			// 单次写入：drawerRef 要等重渲染才更新，关闭场景必须显式传 null。
			saveDrawerState(id, closingActive ? null : drawerRef.current, next, closingActive ? false : drawerPinnedRef.current);
		},
		[invalidateGitDiff, saveDrawerState],
	);

	const toggleDrawerPinned = useCallback(() => {
		const id = projectIdRef.current;
		const currentDrawer = drawerRef.current;
		if (!id || !currentDrawer) return;
		const willPin = !drawerPinnedRef.current;
		setDrawerPinnedByProject((current) => {
			const next = { ...current };
			if (willPin) next[id] = currentDrawer;
			else delete next[id];
			return next;
		});
		const currentPanels = pinnedPanelsByProjectRef.current[id] ?? DEFAULT_PINNED_DRAWER_PANELS;
		const nextPanels = willPin ? (currentPanels.includes(currentDrawer) ? currentPanels : [...currentPanels, currentDrawer]) : currentPanels.filter((panel) => panel !== currentDrawer);
		if (nextPanels.length === 0) return;
		setPinnedPanelsByProject((all) => ({ ...all, [id]: nextPanels }));
		// 钉住标志显式落盘：水合只认这个字段，不再从面板∈pinnedPanels 推断。
		saveDrawerState(id, currentDrawer, nextPanels, willPin);
	}, [saveDrawerState]);

	const closeGitDiff = useCallback(() => {
		invalidateGitDiff();
	}, [invalidateGitDiff]);

	const openWorkspaceFileDiff = useCallback(async (group: GitResourceGroupType, path: string) => {
		const id = projectIdRef.current;
		const request = ++gitRequestRef.current;
		const diff = id ? await gitRef.current?.workspaceFileDiff(id, group, path) : null;
		if (
			!id ||
			!isCurrentGitDiffResponse({
				request,
				currentRequest: gitRequestRef.current,
				responseProjectId: id,
				activeProjectId: projectIdRef.current,
			})
		)
			return null;
		if (!diff) return null;
		setDrawer("git");
		setDrawerCollapsed(false);
		setGitDiffDisplayMode("drawer");
		setGitDiff({ ...diff, projectId: id, label: diff.path.split(/[\\/]/).pop() ?? diff.path });
		return diff;
	}, []);

	const openCommitFileDiff = useCallback(async (commit: CommitEntry, file: GitChangedFile) => {
		const id = projectIdRef.current;
		const request = ++gitRequestRef.current;
		const diff = id ? await gitRef.current?.commitFileDiff(id, commit.hash, file.path, file.originalPath) : null;
		if (
			!id ||
			!isCurrentGitDiffResponse({
				request,
				currentRequest: gitRequestRef.current,
				responseProjectId: id,
				activeProjectId: projectIdRef.current,
			})
		)
			return null;
		if (!diff) return null;
		setDrawer("git");
		setDrawerCollapsed(false);
		setGitDiffDisplayMode("drawer");
		setGitDiff({ ...diff, projectId: id, label: `${diff.path.split(/[\\/]/).pop() ?? diff.path} (${commit.shortHash})` });
		return diff;
	}, []);

	const toggleGitDiffDisplayMode = useCallback(() => {
		setGitDiffDisplayMode((mode) => {
			if (mode === "drawer") return "modal";
			setDrawer("git");
			setDrawerCollapsed(false);
			return "drawer";
		});
	}, []);

	const gitPanelAdapter = useMemo<WorkspaceGitResourceAdapter>(
		() => ({
			commitLog: (...args) => gitRef.current?.commitLog(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			commitDetail: (...args) => gitRef.current?.commitDetail(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			branchCompare: (...args) => gitRef.current?.branchCompare(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			getStatus: (...args) => gitRef.current?.getStatus(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			stageFiles: (...args) => gitRef.current?.stageFiles(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			unstageFiles: (...args) => gitRef.current?.unstageFiles(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			discardFile: (...args) => gitRef.current?.discardFile(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			commit: (...args) => gitRef.current?.commit(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			workspaceFileDiff: (...args) => gitRef.current?.workspaceFileDiff(...args) ?? Promise.reject(new Error("Git service is unavailable")),
			commitFileDiff: (...args) => gitRef.current?.commitFileDiff(...args) ?? Promise.reject(new Error("Git service is unavailable")),
		}),
		[],
	);

	const [browserFullscreen, setBrowserFullscreen] = useState(false);
	const openBrowser = useCallback(() => {
		invalidateGitDiff();
		setDrawer("browser");
		setDrawerCollapsed(false);
	}, [invalidateGitDiff]);
	const enterBrowserFullscreen = useCallback(() => setBrowserFullscreen(true), []);
	/**
	 * 关闭浏览器面板（全屏 X / 关闭最后一个 tab 统一入口）：
	 * 退出全屏并收起浏览器抽屉。区别于 minimizeBrowser（仅退出全屏、保留抽屉）。
	 * 此前只 setBrowserFullscreen(false)，抽屉模式下是空操作，导致关最后一个 tab 时侧边栏无法收起。
	 */
	const closeBrowser = useCallback(() => {
		setBrowserFullscreen(false);
		closeDrawer();
	}, [closeDrawer]);
	const minimizeBrowser = useCallback(() => {
		setBrowserFullscreen(false);
		openBrowser();
	}, [openBrowser]);

	const [externalEditors, setExternalEditors] = useState<ExternalEditor[]>([]);
	const [externalEditorsOpen, setExternalEditorsOpen] = useState(false);
	const [externalEditorsAnchor, setExternalEditorsAnchor] = useState<{ x: number; y: number } | null>(null);
	const [externalEditorsTargetPath, setExternalEditorsTargetPath] = useState<string | null>(null);
	const editorRequestRef = useRef(0);
	const loadExternalEditors = useCallback(async (forProjectId = projectIdRef.current) => {
		const request = ++editorRequestRef.current;
		const list = await editorsRef.current?.list();
		if (request !== editorRequestRef.current || projectIdRef.current !== forProjectId) return [];
		const next = list ?? [];
		setExternalEditors(next);
		return next;
	}, []);
	const openExternalEditorChooser = useCallback(
		(projectPath: string, anchor?: { x: number; y: number }) => {
			setExternalEditorsTargetPath(projectPath);
			setExternalEditorsAnchor(anchor ?? null);
			setExternalEditorsOpen(true);
			void loadExternalEditors();
		},
		[loadExternalEditors],
	);
	const closeExternalEditorChooser = useCallback(() => {
		editorRequestRef.current += 1;
		setExternalEditorsOpen(false);
		setExternalEditorsAnchor(null);
		setExternalEditorsTargetPath(null);
	}, []);
	const externalEditorsTargetPathRef = useRef<string | null>(null);
	externalEditorsTargetPathRef.current = externalEditorsTargetPath;
	const openProjectInExternalEditor = useCallback(async (editor: ExternalEditor) => {
		const id = projectIdRef.current;
		const path = externalEditorsTargetPathRef.current;
		const request = ++editorRequestRef.current;
		if (!path || !editorsRef.current) return;
		setExternalEditorsOpen(false);
		await editorsRef.current.openProject(editor, path);
		if (request !== editorRequestRef.current || projectIdRef.current !== id) return;
		setExternalEditorsAnchor(null);
		setExternalEditorsTargetPath(null);
	}, []);

	useEffect(() => {
		invalidateGitDiff();
		editorRequestRef.current += 1;
		setBrowserFullscreen(false);
		setExternalEditorsOpen(false);
		setExternalEditorsAnchor(null);
		setExternalEditorsTargetPath(null);
	}, [invalidateGitDiff, projectId]);

	return {
		drawer,
		drawerCollapsed,
		drawerWidth,
		setDrawerWidth,
		drawerPinned,
		drawerPinnedPanel,
		rpcLogAgentId,
		openRpcLogPanel,
		closeRpcLogPanel,
		openDrawer,
		openDrawerForce,
		closeDrawer,
		collapseDrawer,
		expandDrawer,
		toggleDrawerPinned,
		toggleDrawerPanelPinned,
		pinnedPanels,
		gitDiff,
		gitDiffDisplayMode,
		closeGitDiff,
		openWorkspaceFileDiff,
		openCommitFileDiff,
		toggleGitDiffDisplayMode,
		gitPanelAdapter,
		browserFullscreen,
		openBrowser,
		enterBrowserFullscreen,
		closeBrowser,
		minimizeBrowser,
		externalEditors,
		externalEditorsOpen,
		externalEditorsAnchor,
		externalEditorsTargetPath,
		loadExternalEditors,
		openExternalEditorChooser,
		closeExternalEditorChooser,
		openProjectInExternalEditor,
	};
}
