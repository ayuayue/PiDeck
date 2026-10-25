import { Fragment, memo, useState, type ReactNode } from "react";
import { ChevronDown, FileText, Loader2, Minus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "../../ui-shadcn/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../ui-shadcn/context-menu";
import { getFileIconColor, getFileIconSeti } from "../../../fileIcons";
import { t } from "../../../i18n";
import { GitStatus, type GitFileStatus, type GitResource, type GitResourceGroupType } from "../../../../../shared/types";
import { buildChangeTreeRows, toRelativeChangePath, type GitChangeViewMode } from "./changeTree";

/** 树形视图每级缩进（px）；与文件抽屉的树保持同一节奏 */
export const CHANGE_TREE_INDENT_PX = 14;
/** 文件行的基准左内边距，与扁平视图的 pl-3 保持一致 */
const FILE_ROW_BASE_PADDING = 12;
/** 目录行的基准左内边距，与扁平视图的 px-2 保持一致 */
const DIR_ROW_BASE_PADDING = 8;

export function fileNameOnly(path: string): string {
	return path.split(/[/\\]/).pop() ?? path;
}

/**
 * 缩短长目录路径，类似 Java package 包名缩写：取每段的首字母。
 * 例如 "src/main/java/com/example/service/impl" → "s/m/j/c/e/s/i"。
 * 短路径（≤3 段或总长 ≤20）保持原样。
 * 仅扁平视图使用：树形视图靠紧凑链把层级摊平，缩写会丢掉可读的目录名。
 */
function shortenDir(dir: string): string {
	const parts = dir.split("/");
	if (parts.length <= 3 || dir.length <= 20) return dir;
	return parts.map((p) => p.charAt(0) || "").join("/");
}

/** 按目录分组 Git 资源，返回 { dir -> resources[] } 映射（扁平视图；目录只到一级） */
function groupByDir(
	resources: GitResource[],
	/** 项目根目录，传入后目录名显示为相对路径而非绝对路径 */
	rootPath?: string,
): Map<string, GitResource[]> {
	const dirs = new Map<string, GitResource[]>();
	for (const r of resources) {
		// 将绝对路径转为相对路径，使目录分组显示简洁的相对路径而非长绝对路径
		const p = toRelativeChangePath(r.path, rootPath);
		const parts = p.split(/[/\\]/);
		const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
		if (!dirs.has(dir)) dirs.set(dir, []);
		dirs.get(dir)!.push(r);
	}
	return dirs;
}

/** 收集变更列表中可折叠的目录键（扁平视图语义：单根无目录头时返回空） */
export function getCollapsibleChangeDirs(resources: GitResource[], projectRoot?: string): string[] {
	const byDir = groupByDir(resources, projectRoot);
	const dirs = [...byDir.keys()];
	// 与 FileTree 一致：仅一个根目录时不显示目录头，也就没有可折叠项
	if (dirs.length === 1 && dirs[0] === "") return [];
	return dirs;
}

/**
 * 按目录渲染文件列表：flat = 一级目录分组；tree = 嵌套目录树（紧凑链合并单子目录）。
 * memo：commit composer 输入会让 GitPanel 每次按键重渲，resources/回调引用不变时
 * 不应重建整棵变更树（行内 Radix ContextMenu + Seti SVG，代价随变更文件数线性增长）。
 */
export const FileTree = memo(function FileTree(props: {
	resources: GitResource[];
	groupType: GitResourceGroupType;
	stageFile?: (path: string) => void;
	/** 目录级暂存只传当前目录资源，避免影响其他目录。 */
	stageDir?: (paths: string[]) => void;
	unstageFile?: (path: string) => void;
	discardFile?: (path: string, group: "workingTree" | "untracked") => void;
	/** 目录级回滚携带资源组，主进程可在一次状态快照中安全处理混合资源。 */
	discardDir?: (resources: Array<{ path: string; group: "workingTree" | "untracked" }>, label: string) => void;
	/** 右键菜单“删除文件”入口；未提供时不启用右键菜单 */
	deleteFile?: (path: string) => void;
	/** 行内“打开文件”按钮：打开编辑器而非 diff 视图 */
	onOpenFile?: (path: string) => void;
	mutating: boolean;
	onOpenWorkspaceFileDiff: (group: GitResourceGroupType, path: string) => void;
	/** 项目根目录路径，用于显示相对路径 */
	projectRoot?: string;
	/** 受控：已折叠目录集合（与父级「收起/展开全部」共享） */
	collapsedDirs: Set<string>;
	onToggleDir: (dir: string) => void;
	/** 视图模式：flat（默认，一级目录分组）/ tree（嵌套目录树） */
	viewMode?: GitChangeViewMode;
}) {
	const byDir = groupByDir(props.resources, props.projectRoot);
	// 按目录名排序，根目录排最前
	const dirs = [...byDir.keys()].sort((a, b) => {
		if (a === "") return -1;
		if (b === "") return 1;
		return a.localeCompare(b);
	});

	/**
	 * 单行文件：暂存/取消暂存/回滚/打开。depth 只影响左缩进，动作与扁平视图完全一致。
	 */
	const renderResourceRow = (r: GitResource, depth: number) => {
		const actions: Array<{
			label: string;
			kind: "stage" | "unstage" | "discard" | "open";
			disabled?: boolean;
			run: () => void;
		}> = [];
		if (props.groupType === "index") {
			actions.push({
				label: t("git.unstage"),
				kind: "unstage",
				disabled: props.mutating,
				run: () => props.unstageFile?.(r.path),
			});
		} else if (props.groupType === "workingTree" || props.groupType === "untracked") {
			// Changes 组只含工作区侧资源（见 collectUnstagedResources），每行都能再次暂存/回滚
			actions.push({
				label: t("git.stage"),
				kind: "stage",
				disabled: props.mutating,
				run: () => props.stageFile?.(r.path),
			});
			// 回滚：tracked 走 git restore，untracked 走回收站删除
			actions.push({
				label: t("git.discardChanges"),
				kind: "discard",
				disabled: props.mutating,
				run: () => props.discardFile?.(r.path, r.status === GitStatus.UNTRACKED ? "untracked" : "workingTree"),
			});
		}
		if (props.onOpenFile) {
			actions.push({
				label: t("common.open"),
				kind: "open",
				run: () => props.onOpenFile?.(r.path),
			});
		}
		return (
			<ResourceRow
				key={r.path}
				status={r.status}
				letter={r.letter}
				path={r.path}
				indent={depth * CHANGE_TREE_INDENT_PX}
				onOpen={() =>
					props.onOpenWorkspaceFileDiff(
						// Changes 组只含工作区侧资源（workingTree + untracked，见 collectUnstagedResources）：
						// 未跟踪文件按实际状态传 untracked，否则服务端在 workingTree 组找不到而打不开
						props.groupType === "workingTree" && r.status === GitStatus.UNTRACKED ? "untracked" : props.groupType,
						r.path,
					)
				}
				actions={actions}
				deleteFile={props.deleteFile ? (path) => props.deleteFile?.(path) : undefined}
			/>
		);
	};

	/**
	 * 目录行：折叠开关 + 目录级暂存/回滚 + 计数。
	 * 目录级操作只作用于传入的资源（树形视图传整棵子树），不影响其他目录。
	 */
	const renderDirHeader = (dir: string, label: string, dirResources: GitResource[], depth: number) => {
		const discardable = dirResources
			.filter((resource) => resource.status === GitStatus.UNTRACKED || props.groupType === "workingTree")
			.map((resource) => ({
				path: resource.path,
				group: resource.status === GitStatus.UNTRACKED ? ("untracked" as const) : ("workingTree" as const),
			}));
		return (
			<div
				key={dir || "root"}
				className="group/dir flex cursor-pointer items-center gap-1 rounded-xs px-2 py-[3px] select-none hover:bg-[var(--git-panel-hover)] focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none"
				style={{ paddingLeft: DIR_ROW_BASE_PADDING + depth * CHANGE_TREE_INDENT_PX }}
				/* 折叠是目录展开的唯一入口，键盘必须可达（GitGraph 行同款 inset 焦点环） */
				role="button"
				tabIndex={0}
				aria-expanded={!props.collapsedDirs.has(dir)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						props.onToggleDir(dir);
					}
				}}
				onClick={() => props.onToggleDir(dir)}
			>
				<ChevronDown size={12} className={`shrink-0 text-text-tertiary transition-transform duration-fast${props.collapsedDirs.has(dir) ? " -rotate-90" : " rotate-0"}`} />
				<span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={dir || "/"}>
					{label}
				</span>
				<span className="ml-auto flex items-center gap-0.5">
					{props.stageDir && dirResources.length > 0 && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="invisible size-6 rounded-xs text-text-tertiary group-hover/dir:visible hover:bg-[var(--git-panel-hover)] hover:text-text-primary"
							aria-label={t("git.stageDirectory")}
							title={t("git.stageDirectory")}
							disabled={props.mutating}
							onClick={(event) => {
								event.stopPropagation();
								props.stageDir?.(dirResources.map((resource) => resource.path));
							}}
						>
							<Plus size={13} aria-hidden="true" />
						</Button>
					)}
					{props.discardDir && discardable.length > 0 && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="invisible size-6 rounded-xs text-text-tertiary group-hover/dir:visible hover:bg-[var(--git-panel-hover)] hover:text-[var(--color-danger)]"
							aria-label={t("git.discardDirectory")}
							title={t("git.discardDirectory")}
							disabled={props.mutating}
							onClick={(event) => {
								event.stopPropagation();
								props.discardDir?.(discardable, dir || "/");
							}}
						>
							<RotateCcw size={13} aria-hidden="true" />
						</Button>
					)}
					<span className="px-1 text-micro tabular-nums text-text-tertiary">{dirResources.length}</span>
				</span>
			</div>
		);
	};

	// 树形视图：嵌套目录 + 缩进；折叠项由 buildChangeTreeRows 直接剪枝，渲染层无需回溯层级
	if (props.viewMode === "tree") {
		return <>{buildChangeTreeRows(props.resources, props.projectRoot, props.collapsedDirs).map((row) => (row.kind === "dir" ? renderDirHeader(row.path, row.label, row.resources, row.depth) : renderResourceRow(row.resource, row.depth)))}</>;
	}

	return (
		<>
			{dirs.map((dir) => {
				const resources = byDir.get(dir)!;
				// 单目录且无嵌套时不显示目录头
				const isSingleRoot = dirs.length === 1 && dir === "";
				// 即使只有根目录，目录级操作仍需要一个可点击的目录头；没有批量操作时保持旧的紧凑布局。
				const hideDirHeader = isSingleRoot && !props.stageDir && !props.discardDir;
				return (
					<Fragment key={dir || "root"}>
						{!hideDirHeader && renderDirHeader(dir, shortenDir(dir) || "/", resources, 0)}
						{(!props.collapsedDirs.has(dir) || hideDirHeader) && resources.map((r) => renderResourceRow(r, 0))}
					</Fragment>
				);
			})}
		</>
	);
});

export function statusTone(status: GitStatus | GitFileStatus, isCompareContext = false): string {
	if (isCompareContext) {
		switch (status) {
			case "added":
				return "status-added";
			case "deleted":
				return "status-deleted";
			case "renamed":
				return "status-renamed";
			default:
				return "status-modified";
		}
	}

	switch (status) {
		case GitStatus.INDEX_ADDED:
		case GitStatus.UNTRACKED:
		case GitStatus.INTENT_TO_ADD:
			return "status-added";
		case GitStatus.INDEX_DELETED:
		case GitStatus.DELETED:
			return "status-deleted";
		case GitStatus.INDEX_RENAMED:
		case GitStatus.INDEX_COPIED:
		case GitStatus.INTENT_TO_RENAME:
			return "status-renamed";
		case GitStatus.ADDED_BY_US:
		case GitStatus.ADDED_BY_THEM:
		case GitStatus.DELETED_BY_US:
		case GitStatus.DELETED_BY_THEM:
		case GitStatus.BOTH_ADDED:
		case GitStatus.BOTH_DELETED:
		case GitStatus.BOTH_MODIFIED:
			return "status-conflicting";
		default:
			return "status-modified";
	}
}

export function compareStatusLetter(status: GitFileStatus): string {
	switch (status) {
		case "added":
			return "A";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		default:
			return "M";
	}
}

export function FileIcon({ name }: { name: string }) {
	try {
		const { svg, colorName } = getFileIconSeti(name);
		return <span aria-hidden="true" className="mr-1.5 inline-flex size-5 shrink-0 items-center justify-center [&_svg]:size-full [&_svg]:fill-current" style={{ color: getFileIconColor(colorName) }} dangerouslySetInnerHTML={{ __html: svg }} />;
	} catch {
		// 未知类型兜底：FileText 线性图标（16px，与 Seti 图标同槽位）而非空透明方块——
		// 空方块在非代码文件密集的目录里像图标加载失败。
		return (
			<span aria-hidden="true" className="mr-1.5 inline-flex size-5 shrink-0 items-center justify-center text-[var(--git-desc-fg)] [&_svg]:size-4">
				<FileText />
			</span>
		);
	}
}

/** Mirrors VS Code's monaco-tl-twistie without importing structural icons. */
export function Twistie({ open }: { open: boolean }) {
	return <ChevronDown aria-hidden="true" size={14} strokeWidth={2} className={`inline-block size-3.5 shrink-0 text-[var(--git-desc-fg)] transition-transform duration-fast${open ? "" : " -rotate-90"}`} />;
}

function GitStageGlyph({ unstage = false }: { unstage?: boolean }) {
	/* 与行内 stage/unstage 按钮同用 lucide 图标；弃用超大字号 ＋/− 字符（字形基线靠 translateY 补丁对齐，观感发虚） */
	const Glyph = unstage ? Minus : Plus;
	return (
		<span className="flex size-5 items-center justify-center" aria-hidden="true">
			<Glyph size={13} strokeWidth={2} />
		</span>
	);
}

export function ResourceRow(props: {
	status: GitStatus;
	letter: string;
	path: string;
	compareStatus?: GitFileStatus;
	actions?: Array<{
		label: string;
		kind: "stage" | "unstage" | "discard" | "open";
		disabled?: boolean;
		run: () => void;
	}>;
	/** 右键菜单“删除文件”入口；未提供时不启用右键菜单（compare 只读列表） */
	deleteFile?: (path: string) => void;
	onOpen?: () => void | Promise<void>;
	/** 树形视图缩进（px），叠加在基准左内边距之上 */
	indent?: number;
}) {
	const [opening, setOpening] = useState(false);
	const name = fileNameOnly(props.path);
	const tone = props.compareStatus ? statusTone(props.compareStatus, true) : statusTone(props.status);
	const letter = props.compareStatus ? compareStatusLetter(props.compareStatus) : props.letter;
	const rowPadding = { paddingLeft: FILE_ROW_BASE_PADDING + (props.indent ?? 0) };
	const row = (
		<div className={`group git-resource-row flex h-[26px] items-center pr-[7px] text-body leading-[26px] hover:bg-[var(--git-panel-hover)] focus-within:bg-[var(--git-panel-hover)] ${tone}`} title={props.path}>
			{props.onOpen ? (
				<button
					type="button"
					className="git-resource-open flex h-[26px] min-w-0 flex-1 cursor-pointer appearance-none items-center border-0 bg-transparent p-0 text-left font-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none disabled:cursor-progress disabled:opacity-70"
					style={rowPadding}
					aria-label={t("git.openWorkspaceDiff", { path: props.path })}
					aria-busy={opening}
					disabled={opening}
					onClick={async () => {
						setOpening(true);
						try {
							await props.onOpen?.();
						} finally {
							setOpening(false);
						}
					}}
				>
					<FileIcon name={name} />
					<span className="git-resource-name min-w-0 flex-[0_1_auto] truncate text-[var(--git-panel-fg)]">{name}</span>
				</button>
			) : (
				<div className="flex h-[26px] min-w-0 flex-1 cursor-default items-center border-0 bg-transparent p-0 text-left font-inherit" style={rowPadding}>
					<FileIcon name={name} />
					<span className="git-resource-name min-w-0 flex-[0_1_auto] truncate text-[var(--git-panel-fg)]">{name}</span>
				</div>
			)}
			{props.actions && props.actions.length > 0 && (
				<div className="invisible mr-1 flex flex-[0_0_auto] items-center gap-0.5 group-hover:visible group-focus-within:visible">
					{props.actions.map((action) => (
						<Button
							variant="ghost"
							size="icon-sm"
							key={action.kind}
							className={`size-6 rounded-xs text-text-tertiary hover:bg-[var(--git-panel-hover)] hover:text-text-primary${action.kind === "discard" ? " hover:text-[var(--color-danger)]" : ""}`}
							aria-label={action.label}
							title={action.label}
							disabled={action.disabled}
							onClick={action.run}
						>
							{action.kind === "discard" ? (
								<RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
							) : action.kind === "open" ? (
								<FileText size={13} strokeWidth={2} aria-hidden="true" />
							) : action.kind === "unstage" ? (
								<Minus size={13} strokeWidth={2} aria-hidden="true" />
							) : (
								<Plus size={13} strokeWidth={2} aria-hidden="true" />
							)}
						</Button>
					))}
				</div>
			)}
			<span className="git-decoration flex items-center justify-end" aria-hidden="true">
				{opening ? <Loader2 size={13} className="animate-pideck-spin" /> : letter}
			</span>
		</div>
	);
	// 右键删除仅对变更列表启用：包一层 ContextMenu，删除后由父级弹确认框；
	// 回滚已移到行内按钮（add/rollback/openfile），compare 只读列表不启用右键
	if (!props.deleteFile) return row;
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
			<ContextMenuContent alignOffset={-4}>
				{props.deleteFile && (
					<ContextMenuItem variant="destructive" className="gap-2 text-control" onSelect={() => props.deleteFile?.(props.path)}>
						<Trash2 size={14} aria-hidden="true" />
						{t("git.deleteFile")}
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function ResourceGroup(props: { title: string; count: number; open: boolean; onToggle: () => void; allAction?: () => void; allLabel?: string; allDisabled?: boolean; children: ReactNode }) {
	return (
		<div className={`group border-b border-[var(--git-panel-border)] last:border-b-0${props.open ? " open" : ""}`}>
			<div className="flex h-[22px] items-center bg-transparent px-[7px] pl-[3px] hover:bg-[var(--git-panel-hover)]">
				<button type="button" className="inline-flex h-[22px] min-w-0 flex-1 cursor-pointer items-center border-0 bg-transparent p-0 text-left text-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none" aria-expanded={props.open} onClick={props.onToggle}>
					<Twistie open={props.open} />
					<span className="ml-px min-w-0 flex-1 truncate text-control font-semibold tracking-normal text-[var(--git-panel-fg)]">{props.title}</span>
				</button>
				{props.allAction && (
					<div className="hidden items-center gap-px group-hover:flex group-focus-within:flex group-[.open]:flex">
						<Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label={props.allLabel} title={props.allLabel} disabled={props.allDisabled} onClick={() => props.allAction?.()}>
							<GitStageGlyph unstage={props.allLabel === t("git.unstageAll")} />
						</Button>
					</div>
				)}
				<span className="ml-1 min-w-[14px] text-right text-xs tabular-nums text-[var(--git-desc-fg)]">{props.count}</span>
			</div>
			{props.open && <div className="min-w-0">{props.children}</div>}
		</div>
	);
}
