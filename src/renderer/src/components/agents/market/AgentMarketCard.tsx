import { Bot, Copy, GripVertical, Pencil, Pin, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentProfile } from "../../../../../shared/types/agentProfile";
import type { ListReorderItemBinding } from "../../../hooks/useListReorder";
import { t } from "../../../i18n";
import { Badge } from "../../ui-shadcn/badge";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui-shadcn/tooltip";
import { useAgentMarketActions } from "./useAgentMarketActions";

interface AgentMarketCardProps {
	agent: AgentProfile;
	/** 该智能体就是划词工具当前生效的默认（卡片角标）。 */
	selectionDefault: boolean;
	/** 详情面板正在展示这张卡片（描边高亮）。 */
	active: boolean;
	onOpen: (agent: AgentProfile) => void;
	onUse: (agent: AgentProfile) => void;
	onEdit: (agent: AgentProfile) => void;
	onRequestDelete: (agent: AgentProfile) => void;
	/** 「使用」正在建会话：按钮显示 loading，避免连点建出多个绑定会话。 */
	usePending: boolean;
	/** 拖拽重排接线（手柄/拖拽态/插入指示线），由 AgentMarketGrid 统一生成。 */
	reorder: ListReorderItemBinding;
	/** 批量删除模式：整卡变成选择目标，点哪儿都是切换选中。 */
	selectionMode: boolean;
	/** 是否已在选区（批量模式下描边高亮）。 */
	checked: boolean;
	/** 切换选中（内置卡片不可选，由卡片自己禁用复选框）。 */
	onToggleSelect: (agent: AgentProfile) => void;
}

/**
 * 市场卡片：图标 + 名称/徽标 + 两行简介 + 使用量；悬停时使用量让位给操作行。
 *
 * 操作行而不是整卡按钮：卡片正文是「打开详情」按钮，操作/删除是同级按钮，
 * 避免 button 套 button 的非法结构；悬停行默认 opacity-0，键盘 focus 时由
 * group-focus-within 显形，保证纯键盘也能操作。
 */
export function AgentMarketCard({ agent, selectionDefault, active, reorder, selectionMode, checked, onToggleSelect, onOpen, onUse, onEdit, onRequestDelete, usePending }: AgentMarketCardProps) {
	const actions = useAgentMarketActions();
	const usage = agent.usageCount > 0 ? t("agentMarket.usage", { count: agent.usageCount }) : t("agentMarket.neverUsed");

	return (
		<article
			ref={reorder.register}
			className={cn(
				"group relative flex h-full flex-col gap-2 rounded-xl border border-border/50 bg-bg-panel/40 p-3 transition-colors hover:border-border hover:bg-bg-panel/70",
				active && "border-primary/40 bg-primary/5 hover:border-primary/40",
				selectionMode && checked && "border-primary/50 bg-primary/10 hover:border-primary/50",
				selectionMode && "cursor-pointer",
				// 拖拽中的卡片只做半透明标记：真正的「拖到哪」由插入指示线回答。
				reorder.dragging && "opacity-40",
			)}
		>
			{/* 批量模式：复选框固定在右上角，整卡点击也是切换（正文按钮的 onClick 已改写）。 */}
			{selectionMode && (
				<span className="absolute top-2 right-2 z-10 flex size-6 items-center justify-center rounded-md bg-background/80">
					<Checkbox checked={checked} disabled={agent.builtin} aria-label={agent.builtin ? t("agentMarket.builtinNoDelete") : t("common.toggleSelection")} title={agent.builtin ? t("agentMarket.builtinNoDelete") : t("common.toggleSelection")} onCheckedChange={() => onToggleSelect(agent)} />
				</span>
			)}
			{/* 插入指示线：网格里插到卡片左侧/右侧（跨行落点也落在相邻卡片旁边）。 */}
			{reorder.dropPosition && <span className={cn("pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary", reorder.dropPosition === "before" ? "-left-1" : "-right-1")} aria-hidden="true" />}
			<button
				type="button"
				className="flex min-w-0 items-start gap-2.5 rounded-lg text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
				title={selectionMode ? t("common.toggleSelection") : t("agentMarket.detailTitle")}
				aria-pressed={selectionMode ? checked : undefined}
				onClick={() => (selectionMode ? onToggleSelect(agent) : onOpen(agent))}
			>
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-muted text-lg leading-none" aria-hidden="true">
					{agent.icon ? agent.icon : <Bot className="size-4 text-muted-foreground" />}
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					{/* 标题行不换行：徽标换到第二行会让各卡片简介起始位置参差；名称放不下时截断，靠 title 兜住全文。 */}
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="min-w-0 truncate text-sm font-medium text-foreground" title={agent.name}>
							{agent.name}
						</span>
						{agent.builtin && (
							<Badge variant="neutral" size="sm">
								{t("agentMarket.builtinBadge")}
							</Badge>
						)}
						{selectionDefault && (
							<Badge variant="info" size="sm">
								{t("agentMarket.selectionDefaultBadge")}
							</Badge>
						)}
					</span>
					{/* 不能再叠 block：Tailwind v4 里 .block 排在 .line-clamp-2 之后，display:block 会覆盖 -webkit-box，截断直接失效。 */}
					<span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{agent.description}</span>
				</span>
			</button>

			{/* mt-auto 把使用量/操作行吸到卡片底部：简介行数不同的卡片也在同一基线上对齐。 */}
			<div className="relative mt-auto flex h-7 shrink-0 items-center">
				<span className={cn("absolute inset-y-0 left-0 flex max-w-full items-center truncate text-micro text-text-tertiary transition-opacity", !selectionMode && "group-hover:opacity-0 group-focus-within:opacity-0")}>{usage}</span>
				{/* 手柄与操作行同处一条底行：悬停时使用量淡出、手柄在左侧显形，标题行与正文保持干净。 */}
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className={cn("absolute inset-y-0 left-0 h-6 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 active:cursor-grabbing", selectionMode && "hidden")}
					title={t("common.dragReorder")}
					aria-label={t("common.dragReorder")}
					{...reorder.gripProps}
					onClick={(event) => event.stopPropagation()}
				>
					<GripVertical className="size-3.5" aria-hidden="true" />
				</Button>
				<div className={cn("absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100", selectionMode && "hidden")}>
					{/* 「使用」不再是调用面板：新建一个绑定该智能体的会话并收起市场，角色设定对时间线隐藏。title 里说明这一点。 */}
					<Button type="button" size="xs" className="mr-0.5 h-6 px-2 text-xs" title={t("agentMarket.useInSessionHint")} loading={usePending} onClick={() => onUse(agent)}>
						{t("agentMarket.use")}
					</Button>
					<Button type="button" variant="ghost" size="icon-xs" title={t("agentMarket.setSelectionDefault")} aria-label={t("agentMarket.setSelectionDefault")} disabled={selectionDefault} onClick={() => void actions.setSelectionDefault(agent)}>
						<Pin className="size-3" aria-hidden="true" />
					</Button>
					<Button type="button" variant="ghost" size="icon-xs" title={t("agentMarket.edit")} aria-label={t("agentMarket.edit")} onClick={() => onEdit(agent)}>
						<Pencil className="size-3" aria-hidden="true" />
					</Button>
					<Button type="button" variant="ghost" size="icon-xs" title={t("agentMarket.duplicate")} aria-label={t("agentMarket.duplicate")} onClick={() => void actions.duplicateAgent(agent)}>
						<Copy className="size-3" aria-hidden="true" />
					</Button>
					{agent.builtin && (
						<Button type="button" variant="ghost" size="icon-xs" title={t("agentMarket.resetBuiltin")} aria-label={t("agentMarket.resetBuiltin")} onClick={() => void actions.resetBuiltinAgent(agent)}>
							<RotateCcw className="size-3" aria-hidden="true" />
						</Button>
					)}
					{agent.builtin ? (
						// 禁用按钮不触发指针事件，Tooltip 必须挂在包了一层的 span 上，否则「为什么不能删」永远弹不出来。
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex" tabIndex={-1}>
									<Button type="button" variant="ghost" size="icon-xs" disabled title={t("agentMarket.builtinNoDelete")} aria-label={t("agentMarket.builtinNoDelete")}>
										<Trash2 className="size-3" aria-hidden="true" />
									</Button>
								</span>
							</TooltipTrigger>
							<TooltipContent>{t("agentMarket.builtinNoDelete")}</TooltipContent>
						</Tooltip>
					) : (
						<Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" title={t("agentMarket.delete")} aria-label={t("agentMarket.delete")} onClick={() => onRequestDelete(agent)}>
							<Trash2 className="size-3" aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>
		</article>
	);
}
