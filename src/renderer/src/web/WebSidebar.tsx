/**
 * WebSidebar — Web 端左侧栏（与桌面端 SidebarContent 同风格）。
 *
 * 结构：品牌区（BrandLockup）→ 搜索框 → 项目树（项目可展开收起；展开后列出
 * 该项目的会话，会话行带运行状态指示器）
 * → 底部连接状态。
 *
 * 交互：点击项目行 = 展开/收起；点击项目行内的 "+" = 新建会话（POST /api/sessions）；
 * 点击会话行 = 打开会话（切 activeSessionId）。
 */
import { useEffect, useMemo, useState } from "react";
import { Check, FolderPlus, Play, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { WebBrandLockup } from "./WebBrandLockup";
import { cn } from "@/lib/utils";
import { sessionStatusDotClass } from "@/agentListDisplay";
import { SessionBackendMark } from "@/components/session/SessionSourceBadge";
import type { WebProject, WebRuntime, WebSession, WebState } from "./webTypes";

const projectRowClass =
	"conversation relative w-full min-h-9 items-center gap-1.5 rounded-lg border border-transparent bg-background px-3 py-1 text-left text-body text-foreground shadow-none transition-[background-color,border-color] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground";

const sessionRowClass =
	"conversation agent-row relative flex min-h-7 w-full items-center gap-1.5 rounded-md border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,border-color] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground";

/** 与桌面 SessionTree 一致：只有当前会话灰底，父项目行不加选中态。 */
const selectedRowClass = "active bg-bg-active text-foreground";

/** 与桌面 ProjectTree 相同的项目目录名展示：chat 项目显示「聊天」，
 *  其余取路径末段；用户重命名过（name 与目录名不同）时优先展示自定义别名。 */
function displayProjectName(project: WebProject): string {
	if (project.kind === "chat") return t("app.chatProject");
	const normalized = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
	const dirName = normalized.split("/").pop() || "";
	if (!dirName) return project.name || project.path;
	return project.name && project.name !== dirName ? project.name : dirName;
}

function matchesSearch(value: string, search: string): boolean {
	return !search || value.toLowerCase().includes(search.toLowerCase());
}

const UNGROUPED_GROUP_KEY = "__web_ungrouped__";

/** 未分组会话列表的会话行 + 「更多会话」折叠按钮。 */
function SessionRows(props: {
	sessions: WebSession[];
	runtimeFor: (sessionId: string) => WebRuntime | undefined;
	activeSessionId: string;
	showAll: boolean;
	onToggleShowAll: () => void;
	onSelect: (sessionId: string) => void;
}) {
	const { sessions, runtimeFor, activeSessionId, showAll, onToggleShowAll, onSelect } = props;
	const visible = showAll ? sessions : sessions.slice(0, 5);
	const hiddenCount = sessions.length - visible.length;
	return (
		<>
			{visible.map((session) => {
				const runtime = runtimeFor(session.id);
				return (
					<button
						type="button"
						key={session.id}
						className={cn(
							sessionRowClass,
							"session-row",
							session.id === activeSessionId && selectedRowClass,
						)}
						title={session.title}
						onClick={() => onSelect(session.id)}
					>
						{renderRuntimeStatusDot(runtime?.status)}
						<div className="conversation-body min-w-0 flex-1">
							<div className="conversation-title flex min-w-0 items-center gap-1.5">
								<strong className={cn("min-w-0 flex-1 truncate", runtime ? "font-medium" : "font-normal text-muted-foreground/90")}>
									{session.title || t("common.untitled")}
								</strong>
								{/* 后端徽标（C18 同源）：dsh 会话显示鲸鱼 logo，pi 会话显示 pi logo */}
								<SessionBackendMark backend={session.backend} className="size-4 shrink-0 rounded" />
							</div>
						</div>
					</button>
				);
			})}
			{hiddenCount > 0 && (
				<button
					type="button"
					className="conversation session-row relative flex min-h-7 w-full items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-0 text-center text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					onClick={onToggleShowAll}
				>
					{showAll ? t("common.collapse") : t("web.moreSessions", { count: hiddenCount })}
				</button>
			)}
		</>
	);
}

/** Web 侧栏与桌面 Tab/侧栏复用同一组状态点，纯历史记录不显示状态。 */
function renderRuntimeStatusDot(status?: string) {
	const dotClass = sessionStatusDotClass(status);
	if (!dotClass) return null;
	const label = status === "idle"
		? t("app.statusIdle")
		: status === "error"
			? t("app.statusError")
			: t("app.statusRunning");
	return (
		<span
			className={cn(
				"size-1.5 shrink-0 rounded-full",
				dotClass,
				status === "error" ? "" : "animate-pulse",
			)}
			aria-label={label}
			title={label}
		/>
	);
}

export function WebSidebar(props: {
	state: WebState;
	activeSessionId: string;
	creatingProjectId: string;
	connected: boolean;
	mobileOpen: boolean;
	onCloseMobile: () => void;
	onSelectSession: (sessionId: string) => void;
	onCreateSession: (projectId: string) => void;
	onCreateProject: (path: string) => Promise<WebProject>;
	onDeleteProject: (projectId: string) => Promise<void>;
}) {
	const { state, activeSessionId, creatingProjectId, connected, mobileOpen } = props;
	const [search, setSearch] = useState("");
	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
	// 会话数超过上限时展开的项目（默认每个项目只展示最近 N 条，点「更多」展开全部）
	const [expandedSessionProjects, setExpandedSessionProjects] = useState<Set<string>>(() => new Set());
	const [addingProject, setAddingProject] = useState(false);
	const [projectPath, setProjectPath] = useState("");
	const [projectBusy, setProjectBusy] = useState(false);

	const toggleProject = (projectId: string) => {
		setExpandedProjects((current) => {
			const next = new Set(current);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	};

	const runtimeFor = (sessionId: string): WebRuntime | undefined =>
		state.runtimes.find((runtime) => runtime.sessionId === sessionId);

	/** 项目按最近打开时间降序（chat 项目恒置顶），与桌面端按时间感知一致 */
	const sortedProjects = useMemo(
		() =>
			[...state.projects].sort(
				(a, b) =>
					Number(b.kind === "chat") - Number(a.kind === "chat") ||
					(b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
			),
		[state.projects],
	);

	/** 会话按最近活动时间降序（最新在上） */
	const sortedSessions = useMemo(
		() => [...state.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
		[state.sessions],
	);

	const toggleSessionExpand = (projectId: string) => {
		setExpandedSessionProjects((current) => {
			const next = new Set(current);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	};

	// 未分组会话 = projectId 不匹配任何已登记项目的 catalog 记录（孤儿/项目被删等）。
	// 兜底分组始终可见，不会被项目折叠状态吞掉；搜索时仍按标题过滤。
	const searching = search.trim().length > 0;
	const projectIds = useMemo(() => new Set(state.projects.map((project) => project.id)), [state.projects]);
	const ungroupedSessions = useMemo(
		() =>
			sortedSessions.filter(
				(session) =>
					!projectIds.has(session.projectId) &&
					matchesSearch(session.title || session.id, search.trim()),
			),
		[sortedSessions, projectIds, search],
	);
	const showAllUngrouped = searching || expandedSessionProjects.has(UNGROUPED_GROUP_KEY);
	const toggleUngroupedExpand = () => toggleSessionExpand(UNGROUPED_GROUP_KEY);

	const submitProject = async () => {
		const path = projectPath.trim();
		if (!path || projectBusy) return;
		setProjectBusy(true);
		try {
			const project = await props.onCreateProject(path);
			setExpandedProjects((current) => new Set(current).add(project.id));
			setProjectPath("");
			setAddingProject(false);
		} catch {
			// 父级保留结构化错误并展示在聊天区；这里负责结束 busy 状态，避免表单永久锁死。
		} finally {
			setProjectBusy(false);
		}
	};

	const requestDelete = async (project: WebProject) => {
		if (project.kind === "chat") return;
		if (typeof window !== "undefined" && !window.confirm(t("web.deleteProjectConfirm"))) return;
		await props.onDeleteProject(project.id);
	};

	// 搜索/切换会话时自动展开对应项目；普通项目展开状态完全由用户控制。
	const activeSessionProjectId = state.sessions.find(
		(session) => session.id === activeSessionId,
	)?.projectId;

	useEffect(() => {
		if (!activeSessionProjectId) return;
		// 切换会话时只负责把目标项目展开一次；用户随后仍可手动收起它。
		setExpandedProjects((current) => {
			if (current.has(activeSessionProjectId)) return current;
			return new Set(current).add(activeSessionProjectId);
		});
	}, [activeSessionProjectId]);

	return (
		<>
			<button
				type="button"
				className={cn("mobile-sidebar-backdrop", mobileOpen && "is-open")}
				onClick={props.onCloseMobile}
				aria-label={t("web.closeProjects")}
			/>
			<aside
				className={cn(
					"chat-list-pane flex h-full min-w-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground",
					mobileOpen && "mobile-open",
				)}
				aria-label={t("app.search")}
			>
			{/* 品牌区提到 body 外，与桌面侧栏一致贴顶 */}
			<div className="list-toolbar flex h-10 shrink-0 items-center gap-1 px-0.5">
				<div className="app-badge flex min-w-0 flex-1 items-center">
					<WebBrandLockup />
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="mobile-sidebar-close size-8 shrink-0"
					onClick={props.onCloseMobile}
					aria-label={t("web.closeProjects")}
					title={t("web.closeProjects")}
				>
					<X className="size-4" aria-hidden="true" />
				</Button>
			</div>
			<div className="sidebar-body flex min-h-0 flex-1 flex-col gap-2 px-2 py-1">
				{/* 搜索行 */}
				<div className="search-row grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
					<div className="search-box relative min-w-0">
						<Search
							size={14}
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
							aria-hidden="true"
						/>
						<Input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={t("app.search")}
							className="h-9 pl-8"
						/>
					</div>
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="size-9 shrink-0"
						onClick={() => setAddingProject((value) => !value)}
						aria-label={t("web.newProject")}
						title={t("web.newProject")}
					>
						<FolderPlus className="size-4" aria-hidden="true" />
					</Button>
				</div>
				{addingProject && (
					<form
						className="flex shrink-0 items-center gap-1"
						onSubmit={(event) => {
							event.preventDefault();
							void submitProject();
						}}
					>
						<Input
							value={projectPath}
							onChange={(event) => setProjectPath(event.target.value)}
							placeholder={t("web.projectPathPlaceholder")}
							className="h-8 min-w-0 flex-1 text-caption"
							autoFocus
							disabled={projectBusy}
						/>
						<Button type="submit" variant="ghost" size="icon" className="size-8 shrink-0" disabled={projectBusy || !projectPath.trim()} aria-label={t("web.createProject")} title={t("web.createProject")}>
							<Check className="size-4" aria-hidden="true" />
						</Button>
						<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" disabled={projectBusy} onClick={() => setAddingProject(false)} aria-label={t("common.close")} title={t("common.close")}>
							<X className="size-4" aria-hidden="true" />
						</Button>
					</form>
				)}
				{/* 项目/会话树 */}
				<div className="conversation-list min-h-0 flex-1 overflow-y-auto">
					{sortedProjects.map((project) => {
						const projectSessions = sortedSessions
							.filter((session) => session.projectId === project.id)
							.filter((session) => matchesSearch(session.title || session.id, search.trim()));
						const expanded = searching || expandedProjects.has(project.id);
						const showAllSessions = searching || expandedSessionProjects.has(project.id);
						const projectName = displayProjectName(project);
						const creating = creatingProjectId === project.id;
						return (
							<div key={project.id} className="project-group mb-2">
								<div className="project-row flex min-w-0 items-center gap-0.5">
									<button
										type="button"
										className={cn(projectRowClass, "flex min-h-8 min-w-0 flex-1")}
										disabled={Boolean(creatingProjectId)}
										onClick={() => toggleProject(project.id)}
										title={project.path}
									>
										<span
											className={cn(
												"project-fold grid size-5 place-items-center text-muted-foreground",
												!expanded && "folded",
											)}
											aria-hidden="true"
										>
											<PlayIcon expanded={expanded} />
										</span>
										<div className="conversation-body min-w-0 flex-1">
											<div className="conversation-title flex min-w-0 items-center gap-1.5">
												<strong className="min-w-0 flex-1 truncate font-medium" title={project.path}>{projectName}</strong>
											</div>
										</div>
									</button>
									<div className="project-row-actions flex shrink-0 items-center gap-0.5">
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="project-action size-7"
											disabled={Boolean(creatingProjectId)}
											title={t("app.newSession")}
											aria-label={t("app.newSession")}
											onClick={() => props.onCreateSession(project.id)}
										>
											{creating ? (
												<span className="size-3 animate-pideck-spin rounded-full border border-current border-t-transparent" aria-hidden="true" />
											) : (
												<Plus className="size-3.5" aria-hidden="true" />
											)}
										</Button>
										{project.kind !== "chat" && (
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="project-action size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
												title={t("web.deleteProject")}
												aria-label={t("web.deleteProject")}
												onClick={() => void requestDelete(project)}
											>
												<Trash2 className="size-3.5" aria-hidden="true" />
											</Button>
										)}
									</div>
								</div>
								{expanded && (
									<div className="project-children mt-2 flex flex-col gap-2 px-1 pb-1">
										<SessionRows
											sessions={projectSessions}
											runtimeFor={runtimeFor}
											activeSessionId={activeSessionId}
											showAll={showAllSessions}
											onToggleShowAll={() => toggleSessionExpand(project.id)}
											onSelect={props.onSelectSession}
										/>
										{projectSessions.length === 0 && (
											<div className="px-6 py-1 text-caption text-muted-foreground">
												{t("web.noSessions")}
											</div>
										)}
									</div>
								)}
							</div>
						);
					})}
					{/* 未分组兜底：孤儿 catalog 记录（projectId 缺失、项目被删除/从未注册等）
						无法匹配任何项目，不能让它们在侧栏完全不可见。收集到独立分组下，保留
						运行态圆点与点击打开能力，与项目内会话同等待遇。 */}
					{ungroupedSessions.length > 0 && (
						<div className="project-group mb-2">
							<div className="project-row flex min-w-0 items-center gap-0.5">
								<div
									className={cn(projectRowClass, "cursor-default bg-muted/40")}
									title={t("web.ungroupedHint")}
								>
									<div className="conversation-body min-w-0 flex-1">
										<div className="conversation-title flex min-w-0 items-center gap-1.5">
											<strong className="min-w-0 flex-1 truncate font-medium">
												{t("web.ungrouped")}
											</strong>
										</div>
									</div>
								</div>
							</div>
							<div className="project-children mt-2 flex flex-col gap-2 px-1 pb-1">
								<SessionRows
									sessions={ungroupedSessions}
									runtimeFor={runtimeFor}
									activeSessionId={activeSessionId}
									showAll={showAllUngrouped}
									onToggleShowAll={() => toggleUngroupedExpand()}
									onSelect={props.onSelectSession}
								/>
							</div>
						</div>
					)}
					{state.projects.length === 0 && ungroupedSessions.length === 0 && (
						<div className="px-2 py-3 text-caption text-muted-foreground">
							{t("app.emptyNoProject")}
						</div>
					)}
				</div>
			</div>
			{/* 底栏连接状态 */}
			<div className="toolbar-actions sidebar-bottom-actions flex shrink-0 items-center gap-0.5 border-t border-border px-1.5 py-1">
				<div className="flex min-w-0 flex-1 items-center gap-2 text-caption text-muted-foreground">
					<span
						className={cn(
							"size-1.5 shrink-0 rounded-full",
							connected ? "bg-primary" : "bg-warning",
						)}
						aria-hidden="true"
					/>
					<span className="truncate">
						{connected ? t("web.connected") : t("web.connecting")}
					</span>
				</div>
			</div>
			</aside>
		</>
	);
}

/** 项目行展开/收起图标：复用桌面 ProjectTree 的 Play 旋转动画语义。 */
function PlayIcon(props: { expanded: boolean }) {
	return (
		<Play
			size={12}
			className={cn("transition-transform", props.expanded && "rotate-90")}
		/>
	);
}
