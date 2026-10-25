import { Bot, ListChecks, Plus, Search } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";

interface AgentMarketHeaderProps {
	query: string;
	onQueryChange: (query: string) => void;
	onCreate: () => void;
	/** 批量删除模式开关；为空时不渲染入口（例如还没有任何智能体）。 */
	onToggleSelection?: () => void;
	selectionMode?: boolean;
}

/**
 * 「智能体」页面主视图头部：标题 + 说明 + 搜索 + 新建。
 * 页面是会话 Tab 栏里的页面 Tab，关闭由 Tab 负责，头部不再放关闭按钮；
 * 划词工具设置搬到 PiDeck 设置页，这里不再有设置入口。
 */
export function AgentMarketHeader({ query, onQueryChange, onCreate, onToggleSelection, selectionMode = false }: AgentMarketHeaderProps) {
	return (
		<header className="flex shrink-0 flex-col gap-3 border-b border-border/40 px-5 py-3">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
							<Bot className="size-4" aria-hidden="true" />
						</span>
						<h1 className="truncate text-base font-semibold text-foreground">{t("agentMarket.title")}</h1>
					</div>
					<p className="mt-1 truncate text-xs text-muted-foreground">{t("agentMarket.subtitle")}</p>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{onToggleSelection && (
						<Button type="button" variant={selectionMode ? "secondary" : "outline"} size="sm" className="h-8 gap-1.5 text-xs" aria-pressed={selectionMode} title={t("common.bulkSelectHint")} onClick={onToggleSelection}>
							<ListChecks className="size-3.5" aria-hidden="true" />
							{t("common.bulkSelect")}
						</Button>
					)}
					<Button type="button" size="sm" className="h-8 gap-1.5 text-xs" onClick={onCreate}>
						<Plus className="size-3.5" aria-hidden="true" />
						{t("agentMarket.create")}
					</Button>
				</div>
			</div>
			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t("agentMarket.searchPlaceholder")} aria-label={t("agentMarket.searchPlaceholder")} size="sm" className="pl-7 text-xs" />
			</div>
		</header>
	);
}
