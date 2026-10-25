/**
 * 提示词增强设置区（设置 → 通用 tab 内的 section）。
 *
 * 模型策略（跟随会话模型 / 指定固定模型）由 FixedModelSettingRows 承担——与输入预测共用
 * 同一套行与保存语义，两边各自写自己的 settings 字段与 atom；这里只保留本功能独有的
 * 「增强时携带会话上下文」开关。自管理保存（不进 CommonTab 草稿），
 * 与 VoiceTranscriptionSettingsSection 同模式。
 */
import { useCallback, useId, useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { showNotice } from "../../../utils/notice";
import { enhanceIncludeContextAtom, enhanceModelAtom } from "../../../atoms/composer-atoms";
import { Switch } from "../../ui-shadcn/switch";
import { ENHANCE_CONTEXT_MAX_CHARS, ENHANCE_CONTEXT_MAX_MESSAGES } from "../../../../../shared/types/enhance";
import { FixedModelSettingRows } from "./FixedModelSettingRows";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";

export function PromptEnhanceSettingsSection() {
	const setEnhanceModel = useSetAtom(enhanceModelAtom);
	const setEnhanceIncludeContext = useSetAtom(enhanceIncludeContextAtom);
	const contextSwitchId = useId();
	const savingRef = useRef(false);
	const [includeContext, setIncludeContext] = useState(false);
	const [hydrated, setHydrated] = useState(false);
	const [saving, setSaving] = useState(false);

	// 挂载时以磁盘设置为基准（App 水合的 atom 可能晚于本组件挂载，这里以 get 为准）
	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled) return;
				setIncludeContext(settings.enhanceIncludeContext === true);
				setHydrated(true);
			})
			.catch(() => setHydrated(true));
		return () => {
			cancelled = true;
		};
	}, []);

	/** 明确保存成功后才写穿开关，失败绝不能让下一次增强意外携带正文。 */
	const persistContext = useCallback(
		async (next: boolean) => {
			if (savingRef.current) return;
			savingRef.current = true;
			setSaving(true);
			try {
				const saved = await desktopApi.settings.update({ enhanceIncludeContext: next });
				setIncludeContext(saved.enhanceIncludeContext === true);
				setEnhanceIncludeContext(saved.enhanceIncludeContext === true);
				showNotice(t("settings.enhance.saved"), 5000);
			} catch {
				showNotice(t("settings.enhance.saveFailed"), 6000);
			} finally {
				savingRef.current = false;
				setSaving(false);
			}
		},
		[setEnhanceIncludeContext],
	);

	return (
		<SettingsSection id="settings-section-common-prompt-enhance" title={t("settings.enhance.section")} description={t("settings.enhance.sectionDesc")}>
			<FixedModelSettingRows settingKey="enhanceModel" onSaved={setEnhanceModel} modeTitle={t("settings.enhance.modelMode")} modeDesc={t("settings.enhance.modelModeDesc")} savedNotice={t("settings.enhance.saved")} failedNotice={t("settings.enhance.saveFailed")} />

			<SettingRow title={<label htmlFor={contextSwitchId}>{t("settings.enhance.includeContext")}</label>} description={t("settings.enhance.includeContextDesc", { messages: ENHANCE_CONTEXT_MAX_MESSAGES, chars: ENHANCE_CONTEXT_MAX_CHARS })}>
				<Switch id={contextSwitchId} checked={includeContext} disabled={!hydrated || saving} onCheckedChange={(next) => void persistContext(next)} />
			</SettingRow>
		</SettingsSection>
	);
}
