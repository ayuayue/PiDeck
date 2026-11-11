/**
 * WebAgentsDialog — Web 端「智能体」面板（与桌面「智能体」页同源 AgentProfileStore）。
 *
 * 能力边界：**只读 + 使用**。列目录、看角色设定、点「使用」直接建一条绑定该智能体的
 * 草稿会话（标题/后端/模型取智能体配置）；创建/编辑/删除/复制留在桌面端——Web 端
 * 没有图标选择器与长文本编辑器，半套编辑只会造出脏数据。
 *
 * 与「技能与扩展」弹窗同一交互语言：搜索 + 分类筛选 + 单列卡片，移动端整屏。
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, Search, X } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agents/AgentIcon";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { displayProjectName, resolveTargetProjectId } from "./webProjectLabel";
import type { WebAgentProfile, WebProject } from "./webTypes";

/** 目录状态由父级持有（头部提示条与弹窗共用一份，避免两处各拉一次）。 */
export type WebAgentsPhase = "loading" | "ready" | "error";

/** 分类标签复用桌面同名字典（agentMarket.category.*），不在 Web 端另造一套文案。 */
const CATEGORY_LABEL_KEYS = {
	general: "agentMarket.category.general",
	translation: "agentMarket.category.translation",
	writing: "agentMarket.category.writing",
	coding: "agentMarket.category.coding",
	analysis: "agentMarket.category.analysis",
} as const;
const CATEGORY_ORDER = ["general", "translation", "writing", "coding", "analysis"] as const;

function categoryLabel(category: string): string {
	const key = CATEGORY_LABEL_KEYS[category as keyof typeof CATEGORY_LABEL_KEYS];
	return key ? t(key) : category;
}

export function WebAgentsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; agents: WebAgentProfile[]; phase: WebAgentsPhase; projects: WebProject[]; defaultProjectId?: string; onReload: () => void; onUse: (agent: WebAgentProfile, projectId: string) => Promise<void>; useDisabled?: boolean }) {
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [usingId, setUsingId] = useState<string | null>(null);
	// 目标项目：「使用」会真的建会话，所以不能只靠调用方推断。默认取当前会话所在项目
	// （没有会话时取内置对话项目），用户可在这里切到别的目录；记着本次的选择，切会话不重置。
	const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
	const projects = props.projects;
	const targetProjectId = resolveTargetProjectId(projects, pickedProjectId ?? props.defaultProjectId);

	// 每次打开都重拉一次：角色设定/新增智能体多在桌面端改，Web 面板必须看到最新目录。
	const { open, onReload } = props;
	useEffect(() => {
		if (open) onReload();
	}, [open, onReload]);

	const agents = props.agents;
	// 分类 chip 按实际存在的分类给出（0 个的分类不占一行，窄屏更省空间）。
	const categories = useMemo(() => {
		const present = new Set(agents.map((agent) => agent.category));
		return CATEGORY_ORDER.filter((entry) => present.has(entry));
	}, [agents]);
	const filtered = useMemo(() => {
		const keyword = search.trim().toLowerCase();
		return agents.filter((agent) => {
			if (category && agent.category !== category) return false;
			if (!keyword) return true;
			return `${agent.name}\n${agent.description}\n${categoryLabel(agent.category)}`.toLowerCase().includes(keyword);
		});
	}, [agents, category, search]);

	const use = async (agent: WebAgentProfile) => {
		if (!targetProjectId) return;
		setUsingId(agent.id);
		try {
			await props.onUse(agent, targetProjectId);
		} finally {
			setUsingId(null);
		}
	};

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			{/* 移动端整屏（长列表 + 展开角色设定需要高度），桌面收成卡片 */}
			<DialogContent className="flex h-[100dvh] w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[min(80dvh,42rem)] sm:max-w-2xl sm:rounded-xl" showCloseButton={false}>
				<DialogHeader className="flex shrink-0 flex-row items-start gap-2 border-b border-border px-3 py-2.5 text-left">
					<div className="min-w-0 flex-1">
						<DialogTitle className="text-title">{t("agentMarket.title")}</DialogTitle>
						<p className="mt-0.5 text-micro text-muted-foreground">{t("web.agentsSubtitle")}</p>
					</div>
					<Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground" aria-label={t("common.close")} title={t("common.close")} onClick={() => props.onOpenChange(false)}>
						<X className="size-4" aria-hidden="true" />
					</Button>
				</DialogHeader>

				<div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3 py-2">
					<label className="flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
						<Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						<Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("agentMarket.searchPlaceholder")} aria-label={t("agentMarket.searchPlaceholder")} className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-control shadow-none focus-visible:ring-0" />
					</label>
					{categories.length > 1 ? (
						<div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]">
							<CategoryChip label={t("agentMarket.categoryAll")} active={category === null} onClick={() => setCategory(null)} />
							{categories.map((entry) => (
								<CategoryChip key={entry} label={categoryLabel(entry)} active={category === entry} onClick={() => setCategory(entry)} />
							))}
						</div>
					) : null}
					{/* 目标项目：「使用」会立即建会话，建到哪个目录必须在这里可见/可切。
					    用原生 select：移动端弹系统选择器，也不用在 Dialog 里再叠一层 radix 弹层。 */}
					<label className="flex items-center gap-2">
						<span className="shrink-0 text-micro text-muted-foreground">{t("web.agentsTargetProject")}</span>
						<select
							className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-micro text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 disabled:opacity-60"
							value={targetProjectId ?? ""}
							onChange={(event) => setPickedProjectId(event.target.value || null)}
							disabled={projects.length === 0}
							aria-label={t("web.agentsTargetProject")}
							data-testid="web-agents-project"
						>
							{targetProjectId ? null : <option value="">{t("web.agentsNoProject")}</option>}
							{projects.map((project) => (
								<option key={project.id} value={project.id}>
									{displayProjectName(project)}
								</option>
							))}
						</select>
					</label>
				</div>

				{/* scroll-ok: bounded —— 智能体目录是用户维护的短列表（卡片一行一个），不是无限流。 */}
				<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
					{props.phase === "loading" ? (
						<div className="flex items-center justify-center gap-2 py-8 text-caption text-muted-foreground">
							<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
							{t("web.agentsLoading")}
						</div>
					) : props.phase === "error" ? (
						<div role="alert" className="flex flex-col items-center gap-2 py-8 text-caption text-danger">
							<span className="flex items-center gap-1.5">
								<AlertTriangle className="size-4" aria-hidden="true" />
								{t("web.agentsLoadFailed")}
							</span>
							<Button type="button" variant="outline" size="sm" className="h-8 px-3 text-caption" onClick={props.onReload}>
								{t("common.retry")}
							</Button>
						</div>
					) : filtered.length === 0 ? (
						<div className="py-8 text-center text-caption text-muted-foreground">{agents.length === 0 ? t("agentMarket.empty") : t("agentMarket.noResults")}</div>
					) : (
						filtered.map((agent) => {
							const expanded = expandedId === agent.id;
							return (
								<div key={agent.id} className={cn("mb-1.5 overflow-hidden rounded-lg border transition-colors", expanded ? "border-border bg-card" : "border-transparent hover:bg-muted/50")}>
									<button type="button" className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : agent.id)}>
										<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-muted text-lg leading-none" aria-hidden="true">
											<AgentIcon icon={agent.icon} />
										</span>
										<span className="min-w-0 flex-1">
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="min-w-0 truncate text-control font-medium text-foreground">{agent.name}</span>
												{agent.builtin ? <span className="shrink-0 rounded bg-muted px-1 py-px text-micro text-muted-foreground">{t("agentMarket.builtinBadge")}</span> : null}
											</span>
											<span className="mt-0.5 block truncate text-micro text-muted-foreground">{agent.description || categoryLabel(agent.category)}</span>
										</span>
										<ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden="true" />
									</button>
									{expanded ? (
										<div className="flex flex-col gap-2 border-t border-border/60 px-2.5 pt-2 pb-2.5">
											<div className="flex items-center gap-2 text-micro text-muted-foreground">
												<span>{categoryLabel(agent.category)}</span>
												<span aria-hidden="true">·</span>
												<span className="font-mono">{agent.model ? `${agent.model.provider}/${agent.model.modelId}` : t("agentMarket.modelUnset")}</span>
											</div>
											{agent.systemPrompt ? (
												<>
													<span className="text-micro font-medium text-foreground">{t("agentMarket.detailPrompt")}</span>
													{/* scroll-ok: text —— 单一文本块（pre），没有行列表可切。 */}
													<pre className="max-h-52 overflow-y-auto rounded-md bg-bg-muted/40 p-2 font-mono text-micro leading-relaxed break-words whitespace-pre-wrap text-foreground/90">{agent.systemPrompt}</pre>
												</>
											) : null}
											<Button type="button" size="sm" className="h-9 w-full" data-testid="web-agent-use" loading={usingId === agent.id} disabled={props.useDisabled || !targetProjectId || (usingId !== null && usingId !== agent.id)} onClick={() => void use(agent)}>
												{t("agentMarket.use")}
											</Button>
											<p className="text-micro leading-snug text-muted-foreground">{t("web.agentsUseHint")}</p>
										</div>
									) : null}
								</div>
							);
						})
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function CategoryChip(props: { label: string; active: boolean; onClick: () => void }) {
	return (
		<button type="button" className={cn("shrink-0 rounded-full px-2.5 py-1 text-micro transition-colors", props.active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70")} onClick={props.onClick}>
			{props.label}
		</button>
	);
}
