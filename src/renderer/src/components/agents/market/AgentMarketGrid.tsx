import { Bot, Plus, SearchX } from "lucide-react";
import type { AgentProfile } from "../../../../../shared/types/agentProfile";
import { useListReorder } from "../../../hooks/useListReorder";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { AgentMarketCard } from "./AgentMarketCard";
import { RemovalList, RemovalRow } from "../../removal/RemovalList";

interface AgentMarketGridProps {
	/** 已过滤的智能体（顺序来自 atom 的展示排序）。 */
	agents: AgentProfile[];
	/** 未过滤的完整展示顺序 id（搜索/分类过滤时隐藏的卡片也留在里面）。 */
	orderIds: string[];
	/** 未过滤的智能体总数：区分「空市场」与「搜索无结果」两种空态。 */
	totalCount: number;
	selectionDefaultId: string | null;
	selectedAgentId: string | null;
	/** 「使用」创建会话中的智能体 id：卡片按钮显示 loading 并忽略重复点击。 */
	usePendingId: string | null;
	/** 拖拽排序：只上报真正发生位移的顺序（落盘与乐观更新由工作区负责）。 */
	onReorder: (nextOrder: string[]) => void;
	onOpen: (agent: AgentProfile) => void;
	onUse: (agent: AgentProfile) => void;
	onEdit: (agent: AgentProfile) => void;
	onRequestDelete: (agent: AgentProfile) => void;
	onCreate: () => void;
	/** 批量删除模式：卡片变成选择目标，拖拽手柄收起。 */
	selectionMode: boolean;
	/** 已选中的智能体 id 集合。 */
	selectedIds: ReadonlySet<string>;
	onToggleSelect: (agent: AgentProfile) => void;
}

/**
 * 响应式卡片网格 + 两种空态。
 * 列宽用 auto-fill/minmax：市场现在是随会话列伸缩的页面（不再被 Dialog 限宽 960），
 * 详情面板展开后网格自动减少列数，不需要为「详情是否展开」写第二套断点。
 */
export function AgentMarketGrid({ agents, orderIds, totalCount, selectionDefaultId, selectedAgentId, usePendingId, onReorder, onOpen, onUse, onEdit, onRequestDelete, onCreate, selectionMode, selectedIds, onToggleSelect }: AgentMarketGridProps) {
	// 拖拽排序：可见卡片决定落点，orderIds（完整顺序）决定持久化结果——搜索/分类过滤时
	// 隐藏的卡片在完整顺序里保持原位，不会被「只看得见的部分」洗牌。
	const reorder = useListReorder({ keys: orderIds, visibleKeys: agents.map((agent) => agent.id), orientation: "grid", onReorder });

	if (agents.length === 0) {
		if (totalCount === 0) {
			return (
				<div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
					<span className="flex size-12 items-center justify-center rounded-xl bg-bg-muted text-muted-foreground">
						<Bot className="size-6" aria-hidden="true" />
					</span>
					<p className="text-sm font-medium text-foreground">{t("agentMarket.empty")}</p>
					<p className="max-w-sm text-xs text-muted-foreground">{t("agentMarket.emptyDesc")}</p>
					<Button type="button" size="sm" className="mt-2 h-8 gap-1.5 text-xs" onClick={onCreate}>
						<Plus className="size-3.5" aria-hidden="true" />
						{t("agentMarket.create")}
					</Button>
				</div>
			);
		}
		return (
			<div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
				<SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
				<p className="text-sm text-muted-foreground">{t("agentMarket.noResults")}</p>
			</div>
		);
	}

	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3" {...reorder.containerProps}>
			{/* 删除淡出 + 网格位移收拢：remainingIds 用未过滤的 orderIds——搜索/分类隐藏的卡片
			    不算删除（exit 时长为 0，瞬时让位），真实删除才淡出 100ms 并让兄弟卡片滑位。
			    与 useListReorder 的拖拽 FLIP 互不干扰：重排不 bump 生成数。 */}
			<RemovalList remainingIds={orderIds}>
				{agents.map((agent) => (
					<RemovalRow key={agent.id} itemId={agent.id}>
						<AgentMarketCard
							agent={agent}
							selectionDefault={selectionDefaultId === agent.id}
							active={selectedAgentId === agent.id}
							usePending={usePendingId === agent.id}
							reorder={reorder.itemBinding(agent.id)}
							selectionMode={selectionMode}
							checked={selectedIds.has(agent.id)}
							onToggleSelect={onToggleSelect}
							onOpen={onOpen}
							onUse={onUse}
							onEdit={onEdit}
							onRequestDelete={onRequestDelete}
						/>
					</RemovalRow>
				))}
			</RemovalList>
		</div>
	);
}
