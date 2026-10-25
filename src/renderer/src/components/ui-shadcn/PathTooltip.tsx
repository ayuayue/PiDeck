"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { cn } from "@/lib/utils";

/**
 * 长路径/长文本悬浮提示，用于替代原生 title 属性。
 *
 * 背景：会话/项目行的 filePath 直接放在原生 title 上时，Chromium 会把超长文本
 * 自动换行并直接截断（无省略号），圆角矩形在窗口边缘还会被切掉，且无法控制
 * 宽度与位置。本组件用 Radix Tooltip 完整渲染内容：
 * - break-all + whitespace-pre-wrap 保证路径完整显示、不截断
 * - max-width 限制防止溢出视口，Radix 自动避让窗口边缘（翻转/重新对齐）
 * - 面板风样式跟随主题（bg-popover + border），与项目浮层风格一致
 * - 内容只读：气泡必须 pointer-events-none。默认贴在项目名右侧时，鼠标
 *   移入气泡会先离开很窄的触发区，Radix 立刻关 tooltip，指针又回到触发区，
 *   形成开关闪烁。disableHoverableContent 同步关掉「可悬停内容」语义。
 * - 关闭有短宽限期：快划过触发区边缘时不要立刻关。开关动画关掉，避免
 *   宽限期内仍看到 zoom/fade 闪一下。
 */
export function PathTooltip(props: {
	/** 悬浮时展示的完整内容（一般是路径文本） */
	content: ReactNode;
	/** 触发器，必须能接受 ref（通常直接包住原按钮元素） */
	children: ReactNode;
	className?: string;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	sideOffset?: number;
	delayDuration?: number;
	/** 指针离开触发区后多久才关；盖住快划过边缘的抖动。 */
	hideDelay?: number;
}) {
	const { content, children, className, side = "right", align = "start", sideOffset = 8, delayDuration = 250, hideDelay = 220 } = props;
	const [open, setOpen] = useState(false);
	const hideTimerRef = useRef(0);
	useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

	const onOpenChange = (next: boolean) => {
		window.clearTimeout(hideTimerRef.current);
		if (next) {
			setOpen(true);
			return;
		}
		hideTimerRef.current = window.setTimeout(() => setOpen(false), hideDelay);
	};

	return (
		<Tooltip open={open} onOpenChange={onOpenChange} delayDuration={delayDuration} disableHoverableContent>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent
				side={side}
				align={align}
				sideOffset={sideOffset}
				arrowClassName="bg-popover fill-popover"
				className={cn("pointer-events-none max-w-[min(440px,calc(100vw-40px))] rounded-lg border border-border bg-popover px-3 py-2 text-caption text-popover-foreground shadow-md animate-none data-[state=closed]:animate-none", className)}
			>
				<span className="block max-w-full break-all whitespace-pre-wrap">{content}</span>
			</TooltipContent>
		</Tooltip>
	);
}
