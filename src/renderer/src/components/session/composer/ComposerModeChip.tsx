import { useState, type ReactNode } from "react";
import { CircleX } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_OUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type ComposerModeChipTone = "plan" | "goal";

/**
 * 模式身份色与 composer-box 的边框着色同源（timeline.css：plan=brand-green、goal=accent）：
 * 用 text-* 定 tone，再用 bg-current/10 + border-current/25 取同一个色做底与描边，
 * 主题色/暗色切换时 chip 自动跟随，不需要第二套色值。
 */
const TONE_CLASS: Record<ComposerModeChipTone, string> = {
	plan: "text-[var(--color-brand-green)]",
	goal: "text-primary",
};

/**
 * 底栏特殊模式 chip（计划 / 目标）。
 *
 * 产品规则（2026-10 用户反馈）：
 * - 普通模式不渲染任何模式控件：旧的闪电图标既不好看也没信息量，普通态的「模式身份」就是「没有 chip」；
 * - 入口收进「+」菜单的模式分组，普通模式不作为可选项列出（普通 = 不在任何特殊模式）；
 * - chip 本身就是退出按钮：鼠标移入或键盘聚焦时，左侧 glyph 旋成带圈 ×（用户给的参考图样式），
 *   点击即 setMode("normal")——与 ComposerArea 的 onCancelPlan 同一条路径，不额外造状态；
 * - 文案只用短名（计划 / 目标），底栏不再出现「模式」二字。
 */
export function ComposerModeChip(props: {
	/** 模式 id：给 e2e/样式定位用，也决定 tone。 */
	mode: ComposerModeChipTone;
	/** 短名（计划 / 目标）。 */
	label: string;
	/** 常态图标（模式 glyph），hover/focus 时换成带圈 ×。 */
	icon: ReactNode;
	/** 悬浮说明 + 可访问名：计划=取消计划、目标=暂停目标。 */
	title: string;
	disabled?: boolean;
	onExit: () => void;
}) {
	const reduce = useReducedMotion();
	// 图标换成 × 只在交互态成立；hover 与键盘聚焦共用一份状态，
	// 避免「鼠标看得到 ×、Tab 用户看不到」的两套反馈。
	const [exitAffordance, setExitAffordance] = useState(false);

	return (
		<motion.button
			type="button"
			data-composer-mode={props.mode}
			className={cn(
				// 圆角与底栏其它按钮（后端/+ 菜单/旧模式触发器）一致用 rounded-md：胶囊形与整排方角按钮不同族。
				"composer-mode-chip inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-current/25 bg-current/10 px-1.5 text-control font-semibold",
				"transition-colors duration-fast hover:bg-current/15 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50",
				TONE_CLASS[props.mode],
			)}
			title={props.title}
			aria-label={props.title}
			disabled={props.disabled}
			initial={reduce ? false : { opacity: 0, scale: 0.84, x: -8 }}
			animate={{ opacity: 1, scale: 1, x: 0 }}
			exit={reduce ? undefined : { opacity: 0, scale: 0.88, x: -6 }}
			transition={{ ...SPRING_SWAP, opacity: { duration: 0.16, ease: EASE_OUT } }}
			onPointerEnter={() => setExitAffordance(true)}
			onPointerLeave={() => setExitAffordance(false)}
			onFocus={() => setExitAffordance(true)}
			onBlur={() => setExitAffordance(false)}
			onClick={props.onExit}
		>
			<span aria-hidden="true" className="relative inline-grid size-4 shrink-0 place-items-center overflow-hidden">
				<AnimatePresence mode="popLayout" initial={false}>
					<motion.span
						key={exitAffordance ? "exit" : "mode"}
						initial={reduce ? false : { opacity: 0, scale: 0.5, rotate: exitAffordance ? -90 : 90 }}
						animate={{ opacity: 1, scale: 1, rotate: 0 }}
						exit={reduce ? undefined : { opacity: 0, scale: 0.5, rotate: exitAffordance ? 90 : -90 }}
						transition={{ duration: 0.16, ease: EASE_OUT }}
						className="col-start-1 row-start-1 inline-flex items-center justify-center"
					>
						{exitAffordance ? <CircleX size={14} strokeWidth={2} /> : props.icon}
					</motion.span>
				</AnimatePresence>
			</span>
			<span className="max-w-28 truncate">{props.label}</span>
		</motion.button>
	);
}
