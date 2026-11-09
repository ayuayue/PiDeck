"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// 默认 350ms：悬停即弹（0ms）会让鼠标扫过工具条时 tooltip 连环闪现；
// Radix skipDelayDuration=300ms 保证连续浏览时第二个起 0ms 跟随。需要更快/更慢的调用点自行覆盖。
function TooltipProvider({ delayDuration = 350, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
	return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
	return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
	return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/**
 * 只跟随鼠标悬停的 Tooltip 开关：把返回的 open/onOpenChange 交给 <Tooltip>，
 * hoverProps 展开到触发元素上。
 *
 * Radix 默认在触发元素获得 focus 时也弹气泡；而切走窗口再切回来时，浏览器会把焦点
 * 还给上次聚焦的元素，「回来就自动展开 Tab 的项目与路径」就是这么来的（用户反馈）。
 * 用受控 open + 悬停标记只放行指针悬停的开启请求：Radix 的 delayDuration 计时照旧，
 * 键盘聚焦不再自动弹泡（Tab 标题本来就可见，aria-label 仍给读屏完整信息）。
 */
function useHoverOnlyTooltip() {
	const [open, setOpen] = React.useState(false);
	const hoveredRef = React.useRef(false);
	const onOpenChange = React.useCallback((next: boolean) => {
		if (!next) {
			setOpen(false);
			return;
		}
		if (hoveredRef.current) setOpen(true);
	}, []);
	const hoverProps = {
		onPointerEnter: () => {
			hoveredRef.current = true;
		},
		onPointerLeave: () => {
			hoveredRef.current = false;
		},
	};
	return { open, onOpenChange, hoverProps };
}

function TooltipContent({
	className,
	arrowClassName,
	sideOffset = 0,
	children,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
	/** 允许数据型 Tooltip 让箭头与自定义弹层表面保持同色。 */
	arrowClassName?: string;
}) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				className={cn(
					"z-(--z-popover) w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background duration-fast ease-out-quint fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:ease-in",
					className,
				)}
				{...props}
			>
				{children}
				<TooltipPrimitive.Arrow className={cn("z-(--z-popover) size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground", arrowClassName)} />
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, useHoverOnlyTooltip };
