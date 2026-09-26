import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedPanelWidth } from "./usePersistedPanelWidth";
import type { BranchDiffResult, CommitDetail, CommitEntry, ExternalEditor, GitChangedFile, GitCommitFileDiff, GitResourceGroupType, GitResourceGroups, GitWorkspaceFileDiff, ProjectFileTarget } from "../../../shared/types";

export const DRAWER_ANIMATION_MS = 120;
export const EDITOR_TAB_LIMIT = 5;
export const EDITOR_TAB_TEXT_BUDGET = 24 * 1024 * 1024;

export type WorkspaceDrawerPanel = "files" | "sessions" | "browser" | "git" | "trajectory" | "rewind";
export type WorkspaceEditorMode = "view" | "diff";

export type WorkspaceEditorTab = {
	id: string;
	filePath: string;
	fileTarget?: ProjectFileTarget;
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
	stageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	unstageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	discardFile: (projectId: string, group: "workingTree" | "untracked", target: ProjectFileTarget) => Promise<void>;
	commit: (projectId: string, message: string) => Promise<void>;
	workspaceFileDiff: (projectId: string, group: GitResourceGroupType, target: ProjectFileTarget, repoTarget?: ProjectFileTarget) => Promise<GitWorkspaceFileDiff | null>;
	commitFileDiff: (projectId: string, hash: string, target: ProjectFileTarget, originalTarget?: ProjectFileTarget, repoTarget?: ProjectFileTarget) => Promise<GitCommitFileDiff | null>;
};

export type WorkspaceExternalEditorAdapter = {
	list: () => Promise<ExternalEditor[]>;
	openProject: (editor: ExternalEditor, projectPath: string) => Promise<void>;
};

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
		const value = parsed as { panel?: unknown; pinned?: unknown };
		// 编辑器面板已从抽屉移除（阅读面迁到分屏）；旧存档里的 "editor" 降级为文件树，
		// 避免读到旧值后面板状态无效（validPanel 校验失败会整体返回 null）。
		const panel = value.panel === "editor" ? "files" : value.panel;
		const validPanel = panel === null || ["files", "sessions", "browser", "git", "trajectory", "rewind"].includes(String(panel));
		return validPanel && typeof value.pinned === "boolean" ? { panel: panel as WorkspaceDrawerPanel | null, pinned: value.pinned } : null;
	} catch {
		return null;
	}
}

function writeDrawerState(storage: WorkspacePanelOptions["storage"], key: string, panel: WorkspaceDrawerPanel | null, pinned: boolean) {
	try {
		storage?.setItem(key, JSON.stringify({ panel, pinned }));
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
	const drawerPinnedPanel = projectId ? drawerPinnedByProject[projectId] : undefined;
	const drawerPinned = Boolean(drawerPinnedPanel && drawer === drawerPinnedPanel);
	const drawerPinnedRef = useRef(false);
	drawerRef.current = drawer;
	drawerPinnedByProjectRef.current = drawerPinnedByProject;
	drawerPinnedRef.current = drawerPinned;

	const loadDrawerState = useCallback((id: string) => readDrawerState(storageRef.current, `${drawerPrefixRef.current}${id}`), []);
	const saveDrawerState = useCallback((id: string, panel: WorkspaceDrawerPanel | null, pinned: boolean) => writeDrawerState(storageRef.current, `${drawerPrefixRef.current}${id}`, panel, pinned), []);

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
		if (!isInitialHydration || !drawerRef.current) {
			setDrawer(saved?.panel ?? null);
			setDrawerCollapsed(false);
		}
		setDrawerPinnedByProject((current) => {
			const next = { ...current };
			if (saved?.pinned && saved.panel) next[projectId] = saved.panel;
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
			if (projectIdRef.current) saveDrawerState(projectIdRef.current, next, Boolean(pinnedPanel && next === pinnedPanel));
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
			if (projectIdRef.current) saveDrawerState(projectIdRef.current, panel, Boolean(pinnedPanel && panel === pinnedPanel));
			setDrawer(panel);
			setDrawerCollapsed(false);
		},
		[invalidateGitDiff, saveDrawerState],
	);

	const closeDrawer = useCallback(() => {
		if (drawerPinnedRef.current) return;
		invalidateGitDiff();
		if (projectIdRef.current) saveDrawerState(projectIdRef.current, null, false);
		setDrawer(null);
	}, [invalidateGitDiff, saveDrawerState]);

	const collapseDrawer = useCallback(() => {
		if (!drawerPinnedRef.current) setDrawerCollapsed(true);
	}, []);

	const expandDrawer = useCallback(() => setDrawerCollapsed(false), []);

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
		saveDrawerState(id, currentDrawer, willPin);
	}, [saveDrawerState]);

	const closeGitDiff = useCallback(() => {
		invalidateGitDiff();
	}, [invalidateGitDiff]);

	const openWorkspaceFileDiff = useCallback(async (group: GitResourceGroupType, target: ProjectFileTarget, repoTarget?: ProjectFileTarget) => {
		const id = projectIdRef.current;
		const request = ++gitRequestRef.current;
		const diff = id ? await gitRef.current?.workspaceFileDiff(id, group, target, repoTarget) : null;
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
		const diff = id ? await gitRef.current?.commitFileDiff(id, commit.hash, file.target, file.originalTarget) : null;
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
		openDrawer,
		openDrawerForce,
		closeDrawer,
		collapseDrawer,
		expandDrawer,
		toggleDrawerPinned,
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
