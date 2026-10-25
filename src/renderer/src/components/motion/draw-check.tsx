"use client";

// 借鉴 beui.dev/components/motion/checkbox 的 draw-on 描线动画（ApprovalCard 选中态同款节奏），
// 抽成独立标记组件供 ask 选项行复用；不替换 beui Checkbox 本体，避免把整行选项降级成「圆点+短标签」。

import { motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "@/lib/ease";

const CHECK_PATH = "M5 13l4 4L19 7";

/** 选中态对勾：pathLength 描线 + 轻微缩放弹入；prefers-reduced-motion 下直接静态显示。 */
export function DrawCheck({ size = 14, className }: { size?: number; className?: string }) {
	const reduce = useReducedMotion();
	return (
		<motion.svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={3}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
			initial={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.5 }}
			animate={{ opacity: 1, scale: 1 }}
			transition={reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
		>
			<motion.path d={CHECK_PATH} initial={reduce ? { pathLength: 1 } : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduce ? { duration: 0 } : { duration: 0.3, ease: EASE_OUT, delay: 0.04 }} />
		</motion.svg>
	);
}
