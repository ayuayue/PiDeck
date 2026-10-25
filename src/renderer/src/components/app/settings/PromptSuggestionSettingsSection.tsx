/**
 * 输入预测设置区（设置 → 通用 tab 内的 section）。
 *
 * 自管理保存（与提示词增强同一模式）：开关一拨就落 settings 并写穿 atom，
 * composer 下一轮结束时即按新值决定是否发起预测，无需重开会话。
 * 模型策略（跟随会话模型 / 指定固定模型）走 FixedModelSettingRows——
 * 与提示词增强共用行与保存语义，但写的是独立的 settings.promptSuggestionModel：
 * 预测是每轮都发一次的后台调用，用户常想用便宜的小模型，不必与增强模型绑定。
 */
import { useCallback, useId, useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { showNotice } from "../../../utils/notice";
import { promptSuggestionEnabledAtom, promptSuggestionModelAtom } from "../../../atoms/composer-atoms";
import { Switch } from "../../ui-shadcn/switch";
import { FixedModelSettingRows } from "./FixedModelSettingRows";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";

export function PromptSuggestionSettingsSection() {
	const setEnabledAtom = useSetAtom(promptSuggestionEnabledAtom);
	const setModelAtom = useSetAtom(promptSuggestionModelAtom);
	const switchId = useId();
	const savingRef = useRef(false);
	const [enabled, setEnabled] = useState(true);
	const [saving, setSaving] = useState(false);

	// 挂载时以磁盘设置为基准（App 水合的 atom 可能晚于本组件挂载）。
	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (!cancelled) setEnabled(settings.promptSuggestionEnabled !== false);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	/** 只认保存成功后的返回值：失败回滚，避免「界面关了、下一轮还在偷偷请求模型」。 */
	const persist = useCallback(
		async (next: boolean) => {
			if (savingRef.current) return;
			savingRef.current = true;
			const previous = enabled;
			setEnabled(next);
			setSaving(true);
			try {
				const saved = await desktopApi.settings.update({ promptSuggestionEnabled: next });
				const value = saved.promptSuggestionEnabled !== false;
				setEnabled(value);
				setEnabledAtom(value);
				showNotice(t("settings.promptSuggestion.saved"), 4000);
			} catch {
				setEnabled(previous);
				showNotice(t("settings.promptSuggestion.saveFailed"), 6000);
			} finally {
				savingRef.current = false;
				setSaving(false);
			}
		},
		[enabled, setEnabledAtom],
	);

	return (
		<SettingsSection id="settings-section-common-prompt-suggestion" title={t("settings.promptSuggestion.section")} description={t("settings.promptSuggestion.sectionDesc")}>
			<SettingRow anchor="common-prompt-suggestion-enabled" title={<label htmlFor={switchId}>{t("settings.promptSuggestion.enabled")}</label>} description={t("settings.promptSuggestion.enabledDesc")}>
				<Switch id={switchId} checked={enabled} disabled={saving} onCheckedChange={(value) => void persist(value)} />
			</SettingRow>

			<FixedModelSettingRows settingKey="promptSuggestionModel" onSaved={setModelAtom} modeTitle={t("settings.promptSuggestion.modelMode")} modeDesc={t("settings.promptSuggestion.modelModeDesc")} savedNotice={t("settings.promptSuggestion.saved")} failedNotice={t("settings.promptSuggestion.saveFailed")} />
		</SettingsSection>
	);
}
