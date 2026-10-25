import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 表单控件高度契约（与 `select.tsx` 的 SelectTrigger 共用同一套档位）：
 *
 * - `default` = 36px：设置行、对话框、卡片表单等所有「一行一个字段」的场景；
 * - `sm` = 32px：仅用于表格行内编辑、卡片内联字段等紧凑容器。
 *
 * 禁止再在调用处写 `className="h-7" / "h-10"` 这类临时高度——那正是设置页与
 * 配置管理页控件参差的来源（`tests/controlHeightContract.test.mjs` 兜底）。
 */
function Input({ className, type, size = "default", ...props }: Omit<React.ComponentProps<"input">, "size"> & { size?: "default" | "sm" }) {
	return (
		<input
			type={type}
			data-slot="input"
			data-size={size}
			className={cn(
				"data-[size=default]:h-9 data-[size=sm]:h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-control shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
				"focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				"aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
