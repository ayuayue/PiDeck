import { Fragment, memo, useMemo, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, FileText, Loader2, Minus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "../../ui-shadcn/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../ui-shadcn/context-menu";
import { getFileIconColor, getFileIconSeti } from "../../../fileIcons";
import { cn } from "../../../lib/utils";
import { t } from "../../../i18n";
import { GitStatus, type GitDiscardResource, type GitFileStatus, type GitResource, type GitResourceGroupType, type ProjectFileTarget } from "../../../../../shared/types";
import { buildChangeFlatRows, buildChangeTreeRows, toRelativeChangePath, type ChangeTreeRow, type GitChangeViewMode } from "./changeTree";
import { VirtualStack } from "../../ui-shadcn/virtual-stack";

/*
 * 变更列表与文件抽屉（FileTreeRows）共用的行规格：行高 28px、字号 text-body、
 * 左内边距 --space-2 + depth × 8px、图标槽 24px、twistie 槽 16px。
 * 两个面板在右抽屉用同一套节奏，切 tab 时行距/缩进/图标列都不会跳动。
 */
/** 树形视图每级缩进（px）：与文件抽屉的 depth × 8px 同值 */
export const CHANGE_TREE_INDENT_PX = 8;
/** 文件行与目录行共用的基准左内边距（--space-2） */
const CHANGE_ROW_BASE_PADDING = 8;
export function fileNameOnly(path: string): string {
	return path.split(/[/\\]/).pop() ?? path;
}

/** 按目录分组 Git 资源，返回 { dir -> resources[] } 映射（getCollapsibleChangeDirs 用；目录只到一级） */
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

/** 树形/扁平两视图共用：文件行的动作集合类型（ResourceRow 入参） */
type ChangeRowAction = {
	label: string;
	kind: "stage" | "unstage" | "discard" | "open";
	disabled?: boolean;
	run: () => void;
};

/**
 * 行渲染上下文：每组一套动作/折叠配置。FileTree（远端面板沿用）与
 * ChangesGroupsStack（本地变更区）都通过它调 renderChangeDirRow/renderChangeFileRow，
 * 两处行渲染不会漂移。
 */
export type ChangeRowContext = {
	groupType: GitResourceGroupType;
	mutating: boolean;
	onOpenWorkspaceFileDiff: (group: GitResourceGroupType, target: ProjectFileTarget) => void | Promise<void>;
	collapsedDirs: ReadonlySet<string>;
	onToggleDir: (dir: string) => void;
	readOnly?: boolean;
	/** Managed remote index capability: no directory, discard or delete actions even if callbacks exist. */
	indexActionsOnly?: boolean;
	stagedPaths?: ReadonlySet<string>;
	stageFile?: (target: ProjectFileTarget) => void;
	unstageFile?: (target: ProjectFileTarget) => void;
	discardFile?: (target: ProjectFileTarget, group: "workingTree" | "untracked") => void;
	deleteFile?: (target: ProjectFileTarget) => void;
	onOpenFile?: (target: ProjectFileTarget) => void;
	stageDir?: (targets: ProjectFileTarget[]) => void;
	discardDir?: (resources: GitDiscardResource[], label: string) => void;
};

/** 文件行动作集合：与旧 FileTree.renderResourceRow 同判据（远端 index-only 只给取消暂存等）。 */
function changeRowActions(r: GitResource, ctx: ChangeRowContext): ChangeRowAction[] {
	const actions: ChangeRowAction[] = [];
	// 远端 index-only 能力只给「取消暂存」，不给目录/丢弃/删除动作；readOnly 连动作用都不给。
	if (!ctx.readOnly && ctx.groupType === "index" && (!ctx.indexActionsOnly || ctx.unstageFile)) {
		actions.push({
			label: t("git.unstage"),
			kind: "unstage",
			disabled: ctx.mutating,
			run: () => ctx.unstageFile?.(r.target),
		});
	} else if (!ctx.readOnly && (!ctx.indexActionsOnly || ctx.stageFile) && (ctx.groupType === "workingTree" || ctx.groupType === "untracked")) {
		// 已暂存文件在 Changes 组仅保留打开按钮，暂存/回滚归 Staged 组（VS Code 语义）
		if (!ctx.stagedPaths?.has(r.path)) {
			actions.push({
				label: t("git.stage"),
				kind: "stage",
				disabled: ctx.mutating,
				run: () => ctx.stageFile?.(r.target),
			});
			// 回滚：tracked 走 git restore，untracked 走回收站删除
			if (!ctx.indexActionsOnly)
				actions.push({
					label: t("git.discardChanges"),
					kind: "discard",
					disabled: ctx.mutating,
					run: () => ctx.discardFile?.(r.target, r.status === GitStatus.UNTRACKED ? "untracked" : "workingTree"),
				});
		}
	}
	if (ctx.onOpenFile) {
		actions.push({
			label: t("common.open"),
			kind: "open",
			run: () => ctx.onOpenFile?.(r.target),
		});
	}
	return actions;
}

/** 单行文件：暂存/取消暂存/回滚/打开。depth 只影响左缩进，动作与扁平视图完全一致。 */
function renderChangeFileRow(r: GitResource, depth: number, ctx: ChangeRowContext): ReactNode {
	return (
		<ResourceRow
			key={r.path}
			status={r.status}
			letter={r.letter}
			path={r.displayPath || r.path}
			target={r.target}
			indent={depth * CHANGE_TREE_INDENT_PX}
			onOpen={() =>
				ctx.onOpenWorkspaceFileDiff(
					// Changes 组只含工作区侧资源（workingTree + untracked，见 collectUnstagedResources）：
					// 未跟踪文件按实际状态传 untracked，否则服务端在 workingTree 组找不到而打不开
					ctx.groupType === "workingTree" && r.status === GitStatus.UNTRACKED ? "untracked" : ctx.groupType,
					r.target,
				)
			}
			actions={changeRowActions(r, ctx)}
			deleteFile={!ctx.readOnly && !ctx.indexActionsOnly && ctx.deleteFile ? (target) => ctx.deleteFile?.(target) : undefined}
		/>
	);
}

/**
 * 目录行：折叠开关 + 目录级暂存/回滚 + 计数。
 * 目录级操作只作用于传入的资源（树形视图传整棵子树），不影响其他目录。
 */
function renderChangeDirRow(dir: string, label: string, dirResources: GitResource[], depth: number, ctx: ChangeRowContext): ReactNode {
	// 已暂存文件在 Changes 组不再提供目录级暂存（VS Code 语义）：目录按钮与行内按钮同一判据。
	const stageable = dirResources.filter((resource) => !ctx.stagedPaths?.has(resource.path));
	const discardable = stageable
		.filter((resource) => resource.status === GitStatus.UNTRACKED || ctx.groupType === "workingTree")
		.map((resource) => ({
			target: resource.target,
			group: resource.status === GitStatus.UNTRACKED ? ("untracked" as const) : ("workingTree" as const),
		}));
	return (
		<div
			key={dir || "root"}
			className="group/dir flex h-7 cursor-pointer items-center gap-1.5 rounded-sm pr-2 text-body select-none transition-[background-color,border-color,box-shadow] duration-base hover:bg-muted focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none"
			style={{ paddingLeft: CHANGE_ROW_BASE_PADDING + depth * CHANGE_TREE_INDENT_PX }}
			/* 折叠是目录展开的唯一入口，键盘必须可达（GitGraph 行同款 inset 焦点环） */
			role="button"
			tabIndex={0}
			aria-expanded={!ctx.collapsedDirs.has(dir)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					ctx.onToggleDir(dir);
				}
			}}
			onClick={() => ctx.onToggleDir(dir)}
		>
			{/* twistie 槽宽 16px + 3px 视觉偏移：与文件抽屉的目录行同一列 */}
			<span aria-hidden="true" className="inline-flex h-full w-4 shrink-0 translate-x-[3px] items-center justify-center">
				<ChevronDown size={14} strokeWidth={2} className={`shrink-0 text-text-tertiary transition-transform duration-fast${ctx.collapsedDirs.has(dir) ? " -rotate-90" : " rotate-0"}`} />
			</span>
			<span className="min-w-0 flex-1 truncate font-normal text-[var(--git-panel-fg)]" title={dir || "/"}>
				{label}
			</span>
			<span className="ml-auto flex items-center gap-0.5">
				{!ctx.readOnly && !ctx.indexActionsOnly && ctx.stageDir && stageable.length > 0 && (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="invisible size-6 rounded-xs text-text-tertiary group-hover/dir:visible hover:bg-[var(--git-panel-hover)] hover:text-text-primary"
						aria-label={t("git.stageDirectory")}
						title={t("git.stageDirectory")}
						disabled={ctx.mutating}
						onClick={(event) => {
							event.stopPropagation();
							ctx.stageDir?.(stageable.map((resource) => resource.target));
						}}
					>
						<Plus size={13} aria-hidden="true" />
					</Button>
				)}
				{!ctx.readOnly && !ctx.indexActionsOnly && ctx.discardDir && discardable.length > 0 && (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="invisible size-6 rounded-xs text-text-tertiary group-hover/dir:visible hover:bg-[var(--git-panel-hover)] hover:text-[var(--color-danger)]"
						aria-label={t("git.discardDirectory")}
						title={t("git.discardDirectory")}
						disabled={ctx.mutating}
						onClick={(event) => {
							event.stopPropagation();
							ctx.discardDir?.(discardable, dir || "/");
						}}
					>
						<RotateCcw size={13} aria-hidden="true" />
					</Button>
				)}
				<span className="px-1 text-micro tabular-nums text-text-tertiary">{dirResources.length}</span>
			</span>
		</div>
	);
}

/** 把 ChangeTreeRow 序列渲染成行（tree/flat 两视图共用；折叠剪枝已在 builder 内完成）。 */
function renderChangeRows(rows: ChangeTreeRow[], ctx: ChangeRowContext): ReactNode {
	return <>{rows.map((row) => (row.kind === "dir" ? renderChangeDirRow(row.path, row.label, row.resources, row.depth, ctx) : renderChangeFileRow(row.resource, row.depth, ctx)))}</>;
}

/**
 * 按目录渲染文件列表：flat = 一级目录分组；tree = 嵌套目录树（紧凑链合并单子目录）。
 * memo：commit composer 输入会让 GitPanel 每次按键重渲，resources/回调引用不变时
 * 不应重建整棵变更树（行内 Radix ContextMenu + Seti SVG，代价随变更文件数线性增长）。
 */
export const FileTree = memo(function FileTree(props: {
	resources: GitResource[];
	groupType: GitResourceGroupType;
	/** A read-only capability omits mutation controls instead of rendering no-op actions. */
	readOnly?: boolean;
	/** Managed remote index capability: no directory, discard or delete actions even if callbacks exist. */
	indexActionsOnly?: boolean;
	stageFile?: (target: ProjectFileTarget) => void;
	/** 目录级暂存只传当前目录资源，避免影响其他目录。 */
	stageDir?: (targets: ProjectFileTarget[]) => void;
	unstageFile?: (target: ProjectFileTarget) => void;
	discardFile?: (target: ProjectFileTarget, group: "workingTree" | "untracked") => void;
	/** 目录级回滚携带资源组，主进程可在一次状态快照中安全处理混合资源。 */
	discardDir?: (resources: GitDiscardResource[], label: string) => void;
	/** 右键菜单“删除文件”入口；未提供时不启用右键菜单 */
	deleteFile?: (target: ProjectFileTarget) => void;
	/** 行内“打开文件”按钮：打开编辑器而非 diff 视图 */
	onOpenFile?: (target: ProjectFileTarget) => void;
	/** 已暂存文件路径集合：Changes 组中这些文件不再显示 stage/rollback 按钮（VS Code 语义） */
	stagedPaths?: ReadonlySet<string>;
	mutating: boolean;
	onOpenWorkspaceFileDiff: (group: GitResourceGroupType, target: ProjectFileTarget) => void;
	/** 项目根目录路径，用于 flatten 时把绝对路径显示成相对路径（远端资源已是相对 path） */
	projectRoot?: string;
	/** 受控：已折叠目录集合（与父级「收起/展开全部」共享） */
	collapsedDirs: Set<string>;
	onToggleDir: (dir: string) => void;
	/** 视图模式：flat（默认，一级目录分组）/ tree（嵌套目录树） */
	viewMode?: GitChangeViewMode;
}) {
	const ctx: ChangeRowContext = {
		groupType: props.groupType,
		mutating: props.mutating,
		onOpenWorkspaceFileDiff: props.onOpenWorkspaceFileDiff,
		collapsedDirs: props.collapsedDirs,
		onToggleDir: props.onToggleDir,
		readOnly: props.readOnly,
		indexActionsOnly: props.indexActionsOnly,
		stagedPaths: props.stagedPaths,
		stageFile: props.stageFile,
		unstageFile: props.unstageFile,
		discardFile: props.discardFile,
		deleteFile: props.deleteFile,
		onOpenFile: props.onOpenFile,
		stageDir: props.stageDir,
		discardDir: props.discardDir,
	};

	// 树形：嵌套目录 + 缩进（紧凑链合并单子目录）；扁平：一级目录分组（目录头缩写展示）。
	// 两种视图的折叠剪枝都在 builder 内完成，渲染层不感知视图差异。
	const rows = props.viewMode === "tree" ? buildChangeTreeRows(props.resources, props.projectRoot, props.collapsedDirs) : buildChangeFlatRows(props.resources, props.projectRoot, props.collapsedDirs, { includeSingleRootHeader: Boolean(props.stageDir || props.discardDir) });
	return renderChangeRows(rows, ctx);
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

/** 图标槽 24px（与文件抽屉 --file-type-icon-size 同值）：className 可覆盖尺寸/右距（cn 同组后者胜） */
export function FileIcon({ name, className }: { name: string; className?: string }) {
	try {
		const { svg, colorName } = getFileIconSeti(name);
		return <span aria-hidden="true" className={cn("mr-1.5 inline-flex size-5 shrink-0 items-center justify-center [&_svg]:size-full [&_svg]:fill-current", className)} style={{ color: getFileIconColor(colorName) }} dangerouslySetInnerHTML={{ __html: svg }} />;
	} catch {
		// 未知类型兜底：FileText 线性图标（16px，与 Seti 图标同槽位）而非空透明方块——
		// 空方块在非代码文件密集的目录里像图标加载失败。
		return (
			<span aria-hidden="true" className={cn("mr-1.5 inline-flex size-5 shrink-0 items-center justify-center text-[var(--git-desc-fg)] [&_svg]:size-4", className)}>
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
	target?: ProjectFileTarget;
	compareStatus?: GitFileStatus;
	actions?: Array<{
		label: string;
		kind: "stage" | "unstage" | "discard" | "open";
		disabled?: boolean;
		run: () => void;
	}>;
	/** 右键菜单“删除文件”入口；未提供时不启用右键菜单（compare 只读列表） */
	deleteFile?: (target: ProjectFileTarget) => void;
	onOpen?: () => void | Promise<void>;
	/** 树形视图缩进（px），叠加在基准左内边距之上 */
	indent?: number;
}) {
	const [opening, setOpening] = useState(false);
	const name = fileNameOnly(props.path);
	const tone = props.compareStatus ? statusTone(props.compareStatus, true) : statusTone(props.status);
	const letter = props.compareStatus ? compareStatusLetter(props.compareStatus) : props.letter;
	const rowPadding = { paddingLeft: CHANGE_ROW_BASE_PADDING + (props.indent ?? 0) };
	const row = (
		<div className={`group git-resource-row flex h-7 items-center gap-1.5 rounded-sm pr-2 text-body transition-[background-color,border-color,box-shadow] duration-base hover:bg-muted focus-within:bg-muted ${tone}`} title={props.path}>
			{props.onOpen ? (
				<button
					type="button"
					className="git-resource-open flex h-full min-w-0 flex-1 cursor-pointer appearance-none items-center gap-1.5 border-0 bg-transparent p-0 text-left font-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none disabled:cursor-progress disabled:opacity-70"
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
					{/* 16px twistie 占位 + 24px 图标槽：文件图标列与目录行 chevron 同列，列宽与文件抽屉的树行一致 */}
					<span aria-hidden="true" className="h-full w-4 shrink-0" />
					<FileIcon name={name} className="mr-0 size-6" />
					<span className="git-resource-name min-w-0 flex-[0_1_auto] truncate text-[var(--git-panel-fg)]">{name}</span>
				</button>
			) : (
				<div className="flex h-full min-w-0 flex-1 cursor-default items-center gap-1.5 border-0 bg-transparent p-0 text-left font-inherit" style={rowPadding}>
					<span aria-hidden="true" className="h-full w-4 shrink-0" />
					<FileIcon name={name} className="mr-0 size-6" />
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
	if (!props.deleteFile || !props.target) return row;
	const target = props.target;
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
			<ContextMenuContent alignOffset={-4}>
				{props.deleteFile && (
					<ContextMenuItem variant="destructive" className="gap-2 text-control" onSelect={() => props.deleteFile?.(target)}>
						<Trash2 size={14} aria-hidden="true" />
						{t("git.deleteFile")}
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * 变更区分组规格：ChangesGroupsStack 的每组输入。动作回调按组可选（merge 组
 * 只读开 diff；staged 给 unstage；changes 给 stage/回滚/目录级操作），缺省即与
 * FileTree 的旧行为一致（无回调 = 无按钮）。
 */
export type ChangesGroupSpec = {
	/** 行 key 前缀；同文件可同时出现在 staged 与 changes 组，key 必须带组前缀 */
	key: string;
	groupType: GitResourceGroupType;
	title: string;
	open: boolean;
	resources: GitResource[];
	onToggle: () => void;
	/** 组头 hover/展开常显的批量操作（全部暂存/取消暂存） */
	allAction?: () => void;
	allLabel?: string;
	allDisabled?: boolean;
	readOnly?: boolean;
	indexActionsOnly?: boolean;
	stagedPaths?: ReadonlySet<string>;
	stageFile?: (target: ProjectFileTarget) => void;
	unstageFile?: (target: ProjectFileTarget) => void;
	discardFile?: (target: ProjectFileTarget, group: "workingTree" | "untracked") => void;
	deleteFile?: (target: ProjectFileTarget) => void;
	onOpenFile?: (target: ProjectFileTarget) => void;
	stageDir?: (targets: ProjectFileTarget[]) => void;
	discardDir?: (resources: GitDiscardResource[], label: string) => void;
};

/** 组头行：原 ResourceGroup 的头部（扁平化后分组不再有包裹层，分隔线落在每组末行的 border 上）。 */
function GroupHeaderRow(props: { spec: ChangesGroupSpec; border: boolean }) {
	return (
		<div className={`group flex h-7 items-center bg-transparent pr-2 pl-2 hover:bg-muted${props.spec.open ? " open" : ""}${props.border ? " border-b border-[var(--git-panel-border)]" : ""}`}>
			<button type="button" className="inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none" aria-expanded={props.spec.open} onClick={props.spec.onToggle}>
				{/* 与下方目录行的 twistie 同列（16px 槽 + 3px 偏移） */}
				<span aria-hidden="true" className="inline-flex h-full w-4 shrink-0 translate-x-[3px] items-center justify-center">
					<Twistie open={props.spec.open} />
				</span>
				<span className="min-w-0 flex-1 truncate text-control font-semibold tracking-normal text-[var(--git-panel-fg)]">{props.spec.title}</span>
			</button>
			{props.spec.allAction && (
				<div className="hidden items-center gap-px group-hover:flex group-focus-within:flex group-[.open]:flex">
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label={props.spec.allLabel} title={props.spec.allLabel} disabled={props.spec.allDisabled} onClick={() => props.spec.allAction?.()}>
						<GitStageGlyph unstage={props.spec.allLabel === t("git.unstageAll")} />
					</Button>
				</div>
			)}
			<span className="ml-1 min-w-[14px] text-right text-micro tabular-nums text-[var(--git-desc-fg)]">{props.spec.resources.length}</span>
		</div>
	);
}

type ChangesStackRow = { kind: "group"; spec: ChangesGroupSpec; border: boolean } | { kind: "dir"; spec: ChangesGroupSpec; row: Extract<ChangeTreeRow, { kind: "dir" }>; border: boolean } | { kind: "file"; spec: ChangesGroupSpec; resource: GitResource; depth: number; border: boolean };

/**
 * 本地变更区：把 merge/staged/changes 三个分组折成一条扁平行列表，走一个 VirtualStack。
 *
 * 为什么不用每组建一个虚拟器：三组共享同一个滚动容器，per-group virtualizer 需要
 * scrollMargin 补组间偏移，组开合/目录折叠都会让偏移动态漂移，难验证；整区扁平化后
 * 一个 virtualizer 天然无偏移问题。行数 ≤ VirtualStack 的 minRows 时直出 Fragment，
 * 小列表 DOM 与旧结构一致（分组包裹层的分隔线改由每组末行的 border-b 承担）。
 */
export const ChangesGroupsStack = memo(function ChangesGroupsStack(props: {
	/** 变更区自己的限高滚动容器；VirtualStack 依靠它计算可视窗口 */
	scrollRef: RefObject<HTMLDivElement | null>;
	groups: readonly ChangesGroupSpec[];
	viewMode: GitChangeViewMode;
	collapsedDirs: ReadonlySet<string>;
	onToggleDir: (dir: string) => void;
	mutating: boolean;
	onOpenWorkspaceFileDiff: (group: GitResourceGroupType, target: ProjectFileTarget) => void | Promise<void>;
	projectRoot?: string;
}) {
	const items = useMemo<ChangesStackRow[]>(() => {
		const active = props.groups.filter((spec) => spec.resources.length > 0);
		const out: ChangesStackRow[] = [];
		active.forEach((spec, groupIndex) => {
			const isLastGroup = groupIndex === active.length - 1;
			out.push({ kind: "group", spec, border: !isLastGroup });
			if (!spec.open) return;
			const rows = props.viewMode === "tree" ? buildChangeTreeRows(spec.resources, props.projectRoot, props.collapsedDirs) : buildChangeFlatRows(spec.resources, props.projectRoot, props.collapsedDirs, { includeSingleRootHeader: Boolean(spec.stageDir || spec.discardDir) });
			rows.forEach((row, rowIndex) => {
				const border = !isLastGroup && rowIndex === rows.length - 1;
				if (row.kind === "dir") out.push({ kind: "dir", spec, row, border });
				else out.push({ kind: "file", spec, resource: row.resource, depth: row.depth, border });
			});
		});
		return out;
	}, [props.groups, props.viewMode, props.collapsedDirs, props.projectRoot]);

	return (
		<VirtualStack
			items={items}
			scrollRef={props.scrollRef}
			estimateHeight={28}
			getKey={(item) => (item.kind === "group" ? `${item.spec.key}:group` : item.kind === "dir" ? `${item.spec.key}:dir:${item.row.path}` : `${item.spec.key}:file:${item.resource.path}`)}
			renderItem={(item) => {
				if (item.kind === "group") return <GroupHeaderRow spec={item.spec} border={item.border} />;
				const ctx: ChangeRowContext = {
					groupType: item.spec.groupType,
					mutating: props.mutating,
					onOpenWorkspaceFileDiff: props.onOpenWorkspaceFileDiff,
					collapsedDirs: props.collapsedDirs,
					onToggleDir: props.onToggleDir,
					readOnly: item.spec.readOnly,
					indexActionsOnly: item.spec.indexActionsOnly,
					stagedPaths: item.spec.stagedPaths,
					stageFile: item.spec.stageFile,
					unstageFile: item.spec.unstageFile,
					discardFile: item.spec.discardFile,
					deleteFile: item.spec.deleteFile,
					onOpenFile: item.spec.onOpenFile,
					stageDir: item.spec.stageDir,
					discardDir: item.spec.discardDir,
				};
				if (item.kind === "dir") return renderChangeDirRow(item.row.path, item.row.label, item.row.resources, item.row.depth, ctx);
				return renderChangeFileRow(item.resource, item.depth, ctx);
			}}
		/>
	);
});
