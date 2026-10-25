import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Ask 全文提示：原生 title 会截断长问题；Portal 避开卡片裁切，超长内容仍可移入滚动和划选。 */
export function PromptTooltip({ text, children }: { text: string; children: ReactElement }) {
	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side="top" align="start" sideOffset={6} collisionPadding={12} className="max-h-[min(24rem,var(--radix-tooltip-content-available-height))] max-w-[min(36rem,calc(100vw-24px))] overflow-y-auto overscroll-contain whitespace-pre-wrap text-left text-wrap [overflow-wrap:anywhere] select-text">
				{text}
			</TooltipContent>
		</Tooltip>
	);
}
