import { useEffect, useRef, useState } from "react";
import {
  type TerminalDockStateByOwner,
  setTerminalDockOpen,
  setTerminalDockCollapsed,
  pruneTerminalDockState,
  terminalOwnerKey,
} from "../terminalDockState";

const COMPOSER_DEFAULT_TERMINAL_HEIGHT = 220;
const TERMINAL_DOCK_MOTION_MS = 180;

export function useTerminalDock(activeAgentId: string | undefined) {
  const [terminalDockStateByOwner, setTerminalDockStateByOwner] =
    useState<TerminalDockStateByOwner>({});
  const [terminalHeightByAgent, setTerminalHeightByAgent] = useState<
    Record<string, number>
  >({});
  const [terminalDockMounted, setTerminalDockMounted] = useState(false);
  const [terminalDockClosing, setTerminalDockClosing] = useState(false);
  const [terminalDockAgentId, setTerminalDockAgentId] = useState<string>();
  const terminalDockCloseTimerRef = useRef<number | null>(null);

  // 终端打开/折叠状态按 agent 隔离,避免切换项目/agent 后丢失当前终端 UI 状态。
  const activeOwnerKey = activeAgentId
    ? terminalOwnerKey({ kind: "agent", id: activeAgentId })
    : undefined;
  const terminalDockState = activeOwnerKey
    ? terminalDockStateByOwner[activeOwnerKey] ?? terminalDockStateByOwner[activeAgentId ?? ""]
    : undefined;
  const terminalOpen = Boolean(terminalDockState?.open);
  const terminalCollapsed = Boolean(terminalDockState?.collapsed);
  const terminalDockVisible =
    terminalDockMounted && terminalDockAgentId === activeAgentId;
  const terminalRowHeight = activeAgentId
    ? (terminalHeightByAgent[activeAgentId] ?? COMPOSER_DEFAULT_TERMINAL_HEIGHT)
    : COMPOSER_DEFAULT_TERMINAL_HEIGHT;

  // 轨道尺寸只在开关时变更一次，终端本身用 transform 完成合成动画。
  // 关闭时保留组件至动画结束，避免同步销毁 xterm 阻塞第一帧。
  useEffect(() => {
    if (terminalOpen && activeAgentId) {
      if (terminalDockCloseTimerRef.current != null) {
        window.clearTimeout(terminalDockCloseTimerRef.current);
        terminalDockCloseTimerRef.current = null;
      }
      setTerminalDockAgentId(activeAgentId);
      setTerminalDockClosing(false);
      setTerminalDockMounted(true);
      return;
    }
    if (!terminalDockMounted) return;
    if (terminalDockAgentId !== activeAgentId) {
      setTerminalDockMounted(false);
      return;
    }

    setTerminalDockClosing(true);
    terminalDockCloseTimerRef.current = window.setTimeout(
      () => {
        setTerminalDockMounted(false);
        setTerminalDockClosing(false);
      },
      TERMINAL_DOCK_MOTION_MS,
    );
    return () => {
      if (terminalDockCloseTimerRef.current != null) {
        window.clearTimeout(terminalDockCloseTimerRef.current);
        terminalDockCloseTimerRef.current = null;
      }
    };
  }, [activeAgentId, terminalDockAgentId, terminalDockMounted, terminalOpen]);

  function setTerminalOpenForAgent(agentId: string, open: boolean) {
    setTerminalDockStateByOwner((current) =>
      setTerminalDockOpen(current, terminalOwnerKey({ kind: "agent", id: agentId }), open),
    );
  }

  function setTerminalCollapsedForAgent(agentId: string, collapsed: boolean) {
    setTerminalDockStateByOwner((current) =>
      setTerminalDockCollapsed(current, terminalOwnerKey({ kind: "agent", id: agentId }), collapsed),
    );
  }

  /** 清理已关闭 agent 的终端状态，在 agent 列表变化时调用。 */
  function prune(activeIds: Set<string>) {
    setTerminalDockStateByOwner((current) =>
      pruneTerminalDockState(current, activeIds, new Set()),
    );
    setTerminalHeightByAgent((current) => {
      const liveEntries = Object.entries(current).filter(([agentId]) =>
        activeIds.has(agentId),
      );
      return liveEntries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(liveEntries);
    });
  }

  return {
    terminalOpen,
    terminalCollapsed,
    terminalDockVisible,
    terminalDockClosing,
    terminalRowHeight,
    setTerminalOpenForAgent,
    setTerminalCollapsedForAgent,
    terminalHeightByAgent,
    setTerminalHeightByAgent,
    terminalDockMounted,
    terminalDockAgentId,
    prune,
  };
}
