import { Progress as ProgressPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * shadcn Progress 原语（Radix 内核）。
 * 轨道走 muted、填充走主题绿（bg-primary），进度以 aria-valuenow 暴露给辅助技术。
 */
function Progress({ className, value, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
	return (
		<ProgressPrimitive.Root data-slot="progress" className={cn("bg-bg-muted relative h-1.5 w-full overflow-hidden rounded-full", className)} value={value} {...props}>
			<ProgressPrimitive.Indicator data-slot="progress-indicator" className="bg-primary h-full w-full flex-1 transition-all" style={{ transform: `translateX(-${100 - (value || 0)}%)` }} />
		</ProgressPrimitive.Root>
	);
}

export { Progress };
