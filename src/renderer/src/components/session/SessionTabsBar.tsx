import { useAtomValue } from "jotai";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  CircleX,
  Folder,
  MessagesSquare,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { motion, useReducedMotion, type Transition } from "motion/react";
import {
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionRecordsAtom,
  projectInventoryByIdAtom,
} from "../../atoms";
import { t } from "../../i18n";
import { AnimatedBadge } from "../motion/animated-badge";
import { sessionStatusBadge } from "../../utils/sessionStatusBadge";
import { sessionDisplayName } from "../../utils/sessionDisplayName";
import { Button } from "../ui-shadcn/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui-shadcn/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "../ui-shadcn/popover";
import { cn } from "../../lib/utils";
import { SessionBackendBadge } from "./SessionSourceBadge";
import { TitleScrollText } from "../sidebar/TitleScrollText";

import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";
import { buildProjectTabGroups, type ProjectTabGroup } from "../../utils/sessionTabGroups";

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
 * beui Tabs（motion）同款 spring：活动 Tab 指示条切换时带轻微过冲，
 * 落地有生命感而不是硬切；数值与 beui.dev 官方 registry 保持一致。
 */
const TAB_INDICATOR_SPRING: Transition = {
  type: "spring",
  stiffness: 170,
  damping: 24,
  mass: 1.2,
};
/** 用户开启「减少动态效果」时禁用指示条滑动（瞬时切换，不动画）。 */
const TAB_INDICATOR_INSTANT: Transition = { duration: 0 };

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
 *   同一套语义），由共享 layoutId 的 motion.span 滑动呈现；不做浮起/阴影/底部横条
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
  tabs: readonly string[];
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
  onSelectEditorTab?: (tabId: string) => void;
  onCloseEditorTab?: (tabId: string) => void;
  onPromoteEditorPreview?: (tabId: string) => void;
  /** 当前会话的停止 Agent 能力（停掉绑定的 pi/DSH 进程，保留会话与 Tab）：只对当前会话 Tab 生效。 */
  canStopCurrent?: boolean;
  isStoppingCurrent?: boolean;
  onStopCurrent?: () => void;
  /** 当前会话的重启能力：只对当前会话 Tab 生效。 */
  canRestartCurrent?: boolean;
  isRestartingCurrent?: boolean;
  onRestartCurrent?: () => void;
  /** 当前会话的重新加载能力（无 live 运行时）：从磁盘刷新消息文件，只对当前会话 Tab 生效。 */
  canReloadCurrent?: boolean;
  isReloadingCurrent?: boolean;
  onReloadCurrent?: () => void;
};

export function SessionTabsBar(props: SessionTabsBarProps) {
  const { tabs, pinnedTabs, currentSessionId, previewTabId } = props;
  const tabItems = useMemo(() => tabs.map((sessionId) => ({ sessionId })), [tabs]);
  const dragSourceRef = useRef<string | null>(null);
  const dragTargetRef = useRef<{ targetId: string; position: "before" | "after" } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // 拖拽插入指示：当前悬停的目标 Tab 与插入侧（before=左缘 / after=右缘）
  const [dragIndicator, setDragIndicator] = useState<{ targetId: string; position: "before" | "after" } | null>(null);
  // 分屏组管理菜单（右键胶囊打开）：重命名草稿
  const [splitGroupMenuOpen, setSplitGroupMenuOpen] = useState(false);
  const [splitGroupNameDraft, setSplitGroupNameDraft] = useState("");

  // —— 活动 Tab 指示器（beui Tabs 同款）——
  // 所有 Tab（会话/文件）共用同一个 layoutId：active 变化时指示条 spring 滑到新位置，
  // 而不是每个 Tab 自己画一条硬切底条。layoutRoot 使投影作用域限定在本栏内，
  // 滚动容器里的偏移不会被重放成位移（见 beui tabs.tsx 同款注释）。
  const activeIndicatorId = useId();
  const reduceMotion = useReducedMotion();
  const indicatorTransition = reduceMotion ? TAB_INDICATOR_INSTANT : TAB_INDICATOR_SPRING;

  // —— 按项目分组（始终生效，不再受开关控制）——
  // 分组排序是会话 Tab 的固有行为：新会话归入其所属项目组的尾部（buildProjectTabGroups
  // 按 tabs 原序归组，天然保证“新开会话加到自己项目组尾”）；组在视觉上只以 `|` 边界体现，
  // 不渲染胶囊/颜色/折叠。2026-09 收敛：旧“浏览器标签组胶囊 + 开关”已废弃，分组成为默认。
  const sessionRecords = useAtomValue(sessionRecordsAtom);
  const projectsById = useAtomValue(projectInventoryByIdAtom);

  // 项目分组视图：始终构建（分组排序是固有行为）。分屏组内的 Tab 不参与项目分组（保持分屏语义），
  // 从输入中剔除后再聚合；组顺序 = 组内首个 Tab 在 tabs 中的出现顺序。
  const projectView = useMemo(() => {
    const splitSet = new Set(props.splitGroupIds ?? []);
    const groupedTabs = tabs.filter((id) => !splitSet.has(id));
    return buildProjectTabGroups(groupedTabs, pinnedTabs, (sessionId) => {
      const record = sessionRecords[sessionId];
      const projectId = record?.projectId;
      if (!projectId) return undefined;
      return { projectId, name: projectsById[projectId]?.name };
    });
  }, [props.splitGroupIds, tabs, pinnedTabs, sessionRecords, projectsById]);
  // sessionId → 所属项目组（循环里判断落在哪个组，按“组”为单位渲染用）。
  const projectGroupBySession = useMemo(() => {
    const map = new Map<string, ProjectTabGroup>();
    for (const group of projectView.groups) {
      for (const id of group.sessionIds) map.set(id, group);
    }
    return map;
  }, [projectView]);

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
  }, [
    props.tabs,
    props.pinnedTabs,
    props.splitGroupIds,
    props.splitGroupCollapsed,
    props.editorTabs,
  ]);

  /** onDragOver 期间按鼠标位置相对目标 Tab 中点决定插入前后 */
  const handleDragOver = (event: React.DragEvent, targetId: string) => {
    if (!dragSourceRef.current || dragSourceRef.current === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    dragTargetRef.current = { targetId, position };
    // 指示线随悬停实时更新；仅位置变化时 setState，避免高频 re-render
    setDragIndicator((current) =>
      current?.targetId === targetId && current.position === position ? current : { targetId, position },
    );
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
  const handleTabsWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    // 仅在确有横向溢出时接管（未溢出时任何滚轮都无副作用）
    if (el.scrollWidth <= el.clientWidth) return;
    const delta =
      Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    el.scrollLeft += delta;
    // 已滚到横向边界时才让事件穿透（垂直滚动仍留个边角用）；否则吞掉避免页面晃动
    if (event.deltaY && el.scrollLeft > 0 && el.scrollLeft < el.scrollWidth - el.clientWidth) {
      event.preventDefault();
    }
  };

  // 下拉经 Portal 挂到 body；勿写 px-*（会盖掉自定义标题栏为窗口控件留的 padding-right）。
  // 抽屉开关始终在本栏最右侧；打开抽屉后靠 CSS 取消窗口控件让位，避免按钮被空出一截。
  return (
    <div className="session-tabs-bar flex h-10 shrink-0 items-center gap-1 overflow-x-clip border-b border-border/40 bg-background/80 pl-[max(0.5rem,var(--session-tabs-left-inset,0.5rem))]">
      {props.listCollapsed && props.onToggleListCollapsed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="list-toggle-native size-7 shrink-0"
          aria-label={t("app.expandList")}
          title={t("app.expandList")}
          onClick={props.onToggleListCollapsed}
        >
          <PanelLeft className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
      <div className="relative flex min-w-0 flex-1 items-center">
      <motion.div
        ref={scrollRef}
        layoutRoot
        onWheel={handleTabsWheel}
        className="session-tabs-scroll relative flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        {(() => {
          // 分屏组：组内会话聚合渲染（组头胶囊 + 颜色标记）；收起时组内 Tab 隐藏
          const splitGroupIds = props.splitGroupIds ?? [];
          const splitGroupSet = new Set(splitGroupIds);
          const hasSplitGroup = splitGroupIds.length > 1;
          const groupCollapsed = hasSplitGroup && Boolean(props.splitGroupCollapsed);
          const renderTab = (sessionId: string) => (
            <SessionTab
              key={sessionId}
              sessionId={sessionId}
              active={sessionId === currentSessionId}
              pinned={pinnedTabs.includes(sessionId)}
              preview={sessionId === previewTabId}
              dragging={draggingId === sessionId}
              // 指示线插在目标 Tab 的边缘：before=左缘，after=右缘
              indicator={
                dragIndicator && dragIndicator.targetId === sessionId
                  ? dragIndicator.position
                  : null
              }
              // 运行中反馈徽章只对当前会话有意义（作用于其绑定的 Agent 运行时），非当前 Tab 不显示；
              // 运行控制菜单项已上收右上角 ⋯ 菜单，Tab 只保留转动态展示
              isStopping={sessionId === currentSessionId ? props.isStoppingCurrent : undefined}
              isRestarting={
                sessionId === currentSessionId ? props.isRestartingCurrent : undefined
              }
              isReloading={sessionId === currentSessionId ? props.isReloadingCurrent : undefined}
              indicatorId={activeIndicatorId}
              indicatorTransition={indicatorTransition}
              onSelect={props.onSelect}
              onPromotePreview={props.onPromotePreview}
              onClose={props.onClose}
              onCloseOthers={props.onCloseOthers}
              onCloseAll={props.onCloseAll}
              onTogglePin={props.onTogglePin}
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
          );
          // —— 收集顶层 Tab 节点：普通会话 Tab；分屏组「胶囊 + 组内 Tab」整体算一个节点。
          // 分隔线策略改为显式 emitDivider：默认只在「进入新组 / 离开分组 / 普通 Tab 之间」插淡坚线，
          // 同一项目分组内相邻 Tab 不插线（保持组内连续），避免浏览器式分隔线把分组切散。
          const nodes: ReactNode[] = [];
          const emitDivider = () => {
            if (nodes.length > 0) {
              nodes.push(
                <span
                  key={`tab-sep:${nodes.length}`}
                  className="mx-0.5 h-4 w-px shrink-0 bg-border/50"
                  aria-hidden="true"
                />,
              );
            }
          };
          // groupKey 记录当前节点是否处于某项目分组内；null 表示自由/分屏，切换回组时均需分隔线。
          let currentGroupKey: string | null = null;
          // seen 用于“整组重排”：项目组在首个未消费成员处整块输出（组内所有 Tab 一并 emit 并标记
          // seen），保证同一项目的会话永远连续聚合，不因打开顺序被打散；loose/分屏亦标记。
          const seen = new Set<string>();
          const emitNode = (node: ReactNode, groupKey?: string) => {
            nodes.push(node);
            currentGroupKey = groupKey ?? null;
          };
          tabItems.forEach(({ sessionId }) => {
            if (seen.has(sessionId)) return;
            // 1) 分屏组：整组作为一个单元输出（组内 Tab 不参与项目分组）
            if (hasSplitGroup && splitGroupSet.has(sessionId)) {
              // 组内会话：只在组内第一个位置渲染「组头胶囊 +（展开时）组内全部 Tab」
              if (sessionId !== splitGroupIds[0]) return;
            const groupHasFocus =
              currentSessionId != null && splitGroupSet.has(currentSessionId);
            const groupName =
              props.splitGroupName?.trim() || t("session.splitGroup.label");
            const groupColor =
              props.splitGroupColor || SPLIT_GROUP_COLOR_PALETTE[0].value;
            // role="group" 挂在外层容器（容纳胶囊 + 组内 Tab），按钮保持原生 button 语义；
            // aria-expanded/aria-controls 挂在按钮上；右键打开组管理菜单（Popover），
            // 左键点击仍是展开/收起（与浏览器标签组一致）
            const groupNode = (
              <Popover
                open={splitGroupMenuOpen}
                onOpenChange={setSplitGroupMenuOpen}
                key={`split-group:${sessionId}`}
              >
                <PopoverAnchor asChild>
                  <div
                    role="group"
                    aria-label={groupName}
                    className="flex min-w-0 items-center gap-1"
                  >
                    <GroupCapsuleButton
                      color={groupColor}
                      name={groupName}
                      count={splitGroupIds.length}
                      expanded={!groupCollapsed}
                      focused={groupHasFocus}
                      ariaLabel={
                        groupCollapsed
                          ? t("session.splitGroup.expand")
                          : t("session.splitGroup.collapse")
                      }
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
                      <div
                        id="session-split-group-tabs"
                        className="flex min-w-0 items-center gap-1"
                      >
                        {splitGroupIds.map((id) => renderTab(id))}
                      </div>
                    )}
                  </div>
                </PopoverAnchor>
                {/* 组管理菜单：重命名 + 颜色选择 + 取消分屏（其余按钮不要） */}
                <PopoverContent
                  align="start"
                  sideOffset={6}
                  className="w-64 p-3"
                >
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
                    <div
                      className="flex items-center gap-2"
                      role="radiogroup"
                      aria-label={t("session.splitGroup.color")}
                    >
                      {SPLIT_GROUP_COLOR_PALETTE.map((c) => (
                        <button
                          key={c.name}
                          type="button"
                          role="radio"
                          aria-checked={groupColor === c.value}
                          aria-label={t(c.labelKey)}
                          title={t(c.labelKey)}
                          onClick={() => props.onSplitGroupColorChange?.(c.value)}
                          className={cn(
                            "size-5 rounded-full transition-transform hover:scale-110",
                            groupColor === c.value &&
                              "ring-2 ring-offset-2 ring-offset-popover",
                          )}
                          style={{
                            backgroundColor: c.value,
                            ...(groupColor === c.value
                              ? { boxShadow: `0 0 0 1px ${c.value}` }
                              : {}),
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
            // 分屏组作为独立单元：进组前插分隔线；组内不再插线（组颜色胶囊已表达归属）。
            // groupKey 用固定 "split" 参与边界判定：与前后普通 Tab/项目组都自动插 |。
            // 整组仅输出一次：首个成员处输出并标记整组 seen（其余成员在顶部 seen 拦截）。
            for (const sid of splitGroupIds) seen.add(sid);
            emitDivider();
            emitNode(groupNode, "split");
            return;
            }
            // 2) 项目分组（始终生效）：同一项目的会话在这里整组输出——在首个未消费成员处
            //    把整组 sessionIds 逐个 emit 并标记 seen，从而把“后打开的会话”归回其项目组尾，
            //    而不是追加到全局末尾。组间用 currentGroupKey 判界插 |，组内相邻不插。
            const projectGroup = projectGroupBySession.get(sessionId);
            if (projectGroup) {
              const groupKey = "project:" + projectGroup.projectId;
              if (currentGroupKey !== groupKey) emitDivider();
              for (const sid of projectGroup.sessionIds) {
                if (seen.has(sid)) continue;
                emitNode(renderTab(sid), groupKey);
                seen.add(sid);
              }
              return;
            }
            // 3) 普通 Tab（无项目归属 / 固定 Tab / 分组外）：平铺。
            //    只在与“上一个节点不属于同一组”时插 | 分隔（相邻两个普通 Tab 不插线）。
            if (currentGroupKey !== null) emitDivider();
            emitNode(renderTab(sessionId));
            seen.add(sessionId);
          });
          // 分隔线已由 emitDivider 在构建 nodes 时按组边界插入，这里直接平铺输出。
          return nodes;
        })()}
        {/* 浏览器式新建入口：跟在最后一张标签后面，下拉选择新建到哪个项目。
            （新建会话保留独立「+」按钮；⋯ 菜单只收运行控制与工具） */}
        <NewSessionMenu
          targets={props.newSessionTargets}
          onSelect={props.onNewSessionInProject}
        />
        {/* 文件/Diff 与会话共用本栏：同一套 session-tab 皮，不另开绿条栏 */}
        {props.editorTabs && props.editorTabs.length > 0 ? (
          <>
            <span
              className="mx-0.5 h-4 w-px shrink-0 bg-border/50"
              aria-hidden="true"
            />
            {props.editorTabs.flatMap((tab, index) => {
              const node = (
                <EditorWorkbenchTab
                  key={tab.id}
                  tab={tab}
                  indicatorId={activeIndicatorId}
                  indicatorTransition={indicatorTransition}
                  onSelect={props.onSelectEditorTab}
                  onClose={props.onCloseEditorTab}
                  onPromotePreview={props.onPromoteEditorPreview}
                />
              );
              if (index === 0) return [node];
              return [
                <span
                  key={`editor-tab-sep:${tab.id}`}
                  className="mx-0.5 h-4 w-px shrink-0 bg-border/50"
                  aria-hidden="true"
                />,
                node,
              ];
            })}
          </>
        ) : null}
      </motion.div>
      {/* 右缘渐变：溢出时提示「右侧还有 Tab」（纯装饰，不拦截鼠标）。
          放在滚动容器外层（absolute 子元素放 overflow-x-auto 容器内会随内容滚走）。 */}
      {tabsOverflow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background/90 to-transparent"
        />
      )}
      </div>
      {/* 右侧抽屉总开关：固定在会话 Tab 栏最右侧；面板切换图标在抽屉内活动栏。
          ⋯ 菜单收运行控制（当前会话）与工具开关两组（新建会话保留独立「+」按钮）；
          Tab 级操作（固定/关闭等）保留在 Tab 右键菜单。 */}
      {props.onToggleDrawer ||
      props.actions != null ||
      (props.toolActions && props.toolActions.length > 0) ||
      props.onStopCurrent ||
      props.onRestartCurrent ||
      props.onReloadCurrent ? (
        <div className="session-tabs-actions flex shrink-0 items-center gap-1 border-l border-border/30 pl-1">
          {props.actions}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={`size-7${props.toolActions?.some((action) => action.active) ? " text-[var(--color-accent)]" : ""}`}
                title={t("tabs.moreActions")}
                aria-label={t("tabs.moreActions")}
              >
                <MoreHorizontal className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {/* 运行控制只作用于当前会话；无当前会话（onStop 等为空）时整组不显示。
                  置灰用内联 style 而非 className——特异性最高，任何 CSS 都覆盖不了。 */}
              {(props.onStopCurrent || props.onRestartCurrent || props.onReloadCurrent) && (
                <>
                  <DropdownMenuLabel>{t("tabs.currentSessionGroup")}</DropdownMenuLabel>
                  {props.onStopCurrent && (
                    <DropdownMenuItem
                      disabled={!props.canStopCurrent || props.isStoppingCurrent}
                      style={!props.canStopCurrent || props.isStoppingCurrent ? { opacity: 0.4 } : undefined}
                      onSelect={props.onStopCurrent}
                    >
                      <span className="inline-flex items-center gap-2">
                        <CircleStop className={cn("size-3.5", props.isStoppingCurrent && "animate-pulse")} aria-hidden="true" />
                        {props.isStoppingCurrent ? t("app.stopping") : t("tabs.stopAgent")}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {props.onRestartCurrent && (
                    <DropdownMenuItem
                      disabled={!props.canRestartCurrent || props.isRestartingCurrent}
                      style={!props.canRestartCurrent || props.isRestartingCurrent ? { opacity: 0.4 } : undefined}
                      onSelect={props.onRestartCurrent}
                    >
                      <span className="inline-flex items-center gap-2">
                        <RotateCw className={cn("size-3.5", props.isRestartingCurrent && "animate-pideck-spin")} aria-hidden="true" />
                        {props.isRestartingCurrent ? t("app.restarting") : t("app.restart")}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {props.onReloadCurrent && (
                    <DropdownMenuItem
                      disabled={!props.canReloadCurrent || props.isReloadingCurrent}
                      style={!props.canReloadCurrent || props.isReloadingCurrent ? { opacity: 0.4 } : undefined}
                      onSelect={props.onReloadCurrent}
                    >
                      <span className="inline-flex items-center gap-2">
                        <RefreshCw className={cn("size-3.5", props.isReloadingCurrent && "animate-pideck-spin")} aria-hidden="true" />
                        {props.isReloadingCurrent ? t("app.reloading") : t("menu.reloadSession")}
                      </span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              {props.toolActions && props.toolActions.length > 0 && (
                <>
                  <DropdownMenuLabel>{t("tabs.toolsGroup")}</DropdownMenuLabel>
                  {props.toolActions.map((action) => (
                    <DropdownMenuItem key={action.id} onClick={action.onClick}>
                      {action.icon}
                      <span>{action.label}</span>
                      {action.active ? (
                        <Check className="ml-auto size-3.5 text-[var(--color-accent)]" aria-hidden="true" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {props.onToggleDrawer ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={`header-drawer-toggle size-7${props.drawerOpen ? " active" : ""}`}
              title={props.drawerOpen ? t("app.closeDrawer") : t("app.openDrawer")}
              aria-label={props.drawerOpen ? t("app.closeDrawer") : t("app.openDrawer")}
              onClick={props.onToggleDrawer}
            >
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
function EditorWorkbenchTab(props: {
  tab: WorkbenchEditorTabItem;
  /** 与会话 Tab 共用的指示器 layoutId（选中态滑动到本 Tab，同一套 spring） */
  indicatorId: string;
  indicatorTransition: Transition;
  onSelect?: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  onPromotePreview?: (tabId: string) => void;
}) {
  const { tab } = props;
  return (
    <div
      role="tab"
      aria-selected={Boolean(tab.active)}
      title={tab.title ?? tab.label}
      className={cn(
        "session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center rounded-md border px-2 text-caption transition-[color,background-color,border-color,box-shadow,transform] duration-200",
        "w-fit max-w-40",
        // 选中态：灰色柔和实底（以 bg-accent = --color-bg-active，与会话 Tab/侧栏一致），文字 text-foreground
        tab.active
          ? "border-transparent font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:-translate-y-px hover:bg-accent/50 hover:text-foreground",
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
      <span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>
        {tab.label}
      </span>
      <button
        type="button"
        role="tab-close"
        aria-label={t("tabs.close")}
        title={t("tabs.close")}
        className={cn(
          "inline-grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground",
          tab.active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
        )}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose?.(tab.id);
        }}
      >
        <X className="size-3" />
      </button>
      </span>
      {/* 灰色选中背景：与会话 Tab 同一 layoutId（active 变化即 spring 滑动到本 Tab），
          替代旧的底部细条；内容包装层已 z-10 抬升到背景之上。
          背景色用 inline 变量（var(--color-bg-active)）而非 bg-accent 类，同 SessionTab 一致。 */}
      {tab.active && (
        <motion.span
          aria-hidden="true"
          layoutId={props.indicatorId}
          layout="position"
          transition={props.indicatorTransition}
          className="pointer-events-none absolute inset-0 rounded-md bg-accent"
        />
      )}
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
      <span className="inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-(--group-color)/25 px-1 text-[10px] leading-none font-medium text-(--group-color-text)">
        {count}
      </span>
      {expanded ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  );
}

function SessionTab(props: {
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
   *  运行控制菜单项（停止/重启/重新加载）已上收右上角 ⋯ 菜单，Tab 上不再提供。 */
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
  /** 与全栏共享的指示器 layoutId（beui Tabs 同款：active 切换时 spring 滑动） */
  indicatorId: string;
  /** 指示器 transition：spring（默认）/ 减少动态时瞬时 */
  indicatorTransition: Transition;
}) {
  const { sessionId, active, pinned, preview, dragging } = props;
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
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
  // Tab 级操作（固定/关闭等）改为右键菜单（ContextMenu，光标处弹出）；Tab 本体点击仍是切换，
  // 拖拽排序与中键关闭与菜单互不干扰（drag/auxclick 不触发 click）。
  // 运行控制（停止/重启/重新加载）只作用于当前会话，已上收右上角 ⋯ 更多操作菜单。

  const select = () => props.onSelect(sessionId);
  const close = () => props.onClose(sessionId);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        role="tab"
        aria-selected={active}
        data-session-id={sessionId}
        title={title}
        draggable
        onDragStart={props.onDragStart}
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
        onDragEnd={props.onDragEnd}
        onClick={select}
        onDoubleClick={() => {
          // 双击预览 Tab → 常驻（侧栏双击同语义）；已常驻则忽略
          if (preview) props.onPromotePreview?.(sessionId);
        }}
        onAuxClick={(event) => {
          // 中键关闭（固定 Tab 忽略，需先取消固定），与浏览器 Tab 行为一致
          if (event.button === 1 && !pinned) close();
        }}
        className={cn(
          "session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center rounded-md border px-2 text-caption transition-[color,background-color,border-color,box-shadow,transform] duration-200",
          // 固定 Tab 与普通 Tab 同宽策略（按内容收缩，上限 128px）：固定 Tab 无关闭按钮，
          // hover 不会因按钮出现而跳动，无需 w-20 占位；固定宽度反而让 Pin 图标挤占标题空间
          "w-fit max-w-32",
          dragging && "opacity-50",
          // 选中态：灰色柔和实底（bg-accent = --color-bg-active，与左侧 SessionTree 选中行一致），
          // 背景由下方共享 layoutId 的 motion.span spring 滑到当前 Tab；不做黑色实底/阴影/底部条。
          // 文字用 text-foreground（灰底上直接可读，无需反色）。
          active
            ? "border-transparent font-medium text-foreground"
            : "border-transparent text-muted-foreground hover:-translate-y-px hover:bg-accent/50 hover:text-foreground",
          preview && "italic font-normal text-muted-foreground",
        )}
      >
        {/* 内容包装：relative z-10 抬到灰色背景面板之上（背景面板是 absolute，按层序会在内容下）。 */}
        <span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5">
        {badge && (
          // beui AnimatedBadge bare 模式：去掉胶囊边框/背景，仅保留图标滚动/旋转动画；
          // 图标经 [&_svg] 稳定选择器缩到 10px；运行中通过 colorClass 覆盖成黄色旋转。
          <AnimatedBadge
            status={badge.status}
            size="sm"
            bare
            pulse={false}
            className={cn("[&_svg]:h-2.5 [&_svg]:w-2.5", badge.colorClass)}
            aria-hidden="true"
          />
        )}
        {pinned && <Pin className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
        {/* DSH/生图是文字标记，保留自然宽度；固定 size-4 会让文字溢出到右侧操作按钮区域。 */}
        {(record?.backend === "dsh" || record?.backend === "imagegen") && <SessionBackendBadge backend={record?.backend} className="h-4 shrink-0" />}
        {/* G12：DSH plan 模式 / danger 权限预设全局可见（数据来自 runtime state，tab 级常显） */}
        {runtime?.state?.planModeActive && (
          <span
            className="shrink-0 rounded bg-primary/15 px-1 text-[10px] font-medium leading-4 text-primary"
            title={t("app.composerModePlan")}
          >
            {t("app.composerModePlan")}
          </span>
        )}
        {runtime?.state?.goal && runtime.state.goal.phase !== "complete" && (
          <span
            className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-medium leading-4 text-accent"
            title={t("app.composerModeGoal")}
          >
            {t("app.composerModeGoal")}
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
        <TitleScrollText
          text={title}
          disabled={active}
          hoverDelayMs={500}
          className={cn(
            "truncate",
            active ? "font-medium" : "font-normal",
            preview && "italic",
          )}
        />
        {!pinned && (
          <button
            type="button"
            role="tab-close"
            aria-label={t("tabs.close")}
            title={t("tabs.close")}
            className={cn(
              "inline-grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground",
              active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
            )}
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
        {props.indicator && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-primary",
              props.indicator === "before" ? "-left-0.5" : "-right-0.5",
            )}
          />
        )}
        {/* 灰色选中背景按钮（beui Tabs 同款滑动；无底部条）：只有 active Tab 渲染，layoutId 全栏共享，
            切换时 spring 滑到新位置并在目标 Tab 铺满整块灰底——替代旧的底部细条/黑色实底；
            拖拽插入线（props.indicator）是竖线且仅拖拽期存在，二者位置不重叠。
            背景色用 inline 变量（var(--color-bg-active)）而非 bg-accent 类：类依赖 Tailwind
            扫描生成，曾出现在部分环境下类未输出导致「激活 Tab 无背景」的回归。inline 变量
            随主题实时切换，与 SessionTree 选中态同色。 */}
        {active && (
          <motion.span
            aria-hidden="true"
            layoutId={props.indicatorId}
            layout="position"
            transition={props.indicatorTransition}
            className="pointer-events-none absolute inset-0 rounded-md bg-accent"
          />
        )}
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        {/* 固定/关闭等 Tab 级操作；运行控制在右上角 ⋯ 菜单 */}
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
        <ContextMenuItem onSelect={() => props.onCloseOthers(sessionId)}>
          <span className="inline-flex items-center gap-2">
            <CircleX className="size-3.5" aria-hidden="true" />
            {t("tabs.closeOthers")}
          </span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={props.onCloseAll}>
          <span className="inline-flex items-center gap-2">
            <X className="size-3.5" aria-hidden="true" />
            {t("tabs.closeAll")}
          </span>
        </ContextMenuItem>
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
function NewSessionMenu(props: {
  targets: readonly NewSessionTarget[];
  onSelect: (projectId: string) => void;
}) {
  const chatTargets = props.targets.filter((target) => target.isChat);
  const projectTargets = props.targets.filter((target) => !target.isChat);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="session-tabs-new ml-0.5 inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={t("tabs.new")}
          aria-label={t("tabs.new")}
        >
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
