import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel } from "../ui-shadcn/resizable";
import { SessionRuntimeDock } from "../session/SessionRuntimeDock";
import type { PiDesktopApi } from "../../../../preload";
import type { TerminalTarget } from "../../../../shared/types";
import {
  TERMINAL_HEIGHT_MIN,
  applyTerminalPanelResize,
} from "../../terminalDockState";

/** 终端分屏面板的固定约束（px），会话视图与引导页两条路径共用同一组值 */
export const TERMINAL_PANEL_COLLAPSED_SIZE = 34;
export const TERMINAL_PANEL_MIN_SIZE = 120;

export type TerminalDockPanelProps = {
  /** agent 或 project 终端目标；未解析时组件渲染 null（与 SessionRuntimeDock 同契约） */
  target?: TerminalTarget;
  open: boolean;
  closing: boolean;
  collapsed: boolean;
  /** 展开态目标高度（px）：defaultSize 首帧占位用，应为 clamp 后的值 */
  height: number;
  /** 可用高度上限（px）：maxSize clamp，防止终端吃掉整个工作区 */
  maxHeight: number;
  terminal: PiDesktopApi["terminal"];
  /** 终端归属键（agent:<id> / project:<id>）：切换 owner 时重建 dock 实例 */
  ownerKey?: string;
  /** 可选：调用方需要命令式 collapse()/expand() 时传入（SessionView 折叠联动） */
  panelRef?: React.Ref<PanelImperativeHandle>;
  /**
   * 程序化 resize 判定（可选）：composer 增高/回缩等 setLayout 触发的 onResize
   * 不算用户折叠意图——布局挤压导致的面板变矮不应把 collapsed 写死。
   * 会话视图传保护窗口判定；引导页无程序化流程可省略。
   */
  isProgrammaticResize?: () => boolean;
  onOpenChange: (open: boolean) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  /** 展开态高度回写；持久化由调用方 hook 完成（localStorage 跨重启恢复） */
  onHeightChange: (height: number) => void;
};

/**
 * 终端底部分屏面板：复用 react-resizable-panels 的标准分隔条形态
 * （Handle + collapsible Panel + SessionRuntimeDock 的固定组合），
 * 会话视图与引导页两条入口共用同一组件，拖拽/折叠策略统一在这里裁决：
 * - 几何规则（折叠阈值/clamp/拖回展开）收敛在 applyTerminalPanelResize 纯函数；
 * - 拖出的新高度经 onHeightChange 回写并持久化；
 * - 程序化 setLayout 引起的尺寸变化不写折叠态（见 isProgrammaticResize）。
 *
 * 调用方负责条件挂载——面板数变化必须配合 Group key 重建（见
 * sessionResizableGroupKey 的注释），因此本组件不做 mounted 判断，
 * 挂载即渲染 Handle 与 Panel。
 */
export function TerminalDockPanel(props: TerminalDockPanelProps) {
  // 目标未解析（owner 存在但 runtime target 未就绪）时不渲染面板，
  // 调用方的可见性判断与这里的判空双保险
  if (!props.target) return null;

  function handleResize(size: PanelSize) {
    const px = Math.round(size.inPixels);
    // 几何裁决（折叠阈值/clamp/展开意图）走共享纯函数，两条入口路径同一套规则
    const intent = applyTerminalPanelResize({
      px,
      collapsed: props.collapsed,
      maxHeight: Math.max(TERMINAL_HEIGHT_MIN, props.maxHeight),
    });
    // 折叠/展开是用户拖拽意图：程序化 resize 窗口内不写，避免布局挤压误收起；
    // 高度始终回写 clamp 后的合法值，程序化窗口内多写一次无害（值不变时 state 不更新）
    if (
      intent.collapsed !== undefined &&
      intent.collapsed !== props.collapsed &&
      !props.isProgrammaticResize?.()
    ) {
      props.onCollapsedChange(intent.collapsed);
    }
    if (intent.height !== undefined) {
      props.onHeightChange(intent.height);
    }
  }

  return (
    <>
      {/* 可见分隔条：终端分屏的视觉边界 + 拖拽手柄。不用 session 视图的
          .v-splitter（刻意透明、依赖 composer 边框当分界线），这里独立成屏，
          必须自己画出分屏线；after 扩大上下命中区，贴着终端上沿也能拖。 */}
      <ResizableHandle
        className={[
          "relative h-1 w-full shrink-0 cursor-row-resize rounded-none",
          "bg-border/60 transition-colors hover:bg-ring data-[separator=active]:bg-ring",
          "session-terminal-splitter",
          // 命中区向消息区/空态延伸，实际可拖范围远大于可见线条
          "after:absolute after:inset-x-0 after:-top-2 after:h-4 after:content-['']",
        ].join(" ")}
      />
      <ResizablePanel
        id="terminal"
        panelRef={props.panelRef}
        collapsible
        collapsedSize={TERMINAL_PANEL_COLLAPSED_SIZE}
        minSize={TERMINAL_PANEL_MIN_SIZE}
        maxSize={Math.max(TERMINAL_PANEL_MIN_SIZE, props.maxHeight)}
        defaultSize={props.collapsed ? TERMINAL_PANEL_COLLAPSED_SIZE : props.height}
        // 窗口缩放保住终端像素高度，余量全部给时间线列（列内输入栏是固有高度）。
        groupResizeBehavior="preserve-pixel-size"
        onResize={handleResize}
        className="session-v-terminal"
      >
        <SessionRuntimeDock
          key={props.ownerKey}
          target={props.target}
          mounted
          open={props.open}
          closing={props.closing}
          collapsed={props.collapsed}
          height={props.height}
          terminal={props.terminal}
          onOpenChange={props.onOpenChange}
          onCollapsedChange={props.onCollapsedChange}
          onHeightChange={() => {
            // 高度统一由面板 onResize 回写，此回调保留仅为兼容 SessionRuntimeDock 接口
          }}
        />
      </ResizablePanel>
    </>
  );
}
