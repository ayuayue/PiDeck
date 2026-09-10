import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui-shadcn/button"
import { POPOVER_DISMISS_EXEMPT_ATTR } from "@/components/motion/popover-morph"
import { isOutsideInteractionFromToast } from "./toastOutsideGuard"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // 打开：200ms ease-out-quint 淡入 + 从下 8px 浮起（slide-in-from-bottom-2），
        // 形成“展开”感而非硬切；关闭：ease-in 快速下坠淡出。
        // stagger 开启时对直接子元素做轻量级联入场（见 dialog-stagger 样式）。
        "fixed inset-0 z-(--z-dialog) bg-black/50 duration-base data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = "default",
  /** 内容 stagger：大弹框（设置/项目管理等）开启，子元素按序轻微级联入场 */
  stagger = false,
  /**
   * 豁免外层浮层的外部点击关闭：在 portal 根上挂 data-popover-dismiss-exempt，
   * 供 MorphPopover 一类「按 root/contentRef 判内外」的浮层跳过这次外点判定。
   * 用于「浮层内入口打开的弹窗」——弹窗 portal 到 body，与浮层是兄弟节点，
   * 不标记就会被误判成点了浮层外部。见 motion/popover-morph.tsx 同名常量。
   */
  dismissExemptOnOutside = false,
  onPointerDownOutside,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** 尺寸变体：xl 用于全尺寸工作台弹窗（如设置/项目管理，1300×850） */
  size?: "default" | "xl"
  stagger?: boolean
  dismissExemptOnOutside?: boolean
}) {
  return (
    <DialogPortal
      data-slot="dialog-portal"
      {...(dismissExemptOnOutside
        ? { [POPOVER_DISMISS_EXEMPT_ATTR]: "" }
        : {})}
    >
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onPointerDownOutside={(event) => {
          // 点全局 toast（含关闭按钮）不算「点击弹框外部」，弹框保持打开
          if (isOutsideInteractionFromToast(event)) { event.preventDefault(); return; }
          onPointerDownOutside?.(event);
        }}
        onInteractOutside={(event) => {
          if (isOutsideInteractionFromToast(event)) { event.preventDefault(); return; }
          onInteractOutside?.(event);
        }}
        className={cn(
          "fixed top-[50%] left-[50%] z-(--z-dialog) grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg outline-none duration-base ease-out-quint data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-2 data-[state=closed]:ease-in data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 sm:max-w-lg",
          stagger && "dialog-stagger",
          size === "xl" &&
            "sm:max-w-[min(1300px,calc(100vw-48px))] h-[min(850px,calc(100vh-48px))]",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
