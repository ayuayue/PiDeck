import { cn } from "../../lib/utils";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronsDownUp, Folder, FolderTree, RefreshCw, X } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";
import { FileSortControl } from "./FileSortControl";
import { sortFileNodes, FILE_SORT_OPTIONS, FILE_SORT_DEFAULT_DIRECTION, type FileSortMode, type FileSortDirection } from "../../utils/fileTreeSort";
import { compactMiddlePackages } from "../../utils/fileTreeCompact";
import { compactMiddlePackagesAtom, activeEditorFileAtom } from "../../atoms/app-ui-atoms";
import { t } from "../../i18n";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import type { FileTreeNode, Project, SessionSummary } from "../../../../shared/types";
import { FileSearch, Search } from "lucide-react";
import { useFileSearch } from "../../hooks/useFileSearch";
import { useFileTreeStickyAppearance } from "../../hooks/files/useFileTreeStickyAppearance";
import { useLazyListWindow } from "../../hooks/useLazyListWindow";
import { useFileTreeGitStatus } from "../../hooks/files/useFileTreeGitStatus";
import { useFileTreeGitStatusRefresh } from "../../hooks/files/useFileTreeGitStatusRefresh";
import { FileSearchResults } from "./FileSearchResults";
import { FILE_TREE_RENDER_BATCH } from "../../utils/fileTreeRenderBudget";
import { FileTreeNodeRow } from "./FileTreeRows";
import { SessionsPanel } from "./SessionHistoryPanel";
import { isEditableTarget, isFileSearchShortcut, isTypeToSearchKey } from "../../utils/fileSearchTrigger";

// 兼容导出：会话历史弹窗已迁到 SessionHistoryPanel（> 600 行红线），
// SurfaceComponents 的「DrawerContent / SessionFileSummary / SessionHistoryModal」汇总出口保持不变。
export { SessionHistoryModal } from "./SessionHistoryPanel";

// Button 收口状态（P0 UI 统一）：抽屉头部/文件工具行图标按钮已换 shadcn Button（ghost + 原 tailwind class 保留）。
// 保留原生 button（内容排版/折叠区块语义 + 自定义 CSS 驱动，P2 CSS 收口时迁移）：
// session-file-summary-header / -row / -toggle（会话文件摘要）、session-card-inner（会话卡片整卡）、
// session-card-expand-btn（子会话折叠）。

type DiffFileHandler = (path: string, originalContent?: string, content?: string) => void;

type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	originalContent?: string;
	content?: string;
};

export function DrawerContent(props: {
	panel: WorkspaceDrawerPanel;
	project?: Project;
	/** 文件面板所属项目 id：会话历史面板用不到，但文件树与按名称搜索必须靠它（缺了搜索入口不渲染） */
	projectId?: string;
	files: FileTreeNode[];
	/** 文件树内容代次（owner 在 useProjectSync 的 useFileTreeContentState）：树内容真的变了才 +1，驱动着色防抖重拉 */
	fileTreeContentRevision: number;
	sessions: SessionSummary[];
	sessionsLoading?: boolean;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onCollapseAllDirectories: () => void;
	onClose: () => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	onOpenFolder?: () => void;
	onRefreshSessions: () => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (filePath: string, newName: string) => void;
	onCopySession: (session: SessionSummary) => void | Promise<void>;
	onExportSession: (session: SessionSummary) => void | Promise<void>;
	onDeleteSession: (session: SessionSummary) => void | Promise<void>;
	onOpenFile?: (path: string) => void;
	/** 单击默认预览；第二参 permanent = 双击常驻 */
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	/** 项目根目录：面板空白处拖入/粘贴/右键的落点 */
	projectRoot?: string;
	/** 从 OS 拖入文件到目录或面板空白区域（复制） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件到目标目录（Ctrl+V / 右键菜单） */
	onPasteFiles?: (targetDir: string) => void;
	/** 文件树内部拖拽移动文件/目录到目标目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
}) {
	const title = props.panel === "files" ? null : props.project ? t("drawer.projectSessions", { name: props.project.name }) : t("drawer.historyTitle");
	return (
		<>
			{/* 文件抽屉：去掉「文件 + ×」顶栏，关闭改走右侧 rail；会话历史仍保留顶栏。 */}
			{props.panel !== "files" && title && (
				<div className="drawer-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background px-3">
					<strong className="truncate text-sm font-semibold text-foreground">{title}</strong>
					<div className="drawer-header-actions flex shrink-0 items-center gap-1">
						<Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" title={t("drawer.closePanel")} aria-label={t("drawer.closePanel")} onClick={props.onClose}>
							<X size={16} />
						</Button>
					</div>
				</div>
			)}
			{props.panel === "files" && (
				<FilesPanel
					projectId={props.projectId ?? props.project?.id}
					files={props.files}
					fileTreeContentRevision={props.fileTreeContentRevision}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onCollapseAll={props.onCollapseAllDirectories}
					onFileContextMenu={props.onFileContextMenu}
					onRefreshFiles={props.onRefreshFiles}
					onOpenFolder={props.onOpenFolder}
					onOpenFile={props.onOpenFile}
					onViewFile={props.onViewFile}
					projectRoot={props.projectRoot}
					onDropFiles={props.onDropFiles}
					onMoveFiles={props.onMoveFiles}
					onPasteFiles={props.onPasteFiles}
				/>
			)}
			{props.panel === "sessions" && <SessionsPanel sessions={props.sessions} onRefresh={props.onRefreshSessions} onOpen={props.onOpenSession} onRename={props.onRenameSession} onCopy={props.onCopySession} onExport={props.onExportSession} onDelete={props.onDeleteSession} />}
		</>
	);
}

function FilesPanel(props: {
	/** 搜索用项目 id（由抽屉按当前文件树项目传入）：缺省时不渲染搜索入口、快捷键也不响应 */
	projectId?: string;
	files: FileTreeNode[];
	/** 文件树内容代次：树内容真的变了才 +1（owner 在 useProjectSync），驱动着色防抖重拉 */
	fileTreeContentRevision: number;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	/** 收起文件树中所有已展开的目录，清空 expandedDirs。 */
	onCollapseAll?: () => void;
	onOpenFolder?: () => void;
	onOpenFile?: (path: string) => void;
	/** 单击默认预览；第二参 permanent = 双击常驻 */
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	/** 项目根目录：面板空白处拖入/粘贴/右键的落点 */
	projectRoot?: string;
	/** 从 OS 拖入文件到目录或面板空白区域（复制） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件到目标目录（Ctrl+V / 右键菜单） */
	onPasteFiles?: (targetDir: string) => void;
	/** 文件树内部拖拽移动文件/目录到目标目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
}) {
	// 排序维度/方向持久化到 localStorage：文件树排序是用户偏好，跨会话保留
	const FILE_SORT_KEY = "pi-desktop:file-sort";
	const FILE_SORT_DIR_KEY = "pi-desktop:file-sort-dir";
	const [sortMode, setSortMode] = useState<FileSortMode>(() => {
		const saved = typeof window !== "undefined" ? localStorage.getItem(FILE_SORT_KEY) : null;
		return FILE_SORT_OPTIONS.some((o) => o.value === saved) ? (saved as FileSortMode) : "name";
	});
	const [sortDirection, setSortDirection] = useState<FileSortDirection>(() => {
		const saved = typeof window !== "undefined" ? localStorage.getItem(FILE_SORT_DIR_KEY) : null;
		return saved === "asc" || saved === "desc" ? saved : FILE_SORT_DEFAULT_DIRECTION["name"];
	});
	useEffect(() => {
		localStorage.setItem(FILE_SORT_KEY, sortMode);
		// 切换维度时方向跟随该维度的默认方向（名称升序；时间/大小倒序）
		setSortDirection(FILE_SORT_DEFAULT_DIRECTION[sortMode]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sortMode]);
	useEffect(() => {
		localStorage.setItem(FILE_SORT_DIR_KEY, sortDirection);
	}, [sortDirection]);
	// 折叠中间包开关：IDEA 式把单子目录链合并成点分节点，深包结构一行展示。
	const [compactPackages, setCompactPackages] = useAtom(compactMiddlePackagesAtom);
	// 文件名搜索（issue #215）：状态域在 hook，面板只转发输入与关闭
	const fileSearch = useFileSearch({ projectId: props.projectId });
	// Git 状态着色（IDEA 风格：untracked 琥珀棕 / modified 蓝 / added 绿 / conflict 红）：
	// 面板挂载（抽屉打开）与切换项目由 hook 拉取；手动刷新按钮见下方 onClick。
	const gitStatus = useFileTreeGitStatus({ projectId: props.projectId, projectRoot: props.projectRoot });
	// 文件树内容真的变了（复制/粘贴/移动、工具触发的重载、refs 触发的重载）才防抖重拉着色：
	// 触发键是 owner 维护的内容代次，不是 props.files 的引用——展开/收起与纯展示变换都不参与，
	// 也不会把待执行的刷新清掉；挂载首帧由 useFileTreeGitStatus 自己拉过，不重复。
	useFileTreeGitStatusRefresh(props.fileTreeContentRevision, gitStatus.refresh);
	const [searchOpen, setSearchOpen] = useState(false);
	// 面板容器：退出搜索后把焦点收回来，否则焦点落到 body，之后的 Ctrl+F / 输入即搜索都收不到键
	const panelRef = useRef<HTMLDivElement | null>(null);
	// 关闭时同步清空查询词：退出搜索态必须回到完整文件树，且避免残留查询触发下一次挂载时的扫描
	const closeSearch = useCallback(() => {
		setSearchOpen(false);
		fileSearch.clearSearch();
		panelRef.current?.focus();
	}, [fileSearch]);
	// 排序是纯展示层变换：不改变 props.files 引用，只影响渲染次序
	const sortedFiles = useMemo(() => sortFileNodes(props.files, sortMode, sortDirection), [props.files, sortMode, sortDirection]);
	// 折叠中间包是排序之后的另一层纯展示变换：开启时把单子目录链压成一行。
	const displayFiles = useMemo(() => (compactPackages ? compactMiddlePackages(sortedFiles) : sortedFiles), [sortedFiles, compactPackages]);
	/** 拖入高亮的目标目录路径（null = 拖在面板空白区域） */
	const [dragOverDir, setDragOverDir] = useState<string | null>(null);
	const dragCountRef = useRef(0);
	// 活跃编辑器文件高亮订阅上移到面板：行组件不再逐行订阅 atom，
	// 否则每次点文件都会唤醒全部已挂载行（O(N) 重渲）。
	const activeEditorFile = useAtomValue(activeEditorFileAtom);
	// memo 行组件的回调必须引用稳定：App 消息 flush 会重渲整条抽屉链路，
	// 若每帧重建回调，memo 全部失效（2000 行 × 每秒多次 = 持续卡顿）。用 ref 取最新 props。
	const latestPropsRef = useRef(props);
	latestPropsRef.current = props;
	const stableToggleDirectory = useCallback((path: string) => latestPropsRef.current.onToggleDirectory(path), []);
	const stableFileContextMenu = useCallback((node: FileTreeNode, x: number, y: number) => latestPropsRef.current.onFileContextMenu(node, x, y), []);
	const stableOpenFile = useCallback((path: string) => latestPropsRef.current.onOpenFile?.(path), []);
	const stableViewFile = useCallback((path: string, openMode?: "preview" | "permanent") => latestPropsRef.current.onViewFile?.(path, openMode), []);
	const stableDropFiles = useCallback((targetDir: string, files: FileList) => latestPropsRef.current.onDropFiles?.(targetDir, files), []);
	const stableMoveFiles = useCallback((sourcePaths: string[], targetDir: string) => latestPropsRef.current.onMoveFiles?.(sourcePaths, targetDir), []);
	// 文件树渲染预算：首屏只挂一批，滚动到列表底部再追加。否则展开一个 2000 项目录
	// 会在一次 commit 里同步挂满整棵子树（主进程单目录上限即 2000，见 shared/fileTree.ts）。
	const rootWindow = useLazyListWindow(displayFiles, { pageSize: FILE_TREE_RENDER_BATCH, scrollRef: panelRef, resetKey: props.projectId });
	useFileTreeStickyAppearance(panelRef, rootWindow.visible, props.expandedDirs, !searchOpen);

	// 面板自身接受拖入：落在空白区域视为复制到项目根目录
	const handlePanelDragOver = (event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};
	const handlePanelDrop = (event: React.DragEvent) => {
		event.preventDefault();
		setDragOverDir(null);
		dragCountRef.current = 0;
		if (event.dataTransfer.files.length > 0 && props.onDropFiles && props.projectRoot) {
			props.onDropFiles(props.projectRoot, event.dataTransfer.files);
		}
	};
	const handlePanelKeyDown = (event: React.KeyboardEvent) => {
		// Ctrl+V / Cmd+V 粘贴到项目根目录
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
			if (props.onPasteFiles && props.projectRoot) {
				props.onPasteFiles(props.projectRoot);
			}
			return;
		}
		// 搜索要项目 id 才能扫盘：没有选中项目时连入口都不渲染，快捷键也不应响应
		if (!props.projectId) return;
		// Ctrl+F / ⌘F：在面板内打开搜索视图（挡掉宿主自带查找栏）；焦点在输入框里时不抢键
		if (isFileSearchShortcut(event)) {
			if (isEditableTarget(event.target)) return;
			event.preventDefault();
			setSearchOpen(true);
			return;
		}
		// 输入即搜索：焦点在面板/文件树上时直接敲字符即进搜索，首字符带进查询词。
		// searchOpen 后输入框已自己聚焦，字符归输入框，这里不再重复播种。
		if (searchOpen || isEditableTarget(event.target)) return;
		if (isTypeToSearchKey(event)) {
			event.preventDefault();
			setSearchOpen(true);
			fileSearch.setQuery(event.key);
		}
	};
	// 面板内点一下就把焦点收回容器：Ctrl+V 粘贴、Ctrl+F 与「输入即搜索」都挂在容器 keydown 上，
	// 焦点落在 body 时按键不会冒泡到这里（此前必须先点中某个文件行，快捷键才生效）
	const handlePanelMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
		if (isEditableTarget(event.target)) return; // 别把焦点从搜索框/重命名输入框里抢走
		event.currentTarget.focus();
	};
	const handlePanelContextMenu = (event: React.MouseEvent) => {
		// 仅面板背景本身被右键时触发（不拦截文件节点的右键事件）
		if (event.target !== event.currentTarget) return;
		event.preventDefault();
		if (props.projectRoot) {
			props.onFileContextMenu(
				{
					path: props.projectRoot,
					name: "",
					type: "directory",
					relativePath: "",
					children: undefined,
				} as FileTreeNode,
				event.clientX,
				event.clientY,
			);
		}
	};
	return (
		<div
			className="files-panel group/file-tree flex min-h-0 flex-1 flex-col overflow-x-hidden p-0"
			ref={panelRef}
			tabIndex={-1}
			onMouseDown={handlePanelMouseDown}
			onDragOver={handlePanelDragOver}
			onDragLeave={() => {
				setDragOverDir(null);
				dragCountRef.current = 0;
			}}
			onDrop={handlePanelDrop}
			onKeyDown={handlePanelKeyDown}
			onContextMenu={handlePanelContextMenu}
		>
			{/* 工具行贴顶，目录紧接其下；无外圈留白，避免滚动文件名从吸顶区上沿露出。 */}
			<div data-file-tree-toolbar="" className="panel-action-row flex h-7 min-w-0 shrink-0 items-center justify-end gap-1 border-b border-border/40 bg-background px-2 text-xs text-muted-foreground sticky top-0 z-20">
				<div className="panel-action-buttons flex min-w-0 items-center gap-0.5">
					{/* 文件树排序：方向切换与维度选择合并在一个图标菜单内（默认按名称·升序） */}
					<FileSortControl sortMode={sortMode} sortDirection={sortDirection} onSortModeChange={setSortMode} onToggleDirection={() => setSortDirection((d) => (d === "asc" ? "desc" : "asc"))} />
					{/* 折叠中间包：开启时深包目录链合并成一行（默认开），与排序互不影响 */}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className={cn("icon-only inline-grid size-6 place-items-center rounded-md", compactPackages ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}
						onClick={() => setCompactPackages((v) => !v)}
						title={t("drawer.compactPackages")}
						aria-label={t("drawer.compactPackages")}
						aria-pressed={compactPackages}
					>
						<FolderTree size={13} aria-hidden="true" />
					</Button>
					{/* 文件名搜索入口（issue #215）：打开后用结果列表替换文件树 */}
					{props.projectId && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className={cn("icon-only inline-grid size-6 place-items-center rounded-md", searchOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}
							onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
							title={t("drawer.fileSearch")}
							aria-label={t("drawer.fileSearch")}
							aria-pressed={searchOpen}
						>
							<Search size={13} aria-hidden="true" />
						</Button>
					)}
					{props.onOpenFolder && (
						<Button type="button" variant="ghost" size="icon-sm" className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={props.onOpenFolder} title={t("drawer.openFolder")} aria-label={t("drawer.openFolder")}>
							<Folder size={13} />
						</Button>
					)}
					{/* 刷新与全部收起：纯图标，密度对齐 shadcn icon button */}
					{/* 刷新同时重拉 Git 着色：agent 改完文件后点一次刷新，颜色与树同步更新 */}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
						onClick={() => {
							props.onRefreshFiles();
							void gitStatus.refresh();
						}}
						title={t("common.refresh")}
						aria-label={t("common.refresh")}
					>
						<RefreshCw size={13} />
					</Button>
					{props.onCollapseAll && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
							onClick={props.onCollapseAll}
							title={t("drawer.collapseAllDirs")}
							aria-label={t("drawer.collapseAllDirs")}
							disabled={props.expandedDirs.size === 0}
						>
							<ChevronsDownUp size={13} />
						</Button>
					)}
				</div>
			</div>
			{searchOpen ? (
				<FileSearchResults
					query={fileSearch.query}
					onQueryChange={fileSearch.setQuery}
					results={fileSearch.results}
					isSearching={fileSearch.isSearching}
					contentResults={fileSearch.contentResults}
					isContentSearching={fileSearch.isContentSearching}
					onViewFile={props.onViewFile}
					onFileContextMenu={props.onFileContextMenu}
					onClear={closeSearch}
				/>
			) : (
				<>
					{rootWindow.visible.map((node) => (
						<FileTreeNodeRow
							key={node.path}
							node={node}
							depth={0}
							expandedDirs={props.expandedDirs}
							activeEditorFile={activeEditorFile}
							onToggleDirectory={stableToggleDirectory}
							onFileContextMenu={stableFileContextMenu}
							onOpenFile={stableOpenFile}
							onViewFile={stableViewFile}
							onDropFiles={stableDropFiles}
							onMoveFiles={stableMoveFiles}
							dragOverDir={dragOverDir}
							onDragOverDirChange={setDragOverDir}
							scrollRef={panelRef}
							gitStatusOf={gitStatus.statusOf}
						/>
					))}
					{rootWindow.hasMore && <div ref={rootWindow.sentinelRef} aria-hidden="true" className="h-px shrink-0" />}
				</>
			)}
		</div>
	);
}

const SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX = "pid:session-file-summary-collapsed:";
const SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX = "pid:session-file-summary-file-list-expanded:";

/** 读取指定 session 的折叠状态(无存储返回默认值) */
function loadCollapsed(sessionKey: string | null): boolean {
	if (!sessionKey || typeof window === "undefined") return true;
	const stored = localStorage.getItem(SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX + sessionKey);
	return stored !== null ? stored === "true" : true;
}

function loadFileListExpanded(sessionKey: string | null): boolean {
	if (!sessionKey || typeof window === "undefined") return false;
	const stored = localStorage.getItem(SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX + sessionKey);
	return stored !== null ? stored === "true" : false;
}

export function SessionFileSummary(props: {
	files: SessionModifiedFile[];
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
	/** sessionIdOrPath: 会话唯一标识(如 sessionPath),用于按 agent/session 隔离折叠状态。
	 *  组件卸载后再次挂载相同标识时,恢复之前保存的折叠偏好。 */
	sessionIdOrPath?: string;
}) {
	const [collapsed, setCollapsed] = useState(() => loadCollapsed(props.sessionIdOrPath ?? null));
	const [fileListExpanded, setFileListExpanded] = useState(() => loadFileListExpanded(props.sessionIdOrPath ?? null));
	const prevSessionRef = useRef(props.sessionIdOrPath);

	// 当 sessionIdOrPath 变化时重新从 localStorage 读取
	useEffect(() => {
		if (prevSessionRef.current === props.sessionIdOrPath) return;
		prevSessionRef.current = props.sessionIdOrPath;
		setCollapsed(loadCollapsed(props.sessionIdOrPath ?? null));
		setFileListExpanded(loadFileListExpanded(props.sessionIdOrPath ?? null));
	}, [props.sessionIdOrPath]);

	// 仅在用户主动点击时写 localStorage,不在 sessionIdOrPath 切换时误写
	const handleToggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			if (props.sessionIdOrPath) {
				localStorage.setItem(SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX + props.sessionIdOrPath, String(next));
			}
			return next;
		});
	}, [props.sessionIdOrPath]);

	const handleToggleFileList = useCallback(() => {
		setFileListExpanded((prev) => {
			const next = !prev;
			if (props.sessionIdOrPath) {
				localStorage.setItem(SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX + props.sessionIdOrPath, String(next));
			}
			return next;
		});
	}, [props.sessionIdOrPath]);

	const visibleFiles = fileListExpanded ? props.files : props.files.slice(0, 4);
	const hiddenCount = Math.max(0, props.files.length - visibleFiles.length);

	// 无文件时不渲染
	if (props.files.length === 0) return null;

	return (
		<section className="session-file-summary-list-card" aria-label={t("drawer.modifiedFilesAria")}>
			<button className="session-file-summary-header" type="button" onClick={handleToggleCollapsed} aria-expanded={!collapsed}>
				<ChevronDown size={14} className={`session-file-summary-chevron${collapsed ? "" : " open"}`} />
				<span className="session-file-summary-title-span">{t("drawer.modifiedFiles")}</span>
				<small className="session-file-summary-count">
					{props.files.length} {t("app.files")}
				</small>
			</button>
			{/* 折叠体走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
			    display:contents 根不生成盒子，折叠态零空档；列表与 +N 按钮合一收进单个折叠体。 */}
			<Collapsible open={!collapsed} className="contents">
				<CollapsibleContent>
					<ul className="session-file-summary-list">
						{visibleFiles.map((file) => {
							const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
							return (
								<li key={file.path}>
									<button className="session-file-summary-row" type="button" title={file.path} onClick={() => props.onDiffFile?.(file.path, file.originalContent, file.content)}>
										<span className="session-file-summary-name">{fileName}</span>
									</button>
								</li>
							);
						})}
					</ul>
					{props.files.length > 4 && (
						<button className="session-file-summary-toggle" type="button" onClick={handleToggleFileList}>
							{fileListExpanded ? t("common.collapse") : t("drawer.moreFiles", { count: hiddenCount })}
						</button>
					)}
				</CollapsibleContent>
			</Collapsible>
		</section>
	);
}
