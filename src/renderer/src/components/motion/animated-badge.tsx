"use client";
// beui.dev/components/motion/animated-badge

import { AlertTriangle, Check, Circle, Info, LoaderCircle, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type AnimatedBadgeStatus = "neutral" | "info" | "success" | "warning" | "danger" | "loading";

export type AnimatedBadgeSize = "sm" | "md";

export interface AnimatedBadgeProps extends Omit<HTMLMotionProps<"span">, "children"> {
	status?: AnimatedBadgeStatus;
	size?: AnimatedBadgeSize;
	children?: ReactNode;
	icon?: ReactNode;
	showIcon?: boolean;
	pulse?: boolean;
	contentKey?: string | number;
	/**
	 * 裸图标模式（PiDeck 扩展，官方无此 prop）：去掉胶囊边框/背景/内边距，
	 * 仅保留图标滚动/旋转动画。用于会话 Tab 等紧凑内嵌场景（官方 sm 胶囊仍偏大）。
	 */
	bare?: boolean;
}

// 状态色一律走 foundation 的语义 token（--color-success / -warning / -danger / -info），
// 暗色与皮肤由 token 自己翻转：此前 emerald/amber 字面色 + dark: 变体补偿，与
// ui-shadcn/badge 的语义档会长成两种绿、两种黄（UI 走查 P0.4）。
const STATUS_CLASS: Record<AnimatedBadgeStatus, string> = {
	neutral: "border-border bg-card text-muted-foreground",
	info: "border-info/30 bg-info/10 text-info",
	success: "border-success/30 bg-success/10 text-success",
	warning: "border-warning/30 bg-warning/10 text-warning",
	danger: "border-danger/30 bg-danger/10 text-danger",
	loading: "border-info/30 bg-info/10 text-info",
};

const SIZE_CLASS: Record<AnimatedBadgeSize, string> = {
	sm: "h-6 gap-1.5 px-2 text-micro",
	md: "h-8 gap-2 px-3 text-xs",
};

const ICON_CLASS: Record<AnimatedBadgeSize, string> = {
	sm: "h-3 w-3",
	md: "h-3.5 w-3.5",
};

const ICONS: Record<AnimatedBadgeStatus, LucideIcon> = {
	neutral: Circle,
	info: Info,
	success: Check,
	warning: AlertTriangle,
	danger: X,
	loading: LoaderCircle,
};

const ICON_ROLL_VARIANTS: Variants = {
	initial: {
		opacity: 0.72,
		y: "80%",
		scale: 0.92,
		rotate: -8,
		filter: "blur(6px)",
	},
	animate: {
		opacity: 1,
		y: "0%",
		scale: 1,
		rotate: 0,
		filter: "blur(0px)",
		// 入场模糊只是过渡：动画结束后必须把 filter 卸成 none。
		// 稳态 blur(0px) 仍然是「带滤镜的元素」，子元素的持续旋转（loading 图标）
		// 每帧都会让父层重做图层处理（issue #510 的 A/B/A trace：PaintArtifactCompositor
		// 更新 374 次/2.5s → 0 次，Layerize 线程 CPU 978ms → 1.78ms）。
		transitionEnd: { filter: "none" },
		transition: {
			y: { type: "spring", stiffness: 210, damping: 24, mass: 0.85 },
			scale: { type: "spring", stiffness: 250, damping: 24, mass: 0.75 },
			rotate: { duration: 0.28, ease: EASE_OUT },
			opacity: { duration: 0.28, ease: EASE_OUT },
			filter: { duration: 0.42, ease: EASE_OUT },
		},
	},
	exit: {
		opacity: 0.5,
		y: "-80%",
		scale: 0.96,
		rotate: 8,
		filter: "blur(6px)",
		transition: { duration: 0.22, ease: EASE_OUT },
	},
};

const TEXT_ROLL_VARIANTS: Variants = {
	initial: { opacity: 0.76, y: "85%", filter: "blur(6px)" },
	animate: {
		opacity: 1,
		y: "0%",
		filter: "blur(0px)",
		// 同上：文案没有持续动画，但残留的滤镜层仍会被邻居的每帧重绘拖着重新栅格化。
		transitionEnd: { filter: "none" },
		transition: {
			y: { type: "spring", stiffness: 210, damping: 24, mass: 0.85 },
			opacity: { duration: 0.3, ease: EASE_OUT },
			filter: { duration: 0.42, ease: EASE_OUT },
		},
	},
	exit: {
		opacity: 0.5,
		y: "-85%",
		filter: "blur(6px)",
		transition: { duration: 0.2, ease: EASE_OUT },
	},
};

export function AnimatedBadge({ status = "neutral", size = "md", children, icon, showIcon = true, pulse = status === "loading", contentKey, bare = false, className, ...rest }: AnimatedBadgeProps) {
	const reduce = useReducedMotion();
	const Icon = ICONS[status];
	const resolvedContentKey = contentKey ?? (typeof children === "string" || typeof children === "number" ? children : status);

	return (
		<motion.span
			layout
			transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
			className={cn(
				"relative inline-flex shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full border font-medium tabular-nums",
				"transition-colors duration-300",
				STATUS_CLASS[status],
				SIZE_CLASS[size],
				// bare：无胶囊外观，仅图标（tailwind-merge 消解与 STATUS_CLASS/SIZE_CLASS 的冲突）
				bare && "h-auto gap-0 rounded-none border-0 bg-transparent p-0",
				className,
			)}
			{...rest}
		>
			{pulse && !reduce ? (
				// CSS keyframes 而不是 Motion：这个脉冲在运行态一直转，Motion 会把 scale 每帧
				// 写回内联 transform（常驻 JS driver）。opacity-10 是基准值：全局减弱动效把
				// 动画压成 0 长度后，元素退回基准透明度而不是变成实心圆。
				<span aria-hidden className="absolute inset-0 rounded-full bg-current opacity-10 animate-pideck-pulse" />
			) : null}
			{showIcon ? (
				<span className="relative z-10 inline-flex items-center justify-center overflow-hidden">
					<AnimatePresence mode="popLayout" initial={false}>
						<motion.span key={status} aria-hidden data-badge-icon variants={ICON_ROLL_VARIANTS} initial={reduce ? false : "initial"} animate={reduce ? { opacity: 1 } : "animate"} exit={reduce ? undefined : "exit"} className="inline-flex will-change-transform">
							{status === "loading" && !icon ? (
								/* 加载圈是进行中操作的状态反馈，需在 reduced-motion 下继续旋转；
                   进出场与 pulse 等装饰性 Motion 动效仍由上层 reduce 分支控制。 */
								<span className="inline-flex animate-pideck-spin">
									<Icon className={ICON_CLASS[size]} />
								</span>
							) : (
								(icon ?? <Icon className={ICON_CLASS[size]} />)
							)}
						</motion.span>
					</AnimatePresence>
				</span>
			) : null}
			{children != null ? (
				<span className="relative z-10 inline-flex overflow-hidden">
					<AnimatePresence mode="popLayout" initial={false}>
						<motion.span key={resolvedContentKey} data-badge-label variants={TEXT_ROLL_VARIANTS} initial={reduce ? false : "initial"} animate={reduce ? { opacity: 1 } : "animate"} exit={reduce ? undefined : "exit"} className="inline-block will-change-transform">
							{children}
						</motion.span>
					</AnimatePresence>
				</span>
			) : null}
		</motion.span>
	);
}
