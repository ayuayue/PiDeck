import type { SettingsSectionId, SettingsTabId } from "../../../atoms";
import type { TranslationKey } from "../../../i18n";
import { SETTINGS_FIELD_ANCHORS } from "../../../utils/settingsFieldAnchors";
import { SETTINGS_TAB_IDS, SETTINGS_TAB_KEYWORDS, SETTINGS_TAB_LABEL_KEYS } from "./settingsTabLayout";
import type { SettingsSearchEntry } from "./settingsSearch";

/**
 * 把「tab 本身 + 静态锚点清单」翻成设置搜索的条目表。
 *
 * 与命令面板（`utils/commandPaletteCommands.ts`）同源：两处都读 `SETTINGS_FIELD_ANCHORS`
 * 与 `SETTINGS_TAB_LABEL_KEYS`，所以设置搜索命中的名字与页面上那行标题、Ctrl+P 里的名字
 * 永远一致。区别只在入口：命令面板要记住 Ctrl+P，搜索框就摆在设置页内容区顶部。
 *
 * 两种粒度都出（与锚点清单的约定一致）：tab 级一条（带用户去整页），
 * 字段/分区级一条（滚到那一行并高亮）。隐藏模块的 tab 也照样出条目 ——
 * 选中后由 SettingsModal 的 revealedTabs 临时显示并提示，不能因为隐藏就搜不到。
 *
 * 翻译在渲染期现取（`translate` 由调用方传 `t`），切换语言后条目自然跟着变。
 */
export function buildSettingsSearchEntries(translate: (key: TranslationKey) => string): SettingsSearchEntry<SettingsTabId, SettingsSectionId>[] {
	const entries: SettingsSearchEntry<SettingsTabId, SettingsSectionId>[] = SETTINGS_TAB_IDS.map((tab) => {
		const label = translate(SETTINGS_TAB_LABEL_KEYS[tab]);
		return { id: `tab:${tab}`, tab, title: label, tabLabel: label, keywords: SETTINGS_TAB_KEYWORDS[tab] };
	});
	for (const anchor of SETTINGS_FIELD_ANCHORS) {
		entries.push({
			id: `field:${anchor.slug}`,
			tab: anchor.tab,
			section: anchor.slug,
			title: translate(anchor.labelKey),
			tabLabel: translate(SETTINGS_TAB_LABEL_KEYS[anchor.tab]),
			keywords: anchor.keywords,
		});
	}
	return entries;
}
