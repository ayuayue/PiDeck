import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	// transition 精确到颜色/阴影/transform/opacity：不再用 transition-all（AGENTS.md 禁裸 all）。
	// active:scale-[0.98] 提供按压反馈（transform 合成器动画，120ms 微反馈档）；
	// 只在按下瞬间生效，hover 不缩放。
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-control font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-fast ease-standard outline-none active:scale-[0.98] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/90",
				destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
				outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
				secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
				ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 px-4 py-2 has-[>svg]:px-3",
				xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
				lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
				icon: "size-9",
				"icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-7",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	loading = false,
	asChild = false,
	children,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
		/**
		 * 提交类操作加载态：禁用按钮 + 行内 spinner（承接 legacy components/ui/Button 的 loading 语义，
		 * 防止双击重复提交）。children 保持渲染，spinner 随内容换行。
		 */
		loading?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} disabled={loading || props.disabled} {...props}>
			{/* asChild 模式（AlertDialogAction/Cancel 等）：Slot 要求 children 必须是单个
          React 元素，不能像普通按钮那样挂两个表达式（loading spinner + children 会
          组成数组 children，触发 “Slot failed to slot onto its children”）。
          asChild 调用方不传 loading，直接透传单元素 children。 */}
			{asChild ? (
				children
			) : (
				<>
					{loading && <span className="size-3.5 shrink-0 animate-pideck-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
					{/* 仅 loading 态包 span 降透明度；常规路径 children 直接挂在按钮上，
              保持 shadcn 官方 inline-flex + gap 横向排布（#115 曾无条件包 span 导致
              “图标+文字”按钮内部变 inline 流式，文字被 h-7 裁切/换行） */}
					{loading ? <span className="opacity-70">{children}</span> : children}
				</>
			)}
		</Comp>
	);
}

export { Button, buttonVariants };
