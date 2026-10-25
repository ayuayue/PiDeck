import type { CSSProperties } from "react";

/**
 * beUI TextShimmer 共享 token —— 官方 registry 源码忠实拷贝
 * （beui.dev/components/motion/text-animation）。
 *
 * 适配说明：官方渐变引用的裸 CSS 变量 --muted-foreground / --foreground
 * 由 tailwind.css 的「shadcn CSS variables 兼容层」提供（映射到本项目语义
 * token），因此本文件保持官方原样、无需改动。
 */
export const TEXT_SHIMMER_KEYFRAMES = "@keyframes beui-text-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}";

export const TEXT_SHIMMER_CLASS_NAME = "bg-[length:200%_100%] bg-clip-text text-transparent bg-[linear-gradient(110deg,var(--muted-foreground)_30%,var(--foreground)_50%,var(--muted-foreground)_70%)]";

export function textShimmerStyle(duration: number): CSSProperties {
	return {
		animation: `beui-text-shimmer ${duration}s linear infinite`,
	};
}
