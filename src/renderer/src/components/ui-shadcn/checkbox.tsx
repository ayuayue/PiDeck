import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * shadcn Checkbox（基于 radix-ui 聚合包）。
 * 事件注意：原生 checkbox 用 onChange(e.target.checked)，本组件用 onCheckedChange(checked)。
 * 支持三态：checked 可传 "indeterminate"（Radix 原生能力），半选时显示 MinusIcon。
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				"peer size-4 shrink-0 rounded-xs border border-input shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="group flex items-center justify-center text-current transition-none">
				<CheckIcon className="size-3.5 group-data-[state=indeterminate]:hidden" />
				<MinusIcon className="hidden size-3.5 group-data-[state=indeterminate]:block" />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
