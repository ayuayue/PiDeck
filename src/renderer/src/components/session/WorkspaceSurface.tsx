import { cn } from "../../lib/utils";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import {
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	FileText,
	Folder,
	FolderOpen,
	Pin,
	RefreshCw,
	X,
} from "lucide-react";
import { normalizeSessionPathForCompare } from "../../agentListDisplay";
import { SessionSourceBadge } from "./SessionSourceBadge";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { FileSortControl } from "./FileSortControl";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../fileIcons";
import { sortFileNodes, FILE_SORT_OPTIONS, FILE_SORT_DEFAULT_DIRECTION, type FileSortMode, type FileSortDirection } from "../../utils/fileTreeSort";
import { writeFileNodeDragPayload } from "../app/AppUtils";
import { t } from "../../i18n";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { showNotice } from "../../utils/notice";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import type { FileTreeNode, Project, SessionSummary } from "../../../../shared/types";
import { Input } from "../ui-shadcn/input";
import { PathTooltip } from "../ui-shadcn/PathTooltip";

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
	files: FileTreeNode[];
	sessions: SessionSummary[];
	sessionsLoading?: boolean;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onCollapseAllDirectories: () => void;
	pinned: boolean;
	onTogglePin: () => void;
	onCollapse: () => void;
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
	onViewFile?: (path: string) => void;
	/** 项目根目录：面板空白处拖入/粘贴/右键的落点 */
	projectRoot?: string;
	/** 从 OS 拖入文件到目录或面板空白区域（复制） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件到目标目录（Ctrl+V / 右键菜单） */
	onPasteFiles?: (targetDir: string) => void;
	/** 文件树内部拖拽移动文件/目录到目标目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
}) {
	const title =
		props.panel === "files"
			? t("drawer.files")
			: props.project
				? t("drawer.projectSessions", { name: props.project.name })
				: t("drawer.historyTitle");
	return (
		<>
			{/* pure official：与 Git 抽屉共用 h-12 顶栏密度 */}
			<div className="drawer-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background px-3">
				<strong className="truncate text-sm font-semibold text-foreground">{title}</strong>
				<div className="drawer-header-actions flex shrink-0 items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className={`inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground${props.pinned ? " active bg-accent text-accent-foreground" : ""}`}
						title={props.pinned ? t("drawer.unpin") : t("drawer.pin")}
						aria-label={props.pinned ? t("drawer.unpin") : t("drawer.pin")}
						onClick={props.onTogglePin}
					>
						<Pin size={15} />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
						disabled={props.pinned}
						title={props.pinned ? t("drawer.pinnedCannotClose") : t("drawer.closePanel")}
						aria-label={t("drawer.closePanel")}
						onClick={props.onClose}
					>
						<X size={16} />
					</Button>
				</div>
			</div>
			{props.panel === "files" && (
				<FilesPanel
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
			{props.panel === "sessions" && (
				<SessionsPanel
					sessions={props.sessions}
					onRefresh={props.onRefreshSessions}
					onOpen={props.onOpenSession}
					onRename={props.onRenameSession}
					onCopy={props.onCopySession}
					onExport={props.onExportSession}
					onDelete={props.onDeleteSession}
				/>
			)}
		</>
	);
}

function FilesPanel(props: {
	files: FileTreeNode[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	/** 收起文件树中所有已展开的目录，清空 expandedDirs。 */
	onCollapseAll?: () => void;
	onOpenFolder?: () => void;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
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
	// 排序是纯展示层变换：不改变 props.files 引用，只影响渲染次序
	const sortedFiles = useMemo(
		() => sortFileNodes(props.files, sortMode, sortDirection),
		[props.files, sortMode, sortDirection],
	);
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
		}
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
			className="files-panel flex min-h-0 flex-1 flex-col overflow-hidden"
			tabIndex={-1}
			onDragOver={handlePanelDragOver}
			onDragLeave={() => { setDragOverDir(null); dragCountRef.current = 0; }}
			onDrop={handlePanelDrop}
			onKeyDown={handlePanelKeyDown}
			onContextMenu={handlePanelContextMenu}
		>
			{/* 工具行：min-w-0 允许收缩；排序为单个图标（鼠标移入展开菜单），不占额外宽度 */}
			<div className="panel-action-row flex h-9 min-w-0 shrink-0 items-center justify-end gap-2 border-b border-border/40 px-3 text-xs text-muted-foreground">
				<div className="panel-action-buttons flex min-w-0 items-center gap-1">
					{/* 文件树排序：方向切换与维度选择合并在一个图标菜单内（默认按名称·升序） */}
					<FileSortControl
						sortMode={sortMode}
						sortDirection={sortDirection}
						onSortModeChange={setSortMode}
						onToggleDirection={() => setSortDirection((d) => (d === "asc" ? "desc" : "asc"))}
					/>
					{props.onOpenFolder && (
						<Button type="button" variant="ghost" size="icon-sm" className="icon-only inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={props.onOpenFolder} title={t("drawer.openFolder")} aria-label={t("drawer.openFolder")}>
							<Folder size={14} />
						</Button>
					)}
					{/* 刷新与全部收起：纯图标，密度对齐 shadcn icon button */}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="icon-only inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
						onClick={props.onRefreshFiles}
						title={t("common.refresh")}
						aria-label={t("common.refresh")}
					>
						<RefreshCw size={14} />
					</Button>
					{props.onCollapseAll && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="icon-only inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
							onClick={props.onCollapseAll}
							title={t("drawer.collapseAllDirs")}
							aria-label={t("drawer.collapseAllDirs")}
							disabled={props.expandedDirs.size === 0}
						>
							<ChevronsDownUp size={14} />
						</Button>
					)}
				</div>
			</div>
			{sortedFiles.map((node) => (
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
			))}
		</div>
	);
}

const SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX =
	"pid:session-file-summary-collapsed:";
const SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX =
	"pid:session-file-summary-file-list-expanded:";

/** 读取指定 session 的折叠状态(无存储返回默认值) */
function loadCollapsed(sessionKey: string | null): boolean {
	if (!sessionKey || typeof window === "undefined") return true;
	const stored = localStorage.getItem(
		SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX + sessionKey,
	);
	return stored !== null ? stored === "true" : true;
}

function loadFileListExpanded(sessionKey: string | null): boolean {
	if (!sessionKey || typeof window === "undefined") return false;
	const stored = localStorage.getItem(
		SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX + sessionKey,
	);
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
	const [collapsed, setCollapsed] = useState(() =>
		loadCollapsed(props.sessionIdOrPath ?? null),
	);
	const [fileListExpanded, setFileListExpanded] = useState(() =>
		loadFileListExpanded(props.sessionIdOrPath ?? null),
	);
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
				localStorage.setItem(
					SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX + props.sessionIdOrPath,
					String(next),
				);
			}
			return next;
		});
	}, [props.sessionIdOrPath]);

	const handleToggleFileList = useCallback(() => {
		setFileListExpanded((prev) => {
			const next = !prev;
			if (props.sessionIdOrPath) {
				localStorage.setItem(
					SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX +
						props.sessionIdOrPath,
					String(next),
				);
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
			<button
				className="session-file-summary-header"
				type="button"
				onClick={handleToggleCollapsed}
				aria-expanded={!collapsed}
			>
				<ChevronDown
					size={14}
					className={`session-file-summary-chevron${collapsed ? "" : " open"}`}
				/>
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
									<button
										className="session-file-summary-row"
										type="button"
										title={file.path}
										onClick={() => props.onDiffFile?.(file.path, file.originalContent, file.content)}
									>
										<span className="session-file-summary-name">{fileName}</span>
									</button>
								</li>
							);
						})}
					</ul>
					{props.files.length > 4 && (
						<button
							className="session-file-summary-toggle"
							type="button"
							onClick={handleToggleFileList}
						>
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
		return isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />;
	}
	try {
		const { svg, colorName } = getFileIconSeti(name);
		const color = getFileIconColor(colorName);
		// SVG 只来自仓库内附带许可证的只读 Seti 数据快照，不接收文件内容或用户输入。
		return (
			<span
				aria-hidden="true"
				className="file-node-seti-icon"
				style={{ color }}
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
		);
	} catch {
		return <FileText size={15} />;
	}
}

function FileNode(props: {
	node: FileTreeNode;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
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
	const rowStyle = { "--file-depth-offset": `${depth * 16}px` } as CSSProperties;
	const menu = (event: ReactMouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	// 内部拖拽移动：dataTransfer 携带源路径，目录行是落点；OS 文件拖入则是复制
	// effectAllowed=copyMove：目录落点显式选 move（内部移动），composer 落点选 copy（插入 @ 引用）
	const handleDragStart = useCallback((event: React.DragEvent) => {
		event.dataTransfer.effectAllowed = "copyMove";
		writeFileNodeDragPayload(event.dataTransfer, node);
	}, [node]);
	const handleDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		props.onDragOverDirChange?.(node.path);
	}, [node.path, props.onDragOverDirChange]);
	const handleDragLeave = useCallback(() => {
		props.onDragOverDirChange?.(null);
	}, [props.onDragOverDirChange]);
	const handleDrop = useCallback((event: React.DragEvent) => {
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
	}, [node.path, props.onDropFiles, props.onMoveFiles, props.onDragOverDirChange]);
	const isDragOver = props.dragOverDir === node.path;
	// #115 U5：树行换 shadcn File Tree 模式（Collapsible + ghost Button + chevron 旋转），
	// 懒加载/持久化展开态（expandedDirs）/拖拽/右键等业务行为不变；
	// 既有 class 钩子（file-node-row 等）保留给样式 token 与测试断言。
	if (node.type === "file")
		return (
			<div className="file-node" style={rowStyle}>
				<Button variant="ghost" className="file file-node-row w-full justify-start" style={rowStyle}
					title={`${node.relativePath}\n${typeLabel}`}
					draggable
					onDragStart={handleDragStart}
					onClick={() => props.onViewFile?.(node.path)}
					onContextMenu={menu}>
					<span className="file-node-icon">
						{fileIconElement(node.name, false, false)}
					</span>
					<span className="file-node-name">{node.name}</span>
					<span className="file-node-type-label">{typeLabel}</span>
				</Button>
			</div>
		);
	return (
		<div className="file-node" style={rowStyle}>
			<Collapsible open={expanded} onOpenChange={() => onToggleDirectory(node.path)}>
				<CollapsibleTrigger asChild>
					<Button variant="ghost" className={cn("directory file-node-row group w-full justify-start", isDragOver && "bg-accent/60 ring-1 ring-border")} style={rowStyle}
						title={node.relativePath}
						draggable
						onDragStart={handleDragStart}
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
						onContextMenu={menu}>
						<ChevronRight className="file-node-chevron transition-transform group-data-[state=open]:rotate-90" size={13} />
						<span className="file-node-icon">
							{fileIconElement(node.name, true, expanded)}
						</span>
						<span className="file-node-name">{node.name}</span>
					</Button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					{node.children && node.children.length > 0 && (
						<div className="file-children">
							{node.children.map((child) => (
								<FileNode key={child.path} node={child}
									expandedDirs={expandedDirs}
									onToggleDirectory={onToggleDirectory}
									onFileContextMenu={props.onFileContextMenu}
									onOpenFile={props.onOpenFile}
									onViewFile={props.onViewFile}
									onDropFiles={props.onDropFiles}
									onMoveFiles={props.onMoveFiles}
									dragOverDir={props.dragOverDir}
									onDragOverDirChange={props.onDragOverDirChange}
									depth={depth + 1} />
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
	const [deleteConfirmSession, setDeleteConfirmSession] =
		useState<SessionSummary | null>(null);
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

	async function runSessionAction(
		session: SessionSummary,
		actionType: "copy" | "export" | "delete",
		action: () => void | Promise<void>,
		successText: string,
	) {
		setSessionActionLoading({ filePath: session.filePath, action: actionType });
		showNotice(
			actionType === "copy"
				? t("drawer.sessionActionCopying")
				: actionType === "export"
					? t("drawer.sessionActionExporting")
					: t("drawer.sessionActionDeleting"),
			3500,
		);
		try {
			await action();
			showNotice(successText, 1600);
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : t("drawer.sessionActionFailed"),
				2400,
			);
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
	const parentSessions = useMemo(() =>
		props.sessions.filter(s => !s.parentSessionPath),
		[props.sessions],
	);
	const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
	const toggleParent = useCallback((filePath: string) => {
		const key = normalizeSessionPathForCompare(filePath) ?? filePath;
		setExpandedParents(prev => {
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
				<Button variant="ghost" size="sm" onClick={props.onRefresh}>{t("common.refresh")}</Button>
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
				<div
					key={session.filePath}
					className="session-card-group"
				>
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
							<Button size="sm" onClick={confirmRename}>{t("common.save")}</Button>
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
								<button
									className="session-card-inner"
									onClick={() => props.onOpen(session)}
								>
									<div className="session-card-title">
										<strong>{session.name || t("common.untitled")}</strong>
										{session.source && session.source !== "pi" && (
											<SessionSourceBadge source={session.source} />
										)}
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
								<Button
									variant="ghost"
									className="session-rename-button"
									title={t("menu.copySession")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"copy",
											() => props.onCopy(session),
											t("drawer.sessionCopied"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy"
											? t("menu.copying")
											: t("common.copy")}
									</span>
								</Button>
								<Button
									variant="ghost"
									className="session-rename-button"
									title={t("menu.exportHtml")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"export",
											() => props.onExport(session),
											t("drawer.sessionExported"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export"
											? t("menu.exporting")
											: t("common.export")}
									</span>
								</Button>
								<Button
									variant="ghost"
									className="session-rename-button"
									title={t("common.rename")}
									onClick={() => startRename(session)}
								>
									<span>{t("common.rename")}</span>
								</Button>
								<Button
									variant="ghost"
									className="session-rename-button text-destructive"
									title={t("common.delete")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() => setDeleteConfirmSession(session)}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete"
											? t("drawer.sessionActionDeleting")
											: t("common.delete")}
									</span>
								</Button>
							</div>
							{/* sessionActionNotice 已改用 toast (sonner) 实现 */}
						</div>
					)}
				</div>
					{children && children.length > 0 && (
						<div className="session-card-children-header">
							<button
								className="session-card-expand-btn"
								title={isExpanded ? t("drawer.collapseSubagentSessions") : t("drawer.expandSubagentSessions")}
								onClick={() => toggleParent(session.filePath)}
							>
								{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
								<span>{t("drawer.subagentSessionCount", { count: children.length })}</span>
							</button>
						</div>
					)}
					{isExpanded && children?.map((child) => (
						<div key={child.filePath} className="session-card session-card-child">
							<div className="session-card-display">
								<PathTooltip content={`${child.name || t("common.untitled")}\n${child.filePath}`}>
									<button
										className="session-card-inner"
										onClick={() => props.onOpen(child)}
									>
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
			{deleteConfirmSession && (() => {
					const deleteChildren = parentToChildren.get(normalizeSessionPathForCompare(deleteConfirmSession.filePath) ?? "") ?? [];
					// #115 U5：删除确认统一走 shadcn ConfirmDialog（danger 变体），删掉散装 backdrop
					return (
						<ConfirmDialog
							title={t("drawer.sessionDeleteTitle")}
							message={deleteChildren.length > 0
								? t("drawer.sessionDeleteBodyWithChildren", {
										name: deleteConfirmSession.name || t("common.untitled"),
										count: deleteChildren.length,
									})
								: t("drawer.sessionDeleteBody", {
										name: deleteConfirmSession.name || t("common.untitled"),
									})}
							confirmLabel={t("common.delete")}
							danger
							onCancel={() => setDeleteConfirmSession(null)}
							onConfirm={() => {
								const target = deleteConfirmSession;
								setDeleteConfirmSession(null);
								void runSessionAction(
									target,
									"delete",
									() => props.onDelete(target),
									t("drawer.sessionDeleted"),
								);
							}}
						/>
					); })()
		}
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
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "session-history-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle></DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="session-history-path" title={props.project.path}>
					{props.project.path}
				</div>
				<div className="session-history-body">
					{props.loading ? (
						<div className="session-history-loading">
							<div className="loader" />
							<span>{t("drawer.historyLoading")}</span>
						</div>
					) : (
						<SessionsPanel
							sessions={props.sessions}
							onRefresh={props.onRefresh}
							onOpen={props.onOpen}
							onRename={props.onRename}
							onCopy={props.onCopy}
							onExport={props.onExport}
							onDelete={props.onDelete}
						/>
					)}
				</div>
		
			</DialogContent>
		</Dialog>
	);
}

/** 创建 git worktree 的对话框 */
