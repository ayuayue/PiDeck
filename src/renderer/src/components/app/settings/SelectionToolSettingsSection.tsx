/**
 * 设置 → 通用 tab 内的「划词工具」设置区（用户反馈：划词设置属于设置页，不属于智能体）。
 *
 * 数据自持（与 PromptEnhanceSettingsSection / VoiceTranscriptionSettingsSection 同模式）：
 * 不进 CommonTab 草稿，改一项即时写 agent-profiles.json 的市场设置并回写快照 atom，
 * AppBootstrap 的 useAgentProfileSync 也会在 changed 事件后重拉，浮钮随之生效。
 *
 * 系统级划词暂时隐藏：本区只保留应用内划词开关、默认智能体与智能体管理。
 */
import { useCallback, useId, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { agentProfileSnapshotAtom, agentProfilesAtom, agentMarketSettingsAtom, openAgentMarketPageAtom } from "../../../atoms";
import { settingsOpenAtom } from "../../../atoms";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { BUILTIN_TRANSLATE_AGENT_ID, type AgentMarketSettings } from "../../../../../shared/types/agentProfile";
import { Button } from "../../ui-shadcn/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Switch } from "../../ui-shadcn/switch";
import { SettingRow } from "./SettingRows";
import { SettingsSection } from "./SettingsStorageTab";

/** Select 里用哨兵值表示「默认（内置翻译官）」，避免 nullable 值塞进 Radix Select。 */
const DEFAULT_AGENT_SENTINEL = "__default__";

export function SelectionToolSettingsSection() {
	const snapshot = useAtomValue(agentProfileSnapshotAtom);
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const setSnapshot = useSetAtom(agentProfileSnapshotAtom);
	const openMarketPage = useSetAtom(openAgentMarketPageAtom);
	const setSettingsOpen = useSetAtom(settingsOpenAtom);
	const enableId = useId();
	const [saving, setSaving] = useState(false);

	const persist = useCallback(
		async (patch: Partial<Pick<AgentMarketSettings, "selectionToolEnabled" | "selectionToolAgentId">>) => {
			if (saving) return;
			setSaving(true);
			try {
				const saved = await desktopApi.agentProfiles.updateSettings(patch);
				// changed 事件会触发 refetch；这里先写回本地快照让开关/下拉立即响应。
				setSnapshot((current) => (current ? { ...current, settings: saved } : current));
			} catch {
				// 失败回读权威快照（UI 回到真实状态），并保留 toast 级别的可见反馈由调用方补。
				const fresh = await desktopApi.agentProfiles.getSnapshot().catch(() => null);
				if (fresh) setSnapshot(fresh);
			} finally {
				setSaving(false);
			}
		},
		[saving, setSnapshot],
	);

	const defaultAgentValue = settings.selectionToolAgentId ?? DEFAULT_AGENT_SENTINEL;
	const defaultAgentLabel = settings.selectionToolAgentId ? (agents.find((agent) => agent.id === settings.selectionToolAgentId)?.name ?? settings.selectionToolAgentId) : t("agentMarket.modelUnset");

	return (
		<SettingsSection id="settings-section-common-selection-tool" title={t("settings.selectionTool.title")} description={t("settings.selectionTool.description")}>
			<SettingRow anchor="common-selection-tool-enabled" title={<label htmlFor={enableId}>{t("settings.selectionTool.enabled")}</label>} description={t("settings.selectionTool.enabledHint")}>
				<Switch id={enableId} checked={settings.selectionToolEnabled} disabled={saving || !snapshot} onCheckedChange={(checked) => void persist({ selectionToolEnabled: checked })} />
			</SettingRow>

			<SettingRow anchor="common-selection-tool-agent" title={<span>{t("settings.selectionTool.defaultAgent")}</span>} description={t("settings.selectionTool.defaultAgentHint")}>
				<Select value={defaultAgentValue} disabled={saving || agents.length === 0} onValueChange={(value) => void persist({ selectionToolAgentId: value === DEFAULT_AGENT_SENTINEL ? null : value })}>
					<SelectTrigger className="w-full" aria-label={t("settings.selectionTool.defaultAgent")}>
						<SelectValue placeholder={defaultAgentLabel} />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectItem value={DEFAULT_AGENT_SENTINEL}>{t("settings.selectionTool.defaultAgentAuto")}</SelectItem>
							{agents.map((agent) => (
								<SelectItem key={agent.id} value={agent.id}>
									{agent.icon ? `${agent.icon} ` : ""}
									{agent.name}
									{agent.id === BUILTIN_TRANSLATE_AGENT_ID ? ` (${t("agentMarket.builtinBadge")})` : ""}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</SettingRow>

			<SettingRow title={<span>{t("settings.selectionTool.manageAgents")}</span>} description={t("agentMarket.subtitle")}>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						setSettingsOpen(false);
						openMarketPage();
					}}
				>
					{t("settings.selectionTool.manageAgents")}
				</Button>
			</SettingRow>
		</SettingsSection>
	);
}
