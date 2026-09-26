import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, FileText, Loader2, Minus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "../../ui-shadcn/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../ui-shadcn/context-menu";
import { getFileIconColor, getFileIconSeti } from "../../../fileIcons";
import { t } from "../../../i18n";
import { GitStatus, type GitDiscardResource, type GitFileStatus, type GitResource, type GitResourceGroupType, type ProjectFileTarget } from "../../../../../shared/types";
export function fileNameOnly(path: string): string {
	return path.split(/[/\\]/).pop() ?? path;
}

/**
 * 缩短长目录路径，类似 Java package 包名缩写：取每段的首字母。
 * 例如 "src/main/java/com/example/service/impl" → "s/m/j/c/e/s/i"。
 * 短路径（≤3 段或总长 ≤20）保持原样。
 */
function shortenDir(dir: string): string {
	const parts = dir.split("/");
	if (parts.length <= 3 || dir.length <= 20) return dir;
	return parts.map((p) => p.charAt(0) || "").join("/");
}

/** 按目录分组 Git 资源，返回 { dir -> resources[] } 映射 */
function groupByDir(resources: GitResource[]): Map<string, GitResource[]> {
	const dirs = new Map<string, GitResource[]>();
	for (const resource of resources) {
		const parts = resource.path.split("/");
		const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
		if (!dirs.has(dir)) dirs.set(dir, []);
		dirs.get(dir)!.push(resource);
	}
	return dirs;
}

/** 收集变更列表中可折叠的目录键（单根无目录头时返回空） */
export function getCollapsibleChangeDirs(resources: GitResource[]): string[] {
	const byDir = groupByDir(resources);
	const dirs = [...byDir.keys()];
	// 与 FileTree 一致：仅一个根目录时不显示目录头，也就没有可折叠项
	if (dirs.length === 1 && dirs[0] === "") return [];
	return dirs;
}

/** 按目录树渲染文件列表 */
export function FileTree(props: {
	resources: GitResource[];
	groupType: GitResourceGroupType;
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
	/** 受控：已折叠目录集合（与父级「收起/展开全部」共享） */
	collapsedDirs: Set<string>;
	onToggleDir: (dir: string) => void;
}) {
	const byDir = groupByDir(props.resources);
	// 按目录名排序，根目录排最前
	const dirs = [...byDir.keys()].sort((a, b) => {
		if (a === "") return -1;
		if (b === "") return 1;
		return a.localeCompare(b);
	});

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
						{!hideDirHeader && (
							<div className="group/dir flex cursor-pointer items-center gap-1 rounded-[4px] px-2 py-[3px] select-none hover:bg-[var(--git-panel-hover)]" onClick={() => props.onToggleDir(dir)}>
								<ChevronDown size={12} className={`shrink-0 text-text-tertiary transition-transform duration-150${props.collapsedDirs.has(dir) ? " -rotate-90" : " rotate-0"}`} />
								<span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={dir || "/"}>
									{shortenDir(dir) || "/"}
								</span>
								{(() => {
									const stageable = resources.filter((resource) => !props.stagedPaths?.has(resource.path));
									const discardable = stageable
										.filter((resource) => resource.status === GitStatus.UNTRACKED || props.groupType === "workingTree")
										.map((resource) => ({
											target: resource.target,
											group: resource.status === GitStatus.UNTRACKED ? ("untracked" as const) : ("workingTree" as const),
										}));
									return (
										<span className="ml-auto flex items-center gap-0.5">
											{props.stageDir && stageable.length > 0 && (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													className="invisible size-6 rounded-[4px] text-text-tertiary group-hover/dir:visible hover:bg-[var(--git-panel-hover)] hover:text-text-primary"
													aria-label={t("git.stageDirectory")}
													title={t("git.stageDirectory")}
													disabled={props.mutating}
													onClick={(event) => {
														event.stopPropagation();
														props.stageDir?.(stageable.map((resource) => resource.target));
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
													className="invisible size-6 rounded-[4px] text-text-tertiary group-hover/dir:visible hover:bg-[var(--git-panel-hover)] hover:text-[var(--color-danger)]"
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
											<span className="px-1 text-[11px] tabular-nums text-text-tertiary">{resources.length}</span>
										</span>
									);
								})()}
							</div>
						)}
						{(!props.collapsedDirs.has(dir) || hideDirHeader) &&
							resources.map((r) => {
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
										run: () => props.unstageFile?.(r.target),
									});
								} else if (props.groupType === "workingTree" || props.groupType === "untracked") {
									// 已暂存文件在 Changes 组仅保留打开按钮，暂存/回滚归 Staged 组（VS Code 语义）
									if (!props.stagedPaths?.has(r.path)) {
										actions.push({
											label: t("git.stage"),
											kind: "stage",
											disabled: props.mutating,
											run: () => props.stageFile?.(r.target),
										});
										// 回滚：tracked 走 git restore，untracked 走回收站删除
										actions.push({
											label: t("git.discardChanges"),
											kind: "discard",
											disabled: props.mutating,
											run: () => props.discardFile?.(r.target, r.status === GitStatus.UNTRACKED ? "untracked" : "workingTree"),
										});
									}
								}
								if (props.onOpenFile) {
									actions.push({
										label: t("common.open"),
										kind: "open",
										run: () => props.onOpenFile?.(r.target),
									});
								}
								return (
									<ResourceRow
										key={r.path}
										status={r.status}
										letter={r.letter}
										path={r.displayPath || r.path}
										target={r.target}
										onOpen={() =>
											props.onOpenWorkspaceFileDiff(
												// Changes 组合并了 workingTree + untracked + index，但 groupType 写死 workingTree；
												// 未跟踪文件按实际状态传 untracked，否则服务端在 workingTree 组找不到而打不开
												props.groupType === "workingTree" && r.status === GitStatus.UNTRACKED ? "untracked" : props.groupType,
												r.target,
											)
										}
										actions={actions}
										deleteFile={props.deleteFile ? (target) => props.deleteFile?.(target) : undefined}
									/>
								);
							})}
					</Fragment>
				);
			})}
		</>
	);
}

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
		return <span aria-hidden="true" className="mr-1.5 box-border inline-flex size-3 shrink-0 items-center justify-center rounded-[4px] border border-[var(--git-desc-fg)] [&_svg]:size-full [&_svg]:fill-current" />;
	}
}

/** Mirrors VS Code's monaco-tl-twistie without importing structural icons. */
export function Twistie({ open }: { open: boolean }) {
	return <span className={`inline-flex size-3.5 shrink-0 items-center justify-center text-[9px] text-[var(--git-desc-fg)] before:block before:content-['▶'] before:transition-transform before:duration-150${open ? " before:rotate-0" : " before:-rotate-90"}`} aria-hidden="true" />;
}

function GitStageGlyph({ unstage = false }: { unstage?: boolean }) {
	return (
		<span className="flex size-5 items-center justify-center font-sans text-xl font-medium leading-5 -translate-y-px" aria-hidden="true">
			{unstage ? "\u2212" : "+"}
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
}) {
	const [opening, setOpening] = useState(false);
	const name = fileNameOnly(props.path);
	const tone = props.compareStatus ? statusTone(props.compareStatus, true) : statusTone(props.status);
	const letter = props.compareStatus ? compareStatusLetter(props.compareStatus) : props.letter;
	const row = (
		<div className={`group git-resource-row flex h-[26px] items-center pr-[7px] text-sm leading-[26px] hover:bg-[var(--git-panel-hover)] focus-within:bg-[var(--git-panel-hover)] ${tone}`} title={props.path}>
			{props.onOpen ? (
				<button
					type="button"
					className="git-resource-open flex h-[26px] min-w-0 flex-1 cursor-pointer appearance-none items-center border-0 bg-transparent p-0 pl-3 text-left font-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none disabled:cursor-progress disabled:opacity-70"
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
				<div className="flex h-[26px] min-w-0 flex-1 cursor-default items-center border-0 bg-transparent p-0 pl-3 text-left font-inherit">
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
							className={`size-6 rounded-[4px] text-text-tertiary hover:bg-[var(--git-panel-hover)] hover:text-text-primary${action.kind === "discard" ? " hover:text-[var(--color-danger)]" : ""}`}
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
			<span className="ml-[5px] flex w-4 shrink-0 justify-end text-xs font-semibold text-right text-[var(--git-desc-fg)]" aria-hidden="true">
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
					<ContextMenuItem variant="destructive" className="gap-2 text-[13px]" onSelect={() => props.deleteFile?.(target)}>
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
					<span className="ml-px min-w-0 flex-1 truncate text-[13px] font-semibold tracking-normal text-[var(--git-panel-fg)]">{props.title}</span>
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
