import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowLeft } from "lucide-react";
import type { AgentProfile } from "../../../../../shared/types/agentProfile";
import { agentMarketSettingsAtom, agentProfileSnapshotAtom, agentProfilesAtom } from "../../../atoms/agent-atoms";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { areAllSelected, pruneSelection, setSelectionFor, toggleSelection } from "../../../utils/selectionSet";
import { BulkSelectionBar } from "../../common/BulkSelectionBar";
import { Badge } from "../../ui-shadcn/badge";
import { Button } from "../../ui-shadcn/button";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { EMPTY_AGENT_MARKET_FILTER, filterAgents, resolveDefaultSelectionAgent, type AgentMarketCategoryFilter } from "../agentMarketFilters";
import { AgentMarketCategoryChips } from "./AgentMarketCategoryChips";
import { AgentMarketDetail } from "./AgentMarketDetail";
import { AgentMarketEditor } from "./AgentMarketEditor";
import { AgentMarketGrid } from "./AgentMarketGrid";
import { AgentMarketHeader } from "./AgentMarketHeader";
import { useAgentMarketActions } from "./useAgentMarketActions";

/** 市场内部路由：列表（含详情侧栏）/ 编辑器。关闭页面不在这里处理，归页面宿主。 */
type AgentMarketRoute = { kind: "market" } | { kind: "editor"; agentId: string | null };

interface AgentMarketWorkspaceProps {
	/** 打开页面时就指定编辑目标的智能体 id（市场外入口传入）；只作初始路由，消费后由宿主清空。 */
	initialEditingAgentId: string | null;
	/** 「使用」：由页面宿主注入的建会话+绑定动作；返回 true 表示已打开绑定会话，市场应收起。 */
	onUseAgent: (agent: AgentProfile) => Promise<boolean>;
	onClose: () => void;
}

/**
 * 智能体工作区：列表（搜索 + 分类 + 卡片网格 + 详情侧栏）+ 编辑器。
 *
 * 路由状态留在这里而不是 atom：它只在市场页面存活期间有意义，页面关闭即卸载，
 * 不需要跨窗口/跨会话持久化。智能体数据与设置仍走 atoms（Lead 的 useAgentProfileSync 同步）。
 * 划词工具设置已移到设置页，市场内不再有设置视图。
 */
export function AgentMarketWorkspace({ initialEditingAgentId, onUseAgent, onClose }: AgentMarketWorkspaceProps) {
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const setSnapshot = useSetAtom(agentProfileSnapshotAtom);
	const actions = useAgentMarketActions();

	const [route, setRoute] = useState<AgentMarketRoute>(() => (initialEditingAgentId ? { kind: "editor", agentId: initialEditingAgentId } : { kind: "market" }));
	const [filter, setFilter] = useState(EMPTY_AGENT_MARKET_FILTER);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<AgentProfile | null>(null);
	const [pendingUseAgentId, setPendingUseAgentId] = useState<string | null>(null);
	const [selectionMode, setSelectionMode] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(() => new Set<string>());
	const [pendingBulkDelete, setPendingBulkDelete] = useState(false);

	const defaultSelection = resolveDefaultSelectionAgent(agents, settings);
	// agents 已经在 atom 里按用户自定义顺序排好（agentProfilesAtom），这里只做搜索/分类收窄。
	const visibleAgents = useMemo(() => filterAgents(agents, filter), [agents, filter]);
	const agentOrderIds = useMemo(() => agents.map((agent) => agent.id), [agents]);
	const selectedAgent = selectedAgentId ? (agents.find((agent) => agent.id === selectedAgentId) ?? null) : null;
	const editingAgent = route.kind === "editor" && route.agentId ? (agents.find((agent) => agent.id === route.agentId) ?? null) : null;
	// 内置智能体不可删除：可选项只来自「可见且非内置」的卡片；全选也只作用于这一批。
	const deletableVisibleIds = useMemo(() => visibleAgents.filter((agent) => !agent.builtin).map((agent) => agent.id), [visibleAgents]);

	// 编辑目标被删除后路由悬空：退回列表，避免编辑器对着不存在的智能体继续编辑。
	useEffect(() => {
		if (route.kind !== "editor" || !route.agentId || editingAgent) return;
		setRoute({ kind: "market" });
	}, [editingAgent, route]);

	// 详情面板选中的智能体被删除后自动收起。
	useEffect(() => {
		if (!selectedAgentId) return;
		if (agents.some((agent) => agent.id === selectedAgentId)) return;
		setSelectedAgentId(null);
	}, [agents, selectedAgentId]);

	// 删除（单个或批量）后收缩选区；列表空了就退出批量态，避免停在无目标的空工具栏上。
	useEffect(() => {
		setSelected((current) =>
			pruneSelection(
				current,
				agents.map((agent) => agent.id),
			),
		);
		if (agents.length === 0) setSelectionMode(false);
	}, [agents]);

	const backToMarket = useCallback(() => {
		setRoute({ kind: "market" });
	}, []);

	const handleQueryChange = useCallback((query: string) => {
		setFilter((current) => ({ ...current, query }));
	}, []);

	const handleCategoryChange = useCallback((category: AgentMarketCategoryFilter) => {
		setFilter((current) => ({ ...current, category }));
	}, []);

	const handleEdit = useCallback((agent: AgentProfile) => {
		setRoute({ kind: "editor", agentId: agent.id });
	}, []);

	/**
	 * 拖拽排序：先乐观更新快照里的 agentOrder（卡片立即落位），再让主进程落盘。
	 * 失败时重拉快照回到权威顺序——拖拽是纯偏好动作，不弹 toast；
	 * 成功路径靠主进程 agent-profiles:changed 再对齐一次（多窗口共享同一份顺序）。
	 */
	const handleReorder = useCallback(
		(nextOrder: string[]) => {
			setSnapshot((current) => (current ? { ...current, agentOrder: nextOrder } : current));
			void desktopApi.agentProfiles.reorder(nextOrder).catch(() => {
				void desktopApi.agentProfiles
					.getSnapshot()
					.then(setSnapshot)
					.catch(() => undefined);
			});
		},
		[setSnapshot],
	);

	/**
	 * 「使用」：交给页面宿主建会话 + 绑定（主进程按绑定注入角色设定，时间线只显示用户输入）。
	 * 成功才收起市场露出新会话；失败留在市场，宿主已经 toast 了原因。
	 * pending 期间忽略重复点击——建会话是异步的，连点会建出多个会话。
	 */
	const handleUse = useCallback(
		async (agent: AgentProfile) => {
			if (pendingUseAgentId) return;
			setPendingUseAgentId(agent.id);
			try {
				if (await onUseAgent(agent)) onClose();
			} catch (error) {
				// 契约上宿主返回 false 而不是 reject；这里兜底未处理的 Promise 拒绝，避免控制台报错。
				showNotice(error instanceof Error ? error.message : String(error), 3500, "error");
			} finally {
				setPendingUseAgentId(null);
			}
		},
		[onClose, onUseAgent, pendingUseAgentId],
	);

	const exitSelection = useCallback(() => {
		setSelectionMode(false);
		setSelected(new Set<string>());
	}, []);

	const enterSelection = useCallback(() => {
		setSelectedAgentId(null);
		setSelectionMode(true);
	}, []);

	const toggleSelect = useCallback((agent: AgentProfile) => {
		if (agent.builtin) return;
		setSelected((current) => toggleSelection(current, agent.id));
	}, []);

	const toggleSelectAllVisible = useCallback(() => {
		setSelected((current) => setSelectionFor(current, deletableVisibleIds, !areAllSelected(current, deletableVisibleIds)));
	}, [deletableVisibleIds]);

	const handleConfirmBulkDelete = async () => {
		const targets = agents.filter((agent) => selected.has(agent.id));
		setPendingBulkDelete(false);
		exitSelection();
		await actions.deleteAgents(targets);
	};

	const handleConfirmDelete = async () => {
		const target = pendingDelete;
		setPendingDelete(null);
		if (target) await actions.deleteAgent(target);
	};

	const routeTitle = t(editingAgent ? "agentMarket.edit" : "agentMarket.create");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{route.kind === "market" ? (
				<>
					<AgentMarketHeader query={filter.query} onQueryChange={handleQueryChange} onCreate={() => setRoute({ kind: "editor", agentId: null })} onToggleSelection={agents.length > 0 ? () => (selectionMode ? exitSelection() : enterSelection()) : undefined} selectionMode={selectionMode} />
					{selectionMode ? (
						<BulkSelectionBar count={selected.size} allSelected={areAllSelected(selected, deletableVisibleIds)} onToggleAll={toggleSelectAllVisible} onExit={exitSelection} onRequestDelete={() => setPendingBulkDelete(true)} />
					) : (
						<AgentMarketCategoryChips value={filter.category} onChange={handleCategoryChange} />
					)}
					<div className="flex min-h-0 flex-1">
						<div className="min-w-0 flex-1 overflow-y-auto px-5 py-3">
							<AgentMarketGrid
								agents={visibleAgents}
								orderIds={agentOrderIds}
								totalCount={agents.length}
								selectionDefaultId={defaultSelection?.id ?? null}
								selectedAgentId={selectedAgentId}
								usePendingId={pendingUseAgentId}
								onReorder={handleReorder}
								onOpen={(agent) => setSelectedAgentId(agent.id)}
								onUse={(agent) => void handleUse(agent)}
								onEdit={handleEdit}
								onRequestDelete={setPendingDelete}
								onCreate={() => setRoute({ kind: "editor", agentId: null })}
								selectionMode={selectionMode}
								selectedIds={selected}
								onToggleSelect={toggleSelect}
							/>
						</div>
						{selectedAgent && (
							<AgentMarketDetail agent={selectedAgent} selectionDefault={defaultSelection?.id === selectedAgent.id} usePending={pendingUseAgentId === selectedAgent.id} onClose={() => setSelectedAgentId(null)} onUse={(agent) => void handleUse(agent)} onEdit={handleEdit} onRequestDelete={setPendingDelete} />
						)}
					</div>
				</>
			) : (
				<>
					<AgentMarketRouteHeader title={routeTitle} builtin={Boolean(editingAgent?.builtin)} onBack={backToMarket} />
					<AgentMarketEditor key={route.agentId ?? "new"} agent={editingAgent} onSaved={backToMarket} onCancel={backToMarket} />
				</>
			)}

			{pendingBulkDelete && <ConfirmDialog title={t("agentMarket.bulkDeleteTitle")} message={t("agentMarket.bulkDeleteBody", { count: selected.size })} confirmLabel={t("common.delete")} danger onCancel={() => setPendingBulkDelete(false)} onConfirm={() => void handleConfirmBulkDelete()} />}
			{pendingDelete && <ConfirmDialog title={t("agentMarket.deleteConfirmTitle")} message={t("agentMarket.deleteConfirmBody", { name: pendingDelete.name })} confirmLabel={t("common.delete")} danger onCancel={() => setPendingDelete(null)} onConfirm={() => void handleConfirmDelete()} />}
		</div>
	);
}

/** 编辑器视图的子头部：返回市场 + 标题（+ 内置徽标）。关闭页面统一交给会话 Tab。 */
function AgentMarketRouteHeader(props: { title: string; builtin: boolean; onBack: () => void }) {
	return (
		<header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/40 px-5 py-3">
			<div className="flex min-w-0 items-center gap-2">
				<Button type="button" variant="ghost" size="icon-sm" className="size-8 shrink-0 text-muted-foreground" title={t("common.back")} aria-label={t("common.back")} onClick={props.onBack}>
					<ArrowLeft className="size-4" aria-hidden="true" />
				</Button>
				<h1 className="truncate text-base font-semibold text-foreground">{props.title}</h1>
				{props.builtin && (
					<Badge variant="neutral" size="sm">
						{t("agentMarket.builtinBadge")}
					</Badge>
				)}
			</div>
		</header>
	);
}
