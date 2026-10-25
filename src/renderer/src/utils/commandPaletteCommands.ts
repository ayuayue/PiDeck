import type { LucideIcon } from "lucide-react";
import { Settings2, SlidersHorizontal } from "lucide-react";
import type { SettingsFocusTarget } from "../atoms";
import { t, type TranslationKey } from "../i18n";
import type { FuzzySearchable } from "./commandPaletteFuzzy";
import { SETTINGS_TAB_KEYWORDS, SETTINGS_TAB_LABEL_KEYS, SETTINGS_TAB_LAYOUT } from "../components/app/settings/settingsTabLayout";
import { isSettingsTabHidden } from "../components/app/settings/settingsTabVisibility";
import { SETTINGS_FIELD_ANCHORS } from "./settingsFieldAnchors";

/**
 * 命令面板条目（Ctrl+P）。
 *
 * 与 sideBar 的会话搜索（MorphingSearch）刻意分开：那边搜「项目/会话」这类实体并跳转，
 * 这边搜「配置项 + 操作」——两类结果混在一个列表里会让两边都变难用（输入 "代理"
 * 既想跳设置页、又可能想找名字带代理的会话）。
 *
 * title / group 存的是**已翻译**字符串而非 i18n key：面板每次打开时重建列表
 * （见 CommandPalette 的 useMemo 依赖），语言切换后自然取到新文案；存 key 反而
 * 要在渲染层再做一次映射。
 */
export type PaletteCommand = FuzzySearchable & {
	id: string;
	/** 结果分组标题（已翻译）；渲染时按首次出现顺序聚合 */
	group: string;
	icon?: LucideIcon;
	/** 右侧快捷键徽标（已按平台格式化），仅操作类命令有 */
	kbd?: string;
	/**
	 * 仅在输入了关键词时才展示。
	 *
	 * 用于「细粒度设置项」这类数量大（几十条）、且只有明确想找某一项时才有意义的条目：
	 * 空查询时全量铺出来会把「操作 / 设置页 / 配置管理」这些顶层入口淹没在长列表里。
	 */
	onlyWhenSearching?: boolean;
	run: () => void;
};

/** 配置管理（pane="config"）的分页入口：与 app-ui-atoms 的 SettingsFocusTarget.configTab 对齐。 */
type ConfigPageCommand = {
	tab: NonNullable<SettingsFocusTarget["configTab"]>;
	titleKey: TranslationKey;
	keywords: readonly string[];
};

const CONFIG_PAGE_COMMANDS: readonly ConfigPageCommand[] = [
	{
		tab: "models",
		titleKey: "command.configModels",
		keywords: ["模型", "供应商", "provider", "model", "api key", "apikey", "模型配置"],
	},
	{
		tab: "auth",
		titleKey: "command.configAuth",
		keywords: ["认证", "登录", "授权", "auth", "login", "oauth", "token"],
	},
	{
		tab: "settings",
		titleKey: "command.configPiSettings",
		keywords: ["pi 配置", "agent 配置", "settings", "config", "参数"],
	},
	{
		tab: "trust",
		titleKey: "command.configTrust",
		keywords: ["信任", "trust", "可信目录", "权限目录"],
	},
	{
		tab: "mcp",
		titleKey: "command.configMcp",
		keywords: ["mcp", "服务", "server", "mcp.json", "适配器"],
	},
	{
		tab: "raw",
		titleKey: "command.configRaw",
		keywords: ["源文件", "配置文件", "json", "raw", "手动编辑"],
	},
];

/**
 * 设置类命令（设置页各 tab + 配置管理各分页）。
 *
 * openSettings 由调用方注入（App 层的 openSettingsAtom setter）——本模块保持纯数据，
 * 不直接依赖 jotai store，便于单测与复用。
 *
 * hiddenModules：用户在外观设置里隐藏的模块。被隐藏的 tab **仍然可搜**（用户找不回来是最糟的结果），
 * 副标题换成「已隐藏，点击显示」；选中后仍直达该 tab（SettingsModal 会在本次弹窗内临时显示它），
 * 不改持久化——要不要永久恢复由用户在外观页自己决定。
 */
export function buildSettingsCommands(openSettings: (target: SettingsFocusTarget) => void, hiddenModules: readonly string[] = []): PaletteCommand[] {
	const group = t("command.groupSettings");
	const subtitle = t("command.openSettingsHint");
	const hiddenSubtitle = t("command.openHiddenSettingsHint");

	const commands: PaletteCommand[] = SETTINGS_TAB_LAYOUT.map((entry) => ({
		id: `settings:${entry.id}`,
		group,
		title: t(SETTINGS_TAB_LABEL_KEYS[entry.id]),
		subtitle: isSettingsTabHidden(hiddenModules, entry.id) ? hiddenSubtitle : subtitle,
		keywords: SETTINGS_TAB_KEYWORDS[entry.id],
		icon: Settings2,
		run: () => openSettings({ tab: entry.id }),
	}));

	const configGroup = t("command.groupConfig");
	for (const page of CONFIG_PAGE_COMMANDS) {
		commands.push({
			id: `config:${page.tab}`,
			group: configGroup,
			title: t(page.titleKey),
			subtitle: t("command.openConfigHint"),
			keywords: page.keywords,
			icon: SlidersHorizontal,
			// pane=config 走配置管理弹窗内部分页；tab=common 保证从任意位置跳过去都有落点
			run: () => openSettings({ tab: "common", pane: "config", configTab: page.tab }),
		});
	}

	// 细粒度设置项：搜到「具体某一项」时直接跳过去（滚到那一行并短暂高亮描边）。
	// subtitle 显示所属 tab 名，让用户预期会被带到哪一页。
	// 标记 onlyWhenSearching：几十条字段级入口在空查询时会把顶层入口淹没。
	const fieldGroup = t("command.groupSettingsFields");
	for (const anchor of SETTINGS_FIELD_ANCHORS) {
		commands.push({
			id: `field:${anchor.slug}`,
			group: fieldGroup,
			title: t(anchor.labelKey),
			subtitle: t(SETTINGS_TAB_LABEL_KEYS[anchor.tab]),
			keywords: anchor.keywords,
			icon: SlidersHorizontal,
			onlyWhenSearching: true,
			run: () => openSettings({ tab: anchor.tab, section: anchor.slug }),
		});
	}

	return commands;
}

/** 分组渲染顺序：操作（最高频）→ 设置页 → 细粒度设置项 → 配置管理；未列出的分组排在最后。 */
export const PALETTE_GROUP_ORDER: readonly TranslationKey[] = ["command.groupActions", "command.groupSettings", "command.groupSettingsFields", "command.groupConfig"];

// 说明：原先这里还有 groupRankedCommands（把打分结果按 PALETTE_GROUP_ORDER 聚合）。
// 迁移到 cmdk 后，分组渲染与组内排序都由 cmdk 负责，只剩「组间顺序」这一条业务约定
// 需要保留，即上面的 PALETTE_GROUP_ORDER，由 CommandPalette 消费。
