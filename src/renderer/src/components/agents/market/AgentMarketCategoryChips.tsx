import { AGENT_PROFILE_CATEGORIES, type AgentProfileCategory } from "../../../../../shared/types/agentProfile";
import { t, type TranslationKey } from "../../../i18n";
import { cn } from "@/lib/utils";
import type { AgentMarketCategoryFilter } from "../agentMarketFilters";

/**
 * 分类 → i18n key 的显式映射：词典里是字面量 key（agentMarket.category.<x>），
 * 直接拼字符串会丢掉 TranslationKey 的强类型（词典改 key 时静默退化），枚举映射则会被 typecheck 拦住。
 */
export const AGENT_CATEGORY_LABEL_KEYS: Record<AgentProfileCategory, TranslationKey> = {
	general: "agentMarket.category.general",
	translation: "agentMarket.category.translation",
	writing: "agentMarket.category.writing",
	coding: "agentMarket.category.coding",
	analysis: "agentMarket.category.analysis",
};

interface AgentMarketCategoryChipsProps {
	value: AgentMarketCategoryFilter;
	onChange: (value: AgentMarketCategoryFilter) => void;
}

/** 市场分类 chips：全部 + 五个分类，单选，与搜索串共同组成筛选条件。 */
export function AgentMarketCategoryChips({ value, onChange }: AgentMarketCategoryChipsProps) {
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-5 py-2.5" role="group" aria-label={t("agentMarket.fieldCategory")}>
			<AgentMarketCategoryChip label={t("agentMarket.categoryAll")} active={value === "all"} onClick={() => onChange("all")} />
			{AGENT_PROFILE_CATEGORIES.map((category) => (
				<AgentMarketCategoryChip key={category} label={t(AGENT_CATEGORY_LABEL_KEYS[category])} active={value === category} onClick={() => onChange(category)} />
			))}
		</div>
	);
}

interface AgentMarketCategoryChipProps {
	label: string;
	active: boolean;
	onClick: () => void;
}

function AgentMarketCategoryChip({ label, active, onClick }: AgentMarketCategoryChipProps) {
	return (
		<button type="button" aria-pressed={active} onClick={onClick} className={cn("inline-flex h-6 items-center rounded-full border px-2.5 text-xs transition-colors", active ? "border-primary/40 bg-primary/10 font-medium text-primary" : "border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
			{label}
		</button>
	);
}
