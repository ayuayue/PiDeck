"use client"

import type { ReactNode } from "react";
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
}) {
	const {
		content,
		children,
		className,
		side = "right",
		align = "start",
		sideOffset = 8,
		delayDuration = 250,
	} = props;
	return (
		<Tooltip delayDuration={delayDuration}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent
				side={side}
				align={align}
				sideOffset={sideOffset}
				arrowClassName="bg-popover fill-popover"
				className={cn(
					"max-w-[min(440px,calc(100vw-40px))] rounded-lg border border-border bg-popover px-3 py-2 text-caption text-popover-foreground shadow-md",
					className,
				)}
			>
				<span className="block max-w-full break-all whitespace-pre-wrap">{content}</span>
			</TooltipContent>
		</Tooltip>
	);
}
