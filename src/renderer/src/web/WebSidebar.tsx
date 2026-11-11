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
import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, CirclePlus, Copy, Download, FolderPlus, GitFork, MoreVertical, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { WebBrandLockup } from "./WebBrandLockup";
import { WebBottomSheet } from "./WebBottomSheet";
import { WEB_SIDEBAR_INITIAL_VISIBLE, growSidebarWindow, resolveSidebarWindow } from "./webSidebarPaging";
import { groupWebSessionsByParent } from "./webSidebarSessions";
import { cn } from "@/lib/utils";
import { isActiveSessionStatus, sessionStatusDotClass } from "@/agentListDisplay";
import { WebBackendMark } from "./WebBackendMark";
import type { WebAcpTool, WebProject, WebRuntime, WebSession, WebState } from "./webTypes";

/* 行本体透明（dsh-web 列表语言：扁平行融入 layer-2 面，hover/选中才铺填充）。
   项目行与会话行共用 32px 行高（触屏 36px）和 10px 圆角——两者是同一种「可点行」，
   不再一个 32 一个 28、一个 10 一个 8 地各说一套。px-2 + 16px 折叠盒收紧缩进链。 */
const rowBaseClass = "relative w-full h-8 items-center rounded-lg px-2 text-left text-control text-foreground shadow-none transition-colors duration-150 hover:bg-muted/60 hover:text-foreground pointer-coarse:h-9";
const projectRowClass = `conversation ${rowBaseClass} flex font-medium`;
const sessionRowClass = `conversation agent-row ${rowBaseClass} flex`;

/* 搜索框 / 新建项目输入共用同一套字段外壳：36px 高、10px 圆角、聚焦时整体亮起。
   宽高/字号只在这里定义一次，避免两个输入各有一套边距和聚焦态。 */
const fieldChromeClass = "flex h-9 items-center rounded-lg border border-input bg-background transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15";
const fieldInputClass = "h-full min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-control shadow-none focus-visible:border-transparent focus-visible:ring-0";

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

/** 会话行可执行的操作（P1；由 WebChatApp 提供实现）。 */
export type WebSessionRowAction = "rename" | "duplicate" | "export" | "delete";

/**
 * 项目会话列表：显式分页（首页 10 条，点「查看更多（剩余 N）」每页 +20，可「收起」回首页）。
 *
 * 语义对齐桌面端「最近会话」：不随滚动自动加载。早先的 IntersectionObserver 哨兵在移动端
 * 抽屉首次布局时就会命中 rootMargin，展开一个大项目会被连续补页成几十上百行（实测「聊天」
 * 115 条展开即 57 行），体感等同「一次性全加载」，既慢又丢掉了「先看最近一页」的信息层级。
 * 单项目 400+ 条会话若全渲染会造 4000+ DOM 节点（实测 258ms 卡顿），分页同时守住渲染成本。
 *
 * 子代理会话（parentSessionId 指向本列表里的父会话）折叠到父行下，父行右侧胶囊显示数量；
 * 默认收起、不占分页额度——一个项目 80+ 条子会话曾把列表撑成一整屏。
 */
function SessionRows(props: { sessions: WebSession[]; runtimeFor: (sessionId: string) => WebRuntime | undefined; activeSessionId: string; searching: boolean; acpTools?: WebAcpTool[]; onSelect: (sessionId: string) => void; onSessionAction?: (action: WebSessionRowAction, sessionId: string) => void }) {
	const { sessions, runtimeFor, activeSessionId, searching, acpTools, onSelect, onSessionAction } = props;
	// requested 是「用户点了几次查看更多」的累计目标条数；进入/退出搜索时回到首页。
	const [requested, setRequested] = useState(WEB_SIDEBAR_INITIAL_VISIBLE);
	useEffect(() => setRequested(WEB_SIDEBAR_INITIAL_VISIBLE), [searching]);
	// 子代理会话折叠到父行下（桌面 SessionTree 同一语义）：分页窗口按顶层行计，
	// 子会话默认不占列表长度——一个项目 80+ 条子会话曾把列表撑成一整屏。
	const tree = useMemo(() => groupWebSessionsByParent(sessions), [sessions]);
	const window_ = resolveSidebarWindow({ total: tree.roots.length, requested, searching });
	const visible = tree.roots.slice(0, window_.visibleCount);
	const hiddenCount = window_.remaining;
	/** 已手动展开的父会话分组；搜索态一律展开，否则命中的子会话藏在折叠里等于搜不到。 */
	const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
	const activeRootId = tree.rootByChildId.get(activeSessionId);
	useEffect(() => {
		// 切到子会话时展开它的父分组一次，否则当前行藏起来、用户看不出自己在哪。
		if (!activeRootId) return;
		setExpandedGroups((current) => (current.has(activeRootId) ? current : new Set(current).add(activeRootId)));
	}, [activeRootId]);
	const toggleGroup = (sessionId: string) => {
		setExpandedGroups((current) => {
			const next = new Set(current);
			if (next.has(sessionId)) next.delete(sessionId);
			else next.add(sessionId);
			return next;
		});
	};
	// 会话操作面板：移动端底部滑出、桌面居中卡片（WebBottomSheet 两形态），
	// 替代 DropdownMenu——触屏无 hover 看不见触发钮，且菜单会从侧栏右缘弹出遮挡聊天区。
	const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
	const menuSession = menuSessionId ? sessions.find((s) => s.id === menuSessionId) : undefined;
	const runAction = (action: WebSessionRowAction) => {
		if (menuSessionId) onSessionAction?.(action, menuSessionId);
		setMenuSessionId(null);
	};
	/**
	 * 单行渲染：顶层行可带子会话折叠胶囊，子行缩进一层且不再有折叠胶囊。
	 * 折叠胶囊与「更多操作」同为浮层外的行内按钮（button 不能嵌 button）。
	 */
	const renderRow = (session: WebSession, subagentCount: number, expanded: boolean) => {
		const runtime = runtimeFor(session.id);
		return (
			<div key={session.id} className={cn(sessionRowClass, "session-row group/session", session.id === activeSessionId && selectedRowClass)} title={session.title}>
				<button type="button" className={cn("flex h-full min-w-0 flex-1 items-center gap-1.5 text-left", runtime && "font-medium")} onClick={() => onSelect(session.id)}>
					{/* 状态位恒定占位：运行中才长圆点，但所有标题左缘对齐，不因有没有圆点左右跳。 */}
					{renderRuntimeStatusDot(runtime?.status) ?? <span className="size-1.5 shrink-0" aria-hidden="true" />}
					<div className="conversation-body min-w-0 flex-1">
						<div className="conversation-title flex min-w-0 items-center gap-1.5">
							<strong className="min-w-0 flex-1 truncate">{session.title || t("common.untitled")}</strong>
							{/* P3：fork 徽标（克隆/回退产生的分支会话） */}
							{session.forked ? <GitFork className="size-3 shrink-0 text-muted-foreground" aria-label={t("web.forkedBadge")} /> : null}
							{/* 后端标记（WebBackendMark）：dsh 鲸鱼 / acp 品牌图标 / imagegen 图标，pi 不署名 */}
							<WebBackendMark backend={session.backend} acpToolId={session.acpToolId} acpTools={acpTools} className="size-4 shrink-0" />
						</div>
					</div>
				</button>
				{/* 子代理会话折叠胶囊：数量徽标 + 展开箭头，与桌面 SessionTree 的 subagent-inline-toggle 同语义 */}
				{subagentCount > 0 ? (
					<button
						type="button"
						className="flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-micro tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground pointer-coarse:h-7 pointer-coarse:px-2"
						aria-expanded={expanded}
						aria-label={t("app.piSubagentCount", { count: subagentCount })}
						title={t("app.piSubagentCount", { count: subagentCount })}
						onClick={(event) => {
							event.stopPropagation();
							toggleGroup(session.id);
						}}
					>
						<ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
						{subagentCount}
					</button>
				) : null}
				{onSessionAction ? (
					<button
						type="button"
						className="session-more-button flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/session:opacity-100 [@media(hover:none)]:opacity-100"
						aria-label={t("web.sessionMenu")}
						title={t("web.sessionMenu")}
						onClick={() => setMenuSessionId(session.id)}
					>
						<MoreVertical className="size-3.5" aria-hidden="true" />
					</button>
				) : null}
			</div>
		);
	};
	return (
		<>
			{visible.map((session) => {
				const children = tree.childrenByParentId.get(session.id) ?? [];
				const expanded = children.length > 0 && (searching || expandedGroups.has(session.id));
				return (
					<Fragment key={session.id}>
						{renderRow(session, children.length, expanded)}
						{expanded ? <div className="ml-2 flex flex-col gap-0.5 border-l border-border-subtle pl-1">{children.map((child) => renderRow(child, 0, false))}</div> : null}
					</Fragment>
				);
			})}
			{hiddenCount > 0 && (
				<button
					type="button"
					data-testid="web-sidebar-load-more"
					className="session-row relative flex min-h-8 w-full items-center justify-start gap-1.5 rounded-lg border border-transparent px-2 text-left text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground pointer-coarse:min-h-9"
					onClick={() => setRequested(growSidebarWindow(window_.visibleCount))}
				>
					{t("web.moreSessions", { count: hiddenCount })}
				</button>
			)}
			{window_.canCollapse && (
				<button
					type="button"
					data-testid="web-sidebar-collapse-sessions"
					className="session-row relative flex min-h-8 w-full items-center justify-start gap-1.5 rounded-lg border border-transparent px-2 text-left text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground pointer-coarse:min-h-9"
					onClick={() => setRequested(WEB_SIDEBAR_INITIAL_VISIBLE)}
				>
					{t("common.collapse")}
				</button>
			)}
			{/* 会话操作面板：跨端 BottomSheet，大触控行，不被侧栏右缘裁剪 */}
			<WebBottomSheet open={Boolean(menuSession)} onOpenChange={(open) => !open && setMenuSessionId(null)} title={menuSession?.title || t("web.sessionMenu")}>
				<ul className="pb-[max(env(safe-area-inset-bottom),0.5rem)]">
					<li>
						<button type="button" className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm text-foreground transition-colors hover:bg-muted/60 active:bg-muted" onClick={() => runAction("rename")}>
							<Pencil className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							{t("web.rename")}
						</button>
					</li>
					<li>
						<button type="button" className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm text-foreground transition-colors hover:bg-muted/60 active:bg-muted" onClick={() => runAction("duplicate")}>
							<Copy className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							{t("web.duplicate")}
						</button>
					</li>
					<li>
						<button type="button" className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm text-foreground transition-colors hover:bg-muted/60 active:bg-muted" onClick={() => runAction("export")}>
							<Download className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							{t("web.exportHtml")}
						</button>
					</li>
					<li className="mt-1 border-t border-border pt-1">
						<button type="button" className="flex h-12 w-full items-center gap-3 px-4 text-left text-sm text-danger transition-colors hover:bg-danger/10 active:bg-danger/15" onClick={() => runAction("delete")}>
							<Trash2 className="size-4 shrink-0" aria-hidden="true" />
							{t("web.deleteSession")}
						</button>
					</li>
				</ul>
			</WebBottomSheet>
		</>
	);
}

/** Web 侧栏与桌面 Tab/侧栏复用同一组状态点，纯历史记录不显示状态。 */
function renderRuntimeStatusDot(status?: string) {
	const dotClass = sessionStatusDotClass(status);
	if (!dotClass) return null;
	const active = isActiveSessionStatus(status);
	const label = status === "idle" ? t("app.statusIdle") : status === "error" ? t("app.statusError") : active ? t("app.statusRunning") : undefined;
	// 与桌面侧栏同口径：idle/error 是静态状态，不跑永久脉动动画（#483）。
	return <span className={cn("size-1.5 shrink-0 rounded-full", dotClass, active && "animate-pulse")} aria-label={label} title={label} />;
}

export function WebSidebar(props: {
	state: WebState;
	activeSessionId: string;
	creatingProjectId: string;
	connected: boolean;
	mobileOpen: boolean;
	onCloseMobile: () => void;
	onSelectSession: (sessionId: string) => void;
	/** P1：会话行操作菜单（重命名/复制/导出/删除）。 */
	onSessionAction?: (action: WebSessionRowAction, sessionId: string) => void;
	onCreateSession: (projectId: string) => void;
	onCreateProject: (path: string) => Promise<WebProject>;
	onDeleteProject: (projectId: string) => Promise<void>;
}) {
	const { state, activeSessionId, creatingProjectId, connected, mobileOpen } = props;
	const [search, setSearch] = useState("");
	const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
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

	const runtimeFor = (sessionId: string): WebRuntime | undefined => state.runtimes.find((runtime) => runtime.sessionId === sessionId);

	/** 项目按最近打开时间降序（chat 项目恒置顶），与桌面端按时间感知一致 */
	const sortedProjects = useMemo(() => [...state.projects].sort((a, b) => Number(b.kind === "chat") - Number(a.kind === "chat") || (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)), [state.projects]);
	const newSessionProject = state.projects.find((project) => project.kind === "chat") ?? state.projects[0];

	/** 会话按最近活动时间降序（最新在上） */
	const sortedSessions = useMemo(() => [...state.sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)), [state.sessions]);

	// 未分组会话 = projectId 不匹配任何已登记项目的 catalog 记录（孤儿/项目被删等）。
	// 兜底分组始终可见，不会被项目折叠状态吞掉；搜索时仍按标题过滤。
	const searching = search.trim().length > 0;
	const projectIds = useMemo(() => new Set(state.projects.map((project) => project.id)), [state.projects]);
	// 搜索先过滤一次会话全集，项目循环与未分组兜底都从同一份命中集合取数：
	// 搜索态下无命中的项目整组隐藏，不再占位显示「暂无会话」。
	const searchedSessions = useMemo(() => (searching ? sortedSessions.filter((session) => matchesSearch(session.title || session.id, search.trim())) : sortedSessions), [sortedSessions, searching, search]);
	const ungroupedSessions = useMemo(() => searchedSessions.filter((session) => !projectIds.has(session.projectId)), [searchedSessions, projectIds]);
	const hasSearchResults = searchedSessions.length > 0;
	// 搜索态一次看到全部命中（命中集合通常很小，用户预期「搜到即列出」）；
	// 非搜索态按显式分页（首页 10 条 + 「查看更多」），语义见 webSidebarPaging。

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

	// 移除项目与删除会话同为不可恢复操作：走与会话删除一致的 AlertDialog，
	// 不用原生 confirm 弹窗（无样式，且移动端会打断手势）。
	const [pendingDeleteProject, setPendingDeleteProject] = useState<WebProject | null>(null);
	const requestDelete = (project: WebProject) => {
		if (project.kind === "chat") return;
		setPendingDeleteProject(project);
	};
	const confirmDeleteProject = async () => {
		const project = pendingDeleteProject;
		if (!project) return;
		setPendingDeleteProject(null);
		await props.onDeleteProject(project.id);
	};

	// 搜索/切换会话时自动展开对应项目；普通项目展开状态完全由用户控制。
	const activeSessionProjectId = state.sessions.find((session) => session.id === activeSessionId)?.projectId;

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
			<button type="button" className={cn("mobile-sidebar-backdrop", mobileOpen && "is-open")} onClick={props.onCloseMobile} aria-label={t("web.closeProjects")} />
			<aside className={cn("chat-list-pane flex h-full min-w-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground", mobileOpen && "mobile-open")} aria-label={t("app.search")}>
				{/* 品牌区提到 body 外，与桌面侧栏一致贴顶；px-3 与下方内容同缘对齐 */}
				<div className="list-toolbar flex h-11 shrink-0 items-center gap-2 px-3">
					<div className="app-badge flex min-w-0 flex-1 items-center">
						<WebBrandLockup />
					</div>
					<Button type="button" variant="ghost" size="icon" className="mobile-sidebar-close -mr-1 size-8 shrink-0 text-muted-foreground hover:text-foreground" onClick={props.onCloseMobile} aria-label={t("web.closeProjects")} title={t("web.closeProjects")}>
						<X className="size-4" aria-hidden="true" />
					</Button>
				</div>
				<div className="sidebar-body flex min-h-0 flex-1 flex-col gap-2 px-3 pt-2 pb-0">
					{/* 高频动作独立于项目树：与首页直发同取内置 chat 项目，进入后直接聚焦输入；
					    项目行右侧的 + 仍负责「在指定项目新建」。
					    2026-11 走查：实心主色整块与下方搜索框各说一套（一个填充块 + 一个描边框），
					    改成与桌面侧栏「新建会话 / 搜索」同一种扁平行动作行——同 36px 高、同 10px 圆角、
					    同图标缩进，主次靠字重与图标色区分，不再用一大块品牌色压住列表。 */}
					{newSessionProject ? (
						<button
							type="button"
							className="flex h-9 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-control font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-60"
							disabled={Boolean(creatingProjectId)}
							onClick={() => props.onCreateSession(newSessionProject.id)}
							title={t("app.newSession")}
						>
							{creatingProjectId === newSessionProject.id ? <span className="size-4 shrink-0 animate-pideck-spin rounded-full border-2 border-current border-t-transparent text-muted-foreground" aria-hidden="true" /> : <CirclePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
							<span className="min-w-0 flex-1 truncate">{t("app.newSession")}</span>
						</button>
					) : null}
					{/* 搜索行：输入框与「新建项目」同 36px / 同 10px 圆角 / 同描边语言，读作一对控件。 */}
					<div className="search-row flex shrink-0 items-center gap-1.5">
						<div className={cn(fieldChromeClass, "search-box min-w-0 flex-1 gap-1 pr-1 pl-2")}>
							<Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("app.search")} aria-label={t("app.search")} type="text" inputMode="search" enterKeyHint="search" autoComplete="off" spellCheck={false} className={fieldInputClass} />
							{search ? (
								<button type="button" className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => setSearch("")} aria-label={t("common.clear")} title={t("common.clear")}>
									<X className="size-3.5" aria-hidden="true" />
								</button>
							) : null}
						</div>
						<Button
							type="button"
							variant="outline"
							size="icon"
							className={cn("size-9 shrink-0 rounded-lg text-muted-foreground", addingProject && "bg-muted text-foreground")}
							onClick={() => setAddingProject((value) => !value)}
							aria-label={t("web.newProject")}
							aria-expanded={addingProject}
							title={t("web.newProject")}
						>
							<FolderPlus className="size-4" aria-hidden="true" />
						</Button>
					</div>
					{addingProject && (
						<form
							className={cn(fieldChromeClass, "shrink-0 gap-0.5 pr-1 pl-2.5")}
							onSubmit={(event) => {
								event.preventDefault();
								void submitProject();
							}}
							onKeyDown={(event) => {
								if (event.key !== "Escape") return;
								// Esc 只收起空表单；已有路径时保留输入，避免误触丢失。
								if (!projectPath && !projectBusy) setAddingProject(false);
							}}
						>
							<Input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder={t("web.projectPathPlaceholder")} aria-label={t("web.projectPathPlaceholder")} className={fieldInputClass} autoFocus disabled={projectBusy} />
							<Button type="submit" variant="ghost" size="icon-sm" className="size-7 shrink-0" disabled={projectBusy || !projectPath.trim()} aria-label={t("web.createProject")} title={t("web.createProject")}>
								<Check className="size-4" aria-hidden="true" />
							</Button>
							<Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" disabled={projectBusy} onClick={() => setAddingProject(false)} aria-label={t("common.close")} title={t("common.close")}>
								<X className="size-4" aria-hidden="true" />
							</Button>
						</form>
					)}
					{/* 项目/会话树 */}
					{/* scroll-ok: bounded —— 行数有硬上限（受控分页 / 上限常量 / 固定枚举），不随数据无限增长。 */}
					<div className="conversation-list min-h-0 flex-1 overflow-y-auto">
						{sortedProjects.map((project) => {
							const projectSessions = searchedSessions.filter((session) => session.projectId === project.id);
							// 搜索态只保留有命中的项目；空组不占位，避免满屏「暂无会话」。
							if (searching && projectSessions.length === 0) return null;
							const expanded = searching || expandedProjects.has(project.id);
							const projectName = displayProjectName(project);
							const creating = creatingProjectId === project.id;
							return (
								<div key={project.id} className="project-group mb-2" data-project-row-id={project.id}>
									<div className="project-row group/project flex min-w-0 items-center gap-0.5">
										<button type="button" className={cn(projectRowClass, "min-w-0 flex-1")} disabled={Boolean(creatingProjectId)} onClick={() => toggleProject(project.id)} title={project.path} aria-expanded={expanded}>
											<span className={cn("project-fold grid size-4 shrink-0 place-items-center text-muted-foreground", !expanded && "folded")} aria-hidden="true">
												<ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
											</span>
											<div className="conversation-body min-w-0 flex-1">
												<div className="conversation-title flex min-w-0 items-center gap-1.5">
													<strong className="min-w-0 flex-1 truncate font-medium" title={project.path}>
														{projectName}
													</strong>
												</div>
											</div>
										</button>
										{/* 动作钮悬停显隐（与桌面侧栏同范式）；触屏（hover:none）与键盘焦点常显 */}
										<div className={cn("project-row-actions flex shrink-0 items-center gap-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/project:opacity-100 [@media(hover:none)]:opacity-100", searching && "hidden")}>
											<Button type="button" variant="ghost" size="icon" className="project-action size-7 shrink-0 text-muted-foreground hover:text-foreground" disabled={Boolean(creatingProjectId)} title={t("app.newSession")} aria-label={t("app.newSession")} onClick={() => props.onCreateSession(project.id)}>
												{creating ? <span className="size-3 animate-pideck-spin rounded-full border border-current border-t-transparent" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
											</Button>
											{project.kind !== "chat" && (
												<Button type="button" variant="ghost" size="icon" className="project-action size-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title={t("web.deleteProject")} aria-label={t("web.deleteProject")} onClick={() => requestDelete(project)}>
													<Trash2 className="size-3.5" aria-hidden="true" />
												</Button>
											)}
										</div>
									</div>
									{expanded && (
										<div className="project-children mt-0.5 ml-2 flex flex-col gap-0.5 pb-0.5">
											<SessionRows sessions={projectSessions} runtimeFor={runtimeFor} activeSessionId={activeSessionId} searching={searching} acpTools={state.acpTools} onSelect={props.onSelectSession} onSessionAction={props.onSessionAction} />
											{projectSessions.length === 0 && <div className="px-2 py-1.5 text-caption text-muted-foreground">{t("web.noSessions")}</div>}
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
									<div className="relative flex min-h-8 w-full items-center gap-1.5 rounded-lg px-2 text-control font-medium text-muted-foreground pointer-coarse:min-h-9" title={t("web.ungroupedHint")}>
										{/* 和可展开项目共享同一条 16px 图标列，文字左缘不因少了折叠键而错位 */}
										<span className="size-4 shrink-0" aria-hidden="true" />
										<div className="conversation-body min-w-0 flex-1">
											<div className="conversation-title flex min-w-0 items-center gap-1.5">
												<strong className="min-w-0 flex-1 truncate font-medium">{t("web.ungrouped")}</strong>
											</div>
										</div>
									</div>
								</div>
								<div className="project-children mt-0.5 ml-2 flex flex-col gap-0.5 pb-0.5">
									<SessionRows sessions={ungroupedSessions} runtimeFor={runtimeFor} activeSessionId={activeSessionId} searching={searching} acpTools={state.acpTools} onSelect={props.onSelectSession} onSessionAction={props.onSessionAction} />
								</div>
							</div>
						)}
						{searching && !hasSearchResults ? (
							<div className="web-sidebar-no-results flex flex-col items-center gap-1.5 px-4 py-10 text-center" data-testid="web-sidebar-no-results">
								<Search className="size-4 text-muted-foreground" aria-hidden="true" />
								<p className="text-caption text-muted-foreground">{t("app.searchNoResults")}</p>
								<button type="button" className="text-caption font-medium text-[var(--color-accent)] hover:underline" onClick={() => setSearch("")}>
									{t("common.clear")}
								</button>
							</div>
						) : null}
						{!searching && state.projects.length === 0 && ungroupedSessions.length === 0 && <div className="px-3 py-4 text-caption text-muted-foreground">{t("app.emptyNoProject")}</div>}
					</div>
					<AlertDialog open={pendingDeleteProject != null} onOpenChange={(open) => !open && setPendingDeleteProject(null)}>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>{t("web.deleteProjectConfirmTitle")}</AlertDialogTitle>
								<AlertDialogDescription>{t("web.deleteProjectConfirm")}</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
								<AlertDialogAction className="bg-danger text-danger-foreground hover:bg-danger/90" onClick={() => void confirmDeleteProject()}>
									{t("web.deleteProject")}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
				{/* 底栏连接状态：px-3 与主体同缘，32px 高不抢列表空间 */}
				<div className="toolbar-actions sidebar-bottom-actions flex h-8 shrink-0 items-center gap-0.5 border-t border-border/60 px-3">
					<div className="flex min-w-0 flex-1 items-center gap-2 text-caption text-muted-foreground">
						{/* 连接态语义色：已连接=success 绿（主色 ink 在新语义档下读不出「通」），连接中=warning */}
						<span className={cn("size-1.5 shrink-0 rounded-full", connected ? "bg-success" : "bg-warning")} aria-hidden="true" />
						<span className="truncate leading-none">{connected ? t("web.connected") : t("web.connecting")}</span>
						{/* 宿主版本号：远程端排查「桌面是新版、手机看到旧版」时的第一眼线索 */}
						{state.version ? <span className="ml-auto shrink-0 font-mono text-micro leading-none text-muted-foreground">v{state.version}</span> : null}
					</div>
				</div>
			</aside>
		</>
	);
}
