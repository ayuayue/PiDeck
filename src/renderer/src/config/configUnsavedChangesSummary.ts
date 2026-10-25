import { t, type TranslationKey } from "../i18n";

/**
 * Pi / DSH 配置关闭确认：列出**全部**脏 tab（不再只点第一个）。
 * 配置页大多是整页草稿（没有设置页那样的字段黄点目录），所以 item 用该 tab 自己的导航名。
 * DSH 子页脏标记是 `dsh:<navId>`；Pi 侧与 dirtyTabs 编码一致。
 */

/** 单条变更项：后端名 + 导航项名（均为 i18n key，渲染时再翻译）。 */
export type ConfigUnsavedItem = {
	tabKey: TranslationKey;
	itemKey: TranslationKey;
};

export type ConfigUnsavedSummary = {
	/** 完整去重后的变更项列表。 */
	items: ConfigUnsavedItem[];
	/** 变更项总数（恒等于 items.length）。 */
	totalCount: number;
};

type CatalogEntry = {
	match: (key: string) => boolean;
	tabKey: TranslationKey;
	itemKeyFor: (key: string) => TranslationKey;
};

const DSH_NAV_ITEM_KEYS: Record<string, TranslationKey> = {
	overview: "config.dsh.tab.overview",
	models: "config.dsh.tab.models",
	presets: "config.dsh.tab.presets",
	plugins: "config.dsh.tab.plugins",
	security: "config.dsh.tab.security",
	auth: "config.dsh.tab.auth",
	raw: "config.dsh.tab.raw",
};

const CATALOG: readonly CatalogEntry[] = [
	{
		match: (key) => key === "dsh" || key.startsWith("dsh:"),
		tabKey: "config.backend.dsh",
		itemKeyFor: (key) => {
			if (key === "dsh") return "config.dsh.title";
			const nav = key.slice("dsh:".length).split(":")[0] ?? "";
			return DSH_NAV_ITEM_KEYS[nav] ?? "config.dsh.title";
		},
	},
	{ match: (key) => key === "config:models", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.models" },
	{ match: (key) => key === "config:auth", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.auth" },
	{ match: (key) => key === "config:settings", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.settings" },
	{ match: (key) => key === "config:trust", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.trust" },
	{ match: (key) => key === "config:mcp", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.mcp" },
	{ match: (key) => key === "config:raw", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.raw" },
	{ match: (key) => key === "security", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.security" },
	{ match: (key) => key === "extensions", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.extensions" },
	{ match: (key) => key === "skills", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.skills" },
	{ match: (key) => key === "prompts", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.prompts" },
];

function itemIdentity(tabKey: TranslationKey, itemKey: TranslationKey): string {
	return `${tabKey}\0${itemKey}`;
}

export function summarizeConfigUnsavedChanges(dirtyTabs: Iterable<string>): ConfigUnsavedSummary | null {
	const dirty = [...dirtyTabs];
	const seen = new Set<string>();
	const items: Array<{ tabKey: TranslationKey; itemKey: TranslationKey }> = [];

	for (const entry of CATALOG) {
		for (const key of dirty) {
			if (!entry.match(key)) continue;
			const tabKey = entry.tabKey;
			const itemKey = entry.itemKeyFor(key);
			const id = itemIdentity(tabKey, itemKey);
			if (seen.has(id)) continue;
			seen.add(id);
			items.push({ tabKey, itemKey });
		}
	}

	if (items.length === 0) return null;
	return {
		items,
		totalCount: items.length,
	};
}

export function formatConfigUnsavedMessage(summary: ConfigUnsavedSummary | null, translate: typeof t = t): string {
	if (!summary || summary.items.length === 0) return translate("config.unsavedMessage");
	const first = summary.items[0];
	const tab = translate(first.tabKey);
	const item = translate(first.itemKey);
	if (summary.totalCount <= 1) {
		return translate("settings.unsavedMessageDetail", { tab, item });
	}
	return translate("settings.unsavedMessageMore", {
		tab,
		item,
		count: summary.totalCount,
	});
}
