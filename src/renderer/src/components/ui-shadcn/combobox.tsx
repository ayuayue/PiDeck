import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";

import { cn } from "../../lib/utils";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "./command";
import { Command as CommandPrimitive } from "cmdk";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/**
 * 可搜索下拉（shadcn combobox 配方）：Popover + Command 组合。
 * 用于选项量大需要键盘输入过滤的场景（系统字体 350+ 族），
 * 普通少量选项仍用 select.tsx，不要全量替换。
 */

export type ComboboxOption = {
	value: string;
	label: string;
	/** 额外参与搜索匹配的关键词（cmdk keywords） */
	keywords?: string;
	/** 选项右侧的补充说明（如「当前值不在系统列表」标记） */
	hint?: string;
};

export type ComboboxProps = {
	value: string;
	options: ComboboxOption[];
	onValueChange: (value: string) => void;
	placeholder?: string;
	searchPlaceholder?: string;
	emptyLabel?: string;
	/** 触发按钮的可访问名 */
	ariaLabel?: string;
	disabled?: boolean;
	className?: string;
};

export function Combobox({ value, options, onValueChange, placeholder, searchPlaceholder, emptyLabel, ariaLabel, disabled, className }: ComboboxProps) {
	const [open, setOpen] = React.useState(false);
	const selected = options.find((option) => option.value === value);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					role="combobox"
					aria-expanded={open}
					aria-label={ariaLabel}
					disabled={disabled}
					className={cn(
						"border-input bg-background ring-offset-background focus-visible:ring-ring flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-colors",
						"focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
						"disabled:cursor-not-allowed disabled:opacity-50",
						"[&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate",
						className,
					)}
				>
					<span className={cn(!selected && "text-muted-foreground")}>{selected ? selected.label : (placeholder ?? "")}</span>
					<ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
				<Command
					// 默认 cmdk 过滤只匹配 value 字符串；这里放宽为「value/label/keywords 的包含匹配」，
					// 支持中文关键词（如「跟随」「代码字体」）命中英文 value
					filter={(itemValue, search) => {
						const option = options.find((candidate) => candidate.value === itemValue);
						if (!option) return 1;
						const haystack = `${option.value} ${option.label} ${option.keywords ?? ""}`.toLowerCase();
						return haystack.includes(search.toLowerCase()) ? 1 : 0;
					}}
				>
					<div className="border-b p-1.5">
						<div className="flex h-8 items-center gap-2 rounded-md border bg-transparent px-2.5">
							<Search className="size-4 shrink-0 opacity-50" aria-hidden />
							{/* 直接用 cmdk.Input：不复用 command.tsx 的 CommandInput（它自带 h-10 外壳与底边框，内嵌形态太宽） */}
							<CommandPrimitive.Input placeholder={searchPlaceholder} className="placeholder:text-muted-foreground h-7 w-full bg-transparent text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50" />
						</div>
					</div>
					<CommandList>
						<CommandEmpty>{emptyLabel}</CommandEmpty>
						<CommandGroup>
							{options.map((option) => (
								<CommandItem
									key={option.value}
									value={option.value}
									keywords={option.keywords ? [option.keywords] : undefined}
									onSelect={(current) => {
										// 重复点同一项 = 取消选择（回退到「跟随」空值语义，与 filter 的取值约定一致）
										onValueChange(current === value ? "" : current);
										setOpen(false);
									}}
								>
									<Check className={cn("mr-2 size-4", option.value === value ? "opacity-100" : "opacity-0")} />
									<span className="min-w-0 flex-1 truncate">{option.label}</span>
									{option.hint && <span className="text-muted-foreground shrink-0 text-xs">{option.hint}</span>}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
