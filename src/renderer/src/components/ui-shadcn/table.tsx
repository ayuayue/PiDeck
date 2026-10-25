import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * shadcn Table 原语（纯 HTML，无 Radix 依赖）。
 * 样式走项目语义 token；大数据列表（如会话管理）用它统一表头/行对齐。
 */
function Table({ className, ...props }: ComponentProps<"table">) {
	return (
		<div data-slot="table-container" className="relative w-full overflow-x-auto">
			<table data-slot="table" className={cn("w-full caption-bottom text-control", className)} {...props} />
		</div>
	);
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
	return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
	return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
	return <tr data-slot="table-row" className={cn("border-b transition-colors hover:bg-bg-hover data-[state=selected]:bg-[color:color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg-panel))]", className)} {...props} />;
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
	return <th data-slot="table-head" className={cn("text-muted-foreground h-9 px-3 text-left align-middle text-caption font-medium whitespace-nowrap", className)} {...props} />;
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
	return <td data-slot="table-cell" className={cn("px-3 py-2 align-middle whitespace-nowrap", className)} {...props} />;
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
