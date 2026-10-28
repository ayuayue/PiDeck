import { useAtomValue } from "jotai";
import { Check, ChevronDown, ChevronRight, CircleStop, CircleX, Copy, FileDown, FileText, Fingerprint, Folder, Globe, Link2, ListChecks, MessagesSquare, Pencil, PanelLeft, PanelRight, Pin, PinOff, ListRestart, Play, Plus, RefreshCcw, RotateCw, Target, Terminal, X } from "lucide-react";
import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, sessionRecordsAtom, projectInventoryByIdAtom, projectByIdAtomFamily, acpEnabledAtom, acpToolsAtom } from "../../atoms";
import { t } from "../../i18n";
import { displayProjectDirectoryName } from "../../rendererUtils";
import { copyTextWithCopiedNotice } from "../../utils/clipboardNotice";
import { motion, useReducedMotion } from "motion/react";
import { AnimatedBadge } from "../motion/animated-badge";
import { EASE_OUT } from "../../lib/ease";
import { resolveTabLayoutGeneration } from "../../utils/sessionTabMotion";
import { sessionStatusBadge } from "../../utils/sessionStatusBadge";
import { canRunSessionAction, type SessionReloadMode, type SessionRunAction, type SessionRunCapabilities, type SessionRunControlView } from "../../utils/sessionCommands";
import { sessionDisplayName } from "../../utils/sessionDisplayName";
import { Button } from "../ui-shadcn/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui-shadcn/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { cn } from "../../lib/utils";
import { AcpBackendMark, SessionBackendBadge, SessionChannelMark, SideTaskMark } from "./SessionSourceBadge";
import { TitleScrollText } from "../sidebar/TitleScrollText";
import { SessionHeader } from "./SessionHeader";
import type { SessionMenuRunControl } from "./SessionActionsMenu";
import { SessionActivityIndicator } from "./SessionActivityIndicator";
import { TAB_CLOSE_BUTTON_CLASS } from "../../utils/tabCloseButton";

import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";
import { buildSessionTabBarEntries, flattenSessionTabBarEntries } from "../../utils/sessionTabGroups";
import { SESSION_TAB_BADGE_EXTRA_WIDTH } from "../../../../shared/sessionTabWidth";

/**
 * 分屏组预设色板（浏览器标签组风格）。
 * 第一个为默认色，与 SPLIT_GROUP_DEFAULT_COLOR 保持一致；labelKey 走 i18n。
 */
export const SPLIT_GROUP_COLOR_PALETTE = [
	{ name: "blue", value: "#0091ff", labelKey: "session.splitGroup.color.blue" },
	{ name: "green", value: "#30a46c", labelKey: "session.splitGroup.color.green" },
	{ name: "yellow", value: "#f5d90a", labelKey: "session.splitGroup.color.yellow" },
	{ name: "orange", value: "#f76b15", labelKey: "session.splitGroup.color.orange" },
	{ name: "red", value: "#e5484d", labelKey: "session.splitGroup.color.red" },
	{ name: "purple", value: "#8e4ec6", labelKey: "session.splitGroup.color.purple" },
	{ name: "pink", value: "#d6409f", labelKey: "session.splitGroup.color.pink" },
	{ name: "gray", value: "#8d8d8d", labelKey: "session.splitGroup.color.gray" },
] as const;

/**
 * 会话 Tab 栏（浏览器式多 Tab）：标题栏下方展示当前打开的所有会话。
 *
 * 生命周期约定（省内存 + 复用 Agent 的最佳实践）：
 * - 点击 Tab = 切换会话（只改 currentSessionId，不启动/停止任何 Agent）；
 * - 关闭 Tab = 仅从列表移除，**不 kill Agent**——后台 Agent 保持运行，
 *   再次打开同一会话时复用已绑定运行时并重新加载最新历史；
 * - 全部 Agent 只在应用整体退出时统一停止（main 进程 before-quit 路径）。
 *
 * 固定（pin）与排序：
 * - 固定 Tab 前置、宽度更小、无关闭按钮，右键/下拉菜单可取消固定；
 * - 拖拽 Tab 可排序，固定/普通区间交叉拖动会自动转换固定状态；
 * - 拖到聊天区边缘可分屏（见 SessionSplitStage）。
 *
 * 操作入口（融合对方收敛方案）：
 * - 每个会话 Tab 的下拉按钮（或右键）打开操作菜单：切换到该会话、固定、
 *   停止 Agent（仅当前 Tab，保留会话与 Tab）、重启（仅当前 Tab）、关闭/关闭其他/关闭全部；
 * - 当前 Tab 识别：灰色柔和实底（选中态背景 = --color-bg-active，与左侧 SessionTree 选中态
 *   同一套语义），直接画在激活 Tab 自己身上、切换瞬时出现；不做滑动/浮起/阴影/底部横条
 *   （2026-10 用户指定取消 beui 同款 layoutId 共享投影：旧实现下选中底色会从上一个 Tab 滑到新 Tab）。
 *   （曾因过粗被弃用）。

/** “+” 下拉里的新建目标：聊天对话区或已打开项目 */
export type NewSessionTarget = {
	projectId: string;
	label: string;
	isChat: boolean;
};

/** 工作台文件/Diff Tab：与会话 Tab 共用同一条栏、同一套视觉（不再单独绿条栏） */
export type WorkbenchEditorTabItem = {
	id: string;
	label: string;
	title?: string;
	preview?: boolean;
	active?: boolean;
};

/**
 * 页面式工作区 Tab（定时任务 / 智能体）：与会话 Tab 同栏并列的伪 Tab，但不是会话。
 * 不参与会话固定/拖拽/分屏，也不进 sessionTabIds；点击激活页面，关闭即卸载页面。
 */
export type WorkspacePageTabItem = {
	id: string;
	title: string;
	icon?: React.ComponentType<{ className?: string }>;
	/** 该页面当前正在呈现（active=false 表示 Tab 仍打开但会话在前台）。 */
	active?: boolean;
	onSelect: () => void;
	onClose: () => void;
};

/** Tab 栏工具开关项：App 层装配（与抽屉活动栏动作同构），本栏只负责渲染与激活态展示。 */
export type SessionToolAction = {
	id: string;
	label: string;
	icon: ReactNode;
	active?: boolean;
	/** 参数放宽到 HTMLElement：按钮既可直渲染也可作为下拉菜单项挂载。 */
	onClick: (event: React.MouseEvent<HTMLElement>) => void;
};

export type SessionTabsBarProps = {
	simple?: boolean;
	tabs: readonly string[];
	/**
	 * 会话 Tab 最大宽度（px，80–400）：来自外观设置 sessionTabMaxWidth，
	 * 经 SESSION_TAB_BADGE_EXTRA_WIDTH 换算后写入 CSS 变量控制各 Tab 封顶。
	 * 不设下限宽度：Tab 仍按内容收缩，短标题不受影响。
	 */
	tabMaxWidth: number;
	pinnedTabs: readonly string[];
	/** VS Code 式预览 Tab（斜体）；至多一个 */
	previewTabId?: string | null;
	currentSessionId?: string;
	onSelect: (sessionId: string) => void;
	/** 双击预览 Tab → 常驻（与侧栏双击同语义） */
	onPromotePreview?: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	onCloseOthers: (sessionId: string) => void;
	onCloseAll: () => void;
	/** 新建会话目标（聊天区置顶 + 已打开项目），由 App 从项目库存装配 */
	newSessionTargets: readonly NewSessionTarget[];
	onNewSessionInProject: (projectId: string) => void;
	/** 新建 ACP 工具会话（acpEnabled 门控后由 App 提供；菜单里按工具→项目二级选择） */
	onNewAcpSession?: (projectId: string, toolId: string) => void;
	onTogglePin: (sessionId: string) => void;
	onReorder: (sourceId: string, targetId: string, position: "before" | "after") => void;
	/** 右侧抽屉总开关：打开/关闭整块右侧面板（活动栏在抽屉内、系统按钮下方）。 */
	onToggleDrawer?: () => void;
	drawerOpen?: boolean;
	/** 左侧栏已收起时，在 Tab 栏左侧提供展开入口（替代浮动按钮）。 */
	listCollapsed?: boolean;
	onToggleListCollapsed?: () => void;
	/** 当前会话的状态/操作区；嵌入 Tab 栏后不再单独占用标题行。 */
	actions?: ReactNode;
	/** 工具开关（草稿纸/终端/外部编辑器等）：原右侧悬浮工具条上收至此，排在抽屉开关左侧。 */
	toolActions?: readonly SessionToolAction[];
	/** 开始/结束拖拽会话 Tab 时通知外层（用于分屏落点预览）。 */
	onDragSessionChange?: (sessionId: string | null) => void;
	/** 分屏组：分屏内会话聚合为组（浏览器标签组风格：颜色标记 + 展开/收起）。 */
	splitGroupIds?: readonly string[];
	/** 分屏组胶囊收起状态（收起时组内 Tab 隐藏，只显示组头） */
	splitGroupCollapsed?: boolean;
	onToggleSplitGroup?: () => void;
	/** 分屏组自定义名称（空则用默认文案） */
	splitGroupName?: string;
	/** 分屏组颜色（组色条 + 组内 Tab 竖条） */
	splitGroupColor?: string;
	onSplitGroupRename?: (name: string) => void;
	onSplitGroupColorChange?: (color: string) => void;
	/** 取消分屏：全部会话退出分屏布局 */
	onExitAllSplit?: () => void;
	/**
	 * 中间栏打开的文件/Diff Tab。挂在同一条 session-tabs-bar 上，
	 * 避免内容区再开第二套「绿条」Tab 栏。
	 */
	editorTabs?: readonly WorkbenchEditorTabItem[];
	/**
	 * 页面式宿主插件面板（presentation:"page"）作为伪 Tab 挂进本栏：打开时占据会话区，
	 * 会话 Tab 全部退为非选中（currentSessionId 由装配层置 undefined）；关闭伪 Tab 即收起插件页。
	 * simple 模式不渲染（无 Tab 栏语义，插件页直接铺满会话区）。
	 */
	pluginTab?: { title: string; icon?: React.ComponentType<{ className?: string }>; onClose: () => void } | null;
	/**
	 * 页面式工作区 Tab（定时任务 / 智能体）：挂在会话 Tab 之后、与会话同栏，
	 * 激活时页面覆盖会话列（装配层把 currentSessionId 置 undefined，会话 Tab 退非选中）。
	 */
	pageTabs?: readonly WorkspacePageTabItem[];
	onSelectEditorTab?: (tabId: string) => void;
	onCloseEditorTab?: (tabId: string) => void;
	onPromoteEditorPreview?: (tabId: string) => void;
	/**
	 * 当前会话的运行控制（全状态）：能力由 renderer 侧策略纯函数给出，
	 * 本组件只按结论渲染与置灰，不做状态分叉。undefined = 无当前会话。
	 * 会话头部控制钮（SessionActionsControl）与 Tab 右键菜单共用同一份快照。
	 */
	runControl?: SessionMenuRunControl;
	/**
	 * 打开当前会话的代理设置弹框（网络代理）。
	 * 与侧栏「会话代理」同源：改完保存即自动重启 runtime 生效，不需要手动「停止 → 启动」。
	 * undefined = 无当前会话或宿主不支持（如 DSH 共享 host）。
	 */
	onOpenProxySetting?: () => void;
	/**
	 * 当前会话的「会话操作」组：重命名 / 复制会话 / 导出 HTML / 复制会话文件路径 / 打开会话文件。
	 * 搜索定位到的会话可能不在侧栏可见（侧栏只渲染部分行），⋯ 菜单是唯一稳定入口；
	 * 可见性判定与侧栏会话右键菜单同一套（DSH 历史会话无宿主文件 → 隐藏复制/导出/路径组）。
	 * undefined = 无当前会话（引导页等），整组不渲染。
	 */
	sessionActions?: SessionTabActions;
	/**
	 * Tab 右键菜单的「会话操作」组：按被右键 Tab 的 sessionId 参数化（后台 Tab 同样可操作）。
	 * 装配层与 sessionActions 同一工厂（能力闸门一致）；返回 undefined = 无该会话记录，整组不渲染。
	 */
	contextSessionActions?: (sessionId: string) => SessionTabActions | undefined;
	/**
	 * Tab 右键菜单的运行控制组：按被右键 Tab 的 sessionId 现算能力（后台 Tab 同样可操作）。
	 * 与右上角 ⋯ 菜单共用同一套策略函数；返回 undefined = 无 runtime/会话，整组不渲染。
	 */
	contextRunControl?: (sessionId: string) => SessionRunControlView | undefined;
};

/** 会话操作组（⋯ 菜单与 Tab 右键菜单共用）：能力闸门由装配层按目标会话算好
 *  （草稿/DSH/无文件路径），渲染层只按 flags 与回调存在性出菜单项。 */
export type SessionTabActions = {
	/** 复制会话：live 走 clone 分流（DSH 亦可），历史走 copyRecord；草稿会话隐藏 */
	canCopySession: boolean;
	/** 导出 HTML：DSH 无实现，隐藏 */
	canExportHtml: boolean;
	/** 有会话文件：无（草稿/DSH）则隐藏「复制路径 / 打开文件」 */
	hasFilePath: boolean;
	onCopySession: () => void;
	onCopySessionFilePath: () => void;
	onOpenSessionFile?: () => void;
	onExportSessionHtml?: () => void;
	/** 重命名回调；undefined（草稿期）时隐藏入口——草稿自动命名前先钉名字会进 manual 终态 */
	onRename?: () => void;
	/** 以目标会话的项目/后端新建一条侧边任务；undefined 时隐藏入口 */
	onCreateSideTask?: () => void;
};

export function SessionTabsBar(props: SessionTabsBarProps) {
	const embeddedHeaderRef = useRef<HTMLDivElement>(null);
	const { tabs, pinnedTabs, currentSessionId, previewTabId, tabMaxWidth } = props;
	const dragSourceRef = useRef<string | null>(null);
	const dragTargetRef = useRef<{ targetId: string; position: "before" | "after" } | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	// 拖拽插入指示：当前悬停的目标 Tab 与插入侧（before=左缘 / after=右缘）
	const [dragIndicator, setDragIndicator] = useState<{ targetId: string; position: "before" | "after" } | null>(null);
	// 分屏组管理菜单（右键胶囊打开）：重命名草稿
	const [splitGroupMenuOpen, setSplitGroupMenuOpen] = useState(false);
	const [splitGroupNameDraft, setSplitGroupNameDraft] = useState("");

	// —— 按项目分组 + 分屏组折叠（始终生效，不再受开关控制）——
	// 分组排序是会话 Tab 的固有行为：新会话归入其所属项目组的尾部（按 tabs 原序归组，天然保证
	// “新开会话加到自己项目组尾”）；组在视觉上只以 `|` 边界体现，不渲染胶囊/颜色/折叠。
	// 2026-09 收敛：旧“浏览器标签组胶囊 + 开关”已废弃，分组成为默认。
	const sessionRecords = useAtomValue(sessionRecordsAtom);
	const projectsById = useAtomValue(projectInventoryByIdAtom);

	// 显示单元序列：渲染顺序与 Ctrl+Tab 循环顺序的唯一来源（issue #346）——快捷键侧
	// （useSessionWorkspaceChrome）消费同一纯函数，避免一边按底层打开顺序切换、一边按聚拢顺序显示。
	// 分屏组在渲染层折叠成「组头胶囊 + 组内 Tab」节点，组内 Tab 不参与项目分组。
	const tabBarEntries = useMemo(
		() =>
			buildSessionTabBarEntries(tabs, pinnedTabs, props.splitGroupIds ?? [], (sessionId) => {
				const record = sessionRecords[sessionId];
				const projectId = record?.projectId;
				if (!projectId) return undefined;
				return { projectId, name: projectsById[projectId]?.name };
			}),
		[props.splitGroupIds, tabs, pinnedTabs, sessionRecords, projectsById],
	);

	// —— 关 Tab 后剩余 Tab 收拢 ——
	// 生成数只在 Tab 集合变化时 +1（见 resolveTabLayoutGeneration）：其余渲染里
	// layoutDependency 不变，motion 不再重新测量，避免状态徽章刷新拖慢整条 Tab 栏。
	// 显示顺序复用 flattenSessionTabBarEntries（与 Ctrl+Tab 循环同源），不再手写一遍展开逻辑。
	const tabLayoutIds = useMemo(() => flattenSessionTabBarEntries(tabBarEntries), [tabBarEntries]);
	const tabLayoutRef = useRef<{ ids: readonly string[]; generation: number } | null>(null);
	const tabLayoutGeneration = resolveTabLayoutGeneration(tabLayoutRef.current?.ids ?? null, tabLayoutIds, tabLayoutRef.current?.generation ?? 0);
	useLayoutEffect(() => {
		tabLayoutRef.current = { ids: tabLayoutIds, generation: tabLayoutGeneration };
	}, [tabLayoutIds, tabLayoutGeneration]);
	const reduceMotion = useReducedMotion();

	// —— 滚动容器 ref（拖拽排序与新建菜单共用）——
	const scrollRef = useRef<HTMLDivElement>(null);

	// —— Tab 横向溢出检测 + 当前 Tab 自动滚动可见 ——
	// Tab 多到横向溢出（会话恢复/新建/关组/分屏收起都会改变内容宽度）时，当前会话
	// Tab 可能被挤到屏幕外。核心解决方式：**把当前 Tab 自动滚到可见**（而不是提示用户
	// 怎么滚）—— 任何时刻用户都能看到自己在哪个会话。策略：
	// 1) 检测溢出（供右侧渐变显示「还有更多」）：ResizeObserver（容器自身变化）+
	//    依赖数组（Tab 内容变化时重建 effect 重检；这些只改 scrollWidth 不改容器自身尺寸，
	//    单靠 ResizeObserver 永远不触发）。
	// 2) 自动滚动：currentSessionId 变化时，若当前 Tab 不在滚动容器可视区内，
	//    立即调整 scrollLeft 让当前 Tab 居中可见（仅移动容器横向滚动，不滚动页面）。
	//    效果：切换/恢复会话后，当前 Tab 永远出现在可视区域，无需手动滚动。
	const [tabsOverflow, setTabsOverflow] = useState(false);

	// 确保当前会话 Tab 滚入容器可视区：仅当它被挤出视口（左/右侧不可见）才滚动。
	// 不直接调 scrollIntoView（会滚动整页/干扰上下文），而是手动调 scrollLeft，
	// 目标位置 = 当前 Tab 居中（容器宽度一半处），这样视觉上当前 Tab 在中央。
	const ensureActiveTabVisible = useCallback(() => {
		const container = scrollRef.current;
		const tabEl = container?.querySelector<HTMLElement>(`[data-session-id="${currentSessionId}"]`);
		if (!container || !tabEl) return;
		const cRect = container.getBoundingClientRect();
		const tRect = tabEl.getBoundingClientRect();
		// 当前 Tab 完整在可视区内（左右 1px 容差），无需滚动
		if (tRect.left >= cRect.left - 1 && tRect.right <= cRect.right + 1) return;
		// 定位：当前 Tab 相对于滚动内容的位置（offsetLeft 相对容器内容流）
		const left = tabEl.offsetLeft - (container.clientWidth - tabEl.offsetWidth) / 2;
		container.scrollLeft = Math.max(0, left);
	}, [currentSessionId]);

	// 挂载时 + 当前会话变化时 + Tab 列表变化时：始终把当前 Tab 滚到可见。
	// 注意依赖数组要把 props.tabs 也纳入：会话恢复是异步的（挂载后 sessionRecords
	// 才补齐），仅依赖 currentSessionId 时「恢复完成、Tab 变多」这一时间点不会重跑，
	// 当前 Tab 仍可能被新恢复的 Tab 挤到屏幕外。
	useLayoutEffect(() => {
		ensureActiveTabVisible();
	}, [ensureActiveTabVisible, props.tabs]);

	// —— 溢出检测（仅供右侧渐变判断）——
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const check = () => {
			// +1 容差：亚像素误差（如 0.5px 溢出）不视为溢出，避免抖动。
			const overflow = el.scrollWidth > el.clientWidth + 1;
			setTabsOverflow(overflow);
		};
		check();
		const resizeObserver = new ResizeObserver(check);
		resizeObserver.observe(el);
		return () => {
			resizeObserver.disconnect();
		};
	}, [props.tabs, props.pinnedTabs, props.splitGroupIds, props.splitGroupCollapsed, props.editorTabs, props.pageTabs]);

	/** onDragOver 期间按鼠标位置相对目标 Tab 中点决定插入前后 */
	const handleDragOver = (event: React.DragEvent, targetId: string) => {
		if (!dragSourceRef.current || dragSourceRef.current === targetId) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const rect = event.currentTarget.getBoundingClientRect();
		const position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
		dragTargetRef.current = { targetId, position };
		// 指示线随悬停实时更新；仅位置变化时 setState，避免高频 re-render
		setDragIndicator((current) => (current?.targetId === targetId && current.position === position ? current : { targetId, position }));
	};

	const handleDrop = (event: React.DragEvent) => {
		event.preventDefault();
		const sourceId = dragSourceRef.current;
		const target = dragTargetRef.current;
		dragSourceRef.current = null;
		dragTargetRef.current = null;
		setDraggingId(null);
		setDragIndicator(null);
		props.onDragSessionChange?.(null);
		if (sourceId && target) {
			props.onReorder(sourceId, target.targetId, target.position);
		}
	};

	const handleDragEnd = () => {
		dragSourceRef.current = null;
		dragTargetRef.current = null;
		setDraggingId(null);
		setDragIndicator(null);
		props.onDragSessionChange?.(null);
	};

	// Tab 超宽时用贯穿滚动：垂直滚轮（无 shift）在 tab 条上改为横向滚动，
	// 否则 overflow-x-auto + [scrollbar-width:none] 下只用触控板横扭/shift+滚轮，
	// 普通鼠标滚轮无法浏览溢出 Tab。这里显式取纵/横向量较大者重定向到 scrollLeft。
	//
	// 2027-02 修正：React onWheel 挂在根容器上是 passive 监听，preventDefault
	// 实际无效（只打 "passive event listener" 告警，穿透语义与注释意图不符）。
	// 改为原生非 passive 监听（与 SurfaceComponents 的会话区滚轮同款写法）。
	// 边界读集中在写 scrollLeft 之前，避免同一次事件里读→写→读交错强制布局。
	const handleTabsWheel = useCallback((event: WheelEvent) => {
		const el = scrollRef.current;
		if (!el) return;
		// 仅在确有横向溢出时接管（未溢出时任何滚轮都无副作用）
		const scrollWidth = el.scrollWidth;
		const clientWidth = el.clientWidth;
		if (scrollWidth <= clientWidth) return;
		const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
		const prevScrollLeft = el.scrollLeft;
		el.scrollLeft = prevScrollLeft + delta;
		// 已滚到横向边界时才让事件穿透（垂直滚动仍留个边角用）；否则吞掉避免页面晃动
		if (event.deltaY && el.scrollLeft > 0 && el.scrollLeft < scrollWidth - clientWidth) {
			event.preventDefault();
		}
	}, []);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const handler = (event: WheelEvent) => handleTabsWheel(event);
		el.addEventListener("wheel", handler, { passive: false });
		return () => el.removeEventListener("wheel", handler);
	}, [handleTabsWheel]);

	// 下拉经 Portal 挂到 body；勿写 px-*（会盖掉自定义标题栏为窗口控件留的 padding-right）。
	// 抽屉开关始终在本栏最右侧；打开抽屉后靠 CSS 取消窗口控件让位，避免按钮被空出一截。
	// --session-tab-max-*：外观设置可调的 Tab 宽度上限，徽标 Tab 额外加 28px（见 shared/sessionTabWidth.ts）。
	return (
		<div
			className={cn(
				"session-tabs-bar flex h-10 shrink-0 items-center gap-1 overflow-x-clip border-b border-border/40 bg-bg-page pl-[max(0.5rem,var(--session-tabs-left-inset,0.5rem))]",
				// 简洁模式与会话栏同高（40px），去掉底边线靠底色差分区。
				// 左内距只在侧栏展开时固定 16px：侧栏收起后本栏顶到窗口左缘，mac 上必须
				// 让位系统红绿灯——留给 foundation.css 的 .list-collapsed 规则算
				// calc(红绿灯宽 + 8px)，这里写死会把它盖掉（utilities 层高于 legacy）。
				props.simple && cn("simple-session-header border-0 bg-transparent", !props.listCollapsed && "[--session-tabs-left-inset:16px]"),
			)}
			style={
				{
					"--session-tab-max-w": `${tabMaxWidth}px`,
					"--session-tab-max-w-badged": `${tabMaxWidth + SESSION_TAB_BADGE_EXTRA_WIDTH}px`,
				} as CSSProperties
			}
		>
			{/* 侧栏收起后的唯一恢复入口：简洁模式同样需要（该模式不再有独立的顶部导航行）。 */}
			{props.listCollapsed && props.onToggleListCollapsed ? (
				<Button type="button" variant="ghost" size="icon-sm" className="list-toggle-native size-7 shrink-0" aria-label={t("app.expandList")} title={t("app.expandList")} onClick={props.onToggleListCollapsed}>
					<PanelLeft className="size-3.5" aria-hidden="true" />
				</Button>
			) : null}
			<div className="relative flex min-w-0 flex-1 items-center">
				<div ref={scrollRef} className="session-tabs-scroll relative flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
					{(() => {
						// 分屏组：组内会话聚合渲染（组头胶囊 + 颜色标记）；收起时组内 Tab 隐藏
						const hasSplitGroup = tabBarEntries.some((entry) => entry.kind === "split");
						const groupCollapsed = hasSplitGroup && Boolean(props.splitGroupCollapsed);
						// 包装层只负责布局位移：关闭中间 Tab 后右侧 Tab 播 0.16s 收拢，而不是瞬移。
						// layoutDependency 用集合生成数（见 resolveTabLayoutGeneration）：状态徽章/标题刷新不触发重测。
						const renderTab = (sessionId: string) => (
							<motion.div key={sessionId} layout="position" layoutDependency={tabLayoutGeneration} transition={{ layout: { duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT } }} className="flex shrink-0">
								<SessionTab
									simple={props.simple}
									sessionId={sessionId}
									active={sessionId === currentSessionId}
									pinned={pinnedTabs.includes(sessionId)}
									preview={sessionId === previewTabId}
									dragging={draggingId === sessionId}
									// 指示线插在目标 Tab 的边缘：before=左缘，after=右缘
									indicator={dragIndicator && dragIndicator.targetId === sessionId ? dragIndicator.position : null}
									// 运行中反馈徽章只对当前会话有意义（作用于其绑定的 Agent 运行时），非当前 Tab 不显示；
									// 运行控制菜单项已上收右上角 ⋯ 菜单，Tab 只保留转动态展示
									isStopping={sessionId === currentSessionId ? props.runControl?.isStopping : undefined}
									isRestarting={sessionId === currentSessionId ? props.runControl?.isRestarting : undefined}
									isReloading={sessionId === currentSessionId ? props.runControl?.isReloading : undefined}
									onSelect={props.onSelect}
									onPromotePreview={props.onPromotePreview}
									onClose={props.onClose}
									onCloseOthers={props.onCloseOthers}
									onCloseAll={props.onCloseAll}
									onTogglePin={props.onTogglePin}
									// 右键菜单的「会话操作」组（重命名/复制/导出/路径/打开）：按本 Tab 的 sessionId 现取，
									// 后台 Tab 也能操作；工厂与 ⋯ 菜单 sessionActions 同源（App 同一装配）。
									sessionActions={props.contextSessionActions?.(sessionId)}
									// 运行控制组：按被右键 Tab 现算能力，后台 Tab 的停止/重启/重载也走这里。
									runControl={props.contextRunControl?.(sessionId)}
									onDragStart={(event) => {
										dragSourceRef.current = sessionId;
										dragTargetRef.current = null;
										setDraggingId(sessionId);
										props.onDragSessionChange?.(sessionId);
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData(SESSION_TAB_DRAG_MIME, sessionId);
										event.dataTransfer.setData("text/plain", sessionId);
									}}
									onDragOver={(event) => handleDragOver(event, sessionId)}
									onDrop={handleDrop}
									onDragEnd={handleDragEnd}
								/>
							</motion.div>
						);
						if (props.simple)
							return (
								<>
									{currentSessionId && renderTab(currentSessionId)}
									{/* 页面式工作区 Tab（定时任务 / 智能体）：简洁模式也保留入口与关闭按钮 */}
									{props.pageTabs?.map((tab) => (
										<WorkspacePageTab key={tab.id} tab={tab} />
									))}
									{currentSessionId && !hasSplitGroup && <SessionHeader mode="session" sessionId={currentSessionId} embedded headerRef={embeddedHeaderRef} runControl={props.runControl} menu={{ sessionActions: props.sessionActions, toolActions: props.toolActions, onOpenProxySetting: props.onOpenProxySetting }} />}
									{hasSplitGroup && (
										<Button variant="ghost" size="icon-sm" aria-label={t("session.splitGroup.exitAll")} title={t("session.splitGroup.exitAll")} onClick={props.onExitAllSplit}>
											<X className="size-3.5" />
										</Button>
									)}
								</>
							);
						// —— 顶层 Tab 节点：普通 Tab / 项目分组 / 分屏组胶囊。显示单元由共享纯函数
						// buildSessionTabBarEntries 给出（与 Ctrl+Tab 循环同源），这里只负责渲染节点 + 在单元边界插分隔线。
						// 分隔线策略：单元边界插线（进入/离开分组、分屏组之间），连续两个自由 Tab 之间不插；
						// 同一项目分组内相邻 Tab 不插线（保持组内连续），避免浏览器式分隔线把分组切散。
						// 强度：border-default（#dfdfdf）再打五折后与白底几乎无差（用户报「看不清」），
						// 必须用不透明的 border-strong（浅 #d7d7d7 / 暗 #3a3a3a），高度也从 h-4 提到 h-5。
						const nodes: ReactNode[] = [];
						const emitDivider = () => {
							if (nodes.length > 0) {
								nodes.push(<span key={`tab-sep:${nodes.length}`} className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true" />);
							}
						};
						// 分屏组节点：胶囊 +（展开时）组内全部 Tab；组内顺序 = 传入的 sessionIds（分屏 layout 视觉顺序）。
						const renderSplitGroup = (sessionIds: readonly string[]) => {
							const splitSet = new Set(sessionIds);
							const groupHasFocus = currentSessionId != null && splitSet.has(currentSessionId);
							const groupName = props.splitGroupName?.trim() || t("session.splitGroup.label");
							const groupColor = props.splitGroupColor || SPLIT_GROUP_COLOR_PALETTE[0].value;
							// role="group" 挂在外层容器（容纳胶囊 + 组内 Tab），按钮保持原生 button 语义；
							// aria-expanded/aria-controls 挂在按钮上；右键打开组管理菜单（Popover），
							// 左键点击仍是展开/收起（与浏览器标签组一致）
							return (
								<Popover open={splitGroupMenuOpen} onOpenChange={setSplitGroupMenuOpen} key={`split-group:${sessionIds[0]}`}>
									<PopoverAnchor asChild>
										<div role="group" aria-label={groupName} className="flex min-w-0 items-center gap-1">
											<GroupCapsuleButton
												color={groupColor}
												name={groupName}
												count={sessionIds.length}
												expanded={!groupCollapsed}
												focused={groupHasFocus}
												ariaLabel={groupCollapsed ? t("session.splitGroup.expand") : t("session.splitGroup.collapse")}
												ariaControls="session-split-group-tabs"
												onToggle={props.onToggleSplitGroup}
												onContextMenu={(event) => {
													// 右键：打开组管理菜单（重命名/颜色/取消分屏）
													event.preventDefault();
													setSplitGroupNameDraft(groupName);
													setSplitGroupMenuOpen(true);
												}}
											/>
											{!groupCollapsed && (
												<div id="session-split-group-tabs" className="flex min-w-0 items-center gap-1">
													{sessionIds.map((id) => renderTab(id))}
												</div>
											)}
										</div>
									</PopoverAnchor>
									{/* 组管理菜单：重命名 + 颜色选择 + 取消分屏（其余按钮不要） */}
									<PopoverContent align="start" sideOffset={6} className="w-64 p-3">
										<div className="flex flex-col gap-3">
											<input
												type="text"
												value={splitGroupNameDraft}
												placeholder={t("session.splitGroup.renamePlaceholder")}
												maxLength={24}
												aria-label={t("session.splitGroup.rename")}
												onChange={(event) => setSplitGroupNameDraft(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === "Enter") {
														event.currentTarget.blur();
													}
												}}
												onBlur={() => {
													const next = splitGroupNameDraft.trim();
													if (next && next !== (props.splitGroupName ?? "")) {
														props.onSplitGroupRename?.(next);
													}
												}}
												className="h-8 w-full rounded-md border border-border-strong bg-background px-2 text-caption text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent focus:ring-1 focus:ring-accent/40"
											/>
											{/* 颜色选择排（浏览器标签组同款：预设色板） */}
											<div className="flex items-center gap-2" role="radiogroup" aria-label={t("session.splitGroup.color")}>
												{SPLIT_GROUP_COLOR_PALETTE.map((c) => (
													<button
														key={c.name}
														type="button"
														role="radio"
														aria-checked={groupColor === c.value}
														aria-label={t(c.labelKey)}
														title={t(c.labelKey)}
														onClick={() => props.onSplitGroupColorChange?.(c.value)}
														className={cn("size-5 rounded-full transition-transform hover:scale-110", groupColor === c.value && "ring-2 ring-offset-2 ring-offset-popover")}
														style={{
															backgroundColor: c.value,
															...(groupColor === c.value ? { boxShadow: `0 0 0 1px ${c.value}` } : {}),
														}}
													/>
												))}
											</div>
											{/* 取消分屏：全部会话退出分屏布局 */}
											<button
												type="button"
												onClick={() => {
													setSplitGroupMenuOpen(false);
													props.onExitAllSplit?.();
												}}
												className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-caption text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
											>
												<CircleX className="size-3.5" aria-hidden="true" />
												{t("session.splitGroup.exitAll")}
											</button>
										</div>
									</PopoverContent>
								</Popover>
							);
						};
						// 显示单元 → 节点：单元边界插分隔线（连续两个自由 Tab 之间不插）。
						let previousGroupKey: string | null = null;
						for (const entry of tabBarEntries) {
							const entryGroupKey = entry.kind === "project" ? `project:${entry.projectId}` : entry.kind === "split" ? "split" : null;
							if (previousGroupKey !== null || entryGroupKey !== null) emitDivider();
							if (entry.kind === "split") nodes.push(renderSplitGroup(entry.sessionIds));
							else if (entry.kind === "project") {
								for (const sessionId of entry.sessionIds) nodes.push(renderTab(sessionId));
							} else nodes.push(renderTab(entry.sessionId));
							previousGroupKey = entryGroupKey;
						}
						return nodes;
					})()}
					{/* 浏览器式新建入口：跟在最后一张标签后面，下拉选择新建到哪个项目。
            （新建会话保留独立「+」按钮；⋯ 菜单只收运行控制与工具） */}
					{!props.simple && <NewSessionMenu targets={props.newSessionTargets} onSelect={props.onNewSessionInProject} onNewAcpSession={props.onNewAcpSession} />}
					{/* 页面式工作区 Tab（定时任务 / 智能体）：与会话 Tab 同栏并列，可关闭、不参与会话拖拽/固定 */}
					{!props.simple && props.pageTabs && props.pageTabs.length > 0 ? (
						<>
							<span className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true" />
							{props.pageTabs.flatMap((tab, index) => {
								const node = <WorkspacePageTab key={tab.id} tab={tab} />;
								if (index === 0) return [node];
								return [<span key={`page-tab-sep:${tab.id}`} className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true" />, node];
							})}
						</>
					) : null}
					{/* 页面式插件面板伪 Tab：始终选中态（它就是当前呈现的视图），与会话 Tab 之间加竖线分隔 */}
					{!props.simple && props.pluginTab ? (
						<>
							<span className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true" />
							<HostPluginTab tab={props.pluginTab} />
						</>
					) : null}
					{/* 文件/Diff 与会话共用本栏：同一套 session-tab 皮，不另开绿条栏 */}
					{props.editorTabs && props.editorTabs.length > 0 ? (
						<>
							<span className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true" />
							{props.editorTabs.flatMap((tab, index) => {
								const node = <EditorWorkbenchTab key={tab.id} tab={tab} onSelect={props.onSelectEditorTab} onClose={props.onCloseEditorTab} onPromotePreview={props.onPromoteEditorPreview} />;
								if (index === 0) return [node];
								return [<span key={`editor-tab-sep:${tab.id}`} className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" aria-hidden="true" />, node];
							})}
						</>
					) : null}
				</div>
				{/* 右缘渐变：溢出时提示「右侧还有 Tab」（纯装饰，不拦截鼠标）。
          放在滚动容器外层（absolute 子元素放 overflow-x-auto 容器内会随内容滚走）。 */}
				{tabsOverflow && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background/90 to-transparent" />}
			</div>
			{/* 抽屉开关：关闭态在会话 Tab 栏最右侧开启；打开后开关并入抽屉活动栏左端（
          贴抽屉左边界），本栏隐藏，否则同一动作在相邻两行各出现一颗按钮。
          运行控制 / 会话操作 / 工具开关已并入会话头部控制钮（SessionActionsControl），
          本栏只保留「+」新建会话与抽屉开关；Tab 级操作（固定/关闭等）在 Tab 右键菜单。 */}
			{props.onToggleDrawer || props.actions != null ? (
				<div className="session-tabs-actions flex shrink-0 items-center gap-1 border-l border-border/30 pl-1">
					{props.actions}
					{props.onToggleDrawer && !props.drawerOpen ? (
						<Button type="button" variant="ghost" size="icon-sm" className="header-drawer-toggle size-7" title={t("app.openDrawer")} aria-label={t("app.openDrawer")} onClick={props.onToggleDrawer}>
							<PanelRight className="size-3.5" aria-hidden="true" />
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * 工作台文件/Diff Tab：视觉复用 session-tab，不引入第二套绿条样式。
 * 与会话 Tab 正交：不参与会话拖拽/固定，只转发选中/关闭/预览晋升。
 */
function EditorWorkbenchTab(props: { tab: WorkbenchEditorTabItem; onSelect?: (tabId: string) => void; onClose?: (tabId: string) => void; onPromotePreview?: (tabId: string) => void }) {
	const { tab } = props;
	// 工作台 Tab 富提示：第一行 tab 标题，第二行完整路径（tab.title 由装配层传入 filePath）。
	// title 缺省时退化为单行，与旧原生 title 行为一致。
	return (
		<Tooltip delayDuration={500}>
			<TooltipTrigger asChild>
				<div
					role="tab"
					aria-selected={Boolean(tab.active)}
					aria-label={tab.title ?? tab.label}
					className={cn(
						// 显式标明 length 只设字号、不带行高（行高紧随其后用 leading-(--line-height-tab)）。
						"session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center rounded-md border px-2 text-[length:var(--font-size-tab)] leading-(--line-height-tab) transition-[color,background-color,border-color,box-shadow,transform] duration-base",
						// 工作台文件/Diff Tab 宽度上限跟随外观设置（--session-tab-max-w 由 SessionTabsBar 根注入），
						// 与会话 Tab 统一宽度来源，不再保留旧固定值。
						"w-fit max-w-(--session-tab-max-w)",
						// hover 底改用 accent-soft（主题淡背景 token，随 data-accent 切换）而非 accent/50：
						// 半透明的 accent/50 叠在 #ffffff 上 ≈ #eff1f3，浅色主题下几乎看不到底色、只有文字变色，
						// 鼠标掠过像“闪一下”（用户反馈「悬停太丑」）；opaque 的 accent-soft 底色稳定可辨且不随背景沾染。
						tab.active ? "border-transparent font-medium text-foreground" : "border-transparent text-muted-foreground hover:-translate-y-px hover:bg-accent-soft hover:text-foreground",
						tab.preview && "italic font-normal text-muted-foreground",
					)}
					onClick={() => props.onSelect?.(tab.id)}
					onDoubleClick={() => {
						if (tab.preview) props.onPromotePreview?.(tab.id);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							props.onSelect?.(tab.id);
						}
					}}
					tabIndex={0}
				>
					<span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5">
						<span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>{tab.label}</span>
						<button
							type="button"
							role="tab-close"
							aria-label={t("tabs.close")}
							title={t("tabs.close")}
							className={cn(TAB_CLOSE_BUTTON_CLASS, tab.active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70")}
							onClick={(event) => {
								event.stopPropagation();
								props.onClose?.(tab.id);
							}}
						>
							<X className="size-3" />
						</button>
					</span>
					{/* 灰色选中背景：只属于激活 Tab 自身，切换时瞬时出现（无滑动动画），
          替代旧的底部细条；内容包装层已 z-10 抬升到背景之上。
          背景色用 inline 变量（var(--color-bg-active)）而非 bg-accent 类，同 SessionTab 一致。 */}
					{tab.active && <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-md bg-accent" />}
				</div>
			</TooltipTrigger>
			{tab.title ? (
				<TooltipContent side="bottom" align="start" className="max-w-80">
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate font-medium">{tab.label}</span>
						{/* 第二行是文件路径：TooltipContent 是反色面（bg-foreground + text-background），
						    次行必须用 text-background 派生色。用 text-muted-foreground(#4b5563) 画在近黑底
						    上只有 ≈2.0:1，用户报过「路径黑色的看不清」。 */}
						<span className="truncate font-mono text-micro text-background/75">{tab.title}</span>
					</div>
				</TooltipContent>
			) : null}
		</Tooltip>
	);
}

/**
 * 页面式宿主插件面板伪 Tab：与 EditorWorkbenchTab 同一套 session-tab 皮。
 * 它在栏里始终是选中态（呈现的视图就是它），选中背景瞬时铺满（无滑动动画）。
 * 不可拖拽排序，唯一动作是关闭（即收起插件页）。
 */
function HostPluginTab(props: { tab: { title: string; icon?: React.ComponentType<{ className?: string }>; onClose: () => void } }) {
	const { tab } = props;
	const Icon = tab.icon;
	return (
		<div
			role="tab"
			aria-selected={true}
			aria-label={tab.title}
			className={cn(
				"session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center rounded-md border border-transparent px-2 font-medium text-foreground text-[length:var(--font-size-tab)] leading-(--line-height-tab) transition-[color,background-color,border-color,box-shadow,transform] duration-base",
				"w-fit max-w-(--session-tab-max-w)",
			)}
		>
			<span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5">
				{Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
				<span className="min-w-0 flex-1 truncate">{tab.title}</span>
				<button
					type="button"
					role="tab-close"
					aria-label={t("tabs.close")}
					title={t("tabs.close")}
					className={cn(TAB_CLOSE_BUTTON_CLASS, "opacity-70 hover:opacity-100")}
					onClick={(event) => {
						event.stopPropagation();
						tab.onClose();
					}}
				>
					<X className="size-3" />
				</button>
			</span>
			<span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-md bg-accent" />
		</div>
	);
}

/**
 * 页面式工作区 Tab（定时任务 / 智能体）：与会话 Tab 同一套 session-tab 皮。
 * 它不是会话：不拖拽、不固定、不参与分屏；点击激活页面，关闭按钮卸载页面。
 * 激活态与文件 Tab 同款（灰色实底只画在激活 Tab 自己身上，无滑动动画）。
 * 刻意不用 Tooltip：Tab 标题本身就是完整名称，避免与提示条契约（3 处悬停提示）纠缠。
 */
function WorkspacePageTab(props: { tab: WorkspacePageTabItem }) {
	const { tab } = props;
	const Icon = tab.icon;
	return (
		<div
			role="tab"
			aria-selected={Boolean(tab.active)}
			aria-label={tab.title}
			title={tab.title}
			data-workspace-page-tab={tab.id}
			tabIndex={0}
			className={cn(
				"session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center rounded-md border border-transparent px-2 text-[length:var(--font-size-tab)] leading-(--line-height-tab) transition-[color,background-color,border-color,box-shadow,transform] duration-base",
				"w-fit max-w-(--session-tab-max-w)",
				tab.active ? "font-medium text-foreground" : "text-muted-foreground hover:-translate-y-px hover:bg-accent-soft hover:text-foreground",
			)}
			onClick={tab.onSelect}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					tab.onSelect();
				}
			}}
		>
			<span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5">
				{Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
				<span className="min-w-0 flex-1 truncate">{tab.title}</span>
				<button
					type="button"
					role="tab-close"
					aria-label={t("tabs.close")}
					title={t("tabs.close")}
					className={cn("inline-grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground/70 transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground", tab.active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60")}
					onClick={(event) => {
						event.stopPropagation();
						tab.onClose();
					}}
				>
					<X className="size-3" />
				</button>
			</span>
			{tab.active && <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-md bg-accent" />}
		</div>
	);
}

/**
 * 分组组头胶囊（分屏组/项目分组共用）：浏览器标签组风格。
 *
 * 旧版「虚线边框 + 灰色底 + 裸数字」太粗糙；新版改为：
 * - 整块淡组色底（10%），focused 时加深（18%）+ 组色边框——颜色来自内联 CSS 变量，
 *   Tailwind 的 color-mix 类（bg-(--group-color)/xx）在运行时解析该变量，无需静态色值；
 * - 文字用组色与主文字色 color-mix（45%），保证亮黄等哈希色在明/暗主题下都可读；
 * - 计数改为小圆徽章（组色 25% 底）而非裸数字。
 */
function GroupCapsuleButton(props: {
	color: string;
	name: string;
	count: number;
	/** 展开态（组内 Tab 可见）；收起时 chevron 朝右 */
	expanded: boolean;
	/** 组内有当前会话：底色/边框加深，显示聚焦态 */
	focused: boolean;
	ariaLabel: string;
	ariaControls: string;
	/** 可选：分屏组场景下由 App 层传入；为空则按钮不可切换（无操作） */
	onToggle?: () => void;
	onContextMenu?: (event: React.MouseEvent) => void;
}) {
	const { color, name, count, expanded, focused } = props;
	return (
		<button
			type="button"
			aria-expanded={expanded}
			aria-controls={props.ariaControls}
			aria-label={props.ariaLabel}
			title={props.ariaLabel}
			onClick={props.onToggle}
			onContextMenu={props.onContextMenu}
			style={
				{
					"--group-color": color,
					// 组色文字：混入主文字色（45% 组色 + 55% 主文字色），明暗主题均可读
					"--group-color-text": `color-mix(in srgb, ${color} 45%, var(--color-text-primary))`,
				} as CSSProperties
			}
			className={cn(
				"flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 text-caption transition-colors",
				"border-solid border-transparent bg-(--group-color)/10 text-(--group-color-text)",
				"hover:bg-(--group-color)/18",
				focused && "border-(--group-color)/40 bg-(--group-color)/18 font-medium",
			)}
		>
			<span className="max-w-40 truncate whitespace-nowrap">{name}</span>
			{/* 计数徽章：小圆底（组色 25%）+ 组色文字，替代旧版“名字 + 裸数字” */}
			<span className="inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-(--group-color)/25 px-1 text-micro leading-none font-medium text-(--group-color-text)">{count}</span>
			{expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
		</button>
	);
}

function SessionTab(props: {
	simple?: boolean;
	sessionId: string;
	active: boolean;
	/** 固定 Tab：前置、窄宽度、无关闭按钮 */
	pinned: boolean;
	/** VS Code 预览：斜体，双击后常驻 */
	preview: boolean;
	dragging: boolean;
	/** 拖拽插入指示：before=左缘竖线，after=右缘竖线 */
	indicator?: "before" | "after" | null;
	/** 运行操作反馈（仅当前会话 Tab 传入）：Tab 徽章显示 停止中/重启中/重载中 转动。
	 *  运行控制同时出现在右上角 ⋯ 菜单与本 Tab 的右键菜单（后台 Tab 也可操作）。 */
	isStopping?: boolean;
	isRestarting?: boolean;
	isReloading?: boolean;
	onSelect: (sessionId: string) => void;
	onPromotePreview?: (sessionId: string) => void;
	onClose: (sessionId: string) => void;
	onCloseOthers: (sessionId: string) => void;
	onCloseAll: () => void;
	onTogglePin: (sessionId: string) => void;
	onDragStart: (event: React.DragEvent) => void;
	onDragOver: (event: React.DragEvent) => void;
	onDrop: (event: React.DragEvent) => void;
	onDragEnd: () => void;
	/** 右键菜单的「会话操作」组（App 按 sessionId 参数化装配）；undefined = 整组不渲染 */
	sessionActions?: SessionTabActions;
	/** 右键菜单的运行控制组（App 按 sessionId 现算能力）；undefined = 整组不渲染 */
	runControl?: SessionRunControlView;
}) {
	const { sessionId, active, pinned, preview, dragging } = props;
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	// Tab hover 富提示的工作区段：会话所属项目的目录名/完整路径。
	// 无记录（草稿/匿名）或项目已移除时省略，不显示空行。
	const tabProject = useAtomValue(projectByIdAtomFamily(record?.projectId ?? ""));
	const workspaceName = tabProject ? displayProjectDirectoryName(tabProject) : undefined;
	const status = runtime?.status;
	// 状态徽章语义与侧栏 SessionTree 状态点一致（idle=蓝、running/starting=黄、error=红）；
	// 重启/停止/重载进行中时统一显示 loading（旋转）；未启动（无 runtime）且无操作不显示徽章，
	// 避免把“未运行”误读成某种状态。
	const badge = sessionStatusBadge(status, {
		isRestarting: props.isRestarting,
		isStopping: props.isStopping,
		isReloading: props.isReloading,
	});
	const title = sessionDisplayName(record?.title, record?.forked) || t("common.untitled");
	// DSH/生图徽标与计划/目标模式 chip 都是不可压缩的固定宽度内容。
	// 上限收窄史：峰值 208/256 → 176/224（用户反馈「Tab 变长了」）→ 116/148（再收 1/3）
	// → 104/132px（视觉上再小一档）。固定开销约 54px（px-2 16 + 状态点 10 + 关闭按钮 16 +
	// 两处 gap-1.5 12），104px 下标题只剩约 50px ≈ 4-5 个汉字，已在可读性下限附近：
	// 若还嫌宽，应先改「状态点/关闭按钮只在激活或 hover 时占位」的取舍，而不是继续压宽度。
	// 截断细节由 hover 富提示（标题 + 工作区）与 TitleScrollText 滚动兜底。
	const hasLeadingBadges = Boolean(record?.backend === "dsh" || record?.backend === "imagegen" || record?.backend === "acp" || runtime?.state?.planModeActive || (runtime?.state?.goal && runtime.state.goal.phase !== "complete"));
	// Tab 级操作（固定/关闭等）改为右键菜单（ContextMenu，光标处弹出）；Tab 本体点击仍是切换，
	// 拖拽排序与中键关闭与菜单互不干扰（drag/auxclick 不触发 click）。
	// 运行控制（停止/重启/重新加载）只作用于当前会话，已上收右上角 ⋯ 更多操作菜单。

	const select = () => props.onSelect(sessionId);
	const close = () => props.onClose(sessionId);

	if (props.simple)
		return (
			// 简洁模式同样用富 hover 提示（标题 + 工作区），与默认标签模式的 Tab 行为一致；
			// 不再用原生 title：原生只能显示标题，且会与 TitleScrollText 的滚动提示叠成双气泡。
			<Tooltip delayDuration={500}>
				<TooltipTrigger asChild>
					<div className="simple-session-title flex min-w-0 flex-1 items-center gap-1.5 px-2 text-sm font-medium text-foreground" aria-label={workspaceName ? `${title} — ${workspaceName}` : title}>
						<SessionActivityIndicator status={status} sessionId={sessionId} busy={props.isRestarting || props.isStopping || props.isReloading} />
						{pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
						<TitleScrollText text={title} disabled className="truncate font-bold" />
						{record?.backend === "acp" ? (
							// ACP 会话用工具品牌图标（Claude/Codex/CodeBuddy…），与消息区作者标同源；
							// 通用「Agent CLI」文字徽标认不出具体 CLI（用户反馈 tab logo 不对）。
							<AcpBackendMark acpToolId={record.acpToolId} className="size-3.5 shrink-0" />
						) : (
							(record?.backend === "dsh" || record?.backend === "imagegen") && <SessionBackendBadge backend={record.backend} className="h-4 shrink-0" />
						)}
						{/* 模式标记与输入框底栏 chip 同源：短名 + 图标（清单/靶心），全名留在 title/aria-label。 */}
						{runtime?.state?.planModeActive && (
							<span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" title={t("app.composerModePlan")} aria-label={t("app.composerModePlan")}>
								<ListChecks className="size-3" aria-hidden="true" />
								{t("app.composerModePlanShort")}
							</span>
						)}
						{runtime?.state?.goal && runtime.state.goal.phase !== "complete" && (
							<span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" title={t("app.composerModeGoal")} aria-label={t("app.composerModeGoal")}>
								<Target className="size-3" aria-hidden="true" />
								{t("app.composerModeGoalShort")}
							</span>
						)}
					</div>
				</TooltipTrigger>
				<TooltipContent side="bottom" align="start" className="max-w-80">
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate font-medium">{title}</span>
						{workspaceName ? (
							<span className="truncate text-micro text-background/75" title={tabProject?.path}>
								{workspaceName}
								{tabProject?.path && tabProject.path !== workspaceName ? ` · ${tabProject.path}` : ""}
							</span>
						) : null}
					</div>
				</TooltipContent>
			</Tooltip>
		);

	return (
		/* 嵌套顺序契约：TooltipTrigger(asChild) > ContextMenuTrigger(asChild) > Tab div。
		   Radix asChild 只把 props 合并到「直接子元素」：中间隔 Root（ContextMenu.Root /
		   Tooltip.Provider 等非 DOM、非 Slot 组件）事件会被静默丢弃（2026-10-01 右键菜单
		   失效的根因）；但 Trigger 都是 Slot 合并透传组件——外层 Trigger 的 hover/focus
		   props 会随链路逐层合并到 div，两层 Trigger 可以叠。2026-10-02 重排时误删
		   TooltipTrigger（Tooltip.Root 失去 trigger）→ hover 富提示（标题+工作区）失效
		   （用户报「移入的效果没了」）；TooltipTrigger 必须保留在链上（单测/e2e 双契约）。 */
		<ContextMenu>
			<Tooltip delayDuration={500}>
				<TooltipTrigger asChild>
					<ContextMenuTrigger asChild>
						<div
							role="tab"
							aria-selected={active}
							data-session-id={sessionId}
							aria-label={workspaceName ? `${title} — ${workspaceName}` : title}
							draggable
							onDragStart={props.onDragStart}
							onDragOver={props.onDragOver}
							onDrop={props.onDrop}
							onDragEnd={props.onDragEnd}
							onClick={select}
							onDoubleClick={() => {
								if (preview) props.onPromotePreview?.(sessionId);
							}}
							onAuxClick={(event) => {
								// 中键关闭（固定 Tab 忽略，需先取消固定），与浏览器 Tab 行为一致
								if (event.button === 1 && !pinned) close();
							}}
							className={cn(
								// 与文件 Tab 一样标明字号类型，防 cn 将字号当颜色删掉；仍消费设置 token。
								"session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center rounded-md border px-2 text-[length:var(--font-size-tab)] leading-(--line-height-tab) transition-[color,background-color,border-color,box-shadow,transform] duration-base",
								// 固定 Tab 与普通 Tab 同宽策略（按内容收缩）：固定 Tab 无关闭按钮，
								// hover 不会因按钮出现而跳动，无需 w-20 占位；固定宽度反而让 Pin 图标挤占标题空间。
								// 有 DSH/生图徽标或模式 chip 时放宽上限：基础上限 + 徽标预留 28px
								// （SESSION_TAB_BADGE_EXTRA_WIDTH，旧 132/104 差值）。
								hasLeadingBadges ? "w-fit max-w-(--session-tab-max-w-badged)" : "w-fit max-w-(--session-tab-max-w)",
								dragging && "opacity-50",
								// 选中态：灰色柔和实底（bg-accent = --color-bg-active，与左侧 SessionTree 选中行一致），
								// 背景由下方 span 画在激活 Tab 自身，切换瞬时出现；不做黑色实底/阴影/底部条。
								// 文字用 text-foreground（灰底上直接可读，无需反色）。
								// hover 底用 accent-soft 实底而非 accent/50：半透明灰叠在白底上几乎不可见（同 EditorWorkbenchTab 注释）。
								active ? "border-transparent font-medium text-foreground" : "border-transparent text-muted-foreground hover:-translate-y-px hover:bg-accent-soft hover:text-foreground",
								preview && "italic font-normal text-muted-foreground",
							)}
						>
							{/* 内容包装：relative z-10 抬到灰色背景面板之上（背景面板是 absolute，按层序会在内容下）。 */}
							<span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5">
								{badge && (
									// beui AnimatedBadge bare 模式：去掉胶囊边框/背景，仅保留图标滚动/旋转动画；
									// 图标经 [&_svg] 稳定选择器缩到 10px；运行中通过 colorClass 覆盖成黄色旋转。
									<AnimatedBadge status={badge.status} size="sm" bare pulse={false} className={cn("[&_svg]:h-2.5 [&_svg]:w-2.5", badge.colorClass)} aria-hidden="true" />
								)}
								{pinned && <Pin className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
								{/* DSH/生图是文字标记，保留自然宽度；固定 size-4 会让文字溢出到右侧操作按钮区域。 */}
								{record?.backend === "acp" ? (
									// 同上：ACP 品牌图标；DSH/生图保留文字标记（自然宽度，固定 size-4 会溢出到右侧按钮区）。
									<AcpBackendMark acpToolId={record?.acpToolId} className="size-3.5 shrink-0" />
								) : (
									(record?.backend === "dsh" || record?.backend === "imagegen") && <SessionBackendBadge backend={record?.backend} className="h-4 shrink-0" />
								)}
								{/* 外部连接渠道（微信/飞书）：tab 上带渠道标志，与侧栏同一套徽标 */}
								{record?.channel && <SessionChannelMark channel={record.channel} className="size-3.5 shrink-0" />}
								{record?.sideTask && <SideTaskMark className="size-3.5 shrink-0" />}
								{/* G12：DSH plan 模式 / danger 权限预设全局可见（数据来自 runtime state，tab 级常显）。
								    文案与图标和输入框底栏 chip 统一：短名（计划/目标）+ 模式图标，全名留在 title/aria-label；
								    Tab 很窄，旧全名「计划模式」会把标题再挤掉两个字。 */}
								{runtime?.state?.planModeActive && (
									<span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1 text-micro font-medium leading-4 text-primary" title={t("app.composerModePlan")} aria-label={t("app.composerModePlan")}>
										<ListChecks className="size-2.5" aria-hidden="true" />
										{t("app.composerModePlanShort")}
									</span>
								)}
								{runtime?.state?.goal && runtime.state.goal.phase !== "complete" && (
									<span
										// 底色与 plan chip 同用 bg-primary/15：不能用 bg-accent/15——激活 tab 的
										// 滑动背景就是实底 bg-accent，accent/15 叠上去完全不可见，chip 会退化成裸文字
										//（浅色主题下尤其明显）。淡蓝底在明暗主题的激活/非激活 tab 上均可读。
										className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1 text-micro font-medium leading-4 text-primary"
										title={t("app.composerModeGoal")}
										aria-label={t("app.composerModeGoal")}
									>
										<Target className="size-2.5" aria-hidden="true" />
										{t("app.composerModeGoalShort")}
									</span>
								)}
								{/* 标题复用侧栏 TitleScrollText：溢出时 hover 滚动到尾、离开回开头（与左侧会话列表一致）。
            strong 是块级元素（flex-1 占满剩余空间），需显式覆盖字重：非激活 400、激活 500，
            否则 strong 的 UA 默认 bold(700) 会让所有 tab 标题变粗。truncate 补省略号
            （组件自带 overflow-hidden 只截断不省略，侧栏靠 legacy .conversation-title strong 补）。
            收敛触发（tab 是高频交互区，侧栏默认行为不适合）：
            - disabled={active}：激活 tab 不滚动——内容已在右侧看全，且切换 tab 时鼠标恰好落在
              新激活 tab 上，立即滚动体验很吵（原生 title 提示兜底）；
            - hoverDelayMs=500：快速扫过 tab 栏不触发，停留半秒才滚。 */}
								<TitleScrollText text={title} disabled={active} hoverDelayMs={500} className={cn("truncate", active ? "font-medium" : "font-normal", preview && "italic")} />
								{!pinned && (
									<button
										type="button"
										role="tab-close"
										aria-label={t("tabs.close")}
										title={t("tabs.close")}
										className={cn(TAB_CLOSE_BUTTON_CLASS, active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70")}
										onClick={(event) => {
											event.stopPropagation();
											close();
										}}
									>
										<X className="size-3" />
									</button>
								)}
							</span>
							{/* 拖拽插入指示线：2px 主题色竖线，贴在目标 Tab 左/右缘 */}
							{props.indicator && <span aria-hidden="true" className={cn("pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-primary", props.indicator === "before" ? "-left-0.5" : "-right-0.5")} />}
							{/* 灰色选中背景：只属于激活 Tab 自身，切换时瞬时出现；拖拽插入线（props.indicator）
            是竖线且仅拖拽期存在，二者位置不重叠。旧实现用全栏共享 layoutId 把底色从旧 Tab 滑到新 Tab，
            用户明确不要这个移动动画，已改为普通 span（不做浮起/阴影/底部条）。
            背景色用 inline 变量（var(--color-bg-active)）而非 bg-accent 类：类依赖 Tailwind
            扫描生成，曾出现在部分环境下类未输出导致「激活 Tab 无背景」的回归。inline 变量
            随主题实时切换，与 SessionTree 选中态同色。 */}
							{active && <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-md bg-accent" />}
						</div>
					</ContextMenuTrigger>
				</TooltipTrigger>
				{/* 富 hover 提示替代原生 title：第一行会话标题，第二行工作区（项目目录名 + 完整路径）。
			    无工作区（草稿/项目缺失）时退化为单行标题，行为与旧 title 一致。
			    delayDuration=500 与 TitleScrollText 的 hoverDelayMs 同拍：快速扫过不弹。 */}
				<TooltipContent side="bottom" align="start" className="max-w-80">
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate font-medium">{title}</span>
						{/* 第二行是「工作区 · 目录」：反色面（浅色近黑底 / 暗色近白底）上不能用页面次要文字色
					    text-muted-foreground，否则浅色 #4b5563 on #202124 ≈ 2.0:1、暗色 #b8b8b2 on #ecece7
					    ≈ 1.6:1 都看不清（用户反馈「目录、路径黑色的看不清」）；改用同族降透明度保留层级。 */}
						{workspaceName ? (
							<span className="truncate text-micro text-background/75" title={tabProject?.path}>
								{workspaceName}
								{tabProject?.path && tabProject.path !== workspaceName ? ` · ${tabProject.path}` : ""}
							</span>
						) : null}
					</div>
				</TooltipContent>
			</Tooltip>
			<ContextMenuContent className="min-w-40">
				{/* 运行控制（停止/重启/热重载/磁盘重载）：放在 Tab 级操作之前，右键就能直接操作 */}
				{props.runControl ? (
					<>
						<RunControlContextItems control={props.runControl} />
						<ContextMenuSeparator />
					</>
				) : null}
				{/* 固定/关闭等 Tab 级操作 */}
				<ContextMenuItem onSelect={() => props.onTogglePin(sessionId)}>
					<span className="inline-flex items-center gap-2">
						{pinned ? <PinOff className="size-3.5" aria-hidden="true" /> : <Pin className="size-3.5" aria-hidden="true" />}
						{pinned ? t("tabs.unpin") : t("tabs.pin")}
					</span>
				</ContextMenuItem>
				{!pinned && (
					<ContextMenuItem onSelect={close}>
						<span className="inline-flex items-center gap-2">
							<X className="size-3.5" aria-hidden="true" />
							{t("tabs.close")}
						</span>
					</ContextMenuItem>
				)}
				<ContextMenuSeparator />
				{/* 批量关闭属于危险操作，采用 destructive 危险变体以红色警示 */}
				<ContextMenuItem variant="destructive" onSelect={() => props.onCloseOthers(sessionId)}>
					<span className="inline-flex items-center gap-2">
						<CircleX className="size-3.5" aria-hidden="true" />
						{t("tabs.closeOthers")}
					</span>
				</ContextMenuItem>
				<ContextMenuItem variant="destructive" onSelect={props.onCloseAll}>
					<span className="inline-flex items-center gap-2">
						<X className="size-3.5" aria-hidden="true" />
						{t("tabs.closeAll")}
					</span>
				</ContextMenuItem>
				{/* 会话操作组：与右上角 ⋯ 菜单「当前会话操作」同一工厂装配，作用目标是被右键的 Tab；
				    能力闸门（草稿/DSH/无文件路径）在装配层算好，这里只按 flags 与回调存在性出项。 */}
				{props.sessionActions && (
					<>
						<ContextMenuSeparator />
						{/* 侧边任务入口与 ⋯ 菜单同源：作用目标是被右键 Tab 的会话（装配层按 sessionId 算好）。 */}
						{props.sessionActions.onCreateSideTask && (
							<ContextMenuItem onSelect={props.sessionActions.onCreateSideTask}>
								<span className="inline-flex items-center gap-2">
									<PanelRight className="size-3.5" aria-hidden="true" />
									{t("menu.createSideTask")}
								</span>
							</ContextMenuItem>
						)}
						{props.sessionActions.onRename && (
							<ContextMenuItem onSelect={props.sessionActions.onRename}>
								<span className="inline-flex items-center gap-2">
									<Pencil className="size-3.5" aria-hidden="true" />
									{t("common.rename")}
								</span>
							</ContextMenuItem>
						)}
						{props.sessionActions.canCopySession && (
							<ContextMenuItem onSelect={props.sessionActions.onCopySession}>
								<span className="inline-flex items-center gap-2">
									<Copy className="size-3.5" aria-hidden="true" />
									{t("menu.copySession")}
								</span>
							</ContextMenuItem>
						)}
						{props.sessionActions.canExportHtml && props.sessionActions.onExportSessionHtml && (
							<ContextMenuItem onSelect={props.sessionActions.onExportSessionHtml}>
								<span className="inline-flex items-center gap-2">
									<FileDown className="size-3.5" aria-hidden="true" />
									{t("menu.exportHtml")}
								</span>
							</ContextMenuItem>
						)}
						{props.sessionActions.hasFilePath && (
							<>
								<ContextMenuItem onSelect={props.sessionActions.onCopySessionFilePath}>
									<span className="inline-flex items-center gap-2">
										<Link2 className="size-3.5" aria-hidden="true" />
										{t("menu.copySessionFilePath")}
									</span>
								</ContextMenuItem>
								{props.sessionActions.onOpenSessionFile && (
									<ContextMenuItem onSelect={props.sessionActions.onOpenSessionFile}>
										<span className="inline-flex items-center gap-2">
											<FileText className="size-3.5" aria-hidden="true" />
											{t("menu.openSessionFile")}
										</span>
									</ContextMenuItem>
								)}
							</>
						)}
					</>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * 新建会话入口（浏览器式 “+”）：固定在标签带末端，下拉选择新建目标。
 * 聊天对话区置顶，之后是已打开的工作区项目；目标列表由 App 装配好传入，
 * 这里只做展示与选择回调，不接触项目库存。
 * （2026-08 收敛调整：仅 Tab 上的小箭头下拉被移除，运行控制上收 ⋯ 菜单；
 *   「+」新建是高频入口，保留独立按钮。）
 */
function NewSessionMenu(props: { targets: readonly NewSessionTarget[]; onSelect: (projectId: string) => void; onNewAcpSession?: (projectId: string, toolId: string) => void }) {
	const chatTargets = props.targets.filter((target) => target.isChat);
	const projectTargets = props.targets.filter((target) => !target.isChat);
	// ACP 入口是 opt-in：仅开关开启且登记了工具时出现；工具→项目二级选择，
	// 只列真实项目（chat 区不是文件项目，作为 ACP 工作目录无意义）。
	const acpEnabled = useAtomValue(acpEnabledAtom);
	const acpTools = useAtomValue(acpToolsAtom);
	const acpVisible = Boolean(props.onNewAcpSession) && acpEnabled && acpTools.length > 0 && projectTargets.length > 0;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="ghost" size="icon-sm" className="session-tabs-new ml-0.5 inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" title={t("tabs.new")} aria-label={t("tabs.new")}>
					<Plus className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="bottom" className="min-w-44">
				{chatTargets.map((target) => (
					<DropdownMenuItem key={target.projectId} onSelect={() => props.onSelect(target.projectId)}>
						<span className="inline-flex items-center gap-2">
							<MessagesSquare className="size-3.5 text-muted-foreground" aria-hidden="true" />
							{target.label}
						</span>
					</DropdownMenuItem>
				))}
				{chatTargets.length > 0 && projectTargets.length > 0 && <DropdownMenuSeparator />}
				{projectTargets.map((target) => (
					<DropdownMenuItem key={target.projectId} onSelect={() => props.onSelect(target.projectId)}>
						<span className="inline-flex min-w-0 items-center gap-2">
							<Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="truncate">{target.label}</span>
						</span>
					</DropdownMenuItem>
				))}
				{acpVisible ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("app.newAcpSession")}</DropdownMenuLabel>
						{acpTools.map((tool) => (
							<DropdownMenuSub key={tool.id}>
								<DropdownMenuSubTrigger className="gap-2">
									<Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
									<span className="truncate">{tool.name}</span>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									{projectTargets.map((target) => (
										<DropdownMenuItem key={target.projectId} onSelect={() => props.onNewAcpSession?.(target.projectId, tool.id)}>
											<span className="inline-flex min-w-0 items-center gap-2">
												<Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
												<span className="truncate">{target.label}</span>
											</span>
										</DropdownMenuItem>
									))}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						))}
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Tab 右键菜单的运行控制组：与 ⋯ 菜单同一套策略结论，只是渲染成 ContextMenuItem。
 * 作用目标是被右键的 Tab（后台 Tab 也能直接停止/重启/热重载）。
 */
function RunControlContextItems(props: { control: SessionRunControlView }) {
	const { control } = props;
	const capabilities = control.capabilities;
	const startOrRestartDisabled = !canRunSessionAction(capabilities, "start") || Boolean(control.isRestarting);
	const abortDisabled = !canRunSessionAction(capabilities, "abort");
	const reloadMode = control.reloadMode ?? "none";
	const reloadEntryDisabled = !canRunSessionAction(capabilities, "reloadResources") || Boolean(control.isReloading);
	const reloadDisabled = !canRunSessionAction(capabilities, "reload") || Boolean(control.isReloading);
	const primaryLabel = control.isRestarting ? t("app.restarting") : capabilities.primaryAction === "start" ? t("tabs.startAgent") : t("app.restart");

	return (
		<>
			<ContextMenuItem disabled={startOrRestartDisabled} style={startOrRestartDisabled ? { opacity: 0.4 } : undefined} onSelect={() => control.onAction(capabilities.primaryAction)}>
				<span className="inline-flex items-center gap-2">
					{capabilities.primaryAction === "start" ? <Play className={cn("size-3.5", control.isRestarting && "animate-pulse")} aria-hidden="true" /> : <RotateCw className={cn("size-3.5", control.isRestarting && "animate-pideck-spin")} aria-hidden="true" />}
					{primaryLabel}
				</span>
			</ContextMenuItem>
			<ContextMenuItem disabled={abortDisabled} style={abortDisabled ? { opacity: 0.4 } : undefined} title={t("tabs.stopAnswerHint")} onSelect={() => control.onAction("abort")}>
				<span className="inline-flex items-center gap-2">
					<CircleStop className="size-3.5" aria-hidden="true" />
					{t("menu.stopAnswer")}
				</span>
			</ContextMenuItem>
			{reloadMode === "resources" ? (
				<ContextMenuItem disabled={reloadEntryDisabled} style={reloadEntryDisabled ? { opacity: 0.4 } : undefined} title={t("menu.reloadResourcesHint")} onSelect={() => control.onAction("reloadResources")}>
					<span className="inline-flex items-center gap-2">
						<RefreshCcw className={cn("size-3.5", control.isReloading && "animate-pideck-spin")} aria-hidden="true" />
						{control.isReloading ? t("app.reloading") : t("menu.reloadResources")}
					</span>
				</ContextMenuItem>
			) : null}
			<ContextMenuItem disabled={reloadDisabled} style={reloadDisabled ? { opacity: 0.4 } : undefined} title={t("menu.reloadMessagesHint")} onSelect={() => control.onAction("reload")}>
				<span className="inline-flex items-center gap-2">
					<ListRestart className={cn("size-3.5", control.isReloading && "animate-pulse")} aria-hidden="true" />
					{control.isReloading ? t("app.reloading") : t("menu.reloadMessages")}
				</span>
			</ContextMenuItem>
		</>
	);
}
