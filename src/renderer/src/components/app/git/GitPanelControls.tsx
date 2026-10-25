import { type ReactNode } from "react";
import { Twistie } from "./GitResourceTree";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { cn } from "../../../lib/utils";

export function PaneHeader(props: { id: string; title: string; count?: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
	return (
		<div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2">
			{/* 标题不参与压缩：「源代码管理图」等固定文案必须完整可见，不能被右侧筛选挤成「源…」。 */}
			<button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs font-medium text-foreground hover:bg-accent" aria-expanded={props.open} aria-controls={`git-pane-${props.id}`} onClick={props.onToggle}>
				<Twistie open={props.open} />
				<span className="whitespace-nowrap text-control font-semibold tracking-normal text-[var(--git-panel-fg)]">{props.title}</span>
			</button>
			{/* 右侧操作区占满剩余宽度并右对齐；标题 shrink-0，筛选可吃掉余量但不挤标题。 */}
			<div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
				{props.children}
				{typeof props.count === "number" && props.count > 0 && <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-micro font-medium text-muted-foreground">{props.count}</span>}
			</div>
		</div>
	);
}

/**
 * Radix Select.Item 禁止 value=""（空串留给「清除选中」语义）。
 * 调用方仍可用 "" 表示「全部 / 未选」；此处映射成稳定哨兵再映射回去。
 */
const EMPTY_FILTER_VALUE = "__git_filter_empty__";

function toSelectValue(value: string): string {
	return value === "" ? EMPTY_FILTER_VALUE : value;
}

function fromSelectValue(value: string): string {
	return value === EMPTY_FILTER_VALUE ? "" : value;
}

/**
 * Compact Git pane filter：shadcn Select。
 * - 必须挂 SelectValue：Radix item-aligned / popper 定位依赖它，缺了菜单会对不齐甚至「点了没反应」。
 * - 抽屉边缘用 popper + collision，避免菜单跑出视口。
 */
export function GitCompactFilter(props: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; ariaLabel: string; className?: string }) {
	const selected = props.options.find((option) => option.value === props.value);
	return (
		<Select value={toSelectValue(props.value)} onValueChange={(next) => props.onChange(fromSelectValue(next))}>
			<SelectTrigger
				aria-label={props.ariaLabel}
				className={cn(
					// 触发器可随剩余宽度变宽以多显示分支名；max-w-full + 标题 shrink-0，避免盖住「源代码管理图」。
					// 不用 font-mono：「全部」等中文标签走面板 --git-ui-font / 项目 base 栈。
					"h-6 w-auto max-w-full min-w-0 gap-1 overflow-hidden rounded-sm border border-transparent px-2 text-control whitespace-nowrap text-text-primary transition-[border-color,background-color] duration-fast hover:border-border-subtle hover:bg-bg-hover focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none [&>svg]:size-3",
					props.className,
				)}
			>
				<SelectValue placeholder={props.ariaLabel}>
					<span className="min-w-0 truncate">{selected?.label ?? props.value}</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent position="popper" align="end" className="max-w-[min(20rem,calc(100vw-16px))]">
				{props.options.map((option) => (
					<SelectItem key={option.value || EMPTY_FILTER_VALUE} value={toSelectValue(option.value)}>
						<span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
