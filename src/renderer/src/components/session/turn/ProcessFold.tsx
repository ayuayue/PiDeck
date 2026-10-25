import { ChevronUp } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { t } from "../../../i18n";
import { lastProcessGroup, type TurnProcessNode } from "../timeline/groupTurnProcess";
import { boundMountedSteps, PROCESS_FOLD_NODE_LIMIT } from "../timeline/turnMountBudget";
import { ErrorStep } from "./ErrorStep";
import { InterimAnswer } from "./InterimAnswer";
import { ProcessGroupStep } from "./ProcessGroupStep";
import { RetryStep } from "./RetryStep";
import type { ProcessGroupOpenState } from "./useProcessGroupState";
import { isGroupOpen } from "./useProcessGroupState";

/**
 * 大折叠栏的内容区（过程组模式）。
 *
 * 语义（用户已确认，对齐 DSH standard 模式）：
 * - 严格按 `groupTurnProcess` 给出的原始时序交替渲染「中间回复 / 过程组 / 一级行」；
 * - 中间回复保持正文样式，不加任何视觉标记；
 * - 过程组自行折叠，组体默认收起（由 `open` 控制）；
 * - 重试 / 错误是**与中间回复同级**的一级行（它们同时是组边界，由分组层决定）；
 * - 最终回答不在这里（`FinalAnswer` 在大折叠栏外常驻）。
 *
 * 挂载预算：`nodes` 与组内成员各自套 `boundMountedSteps`（尾部窗口 + 「显示更早」入口），
 * 否则极端会话（一轮上百步、单组上百成员）会重演 2026-08 渲染进程 OOM 事故。
 */
export type ProcessFoldProps = {
	nodes: readonly TurnProcessNode[];
	/** 大折叠栏是否展开（本组件只在展开时被挂载，保留该 prop 供入口按钮与收起按钮使用） */
	stepsVisible: boolean;
	/** 本轮是否仍在跑：决定最后一个过程组走「正在…」文案 */
	agentRunning?: boolean;
	showThinking?: boolean;
	sessionId?: string;
	/** 当前 live 中间回复 id：它由 TurnRow 挂在大折叠栏外渲染，这里跳过以免双份 */
	liveInterimId?: string;
	/** 本轮的组开合状态（手风琴：自动槽 + 手动集合） */
	groupState: ProcessGroupOpenState;
	onToggleGroup: (groupId: string, open: boolean) => void;
	onOpenFile?: (path: string) => void;
	onOpenExternal: (url: string) => void;
	onCollapse: () => void;
};

export const ProcessFold = memo(function ProcessFold(props: ProcessFoldProps) {
	// 本组件由 TurnRow 按 run 挂载（SessionMessageTimeline.tsx 的 renderRunItem 的 key={item.id}），换 run 必重挂，
	// 所以不像 TurnRow/ProcessGroupStep 那样存 id 判定：只记「展开下界」的原点与批次数。
	// 下界锚在首次点击时的节点总数上：之后尾部追加新节点不会把已展开的旧节点挤回去。
	// VirtualRunList 的 solid↔虚拟切换（多选/导出/恢复锚点）会按行重建，同一 run 的展开进度随之重置
	// （#401 known limitation 2，不是本次改动引入的）。
	const [nodeExpansion, setNodeExpansion] = useState<{ anchor: number; batches: number } | undefined>(undefined);
	const mounted = useMemo(() => boundMountedSteps(props.nodes, PROCESS_FOLD_NODE_LIMIT, nodeExpansion), [props.nodes, nodeExpansion]);
	// 只有本轮仍在跑、且**最后一个节点就是这个组**时它才算「运行中」（决定 shimmer 与「正在…」文案）。
	// 用**节点 id** 而不是数组下标判定：下面渲染的是下界切片 `mounted.items`，
	// 下标在裁剪后与 `props.nodes` 不对应，按下标比较会把「运行中」标到错误的组上。
	// 尾部判定不能用「最后一个组」（2026-08 审计修复）：尾部一旦追加中间回复 / 重试 / 错误行，
	// 说明那个组已经跑完，继续挂 shimmer 报「正在…」就是在撒谎。
	const lastNode = props.nodes[props.nodes.length - 1];
	const runningGroupId = props.agentRunning && lastNode?.kind === "group" ? lastNode.id : undefined;

	const renderNode = (node: TurnProcessNode): ReactNode => {
		switch (node.kind) {
			case "group":
				return (
					<ProcessGroupStep
						group={node}
						running={node.id === runningGroupId}
						open={isGroupOpen(props.groupState, node.id)}
						autoOpen={props.groupState.autoGroupId === node.id}
						onToggle={(open) => props.onToggleGroup(node.id, open)}
						showThinking={props.showThinking}
						sessionId={props.sessionId}
						onOpenFile={props.onOpenFile}
						onOpenExternal={props.onOpenExternal}
					/>
				);
			case "interim":
				// live 那一条由 TurnRow 挂在大折叠栏外，这里跳过以免同一段正文出现两份
				if (node.id === props.liveInterimId) return null;
				// 中间回复引用锚点：settled 正文根节点带 data-message-id，划选可解析来源消息。
				return <InterimAnswer mode="settled" text={node.message.text} hidden={false} isStreaming={false} variant="process" messageId={node.id} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
			case "entry": {
				// 自动重试 / 错误诊断：与中间回复同级的一级行（状态色沿用现状，不做改动）。
				// `TurnStandaloneEntry` 的联合只有这两种，用局部常量收窄即可，不需要兜底分支。
				const { entry } = node;
				return entry.kind === "retry-entry" ? <RetryStep group={{ kind: "retry-group", id: entry.id, message: entry.message }} hidden={false} /> : <ErrorStep group={{ kind: "error-group", id: entry.id, message: entry.message }} hidden={false} />;
			}
		}
	};

	return (
		<div className="flex min-w-0 flex-col">
			{props.stepsVisible && mounted.hiddenCount > 0 && (
				// 超出挂载预算的早期条目入口：与既有「显示更早的 N 条步骤」同款观感
				<button
					type="button"
					className="mt-1 inline-flex h-[26px] items-center gap-2 self-start rounded-[var(--radius-md)] border border-border-subtle bg-[var(--color-chat-card-bg)] px-3 text-chat-detail font-medium text-text-secondary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
					onClick={() => setNodeExpansion((prev) => (prev ? { anchor: prev.anchor, batches: prev.batches + 1 } : { anchor: props.nodes.length, batches: 1 }))}
					title={t("timeline.showEarlierSteps", { count: Math.min(PROCESS_FOLD_NODE_LIMIT, mounted.hiddenCount) })}
				>
					<ChevronUp size={12} aria-hidden="true" />
					<span>{t("timeline.showEarlierSteps", { count: Math.min(PROCESS_FOLD_NODE_LIMIT, mounted.hiddenCount) })}</span>
				</button>
			)}
			{mounted.items.map((node) => (
				<div key={node.id} className="min-w-0">
					{renderNode(node)}
				</div>
			))}
			{props.stepsVisible && (
				<button type="button" className="execution-summary-collapse" onClick={props.onCollapse} title={t("common.collapse")}>
					<ChevronUp size={12} aria-hidden="true" />
					<span>{t("common.collapse")}</span>
				</button>
			)}
		</div>
	);
});
