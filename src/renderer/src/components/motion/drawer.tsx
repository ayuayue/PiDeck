"use client";
// beui.dev/components/motion/drawer

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { EASE_OUT, SPRING_PANEL } from "@/lib/ease";
import { PresenceGate } from "@/lib/presence-gate";
import { cn } from "@/lib/utils";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  children: ReactNode;
  /** Class for the panel surface. */
  className?: string;
  /** Class for the backdrop. */
  backdropClassName?: string;
  ariaLabel?: string;
  /** Close when the backdrop is clicked. Default true. */
  dismissable?: boolean;
  /**
   * PiDeck 扩展（beui 官方无此 prop）：透传到背板与面板的共同包装层。
   *
   * 背板与面板是同级的两个 fixed 兄弟节点，调用方需要一个能把「整张抽屉」
   * 一次性标记出来的挂载点 —— 例如公告详情抽屉要挂 data-* 属性，让外层
   * Radix Dialog 在 closest() 判定中识别「这次外部交互来自抽屉」，从而只关
   * 抽屉、不连带关掉列表弹窗。缺省不渲染包装层，保持官方 DOM 结构不变。
   */
  rootAttributes?: Record<string, string>;
}

export function Drawer({
  open,
  onOpenChange,
  side = "right",
  children,
  className,
  backdropClassName,
  ariaLabel,
  dismissable = true,
  rootAttributes,
}: DrawerProps) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onOpenChange]);

  const offscreen = side === "right" ? "100%" : "-100%";

  // Two fixed siblings, no wrapper: the backdrop spans the viewport edges but
  // paints the scrim, and the panel is inset off one side and paints its own
  // surface, so neither is a transparent edge-spanning layer. Both hang off
  // `PresenceGate`, so interaction releases in the same commit that starts the
  // exit rather than when it ends. See tests/fixed-overlay-edge-sampling.test.tsx.
  //
  // `rootAttributes` goes on both siblings rather than on a shared wrapper: a
  // wrapper would itself be an edge-spanning transparent layer (exactly what
  // this structure avoids) and would break the AnimatePresence direct-child
  // contract each layer relies on.
  return (
    <AnimatePresence>
      {open ? (
        <PresenceGate key="backdrop">
          {({ gate }) => (
            <motion.button
              type="button"
              aria-label="Close"
              tabIndex={dismissable ? 0 : -1}
              onClick={() => dismissable && onOpenChange(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE_OUT }}
              {...rootAttributes}
              {...gate}
              className={cn(
                "fixed inset-0 z-50 h-full w-full cursor-default bg-black/40 backdrop-blur-sm",
                backdropClassName,
              )}
            />
          )}
        </PresenceGate>
      ) : null}
      {open ? (
        <PresenceGate key="panel">
          {({ gate }) => (
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label={ariaLabel}
              initial={reduce ? { opacity: 0 } : { x: offscreen }}
              animate={reduce ? { opacity: 1 } : { x: 0 }}
              exit={reduce ? { opacity: 0 } : { x: offscreen }}
              transition={
                reduce ? { duration: 0.2, ease: EASE_OUT } : SPRING_PANEL
              }
              {...rootAttributes}
              {...gate}
              className={cn(
                "fixed inset-y-0 z-50 flex w-80 max-w-[85vw] flex-col bg-background shadow-2xl",
                side === "right"
                  ? "right-0 border-l border-border"
                  : "left-0 border-r border-border",
                className,
              )}
            >
              {children}
            </motion.aside>
          )}
        </PresenceGate>
      ) : null}
    </AnimatePresence>
  );
}
