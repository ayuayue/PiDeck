import { Bot, Check, ChevronDown } from "lucide-react";
import type { AgentProfile } from "../../../../shared/types/agentProfile";
import { t } from "../../i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

export type AgentInvokeAgentPickerProps = {
	agents: readonly AgentProfile[];
	selected: AgentProfile | null;
	onSelect: (agentId: string) => void;
	/** 紧凑浮条模式：去掉边框/背景，只留「图标 + 名称 + 箭头」，给 Magpie 式单行条让位。 */
	compact?: boolean;
};

/**
 * 原地工具栏头部的智能体选择器：DropdownMenu 直接铺 agentProfilesAtom 的展示顺序
 * （内置翻译在前，其余按创建时间倒序），不另做搜索——列表通常只有个位数。
 * 触发按钮自身带 aria-label，空列表时禁用并显示「选择智能体」。
 * 紧凑尺寸（h-6 / max-w-150）：头部一行还要放动作切换、目标语言与三个图标按钮。
 */
export function AgentInvokeAgentPicker({ agents, selected, onSelect, compact = false }: AgentInvokeAgentPickerProps) {
	const disabled = agents.length === 0;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label={t("agentInvoke.selectAgent")}
					title={t("agentInvoke.selectAgent")}
					className={
						compact
							? "inline-flex h-6 max-w-[104px] min-w-0 items-center gap-1 rounded-md px-1 text-xs text-foreground transition-colors hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-50"
							: "inline-flex h-6 max-w-[150px] min-w-0 items-center gap-1 rounded-md border border-border-subtle bg-transparent px-1.5 text-xs text-foreground transition-colors hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-50"
					}
				>
					{selected?.icon ? (
						<span className="text-sm leading-none" aria-hidden="true">
							{selected.icon}
						</span>
					) : (
						<Bot size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
					)}
					<span className="min-w-0 truncate">{selected?.name ?? t("agentInvoke.selectAgent")}</span>
					<ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={6} data-selection-tool-ui className="max-h-[min(320px,50vh)] w-[260px] overflow-y-auto">
				<DropdownMenuLabel>{t("agentInvoke.agentLabel")}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{agents.map((agent) => (
					<DropdownMenuItem key={agent.id} onSelect={() => onSelect(agent.id)}>
						{agent.icon ? (
							<span className="w-4 shrink-0 text-center text-sm leading-none" aria-hidden="true">
								{agent.icon}
							</span>
						) : (
							<Bot size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						)}
						<span className="min-w-0 flex-1 truncate">{agent.name}</span>
						{agent.id === selected?.id ? <Check size={13} className="shrink-0 text-primary" aria-hidden="true" /> : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
