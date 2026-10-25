import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * shadcn Badge，外加一层「状态语义」变体（UI 走查 P0.4）。
 *
 * 为什么不用 Tailwind 字面色：状态色在 foundation.css 里有语义 token
 * （--color-success / -warning / -danger / -info，暗色与皮肤各自翻转），
 * 页面里写 emerald/amber/rose 字面色就得靠 dark: 变体手工补偿，同一状态
 * 在不同页面会长成两种颜色。状态一律用 success/warning/danger/info/neutral 档。
 *
 * 尺寸两档：default（行内标签，12px）/ sm（表格状态列，20px 高 + text-micro），
 * 状态列不再每次重写 h-5 px-1.5 text-micro。
 */
const badgeVariants = cva("inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border font-medium leading-none transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2", {
	variants: {
		variant: {
			default: "border-transparent bg-primary text-primary-foreground",
			secondary: "border-transparent bg-secondary text-secondary-foreground",
			destructive: "border-transparent bg-destructive text-white",
			outline: "border-border bg-transparent text-foreground",
			success: "border-success/30 bg-success/15 text-success",
			warning: "border-warning/30 bg-warning/15 text-warning",
			danger: "border-danger/30 bg-danger/15 text-danger",
			info: "border-info/30 bg-info/15 text-info",
			neutral: "border-border-subtle bg-bg-muted text-text-secondary",
		},
		size: {
			default: "px-1.5 py-0.5 text-xs",
			sm: "h-5 px-1.5 text-micro",
		},
	},
	defaultVariants: {
		variant: "default",
		size: "default",
	},
});

function Badge({ className, variant = "default", size = "default", ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return <span data-slot="badge" data-variant={variant} data-size={size} className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
