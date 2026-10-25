import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { FILE_SORT_OPTIONS, type FileSortDirection, type FileSortMode } from "../../utils/fileTreeSort";
import { t } from "../../i18n";

interface FileSortControlProps {
	sortMode: FileSortMode;
	sortDirection: FileSortDirection;
	onSortModeChange: (mode: FileSortMode) => void;
	onToggleDirection: () => void;
}

/**
 * 文件树排序控件：单个图标按钮 + 下拉菜单，正序/倒序切换与排序维度选择
 * 合并在同一个菜单组件内（不再拆成 Select + 方向按钮两个控件）。
 *
 * 交互设计：
 * - 平时只展示一个 ArrowUpDown 图标，不占额外宽度、不抢视觉。
 * - 点击图标打开菜单，交由 Radix DropdownMenu 管理开关状态，避免 portal 菜单与外层 hover 边界互相触发。
 * - 菜单第一项是方向切换（升序/倒序，点击翻转），分隔线下为维度列表，
 *   当前维度打勾标识。
 * - 图标 title 实时显示当前排序状态（如「按名称 · 升序」）。
 */
export function FileSortControl(props: FileSortControlProps) {
	const { sortMode, sortDirection, onSortModeChange, onToggleDirection } = props;
	const [open, setOpen] = useState(false);

	const currentLabel = t(FILE_SORT_OPTIONS.find((option) => option.value === sortMode)?.labelKey ?? "drawer.fileSort.name");
	const directionLabel = t(sortDirection === "asc" ? "drawer.fileSortAsc" : "drawer.fileSortDesc");

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="ghost" size="icon-sm" className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" title={`${currentLabel} · ${directionLabel}`} aria-label={t("drawer.fileSort")}>
					<ArrowUpDown size={12} aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-[8.5rem]">
				{/* 方向切换：单个菜单项，点击在正序/倒序间翻转，图标同步变化 */}
				<DropdownMenuItem onClick={onToggleDirection}>
					{sortDirection === "asc" ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}
					{directionLabel}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				{/* 维度列表：当前维度打勾，其余留空位保证对齐 */}
				{FILE_SORT_OPTIONS.map((option) => (
					<DropdownMenuItem key={option.value} onClick={() => onSortModeChange(option.value)}>
						<Check size={14} className={sortMode === option.value ? "opacity-100" : "opacity-0"} aria-hidden="true" />
						{t(option.labelKey)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
