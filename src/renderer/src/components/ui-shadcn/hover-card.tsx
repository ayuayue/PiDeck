"use client";

import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { floatingWheelGuardRef } from "@/lib/floatingWheelGuard";

/**
 * HoverCard 原语组件（基于 Radix UI HoverCardPrimitive 封装）。
 * 用于鼠标悬停延迟展示详细信息，内置 openDelay 与 closeDelay，
 * 避免用户鼠标快速划过列表时频繁触发展示与状态竞态。
 */
function HoverCard({ openDelay = 700, closeDelay = 200, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
	return <HoverCardPrimitive.Root data-slot="hover-card" openDelay={openDelay} closeDelay={closeDelay} {...props} />;
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
	return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

function HoverCardContent({
	className,
	align = "start",
	sideOffset = 8,
	arrowClassName,
	children,
	...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content> & {
	arrowClassName?: string;
}) {
	return (
		<HoverCardPrimitive.Portal>
			<HoverCardPrimitive.Content
				ref={floatingWheelGuardRef}
				data-slot="hover-card-content"
				align={align}
				sideOffset={sideOffset}
				className={cn(
					"z-(--z-popover) w-80 origin-(--radix-hover-card-content-transform-origin) rounded-xl border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-popover)] outline-hidden duration-base ease-out-quint data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:ease-in data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
					className,
				)}
				{...props}
			>
				{children}
				<HoverCardPrimitive.Arrow className={cn("z-(--z-popover) fill-popover stroke-border", arrowClassName)} />
			</HoverCardPrimitive.Content>
		</HoverCardPrimitive.Portal>
	);
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
