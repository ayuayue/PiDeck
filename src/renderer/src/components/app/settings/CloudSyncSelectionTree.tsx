import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, Globe, Puzzle, TriangleAlert, X } from "lucide-react";
import { t, type TranslationKey } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui-shadcn/collapsible";
import type { CloudSyncProjectSelectionNode, CloudSyncResourceCategory } from "../../../../../shared/types";
import { cn } from "../../../lib/utils";

/**
 * 云同步「同步内容」选择树组件族（M9 §12）：按项目/全局组织的可折叠树，
 * 会话与资源类别分组勾选（纯二元，无三态），自选同步路径可移除，云端待映射项目可挂载。
 */

/** 全局同步项目（选择树根节点之一）的固定 id。 */
export const GLOBAL_SYNC_PROJECT_ID = "__global__";

function SessionRow(props: { title: string; relativePath: string; selected: boolean; disabled: boolean; reason?: string; onToggle: () => void }) {
	return (
		<label className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50">
			<Checkbox checked={props.selected} disabled={props.disabled} onCheckedChange={props.onToggle} />
			<FileText size={14} className="shrink-0 text-text-tertiary" />
			<span className="flex-1 truncate text-sm text-foreground/90">{props.title || props.relativePath}</span>
			{props.disabled && props.reason ? (
				<span className="shrink-0 text-warning" title={props.reason}>
					<TriangleAlert size={14} aria-label={props.reason} />
				</span>
			) : null}
		</label>
	);
}

function ResourceRow(props: {
	label?: string;
	relativePath: string;
	selected: boolean;
	disabled: boolean;
	reason?: string;
	/** 自选同步路径的移除按钮（customPathId 资源）。 */
	onRemove?: () => void;
	onToggle: () => void;
}) {
	return (
		<label className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50">
			<Checkbox checked={props.selected} disabled={props.disabled} onCheckedChange={props.onToggle} />
			<Puzzle size={14} className="shrink-0 text-text-tertiary" />
			<span className="min-w-0 flex-1 truncate text-sm text-foreground/70">
				{props.label ? <span className="rounded bg-accent/70 px-1 py-px text-caption">{props.label}</span> : null} {props.relativePath}
			</span>
			{props.disabled && props.reason ? (
				<span className="shrink-0 text-warning" title={props.reason}>
					<TriangleAlert size={14} aria-label={props.reason} />
				</span>
			) : null}
			{props.onRemove ? (
				<button
					type="button"
					tabIndex={-1}
					className="shrink-0 rounded px-1 text-text-tertiary opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100"
					title={t("cloudSync.tree.removeCustomPath")}
					onClick={(event) => {
						event.preventDefault();
						props.onRemove?.();
					}}
				>
					<X size={14} />
				</button>
			) : null}
		</label>
	);
}

/** 类别分组头：复选框 + 类别名 + (选中/总数)。勾上 = 该类全部同步（纯二元，无三态中继）。 */
function CategoryHeader(props: {
	label: string;
	total: number;
	selected: number;
	onToggle: (selected: boolean) => void;
	/** 可折叠类别（会话组）：点头部切换展开/收起。 */
	collapsible?: boolean;
	collapsed?: boolean;
	onToggleCollapse?: () => void;
	/** 滚动容器内吸顶（会话多时不必滚回顶部即可收起）。 */
	sticky?: boolean;
}) {
	const allSelected = props.total > 0 && props.selected === props.total;
	const CollapseIcon = props.collapsed ? ChevronRight : ChevronDown;
	return (
		<div className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50", props.sticky && "sticky top-0 z-10 bg-background/95 backdrop-blur")} onClick={() => props.collapsible && props.onToggleCollapse?.()}>
			<Checkbox checked={allSelected} onCheckedChange={() => props.onToggle(!allSelected)} onClick={(event) => event.stopPropagation()} />
			<span className="min-w-0 flex-1 truncate text-caption font-medium text-text-tertiary">{props.label}</span>
			<span className="shrink-0 text-caption text-text-tertiary">
				{props.selected}/{props.total}
			</span>
			{props.collapsible ? <CollapseIcon size={14} className="shrink-0 text-text-tertiary" /> : null}
		</div>
	);
}

/** 资源类别在树内的展示顺序：全局含 settings 与 config，项目节点同样含 config（自选同步项）。 */
export function categoryOrder(isGlobal: boolean): CloudSyncResourceCategory[] {
	// 全局含 settings（~/.pi/agent/settings.json）与 config（顶层散落文件 + home 相对/仅本机自选）；
	// 项目含 settings（.pi/settings.json）与 config（项目内自选同步路径）。
	return isGlobal ? ["settings", "prompts", "skills", "extensions", "config"] : ["prompts", "skills", "extensions", "settings", "config"];
}

/** 项目选择节点：可折叠；节点头部全选会话，展开后按类别分组（M9 §12.2）。 */
export function ProjectSelectionNode(props: {
	node: CloudSyncProjectSelectionNode;
	expanded: boolean;
	onToggleExpanded: () => void;
	onToggleSession: (selectionId: string) => void;
	onToggleResource: (selectionId: string) => void;
	onToggleNodeSessions: (projectId: string, all: boolean) => void;
	/** M9：类别分组批量勾选（sessions 或资源类别）。 */
	onToggleCategory: (projectId: string, category: "sessions" | CloudSyncResourceCategory, selected: boolean) => void;
	/** M9：移除自选同步路径（config 类别资源行上的 ×）。 */
	onRemoveCustomPath: (customPathId: string) => void;
	/** M9：云端待映射项目 → 手动指定本地同步目录（接线点，当前占位）。 */
	onMountProject?: (remoteProjectId: string, name: string) => void;
	/** 实时选择集合（勾选态/计数以集合为准，不依赖扫描快照）。 */
	sessionSelection: ReadonlySet<string>;
	resourceSelection: ReadonlySet<string>;
}) {
	const { node } = props;
	const isGlobal = node.projectId === GLOBAL_SYNC_PROJECT_ID;
	/** 所有类别组（会话 + 资源）默认收起；点类别头展开/收起（M9 反馈：点开项目时全部折叠）。 */
	const [expandedCategories, setExpandedCategories] = useState<ReadonlySet<string>>(new Set());
	const toggleCategoryCollapse = useCallback((category: string) => {
		setExpandedCategories((prev) => {
			const next = new Set(prev);
			if (next.has(category)) next.delete(category);
			else next.add(category);
			return next;
		});
	}, []);
	const sessionsSelectedCount = node.sessions.filter((session) => props.sessionSelection.has(session.selectionId)).length;
	const sessionCount = node.sessions.length;
	const resourcesSelectedCount = node.resources.filter((resource) => props.resourceSelection.has(resource.selectionId)).length;
	const resourceCount = node.resources.length;

	return (
		<Collapsible open={props.expanded} onOpenChange={props.onToggleExpanded} className="rounded-lg border border-border-subtle bg-background/40">
			<CollapsibleTrigger asChild>
				<div className="flex w-full cursor-pointer items-center gap-2 px-3 py-2" role="button" tabIndex={0}>
					{props.expanded ? <ChevronDown size={15} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={15} className="shrink-0 text-text-tertiary" />}
					{isGlobal ? <Globe size={15} className="shrink-0 text-primary" /> : <Folder size={15} className="shrink-0 text-text-tertiary" />}
					<Checkbox checked={sessionCount > 0 && sessionsSelectedCount === sessionCount} onCheckedChange={() => props.onToggleNodeSessions(node.projectId, sessionsSelectedCount < sessionCount)} onClick={(event) => event.stopPropagation()} />
					<span className="min-w-0 flex-1 truncate text-sm font-medium">{isGlobal ? t("cloudSync.tree.globalPi") : node.name}</span>
					{node.missing ? (
						<>
							<span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-caption text-warning">{t("cloudSync.content.missingProject")}</span>
							<Button
								size="sm"
								variant="outline"
								className="shrink-0 px-2 text-caption"
								title={t("cloudSync.tree.mountHereHint")}
								onClick={(event) => {
									event.stopPropagation();
									props.onMountProject?.(node.projectId, node.name);
								}}
							>
								{t("cloudSync.tree.mountHere")}
							</Button>
						</>
					) : null}
					<span className="shrink-0 text-caption text-text-tertiary">
						{sessionCount > 0 ? t("cloudSync.content.sessionCount", { count: sessionCount, selected: sessionsSelectedCount }) : null}
						{resourceCount > 0 ? (sessionCount > 0 ? " · " : "") + t("cloudSync.content.resourceCount", { count: resourceCount }) : null}
					</span>
				</div>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="space-y-1 border-t border-border-subtle px-2 py-2">
					{node.sessions.length > 0 ? (
						<div className="space-y-0.5">
							<CategoryHeader
								label={t("cloudSync.tree.sessions")}
								total={node.sessions.length}
								selected={sessionsSelectedCount}
								onToggle={(selected) => props.onToggleCategory(node.projectId, "sessions", selected)}
								collapsible
								collapsed={!expandedCategories.has("sessions")}
								onToggleCollapse={() => toggleCategoryCollapse("sessions")}
								sticky
							/>
							{expandedCategories.has("sessions") ? (
								<div className="space-y-0.5 pl-5">
									{node.sessions.map((session) => (
										<SessionRow key={session.selectionId} title={session.title} relativePath={session.relativePath} selected={props.sessionSelection.has(session.selectionId)} disabled={session.status === "unavailable"} reason={session.reason} onToggle={() => props.onToggleSession(session.selectionId)} />
									))}
								</div>
							) : null}
						</div>
					) : null}
					{categoryOrder(isGlobal).map((category) => {
						const items = node.resources.filter((resource) => resource.category === category);
						if (items.length === 0) return null;
						const selected = items.filter((resource) => props.resourceSelection.has(resource.selectionId)).length;
						return (
							<div key={category} className="space-y-0.5 pt-1">
								<CategoryHeader
									label={t(`cloudSync.tree.${category}` as TranslationKey)}
									total={items.length}
									selected={selected}
									onToggle={(all) => props.onToggleCategory(node.projectId, category, all)}
									collapsible
									collapsed={!expandedCategories.has(category)}
									onToggleCollapse={() => toggleCategoryCollapse(category)}
								/>
								{expandedCategories.has(category) ? (
									<>
										{isGlobal && category === "config" ? <div className="px-2 pb-1 text-caption text-text-tertiary">{t("cloudSync.tree.configHint")}</div> : null}
										<div className="space-y-0.5 pl-5">
											{items.map((resource) => (
												<ResourceRow
													key={resource.selectionId}
													label={resource.label}
													relativePath={resource.relativePath}
													selected={props.resourceSelection.has(resource.selectionId)}
													disabled={resource.status === "unavailable"}
													reason={resource.reason}
													onRemove={resource.customPathId ? () => props.onRemoveCustomPath(resource.customPathId!) : undefined}
													onToggle={() => props.onToggleResource(resource.selectionId)}
												/>
											))}
										</div>
									</>
								) : null}
							</div>
						);
					})}
					{sessionCount === 0 && resourceCount === 0 ? <div className="px-2 py-1 text-caption text-text-tertiary">{t("cloudSync.content.nodeEmpty")}</div> : null}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
