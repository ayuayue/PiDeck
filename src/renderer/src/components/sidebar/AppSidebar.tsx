import React, { useRef } from "react";
import { useSetAtom } from "jotai";
import { PanelLeft } from "lucide-react";
import { SidebarContent, type SidebarActions } from "./SidebarContent";
import type { AppInfo, AppThemeMode, SessionSortModeId, WorktreeEntry } from "../../../../shared/types";
import { useSidebarController } from "../../hooks/useSidebarController";
import type { SidebarNavTab } from "../../utils/sidebarNavTab";
import { BrandLockup } from "../app/AppParts";
import { AboutPopover } from "../app/AboutPopover";
import { settingsOpenAtom } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { Button } from "../ui-shadcn/button";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";

interface AppSidebarProps {
	simple?: boolean;
	actions: SidebarActions;
	currentProjectId: string | undefined;
	currentSessionId: string | undefined;
	worktreesByProject: Record<string, WorktreeEntry[]>;
	branchByProject: Record<string, string | null>;
	creatingWorktree: boolean;
	/** Child projects currently being removed（远端工作区按 ProjectId 索引，dev 的纯 path 版本不适用）。 */
	removingWorktreeProjectIds: ReadonlySet<string>;
	/** 「聊天」「项目」分组标题栏在列表滚动时冻结在顶部（settings.sidebarStickyGroupHeaders）。 */
	stickyGroupHeaders?: boolean;
	isLanWeb: boolean;
	/** 「新建会话」：打开初始引导页（居中输入框 + 项目下拉切换），由 App 提供。 */
	onOpenNewSession: () => void;
	onOpenFeedback: () => void;
	/** 关于弹框（版本/官网/GitHub 链接）数据，由 App 从 AppInfo IPC 拉取后提供。 */
	appInfo: AppInfo;
	/** 底栏主题切换：当前主题模式 + 点击循环（浅色→暗色→跟随系统），由 App 提供。 */
	themeMode: AppThemeMode;
	onToggleTheme: () => void;
	/** 左侧栏折叠态与开关（main 布局：按钮在品牌文字右侧） */
	listCollapsed: boolean;
	toggleListCollapsed: () => void;
	/** settings.json 中已保存的展开项目 id，权威来源 */
	settingsExpandedProjectIds?: readonly string[];
	/** settings.json 中已保存的侧栏分段（Chats/项目），权威来源 */
	settingsNavTab?: SidebarNavTab;
	/** settings.json 中已保存的稳定 SessionRecord 置顶 id。 */
	settingsPinnedSessionIds?: readonly string[];
	/** settings.json 中的会话排序模式（settings.sessionSortMode）。 */
	settingsSessionSortMode?: SessionSortModeId;
	/** 首次 settings.get 已完成，controller 可安全处理旧 key 迁移。 */
	settingsLoaded: boolean;
	/** 展开集合完成权威 hydration 后，允许 App 按它懒加载会话。 */
	onExpandedProjectsReady: () => void;
}

export function AppSidebar(props: AppSidebarProps) {
	const setSettingsOpen = useSetAtom(settingsOpenAtom); // 快速连续点击展开/折叠会触发多次 IPC；按顺序写入可避免旧请求最后完成后覆盖新集合。
	const expandedProjectsSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	const navTabSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	const pinnedSessionIdsSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	const sessionSortModeSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	const controller = useSidebarController({
		getRpcLogging: props.actions.rpc.getLogging,
		openRpcLogViewer: props.actions.rpc.openViewer,
		settingsExpandedProjectIds: props.settingsExpandedProjectIds,
		settingsNavTab: props.settingsNavTab,
		settingsPinnedSessionIds: props.settingsPinnedSessionIds,
		settingsSessionSortMode: props.settingsSessionSortMode,
		settingsLoaded: props.settingsLoaded,
		onExpandedProjectsReady: props.onExpandedProjectsReady,
		persistExpandedProjectIds: (projectIds) => {
			expandedProjectsSaveQueueRef.current = expandedProjectsSaveQueueRef.current
				.catch(() => undefined)
				.then(() => desktopApi.settings.update({ sidebarExpandedProjectIds: projectIds }))
				.catch(() => undefined);
		},
		persistNavTab: (tab) => {
			// 与展开集合同款串行队列：快速切换标签时避免旧请求最后完成覆盖新值
			navTabSaveQueueRef.current = navTabSaveQueueRef.current
				.catch(() => undefined)
				.then(() => desktopApi.settings.update({ sidebarNavTab: tab }))
				.catch(() => undefined);
		},
		persistPinnedSessionIds: (sessionIds) => {
			// 快速连续置顶/取消置顶必须按触发顺序落盘，避免较慢的旧请求覆盖新集合。
			pinnedSessionIdsSaveQueueRef.current = pinnedSessionIdsSaveQueueRef.current
				.catch(() => undefined)
				.then(() => desktopApi.settings.update({ pinnedSessionIds: sessionIds }))
				.catch(() => undefined);
		},
		persistSessionSortMode: (mode) => {
			// 排序模式与置顶同款串行队列：快速切换选项时避免旧请求覆盖新值。
			sessionSortModeSaveQueueRef.current = sessionSortModeSaveQueueRef.current
				.catch(() => undefined)
				.then(() => desktopApi.settings.update({ sessionSortMode: mode }))
				.catch(() => undefined);
		},
	});

	return (
		<>
			<SidebarContent
				simple={props.simple}
				controller={controller}
				actions={props.actions}
				currentProjectId={props.currentProjectId}
				currentSessionId={props.currentSessionId}
				worktreesByProject={props.worktreesByProject}
				branchByProject={props.branchByProject}
				creatingWorktree={props.creatingWorktree}
				removingWorktreeProjectIds={props.removingWorktreeProjectIds}
				stickyGroupHeaders={props.stickyGroupHeaders}
				isLanWeb={props.isLanWeb}
				onOpenNewSession={props.onOpenNewSession}
				chrome={
					<>
						{/* 品牌行两种导航模式共用同一条 40px 标题行：左侧留出 mac 红绿灯宽度，
						    右侧固定折叠按钮（垂直居中 40px → 与红绿灯中心同高）。
						    简洁模式只去掉底边线（面板间靠底色差分区），高度/内边距/对齐与标签模式完全一致。 */}
						<div className={cn("list-toolbar flex h-10 shrink-0 items-center gap-1 pr-2.5 pl-[max(0.625rem,var(--traffic-lights-width,0px))]", props.simple ? "border-b border-transparent" : "border-b border-border/40")}>
							{/* min-w-0 flex-1 必须给到 MorphPopover 根：它默认 inline-flex（min-width:auto），
							    不改就无法收缩，长应用名会把字标顶出标题行、折叠按钮被挤到栏外。 */}
							<AboutPopover appInfo={props.appInfo} className="min-w-0 flex-1">
								<div
									className="app-badge flex min-w-0 flex-1 cursor-pointer items-center justify-center pl-5"
									role="button"
									tabIndex={0}
									aria-label={t("about.title")}
									title={t("about.clickHint")}
									onKeyDown={(e) => {
										// 键盘可达性：Enter/空格等价点击，触发 MorphPopoverTrigger 注入的 onClick
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											e.currentTarget.click();
										}
									}}
								>
									<BrandLockup />
								</div>
							</AboutPopover>
							{/* 折叠/展开按钮两种模式同位置（标题行右端）：简洁模式不再单独占一条顶部导航行，
							    否则按钮会浮在品牌行上方、与 mac 红绿灯错开。面板收起后本按钮随面板隐藏，
							    恢复入口统一由会话 Tab 栏左侧提供（见 SessionTabsBar）。 */}
							<Button type="button" variant="ghost" size="icon-sm" className="icon-button list-toggle-native size-7 shrink-0" aria-label={props.listCollapsed ? t("app.expandList") : t("app.collapseList")} title={props.listCollapsed ? t("app.expandList") : t("app.collapseList")} onClick={props.toggleListCollapsed}>
								<PanelLeft size={14} strokeWidth={2} aria-hidden="true" />
							</Button>
						</div>
					</>
				}
				onOpenSettings={() => setSettingsOpen(true)}
				onOpenFeedback={props.onOpenFeedback}
				themeMode={props.themeMode}
				onToggleTheme={props.onToggleTheme}
			/>
		</>
	);
}
