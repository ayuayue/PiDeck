import { Trash2 } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";

interface BulkSelectionBarProps {
	/** 已选条数（0 时删除按钮禁用）。 */
	count: number;
	/** 当前可见项是否已全选：决定「全选」按钮的文案。 */
	allSelected: boolean;
	/** 全选 / 取消全选当前可见项。 */
	onToggleAll: () => void;
	/** 退出批量模式并清空选区。 */
	onExit: () => void;
	/** 打开确认框（确认框与真正的删除由页面负责）。 */
	onRequestDelete: () => void;
	className?: string;
}

/**
 * 批量操作条（收藏页 / 智能体页共用）：已选条数 + 全选 + 退出 + 删除所选。
 *
 * 放在筛选 chips 的位置（同一行高度）而不是再叠一行：批量模式下筛选不再有意义，
 * 切换时列表不跳动；删除走页面自己的 ConfirmDialog，这里只上报意图。
 */
export function BulkSelectionBar({ count, allSelected, onToggleAll, onExit, onRequestDelete, className }: BulkSelectionBarProps) {
	return (
		<div className={cn("flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 bg-primary/5 px-5 py-2", className)} role="group" aria-label={t("common.bulkSelection")}>
			<span className="text-xs font-medium text-foreground tabular-nums">{t("common.selectedCount", { count })}</span>
			<Button type="button" variant="ghost" size="xs" className="h-6 text-xs" onClick={onToggleAll}>
				{allSelected ? t("common.clearSelection") : t("common.selectAll")}
			</Button>
			<Button type="button" variant="ghost" size="xs" className="h-6 text-xs text-muted-foreground" onClick={onExit}>
				{t("common.exitSelection")}
			</Button>
			<Button type="button" variant="ghost" size="xs" className="ml-auto h-6 gap-1 text-xs text-muted-foreground hover:text-[var(--color-danger)]" disabled={count === 0} onClick={onRequestDelete}>
				<Trash2 className="size-3.5" aria-hidden="true" />
				{t("common.deleteSelected")}
			</Button>
		</div>
	);
}
