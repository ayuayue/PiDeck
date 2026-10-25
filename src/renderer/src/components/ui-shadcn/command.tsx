import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";

/**
 * shadcn/command（#115 U5 收尾）：cmdk 标准封装。
 * 用于模型/思考级别/模板等命令面板式选择器，替换旧自研 picker-palette。
 */

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return <CommandPrimitive data-slot="command" className={cn("bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md", className)} {...props} />;
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div data-slot="command-input-wrapper" className="flex h-10 items-center gap-2 border-b px-3">
			<Search className="size-4 shrink-0 opacity-50" />
			<CommandPrimitive.Input data-slot="command-input" className={cn("placeholder:text-muted-foreground flex h-9 w-full rounded-md bg-transparent text-control outline-none disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />
		</div>
	);
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
	return <CommandPrimitive.List data-slot="command-list" className={cn("max-h-[min(420px,50vh)] scroll-py-1 overflow-x-hidden overflow-y-auto", className)} {...props} />;
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return <CommandPrimitive.Empty data-slot="command-empty" className="py-6 text-center text-control" {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return <CommandPrimitive.Group data-slot="command-group" className={cn("text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium", className)} {...props} />;
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
	return <CommandPrimitive.Separator data-slot="command-separator" className={cn("bg-border -mx-1 h-px", className)} {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				"data-[selected=true]:bg-accent-soft data-[selected=true]:text-foreground data-[selected=true]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-control outline-none select-none transition-colors duration-fast data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * cmdk 命令面板外壳：把 Command 装进 Radix Dialog。
 *
 * shadcn 标准里本就有这个组合，项目封装此前只导出了裸 Command（各 picker 自己套
 * Popover/HoverCard）。全局命令面板（Ctrl+P）需要「悬浮面板 + 焦点陷阱 + Esc /
 * 点遮罩关闭 + 关闭后焦点归还」，这些正是 Radix Dialog 已经解决的，不必再手写一遍。
 *
 * 定位与宽度刻意留给调用方（className 透传到 DialogContent）：命令面板要贴在视口
 * 上方（top-14vh）而不是垂直居中，各调用点的观感诉求不同，不该在这里定死。
 */
type CommandDialogProps = React.ComponentProps<typeof Dialog> & {
	/** 无障碍标题（视觉隐藏）：Radix Dialog 要求内容有可访问名 */
	title: string;
	description?: string;
	/** 透传到 DialogContent，用于覆盖定位/宽度 */
	className?: string;
	/**
	 * 透传给内层 cmdk Command（filter / loop / shouldFilter 等）。
	 * 刻意收在一个子对象里而不是平铺：平铺后用 `{...props}` 会把这些 cmdk 专属属性
	 * 一并塞给 Radix Dialog，React 会为未知 DOM 属性报警。
	 */
	commandProps?: React.ComponentProps<typeof CommandPrimitive>;
};

function CommandDialog({ title, description, children, className, commandProps, ...dialogProps }: CommandDialogProps) {
	return (
		<Dialog {...dialogProps}>
			<DialogContent showCloseButton={false} className={cn("gap-0 overflow-hidden p-0", className)}>
				<DialogHeader className="sr-only">
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description ?? title}</DialogDescription>
				</DialogHeader>
				<Command {...commandProps} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-1">
					{children}
				</Command>
			</DialogContent>
		</Dialog>
	);
}

export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator };
