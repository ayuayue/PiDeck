// beui.dev/components/motion/text-animation
import { cn } from "@/lib/utils";
import type { ElementType, ReactNode } from "react";
import { TEXT_SHIMMER_CLASS_NAME, TEXT_SHIMMER_KEYFRAMES, textShimmerStyle } from "@/lib/text-shimmer";

export interface TextShimmerProps {
	children: ReactNode;
	as?: ElementType;
	duration?: number;
	className?: string;
	/**
	 * false 时退化为普通实色字，不保留 bg-clip-text 静态渐变。
	 * 扫光动的是 background-position + bg-clip:text：高分辨率 × 高刷新率
	 * 窗口下每帧都触发整窗合成，常驻 infinite 循环实测空闲即占约 1 个 CPU
	 * 核心（GPU 进程为最大头）。关动画却仍挂 clip 渐变，Chromium 还会留一层
	 * 合成；休息态必须卸掉 clip。常驻 UI（品牌字标）只能短暂 enabled。
	 */
	enabled?: boolean;
}

export function TextShimmer({ children, as: Comp = "span", duration = 2.5, className, enabled = true }: TextShimmerProps) {
	return (
		<>
			{enabled ? <style>{TEXT_SHIMMER_KEYFRAMES}</style> : null}
			<Comp
				style={enabled ? textShimmerStyle(duration) : undefined}
				className={cn(
					"inline-block",
					// 休息态用实色字：bg-clip-text 即使 animation:none 也会让 Chromium 留合成层。
					enabled ? TEXT_SHIMMER_CLASS_NAME : "text-foreground",
					className,
				)}
			>
				{children}
			</Comp>
		</>
	);
}
