import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 轻量状态徽标（shadcn 风格）。
 * 用于会话头部 ctx/cache/cost 等只读信息，避免再散落一套 chip CSS。
 */
export type BadgeVariant = "secondary" | "outline" | "muted";
export type BadgeSize = "sm" | "md";

export function Badge(
	props: HTMLAttributes<HTMLSpanElement> & {
		variant?: BadgeVariant;
		badgeSize?: BadgeSize;
		children: ReactNode;
	},
) {
	const {
		variant = "secondary",
		badgeSize = "sm",
		className,
		children,
		...spanProps
	} = props;

	return (
		<span
			{...spanProps}
			className={cn(
				"ui-badge",
				`ui-badge-${variant}`,
				`ui-badge-${badgeSize}`,
				className,
			)}
		>
			{children}
		</span>
	);
}
