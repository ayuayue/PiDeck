import { cn } from "../../lib/utils";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, FileText, Folder, FolderOpen, FolderTree, LoaderCircle, RefreshCw, X } from "lucide-react";
import { normalizeSessionPathForCompare } from "../../agentListDisplay";
import { SessionSourceBadge } from "./SessionSourceBadge";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { FileSortControl } from "./FileSortControl";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../fileIcons";
import { sortFileNodes, FILE_SORT_OPTIONS, FILE_SORT_DEFAULT_DIRECTION, type FileSortMode, type FileSortDirection } from "../../utils/fileTreeSort";
import { compactMiddlePackages } from "../../utils/fileTreeCompact";
import { compactMiddlePackagesAtom } from "../../atoms/app-ui-atoms";
import { writeFileNodeDragPayload } from "../app/AppUtils";
import { t } from "../../i18n";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { showNotice } from "../../utils/notice";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import type { FileTreeNode, Project, SessionSummary } from "../../../../shared/types";
import { Input } from "../ui-shadcn/input";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import { FileSearch, Search } from "lucide-react";
import { useFileSearch } from "../../hooks/useFileSearch";
import { FileSearchResults } from "./FileSearchResults";
import { isEditableTarget, isFileSearchShortcut, isTypeToSearchKey } from "../../utils/fileSearchTrigger";

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
			className="files-panel flex min-h-0 flex-1 flex-col overflow-x-hidden"
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
			{/* 工具行压矮：去掉顶栏后这是文件抽屉唯一 chrome；h-7 + size-6 对齐侧栏密度 */}
			<div className="panel-action-row flex h-7 min-w-0 shrink-0 items-center justify-end gap-1 border-b border-border/40 px-2 text-xs text-muted-foreground">
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
					<Button type="button" variant="ghost" size="icon-sm" className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={props.onRefreshFiles} title={t("common.refresh")} aria-label={t("common.refresh")}>
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
				<FileSearchResults query={fileSearch.query} onQueryChange={fileSearch.setQuery} results={fileSearch.results} isSearching={fileSearch.isSearching} onViewFile={props.onViewFile} onFileContextMenu={props.onFileContextMenu} onClear={closeSearch} />
			) : (
				displayFiles.map((node) => (
					<FileNode
						key={node.path}
						node={node}
						expandedDirs={props.expandedDirs}
						onToggleDirectory={props.onToggleDirectory}
						onFileContextMenu={props.onFileContextMenu}
						onOpenFile={props.onOpenFile}
						onViewFile={props.onViewFile}
						onDropFiles={props.onDropFiles}
						onMoveFiles={props.onMoveFiles}
						dragOverDir={dragOverDir}
						onDragOverDirChange={setDragOverDir}
					/>
				))
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
			{!collapsed && (
				<>
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
				</>
			)}
		</section>
	);
}

function fileIconElement(name: string, isDirectory: boolean, isExpanded: boolean) {
	if (isDirectory) {
		return isExpanded ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />;
	}
	try {
		const { svg, colorName } = getFileIconSeti(name);
		const color = getFileIconColor(colorName);
		// SVG 只来自仓库内附带许可证的只读 Seti 数据快照，不接收文件内容或用户输入。
		// 尺寸由 .file-node-seti-icon → --file-type-icon-size 承担（树行不用 shadcn Button，避免其 [&_svg]:size-4 抢尺寸）。
		return <span aria-hidden="true" className="file-node-seti-icon" style={{ color }} dangerouslySetInnerHTML={{ __html: svg }} />;
	} catch {
		return <FileText size={16} aria-hidden="true" />;
	}
}

function FileNode(props: {
	node: FileTreeNode;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onOpenFile?: (path: string) => void;
	/** 单击默认预览；第二参 permanent = 双击常驻 */
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	depth?: number;
	/** 拖入文件（仅目录节点使用） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 内部拖拽移动文件/目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
	dragOverDir?: string | null;
	onDragOverDirChange?: (path: string | null) => void;
}) {
	const { node, expandedDirs, onToggleDirectory, depth = 0 } = props;
	const expanded = expandedDirs.has(node.path);
	const typeLabel = node.type === "file" ? getFileTypeLabel(node.name) : "";
	const rowStyle = {
		/* 每层 8px：旧 16 在窄抽屉里空白过大（标注「缩进太大」）。 */
		"--file-depth-offset": `${depth * 8}px`,
		paddingLeft: `calc(var(--space-1) + ${depth * 8}px)`,
		paddingRight: "var(--space-1)",
	} as CSSProperties;
	const menu = (event: ReactMouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	// 内部拖拽移动：dataTransfer 携带源路径，目录行是落点；OS 文件拖入则是复制
	// effectAllowed=copyMove：目录落点显式选 move（内部移动），composer 落点选 copy（插入 @ 引用）
	const handleDragStart = useCallback(
		(event: React.DragEvent) => {
			event.dataTransfer.effectAllowed = "copyMove";
			writeFileNodeDragPayload(event.dataTransfer, node);
		},
		[node],
	);
	const handleDragOver = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = "move";
			props.onDragOverDirChange?.(node.path);
		},
		[node.path, props.onDragOverDirChange],
	);
	const handleDragLeave = useCallback(() => {
		props.onDragOverDirChange?.(null);
	}, [props.onDragOverDirChange]);
	const handleDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			props.onDragOverDirChange?.(null);
			// 内部拖拽移动：优先检查 pi-file-path
			const sourcePath = event.dataTransfer.getData("text/pi-file-path");
			if (sourcePath) {
				if (sourcePath !== node.path && props.onMoveFiles) {
					props.onMoveFiles([sourcePath], node.path);
				}
				return;
			}
			// 外部 OS 文件拖入：复制到目标目录
			if (event.dataTransfer.files.length > 0 && props.onDropFiles) {
				props.onDropFiles(node.path, event.dataTransfer.files);
			}
		},
		[node.path, props.onDropFiles, props.onMoveFiles, props.onDragOverDirChange],
	);
	const isDragOver = props.dragOverDir === node.path;
	/* 树行用原生 button，不用 shadcn Button：后者基类强制子 SVG size-4，
	   会压掉 Seti --file-type-icon-size 与 lucide size，靠 ! 反压是补丁。
	   2027-01：hover 高亮加与侧栏行同款的过渡动画（transition-[background-color,
	   border-color,box-shadow] duration-200），移入文件列表时背景平滑渐变而非瞬切。 */
	const fileRowButtonClass =
		"file-node-row inline-flex h-[28px] min-h-0 w-full items-center justify-start gap-1.5 rounded-sm border-0 bg-transparent py-0 text-left text-body font-normal text-foreground transition-[background-color,border-color,box-shadow] duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";
	if (node.type === "file")
		return (
			<div className="file-node" style={rowStyle}>
				<button
					type="button"
					className={cn("file", fileRowButtonClass)}
					style={rowStyle}
					title={`${node.relativePath}\n${typeLabel}`}
					draggable
					onDragStart={handleDragStart}
					onClick={() => props.onViewFile?.(node.path)}
					onDoubleClick={(event) => {
						event.preventDefault();
						props.onViewFile?.(node.path, "permanent");
					}}
					onContextMenu={menu}
				>
					<span className="file-node-icon">{fileIconElement(node.name, false, false)}</span>
					<span className="file-node-name">{node.name}</span>
					<span className="file-node-type-label">{typeLabel}</span>
				</button>
			</div>
		);
	return (
		<div className="file-node" style={rowStyle}>
			<Collapsible open={expanded} onOpenChange={() => onToggleDirectory(node.path)}>
				<CollapsibleTrigger asChild>
					<button type="button" className={cn("directory group", fileRowButtonClass, isDragOver && "bg-muted ring-1 ring-border")} style={rowStyle} title={node.relativePath} draggable onDragStart={handleDragStart} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onContextMenu={menu}>
						<ChevronRight
							className={cn(
								"file-node-chevron size-3.5 shrink-0 transition-transform",
								/* 受控 Collapsible 在部分挂载时序下 data-state=open 不可靠，
							   按 expanded 显式旋转，保证与子树可见性一致。 */
								expanded ? "rotate-90" : "rotate-0",
							)}
							aria-hidden="true"
						/>
						<span className="file-node-icon">{fileIconElement(node.name, true, expanded)}</span>
						<span className="file-node-name">{node.name}</span>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					{/* 懒加载占位与加载失败态：二者互斥，都不会再盖住文件名。
					 - 占位独立成行（不是行内绝对定位），children 到位后整行消失；
					 - hasChildren=false 表示目录 listing 已失败或目录为空，不展示占位。
					 展开态的 chevron 修正：expanded 且子项未加载时 data-[state=open] 不生效
					 （Collapsible 由 open 受控，这里直接按 expanded 旋转）。 */}
					{expanded && node.hasChildren !== false && !node.children && (
						<div className="file-children flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
							<LoaderCircle size={12} className="animate-pideck-spin shrink-0" aria-hidden="true" />
							<span>{t("drawer.lazyLoading")}</span>
						</div>
					)}
					{node.children && node.children.length > 0 && (
						<div className="file-children">
							{node.children.map((child) => (
								<FileNode
									key={child.path}
									node={child}
									expandedDirs={expandedDirs}
									onToggleDirectory={onToggleDirectory}
									onFileContextMenu={props.onFileContextMenu}
									onOpenFile={props.onOpenFile}
									onViewFile={props.onViewFile}
									onDropFiles={props.onDropFiles}
									onMoveFiles={props.onMoveFiles}
									dragOverDir={props.dragOverDir}
									onDragOverDirChange={props.onDragOverDirChange}
									depth={depth + 1}
								/>
							))}
						</div>
					)}
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}

function SessionsPanel(props: {
	sessions: SessionSummary[];
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	/* sessionActionNotice 已改用 toast (sonner) 实现 */
	const [sessionActionLoading, setSessionActionLoading] = useState<{
		filePath: string;
		action: "copy" | "export" | "delete";
	} | null>(null);
	const [deleteConfirmSession, setDeleteConfirmSession] = useState<SessionSummary | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	function startRename(session: SessionSummary) {
		setRenamingPath(session.filePath);
		setEditValue(session.name || "");
		requestAnimationFrame(() => inputRef.current?.focus());
	}

	function confirmRename() {
		if (renamingPath && editValue.trim()) {
			void props.onRename(renamingPath, editValue.trim());
		}
		setRenamingPath(null);
		setEditValue("");
	}

	async function runSessionAction(session: SessionSummary, actionType: "copy" | "export" | "delete", action: () => void | Promise<void>, successText: string) {
		setSessionActionLoading({ filePath: session.filePath, action: actionType });
		showNotice(actionType === "copy" ? t("drawer.sessionActionCopying") : actionType === "export" ? t("drawer.sessionActionExporting") : t("drawer.sessionActionDeleting"), 3500);
		try {
			await action();
			showNotice(successText, 1600);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : t("drawer.sessionActionFailed"), 2400);
		} finally {
			setSessionActionLoading(null);
		}
	}

	// 计算子会话到父会话的分组映射；路径可能跨 Windows/WSL 或经过 IPC，统一分隔符和大小写。
	const parentToChildren = useMemo(() => {
		const map = new Map<string, SessionSummary[]>();
		for (const s of props.sessions) {
			const parentKey = normalizeSessionPathForCompare(s.parentSessionPath);
			if (parentKey) {
				const list = map.get(parentKey) ?? [];
				list.push(s);
				map.set(parentKey, list);
			}
		}
		return map;
	}, [props.sessions]);
	// 仅显示顶层会话（非子会话）的计数
	const parentSessions = useMemo(() => props.sessions.filter((s) => !s.parentSessionPath), [props.sessions]);
	const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
	const toggleParent = useCallback((filePath: string) => {
		const key = normalizeSessionPathForCompare(filePath) ?? filePath;
		setExpandedParents((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{t("drawer.sessionCount", { count: parentSessions.length })}</span>
				<Button variant="ghost" size="sm" onClick={props.onRefresh}>
					{t("common.refresh")}
				</Button>
			</div>
			{parentSessions.length === 0 && (
				<div className="sessions-empty">
					<strong>{t("drawer.sessionEmptyTitle")}</strong>
					<span>{t("drawer.sessionEmptyDesc")}</span>
				</div>
			)}
			{parentSessions.map((session) => {
				const children = parentToChildren.get(normalizeSessionPathForCompare(session.filePath) ?? "");
				const normalizedPath = normalizeSessionPathForCompare(session.filePath) ?? session.filePath;
				const isExpanded = expandedParents.has(normalizedPath);
				return (
					<div key={session.filePath} className="session-card-group">
						<div className="session-card">
							{renamingPath === session.filePath ? (
								<div className="session-rename-row">
									<Input
										ref={inputRef}
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") confirmRename();
											if (e.key === "Escape") {
												setRenamingPath(null);
												setEditValue("");
											}
										}}
										autoFocus
									/>
									<Button size="sm" onClick={confirmRename}>
										{t("common.save")}
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											setRenamingPath(null);
											setEditValue("");
										}}
									>
										{t("common.cancel")}
									</Button>
								</div>
							) : (
								<div className="session-card-display">
									<PathTooltip content={`${session.name || t("common.untitled")}\n${session.filePath}`}>
										<button className="session-card-inner" onClick={() => props.onOpen(session)}>
											<div className="session-card-title">
												<strong>{session.name || t("common.untitled")}</strong>
												{session.source && session.source !== "pi" && <SessionSourceBadge source={session.source} />}
												<small>
													{new Date(session.updatedAt).toLocaleString()} ·{" "}
													{t("drawer.sessionMessages", {
														count: session.messageCount,
													})}
												</small>
											</div>
										</button>
									</PathTooltip>
									<div className="session-card-actions">
										<Button variant="ghost" className="session-rename-button" title={t("menu.copySession")} disabled={Boolean(sessionActionLoading)} onClick={() => void runSessionAction(session, "copy", () => props.onCopy(session), t("drawer.sessionCopied"))}>
											{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "copy" && <span className="mini-loader animate-pideck-spin" />}
											<span>{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "copy" ? t("menu.copying") : t("common.copy")}</span>
										</Button>
										<Button variant="ghost" className="session-rename-button" title={t("menu.exportHtml")} disabled={Boolean(sessionActionLoading)} onClick={() => void runSessionAction(session, "export", () => props.onExport(session), t("drawer.sessionExported"))}>
											{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "export" && <span className="mini-loader animate-pideck-spin" />}
											<span>{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "export" ? t("menu.exporting") : t("common.export")}</span>
										</Button>
										<Button variant="ghost" className="session-rename-button" title={t("common.rename")} onClick={() => startRename(session)}>
											<span>{t("common.rename")}</span>
										</Button>
										<Button variant="ghost" className="session-rename-button text-destructive" title={t("common.delete")} disabled={Boolean(sessionActionLoading)} onClick={() => setDeleteConfirmSession(session)}>
											{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "delete" && <span className="mini-loader animate-pideck-spin" />}
											<span>{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "delete" ? t("drawer.sessionActionDeleting") : t("common.delete")}</span>
										</Button>
									</div>
									{/* sessionActionNotice 已改用 toast (sonner) 实现 */}
								</div>
							)}
						</div>
						{children && children.length > 0 && (
							<div className="session-card-children-header">
								<button className="session-card-expand-btn" title={isExpanded ? t("drawer.collapseSubagentSessions") : t("drawer.expandSubagentSessions")} onClick={() => toggleParent(session.filePath)}>
									{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
									<span>{t("drawer.subagentSessionCount", { count: children.length })}</span>
								</button>
							</div>
						)}
						{isExpanded &&
							children?.map((child) => (
								<div key={child.filePath} className="session-card session-card-child">
									<div className="session-card-display">
										<PathTooltip content={`${child.name || t("common.untitled")}\n${child.filePath}`}>
											<button className="session-card-inner" onClick={() => props.onOpen(child)}>
												<div className="session-card-title">
													<strong>{child.name || t("common.untitled")}</strong>
													<SessionSourceBadge label={t("drawer.subagentSession")} source="codex" />
													<small>
														{new Date(child.updatedAt).toLocaleString()} ·{" "}
														{t("drawer.sessionMessages", {
															count: child.messageCount,
														})}
													</small>
												</div>
											</button>
										</PathTooltip>
									</div>
								</div>
							))}
					</div>
				);
			})}
			{deleteConfirmSession &&
				(() => {
					const deleteChildren = parentToChildren.get(normalizeSessionPathForCompare(deleteConfirmSession.filePath) ?? "") ?? [];
					// #115 U5：删除确认统一走 shadcn ConfirmDialog（danger 变体），删掉散装 backdrop
					return (
						<ConfirmDialog
							title={t("drawer.sessionDeleteTitle")}
							message={
								deleteChildren.length > 0
									? t("drawer.sessionDeleteBodyWithChildren", {
											name: deleteConfirmSession.name || t("common.untitled"),
											count: deleteChildren.length,
										})
									: t("drawer.sessionDeleteBody", {
											name: deleteConfirmSession.name || t("common.untitled"),
										})
							}
							confirmLabel={t("common.delete")}
							danger
							onCancel={() => setDeleteConfirmSession(null)}
							onConfirm={() => {
								const target = deleteConfirmSession;
								setDeleteConfirmSession(null);
								void runSessionAction(target, "delete", () => props.onDelete(target), t("drawer.sessionDeleted"));
							}}
						/>
					);
				})()}
		</div>
	);
}

export function SessionHistoryModal(props: {
	project: Project;
	sessions: SessionSummary[];
	loading: boolean;
	onClose: () => void;
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex max-h-[min(680px,calc(100vh-80px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle></DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="truncate border-b border-border-subtle bg-bg-muted px-[18px] py-[10px] text-caption text-text-secondary" title={props.project.path}>
					{props.project.path}
				</div>
				<div className="relative flex min-h-[320px] flex-1 flex-col overflow-hidden">
					{props.loading ? (
						<div className="grid min-h-[320px] place-items-center content-center gap-3 text-body text-text-tertiary">
							<div className="loader animate-pideck-spin" />
							<span>{t("drawer.historyLoading")}</span>
						</div>
					) : (
						<SessionsPanel sessions={props.sessions} onRefresh={props.onRefresh} onOpen={props.onOpen} onRename={props.onRename} onCopy={props.onCopy} onExport={props.onExport} onDelete={props.onDelete} />
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** 创建 git worktree 的对话框 */
