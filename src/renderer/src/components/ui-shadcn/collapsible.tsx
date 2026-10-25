import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "../../lib/utils";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
	return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
	return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

/**
 * 折叠内容：tw-animate-css 的 collapsible-down/up 高度动画（200ms 默认档，
 * 走 --radix-collapsible-content-height），Radix Presence 会等 exit 动画结束再卸载，
 * 开合是高度渐变而非 display:none 突变。overflow-hidden 是高度动画的裁剪前提；
 * 消费方若把 CollapsibleContent 放进限高 flex 滚动列，须自行补 shrink-0（排版事故纪律）。
 * reduced-motion 下退回瞬时开合。
 */
function CollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
	return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" className={cn("overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up", className)} {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
