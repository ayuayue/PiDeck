import { useAtomValue } from "jotai";
import { Pin, PinOff, Plus, PanelRight, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
} from "../../atoms";
import { sessionStatusDotClass } from "../../agentListDisplay";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import { cn } from "../../lib/utils";

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
 * - 固定 Tab 前置、宽度更小、无关闭按钮，右键菜单可取消固定；
 * - 拖拽 Tab 可排序，固定/普通区间交叉拖动会自动转换固定状态。
 */

/** 拖拽中的源 Tab id；onDrop 时消费 */
const TAB_DRAG_DATA_KEY = "text/pideck-session-tab";

export type SessionTabsBarProps = {
  tabs: readonly string[];
  pinnedTabs: readonly string[];
  currentSessionId?: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onCloseOthers: (sessionId: string) => void;
  onCloseAll: () => void;
  onNewSession: () => void;
  onTogglePin: (sessionId: string) => void;
  onReorder: (sourceId: string, targetId: string, position: "before" | "after") => void;
  /** 无当前会话时仍显示右侧抽屉入口。 */
  onToggleDrawer?: () => void;
  drawerOpen?: boolean;
  /** 当前会话的状态/操作区；嵌入 Tab 栏后不再单独占用标题行。 */
  actions?: ReactNode;
};

export function SessionTabsBar(props: SessionTabsBarProps) {
  const { tabs, pinnedTabs, currentSessionId } = props;
  const tabItems = useMemo(() => tabs.map((sessionId) => ({ sessionId })), [tabs]);
  const dragSourceRef = useRef<string | null>(null);
  const dragTargetRef = useRef<{ targetId: string; position: "before" | "after" } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // 拖拽插入指示：当前悬停的目标 Tab 与插入侧（before=左缘 / after=右缘）
  const [dragIndicator, setDragIndicator] = useState<{ targetId: string; position: "before" | "after" } | null>(null);

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
    if (sourceId && target) {
      props.onReorder(sourceId, target.targetId, target.position);
    }
  };

  const handleDragEnd = () => {
    dragSourceRef.current = null;
    dragTargetRef.current = null;
    setDraggingId(null);
    setDragIndicator(null);
  };

  // overflow-visible：SessionHeader 的 session-combo 下拉菜单向下弹出，hidden 会把它裁掉导致“+新会话”看似无反应；Tab 滚动已由内部 .session-tabs-scroll 的 overflow-x-auto 承担。
  return (
    // h-[41px] 与右侧抽屉活动栏（.drawer-activity-rail：32px 按钮 + 8px padding + 1px 边框）精确对齐，改任一侧需同步。
    <div className="session-tabs-bar flex h-[41px] shrink-0 items-center gap-1 overflow-visible border-b border-border/40 bg-background/80 px-2">
      <div className="session-tabs-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabItems.map(({ sessionId }) => (
        <SessionTab
          key={sessionId}
          sessionId={sessionId}
          active={sessionId === currentSessionId}
          pinned={pinnedTabs.includes(sessionId)}
          dragging={draggingId === sessionId}
          // 指示线插在目标 Tab 的边缘：before=左缘，after=右缘
          indicator={dragIndicator && dragIndicator.targetId === sessionId ? dragIndicator.position : null}
          onSelect={props.onSelect}
          onClose={props.onClose}
          onCloseOthers={props.onCloseOthers}
          onCloseAll={props.onCloseAll}
          onTogglePin={props.onTogglePin}
          onDragStart={(event) => {
            dragSourceRef.current = sessionId;
            dragTargetRef.current = null;
            setDraggingId(sessionId);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(TAB_DRAG_DATA_KEY, sessionId);
          }}
          onDragOver={(event) => handleDragOver(event, sessionId)}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
        />
        ))}
      </div>
      <div className="session-tabs-actions flex shrink-0 items-center gap-1 border-l border-border/30 pl-1">
        {props.actions}
        {!props.actions && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="session-tabs-new ml-0.5 inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              title={t("tabs.new")}
              aria-label={t("tabs.new")}
              onClick={props.onNewSession}
            >
              <Plus className="size-3.5" />
            </Button>
            {props.onToggleDrawer && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={`header-drawer-toggle size-7${props.drawerOpen ? " active" : ""}`}
                title={props.drawerOpen ? t("app.collapseDrawer") : t("app.expandDrawer")}
                aria-label={props.drawerOpen ? t("app.collapseDrawer") : t("app.expandDrawer")}
                onClick={props.onToggleDrawer}
              >
                <PanelRight className="size-3.5" aria-hidden="true" />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SessionTab(props: {
  sessionId: string;
  active: boolean;
  /** 固定 Tab：前置、窄宽度、无关闭按钮 */
  pinned: boolean;
  dragging: boolean;
  /** 拖拽插入指示：before=左缘竖线，after=右缘竖线 */
  indicator?: "before" | "after" | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onCloseOthers: (sessionId: string) => void;
  onCloseAll: () => void;
  onTogglePin: (sessionId: string) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { sessionId, active, pinned, dragging } = props;
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const status = runtime?.status;
  // 状态点颜色语义与侧栏 SessionTree 一致（idle=蓝、running/starting=黄、error=红）；
  // 未启动（无 runtime）不显示色点，避免把“未运行”误读成某种状态。
  const dotClass = sessionStatusDotClass(status);
  const title = record?.title || t("common.untitled");
  // 右键菜单锚点（虚拟触发器模式，与 FileContextMenu 一致）：左键=切换，右键=菜单
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  const select = () => props.onSelect(sessionId);
  const close = () => props.onClose(sessionId);

  return (
    <>
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
        className={cn(
          "session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 text-caption transition-colors",
          // 短标题按内容收缩，长标题限制在 128px 内；关闭按钮仍保留固定空间，避免 tab 在 hover 时跳动。
          pinned ? "w-20" : "w-fit max-w-32",
          dragging && "opacity-50",
          active
            ? "border-border bg-accent/10 font-medium text-foreground"
            : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
        onClick={select}
        onAuxClick={(event) => {
          // 中键关闭（固定 Tab 忽略，需先取消固定），与浏览器 Tab 行为一致
          if (event.button === 1 && !pinned) close();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuAnchor({ x: event.clientX, y: event.clientY });
        }}
      >
        {dotClass && (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              dotClass,
              status === "error" ? "" : "animate-pulse",
            )}
            aria-hidden="true"
          />
        )}
        {pinned && <Pin className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
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
      </div>
      {menuAnchor && (
        <DropdownMenu open onOpenChange={(open) => { if (!open) setMenuAnchor(null); }}>
          <DropdownMenuTrigger
            aria-hidden
            tabIndex={-1}
            style={{
              position: "fixed",
              left: menuAnchor.x,
              top: menuAnchor.y,
              width: 0,
              height: 0,
              padding: 0,
              border: 0,
              background: "transparent",
              pointerEvents: "none",
            }}
          />
          <DropdownMenuContent align="start" side="bottom" className="min-w-36">
            <DropdownMenuItem onSelect={select}>{t("tabs.switchTo")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onTogglePin(sessionId)}>
              <span className="inline-flex items-center gap-2">
                {pinned ? <PinOff className="size-3.5" aria-hidden="true" /> : <Pin className="size-3.5" aria-hidden="true" />}
                {pinned ? t("tabs.unpin") : t("tabs.pin")}
              </span>
            </DropdownMenuItem>
            {!pinned && <DropdownMenuItem onSelect={close}>{t("tabs.close")}</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => props.onCloseOthers(sessionId)}>
              {t("tabs.closeOthers")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={props.onCloseAll}>{t("tabs.closeAll")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
