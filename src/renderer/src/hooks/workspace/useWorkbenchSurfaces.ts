import { useCallback, useEffect, useState } from "react";
import type { WorkspaceContentOpenMode } from "../../../../shared/types";
import { type WorkbenchSurfaceState, workbenchContentFolded, workbenchShowsContent, workbenchTabActive } from "../../utils/workbenchSurfaces";

/**
 * 中间栏工作台的呈现状态：内容面（文件/Git Diff）在不在、谁在前台、Tab 栏拿哪条列表。
 *
 * 单独成 hook 而不是留在 App：App.tsx 是存量巨文件（门禁禁止净增长），而这组状态必须
 * 同时对齐 useFileEditor（editorMode / gitDrawerDiff）、会话选择与简洁模式三处。
 *
 * 前台面规则：
 * - 会话面与内容面互斥。maximize 下只呈现前台那一面，另一面折叠但保持挂载
 *   （切回来不丢滚动/撤销栈）；split 下两面同屏，不需要让位——否则会把用户
 *   正在对照的文件藏起来。
 * - 点「当前会话 Tab」不改 currentSessionId、点当前文件 Tab 不改 activeTabId，
 *   所以两个方向都要在点击处显式上报；下面的 effect 只兜树/消息里的打开动作
 *   （打开文件、切到别的会话）。
 */
type WorkbenchTabInput = { id: string; filePath: string; label?: string };
type GitDiffInput = { projectId: string; filePath: string; label: string };

export type WorkbenchSurfacesInput = {
	/** 中间栏当前的 Git Diff（优先于文件 tab 呈现） */
	gitDiff: GitDiffInput | null;
	activeProjectId?: string;
	editorTabs: readonly WorkbenchTabInput[];
	previewEditorTabId: string | null;
	activeTabId: string | null;
	/** 文件面自带抽屉（preserveDrawer）时不给「占满/恢复」开关 */
	activeTabPreserveDrawer: boolean;
	editorMode: WorkspaceContentOpenMode;
	toggleEditorMode: () => void;
	gitDiffDisplayMode: WorkspaceContentOpenMode;
	toggleGitDiffDisplayMode: () => void;
	simpleMode: boolean;
	currentSessionId?: string;
};

export type WorkbenchTabItem = {
	id: string;
	label: string;
	title: string;
	preview: boolean;
	active: boolean;
};

export type WorkbenchSurfaces = {
	hasGitDiff: boolean;
	/** 内容面存在（文件 tab 或 Git Diff）——存在不等于在前台 */
	hasContent: boolean;
	/** 工作台此刻是否呈现内容面（存在且没有让位给会话） */
	showsContent: boolean;
	layout: WorkspaceContentOpenMode;
	/** 阅读面主题（跟随 document 主题标记） */
	theme: "dark" | "light";
	/** 内容区宽度：split 分屏时右缘刻度轴贴消息区右缘用；非分屏/让位时归零 */
	contentWidth: number;
	onContentWidthChange: (width: number) => void;
	editorTabs: WorkbenchTabItem[];
	toggleSimpleContent: () => void;
	/** simple 模式走 expanded 开关；preserveDrawer 文件面不给开关 */
	onToggleEditorMode: (() => void) | undefined;
	onToggleGitDiffMode: () => void;
	revealSession: () => void;
	revealContent: () => void;
};

export function useWorkbenchSurfaces(input: WorkbenchSurfacesInput): WorkbenchSurfaces {
	const { gitDiff, activeProjectId, editorTabs, previewEditorTabId, activeTabId, activeTabPreserveDrawer, editorMode, toggleEditorMode, gitDiffDisplayMode, toggleGitDiffDisplayMode, simpleMode, currentSessionId } = input;

	// Git Diff 优先于文件编辑器（同一时刻只挂一份内容面）
	const hasGitDiff = Boolean(gitDiff && gitDiff.projectId === activeProjectId);
	const hasContent = hasGitDiff || Boolean(activeTabId);

	const [simpleContentExpanded, setSimpleContentExpanded] = useState(false);
	useEffect(() => setSimpleContentExpanded(false), [activeTabId, gitDiff?.filePath, simpleMode]);
	const layout: WorkspaceContentOpenMode = simpleMode ? (simpleContentExpanded ? "maximize" : "split") : hasGitDiff ? gitDiffDisplayMode : editorMode;

	const [front, setFront] = useState<"session" | "content">("content");
	const revealContent = useCallback(() => setFront("content"), []);
	const revealSession = useCallback(() => {
		setFront("session");
		// 简洁模式的内容面靠 expanded 撑满会话列，点会话 Tab 即收回分屏
		if (simpleMode) setSimpleContentExpanded(false);
	}, [simpleMode]);
	useEffect(() => {
		if (activeTabId || gitDiff?.filePath) revealContent();
	}, [activeTabId, gitDiff?.filePath, revealContent]);
	useEffect(() => {
		revealSession();
	}, [currentSessionId, revealSession]);

	const surfaceState: WorkbenchSurfaceState = { simpleMode, hasContent, layout, front };
	const contentFolded = workbenchContentFolded(surfaceState);
	const showsContent = workbenchShowsContent(surfaceState);

	const theme: "dark" | "light" = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
	const [contentWidth, setContentWidth] = useState(0);
	const onContentWidthChange = useCallback((width: number) => {
		// 相同宽度跳过，避免拖拽分隔条时反复重渲染
		setContentWidth((current) => (current === width ? current : width));
	}, []);

	const toggleSimpleContent = useCallback(() => setSimpleContentExpanded((value) => !value), []);
	// 点开关就是「要看内容面」：先交回前台再切布局，否则 maximize + 会话在前台会立刻折回去
	const toggleEditorModeInFront = useCallback(() => {
		revealContent();
		toggleEditorMode();
	}, [revealContent, toggleEditorMode]);
	const onToggleGitDiffMode = useCallback(() => {
		revealContent();
		toggleGitDiffDisplayMode();
	}, [revealContent, toggleGitDiffDisplayMode]);

	const fileTabs: WorkbenchTabItem[] = editorTabs.map((tab) => ({
		id: tab.id,
		label: tab.label ?? tab.filePath.split(/[/\\]/).pop() ?? tab.filePath,
		title: tab.filePath,
		preview: tab.id === previewEditorTabId,
		// 让位给会话时文件面不在前台，Tab 不能再画选中态（否则两个 Tab 同时像当前 Tab）
		active: workbenchTabActive(contentFolded, !hasGitDiff && tab.id === activeTabId),
	}));
	const barTabs: WorkbenchTabItem[] = [...(simpleMode || !hasGitDiff ? fileTabs : []), ...(hasGitDiff && gitDiff ? [{ id: `git-diff:${gitDiff.filePath}`, label: gitDiff.label, title: gitDiff.filePath, preview: false, active: workbenchTabActive(contentFolded, true) }] : [])];

	return {
		hasGitDiff,
		hasContent,
		showsContent,
		layout,
		theme,
		contentWidth,
		onContentWidthChange,
		editorTabs: barTabs,
		toggleSimpleContent,
		onToggleEditorMode: simpleMode ? toggleSimpleContent : activeTabPreserveDrawer ? undefined : toggleEditorModeInFront,
		onToggleGitDiffMode: simpleMode ? toggleSimpleContent : onToggleGitDiffMode,
		revealSession,
		revealContent,
	};
}
