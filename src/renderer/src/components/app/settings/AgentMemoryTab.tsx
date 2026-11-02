/**
 * 「记忆」设置 tab：跨三个后端的长期记忆。
 *
 * 从「常用设置」独立出来的理由：这块内容有开关、有统计、有几十条可浏览的条目，
 * 混在常用里把常用页撑成两屏，而它自己又是低频但需要「打开看一眼全貌」的页面。
 *
 * 页面结构按用户的三个问题排：
 *   1. 现在生效吗？（开关：启用 / 自动学习）
 *   2. 占了多少、索引好使吗？（状态 + 导出/导入/清空索引）
 *   3. 里面到底有什么？（条目列表，可展开、可删）
 */

import { useState } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingSwitchRow } from "./SettingRows";
import { AgentMemorySettingsSection } from "./AgentMemorySettingsSection";
import { AgentMemoryEntryList } from "./AgentMemoryEntryList";
import { AgentMemoryStandingEditor } from "./AgentMemoryStandingEditor";

type AgentMemoryTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
};

export function AgentMemoryTab({ draft, updateDraft, isDirty }: AgentMemoryTabProps) {
	// 两个面板互为对方的刷新信号：导出/导入/清空索引会改变条目，删除条目会改变体积统计。
	const [reloadKey, setReloadKey] = useState(0);
	const bump = () => setReloadKey((value) => value + 1);

	return (
		<div className="flex flex-col">
			<SettingsSection id="settings-section-memory-switches" title={t("settings.agentMemorySection")} description={t("settings.agentMemorySectionDesc")}>
				<SettingSwitchRow anchor="memory-enabled" title={t("settings.agentMemoryEnabled")} description={t("settings.agentMemoryEnabledDesc")} checked={draft.agentMemoryEnabled ?? false} dirty={isDirty("agentMemoryEnabled")} onChange={(checked) => updateDraft({ agentMemoryEnabled: checked })} />
				{/* 自动学习会真的调模型（花钱），与「启用」分两格开关；主开关关着时这一格没有意义。 */}
				<SettingSwitchRow
					anchor="memory-auto-learn"
					title={t("settings.agentMemoryAutoLearn")}
					description={t("settings.agentMemoryAutoLearnDesc")}
					checked={draft.agentMemoryAutoLearnEnabled ?? false}
					disabled={!(draft.agentMemoryEnabled ?? false)}
					dirty={isDirty("agentMemoryAutoLearnEnabled")}
					onChange={(checked) => updateDraft({ agentMemoryAutoLearnEnabled: checked })}
				/>
			</SettingsSection>

			{/* STANDING 只有用户能写（Agent 工具改不了），编辑入口独占一区；保存立即生效，不等设置保存。 */}
			<SettingsSection id="settings-section-memory-standing" title={t("settings.agentMemoryStandingSection")} description={t("settings.agentMemoryStandingSectionDesc")} divided>
				<AgentMemoryStandingEditor onChanged={bump} />
			</SettingsSection>

			<SettingsSection id="settings-section-memory-status" title={t("settings.agentMemoryStatus")} description={t("settings.agentMemoryStatusDesc")} divided>
				<AgentMemorySettingsSection reloadKey={reloadKey} onChanged={bump} showLearn={draft.agentMemoryAutoLearnEnabled ?? false} />
			</SettingsSection>

			<SettingsSection id="settings-section-memory-entries" title={t("settings.agentMemoryEntries")} description={t("settings.agentMemoryEntriesDesc")} divided>
				<AgentMemoryEntryList reloadKey={reloadKey} onChanged={bump} />
			</SettingsSection>
		</div>
	);
}
