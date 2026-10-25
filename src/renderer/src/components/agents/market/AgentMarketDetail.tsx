import { Bot, Copy, Pencil, Pin, RotateCcw, Trash2, X } from "lucide-react";
import type { AgentProfile } from "../../../../../shared/types/agentProfile";
import { t } from "../../../i18n";
import { Badge } from "../../ui-shadcn/badge";
import { Button } from "../../ui-shadcn/button";
import { AGENT_CATEGORY_LABEL_KEYS } from "./AgentMarketCategoryChips";
import { agentBackendLabel } from "./agentBackendOptions";
import { useAgentMarketActions } from "./useAgentMarketActions";

/** 模型标签：空 provider/modelId 视同未设置（更新时用空 ref 表达清空，见 AgentMarketEditor）。 */
function agentModelLabel(agent: AgentProfile): string {
	const model = agent.model;
	if (!model || !model.provider.trim() || !model.modelId.trim()) return t("agentMarket.modelUnset");
	return `${model.provider} / ${model.modelId}`;
}

interface AgentMarketDetailProps {
	agent: AgentProfile;
	selectionDefault: boolean;
	/** 「使用」正在为这个智能体建会话：按钮显示 loading，避免连点建出多个绑定会话。 */
	usePending: boolean;
	onClose: () => void;
	onUse: (agent: AgentProfile) => void;
	onEdit: (agent: AgentProfile) => void;
	onRequestDelete: (agent: AgentProfile) => void;
}

/**
 * 右侧详情面板：完整角色设定预览 + 全套操作（使用/编辑/复制/设为划词默认/恢复内置/删除）。
 * 卡片悬停行只放高频操作，低频与危险操作在这里都有带文字的入口，不需要用户去猜图标。
 */
export function AgentMarketDetail({ agent, selectionDefault, usePending, onClose, onUse, onEdit, onRequestDelete }: AgentMarketDetailProps) {
	const actions = useAgentMarketActions();
	const usage = agent.usageCount > 0 ? t("agentMarket.usage", { count: agent.usageCount }) : t("agentMarket.neverUsed");

	return (
		<aside className="flex w-[320px] shrink-0 flex-col border-l border-border/40" aria-label={t("agentMarket.detailTitle")}>
			<header className="flex shrink-0 items-start justify-between gap-2 border-b border-border/40 px-4 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-muted text-lg leading-none" aria-hidden="true">
						{agent.icon ? agent.icon : <Bot className="size-4 text-muted-foreground" />}
					</span>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
						<p className="truncate text-micro text-muted-foreground">{t(AGENT_CATEGORY_LABEL_KEYS[agent.category])}</p>
					</div>
				</div>
				<Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
					<X className="size-4" aria-hidden="true" />
				</Button>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
				{(agent.builtin || selectionDefault) && (
					<div className="flex flex-wrap items-center gap-1.5">
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
					</div>
				)}
				{agent.description ? <p className="text-xs leading-relaxed text-muted-foreground">{agent.description}</p> : null}
				<div className="flex flex-col gap-1">
					<span className="text-micro font-medium text-foreground">{t("agentMarket.fieldModel")}</span>
					<span className="truncate font-mono text-micro text-muted-foreground" title={agentModelLabel(agent)}>
						{agentModelLabel(agent)}
					</span>
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-micro font-medium text-foreground">{t("agentMarket.backend")}</span>
					<span className="truncate text-micro text-muted-foreground">{agentBackendLabel(agent.backend)}</span>
				</div>
				<div className="flex min-h-0 flex-col gap-1">
					<span className="text-micro font-medium text-foreground">{t("agentMarket.detailPrompt")}</span>
					<pre className="max-h-[300px] overflow-y-auto rounded-lg border border-border/40 bg-bg-muted/40 p-2.5 font-mono text-micro leading-relaxed break-words whitespace-pre-wrap text-foreground/90">{agent.systemPrompt}</pre>
				</div>
				<span className="text-micro text-text-tertiary">{usage}</span>
			</div>

			<footer className="flex shrink-0 flex-col gap-1.5 border-t border-border/40 px-4 py-3">
				<div className="flex items-center gap-1.5">
					<Button type="button" size="sm" className="h-8 flex-1 text-xs" title={t("agentMarket.useInSessionHint")} loading={usePending} onClick={() => onUse(agent)}>
						{t("agentMarket.use")}
					</Button>
					<Button type="button" variant="outline" size="sm" className="h-8 flex-1 gap-1.5 text-xs" onClick={() => onEdit(agent)}>
						<Pencil className="size-3.5" aria-hidden="true" />
						{t("agentMarket.edit")}
					</Button>
				</div>
				{/* 用户反馈：「使用」= 复用会话页面，角色设定隐藏、只显示用户输入——入口旁必须写清这个语义。 */}
				<p className="text-micro leading-snug text-muted-foreground">{t("agentMarket.useInSessionHint")}</p>
				<div className="flex items-center gap-1.5">
					<Button type="button" variant="ghost" size="sm" className="h-7 flex-1 justify-start gap-1.5 px-2 text-xs" onClick={() => void actions.duplicateAgent(agent)}>
						<Copy className="size-3.5" aria-hidden="true" />
						{t("agentMarket.duplicate")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="h-7 flex-1 justify-start gap-1.5 px-2 text-xs" disabled={selectionDefault} onClick={() => void actions.setSelectionDefault(agent)}>
						<Pin className="size-3.5" aria-hidden="true" />
						{t("agentMarket.setSelectionDefault")}
					</Button>
				</div>
				{agent.builtin && (
					<Button type="button" variant="ghost" size="sm" className="h-7 justify-start gap-1.5 px-2 text-xs" onClick={() => void actions.resetBuiltinAgent(agent)}>
						<RotateCcw className="size-3.5" aria-hidden="true" />
						{t("agentMarket.resetBuiltin")}
					</Button>
				)}
				<div className="flex items-center justify-between gap-2">
					{agent.builtin ? <span className="text-micro leading-snug text-muted-foreground">{t("agentMarket.builtinNoDelete")}</span> : <span />}
					<Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-2 text-xs text-destructive hover:text-destructive" disabled={agent.builtin} onClick={() => onRequestDelete(agent)}>
						<Trash2 className="size-3.5" aria-hidden="true" />
						{t("agentMarket.delete")}
					</Button>
				</div>
			</footer>
		</aside>
	);
}
