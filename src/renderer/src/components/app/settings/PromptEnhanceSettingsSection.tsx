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
import { Badge } from "../../ui-shadcn/badge";
import { Button } from "../../ui-shadcn/button";
import { Switch } from "../../ui-shadcn/switch";
import { Textarea } from "../../ui-shadcn/textarea";
import { ENHANCE_CONTEXT_MAX_CHARS, ENHANCE_CONTEXT_MAX_MESSAGES } from "../../../../../shared/types/enhance";
import { DEFAULT_ENHANCE_SYSTEM_PROMPT, ENHANCE_SYSTEM_PROMPT_MAX_CHARS } from "../../../../../shared/enhanceSystemPrompt";
import { FixedModelSettingRows } from "./FixedModelSettingRows";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";

/** 空白或与内置模板逐字相同都视为「未自定义」，避免把内置模板固化成自定义副本。 */
function normalizeCustomTemplate(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return !trimmed || trimmed === DEFAULT_ENHANCE_SYSTEM_PROMPT ? null : trimmed;
}

export function PromptEnhanceSettingsSection() {
	const setEnhanceModel = useSetAtom(enhanceModelAtom);
	const setEnhanceIncludeContext = useSetAtom(enhanceIncludeContextAtom);
	const contextSwitchId = useId();
	const savingRef = useRef(false);
	const templateSavingRef = useRef(false);
	const [includeContext, setIncludeContext] = useState(false);
	const [template, setTemplate] = useState(DEFAULT_ENHANCE_SYSTEM_PROMPT);
	const [savedTemplate, setSavedTemplate] = useState<string | null>(null);
	const [hydrated, setHydrated] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savingTemplate, setSavingTemplate] = useState(false);

	// 挂载时以磁盘设置为基准（App 水合的 atom 可能晚于本组件挂载，这里以 get 为准）
	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled) return;
				const customTemplate = normalizeCustomTemplate(settings.enhanceSystemPrompt);
				setIncludeContext(settings.enhanceIncludeContext === true);
				setSavedTemplate(customTemplate);
				setTemplate(customTemplate ?? DEFAULT_ENHANCE_SYSTEM_PROMPT);
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

	// 空白/与内置模板完全一致都归一为 null：不把内置模板复制成「自定义」快照，
	// 否则以后内置模板升级时用户会被一份旧的逐字副本钉住。
	const normalizedTemplate = template.trim() || DEFAULT_ENHANCE_SYSTEM_PROMPT;
	const templateDirty = normalizedTemplate !== (savedTemplate ?? DEFAULT_ENHANCE_SYSTEM_PROMPT);

	const persistTemplate = useCallback(async () => {
		if (templateSavingRef.current) return;
		templateSavingRef.current = true;
		setSavingTemplate(true);
		try {
			const next = normalizedTemplate === DEFAULT_ENHANCE_SYSTEM_PROMPT ? null : normalizedTemplate;
			const saved = await desktopApi.settings.update({ enhanceSystemPrompt: next });
			const customTemplate = normalizeCustomTemplate(saved.enhanceSystemPrompt);
			setSavedTemplate(customTemplate);
			setTemplate(customTemplate ?? DEFAULT_ENHANCE_SYSTEM_PROMPT);
			showNotice(t("settings.enhance.saved"), 5000);
		} catch {
			showNotice(t("settings.enhance.saveFailed"), 6000);
		} finally {
			templateSavingRef.current = false;
			setSavingTemplate(false);
		}
	}, [normalizedTemplate]);

	return (
		<SettingsSection id="settings-section-common-prompt-enhance" title={t("settings.enhance.section")} description={t("settings.enhance.sectionDesc")}>
			<FixedModelSettingRows settingKey="enhanceModel" onSaved={setEnhanceModel} modeTitle={t("settings.enhance.modelMode")} modeDesc={t("settings.enhance.modelModeDesc")} savedNotice={t("settings.enhance.saved")} failedNotice={t("settings.enhance.saveFailed")} />

			<SettingRow title={<label htmlFor={contextSwitchId}>{t("settings.enhance.includeContext")}</label>} description={t("settings.enhance.includeContextDesc", { messages: ENHANCE_CONTEXT_MAX_MESSAGES, chars: ENHANCE_CONTEXT_MAX_CHARS })}>
				<Switch id={contextSwitchId} checked={includeContext} disabled={!hydrated || saving} onCheckedChange={(next) => void persistContext(next)} />
			</SettingRow>

			<SettingRow
				stacked
				title={
					<span className="inline-flex flex-wrap items-center gap-2">
						{t("settings.enhance.template")}
						<Badge variant={savedTemplate ? "info" : "neutral"} size="sm">
							{savedTemplate ? t("settings.enhance.templateCustom") : t("settings.enhance.templateDefault")}
						</Badge>
					</span>
				}
				description={t("settings.enhance.templateDesc")}
			>
				<Textarea value={template} rows={12} maxLength={ENHANCE_SYSTEM_PROMPT_MAX_CHARS} disabled={!hydrated || savingTemplate} spellCheck={false} aria-label={t("settings.enhance.template")} className="min-h-48 resize-y font-mono text-xs leading-relaxed" onChange={(event) => setTemplate(event.target.value)} />
				<div className="flex flex-wrap items-center justify-between gap-2 pt-2">
					<span className="text-micro text-muted-foreground">{t("settings.enhance.templateChars", { count: template.length, max: ENHANCE_SYSTEM_PROMPT_MAX_CHARS })}</span>
					<div className="flex items-center gap-1.5">
						<Button type="button" variant="ghost" size="sm" disabled={!hydrated || savingTemplate || template === DEFAULT_ENHANCE_SYSTEM_PROMPT} onClick={() => setTemplate(DEFAULT_ENHANCE_SYSTEM_PROMPT)}>
							{t("settings.enhance.templateReset")}
						</Button>
						<Button type="button" variant="outline" size="sm" disabled={!hydrated || savingTemplate || !templateDirty} onClick={() => void persistTemplate()}>
							{t("settings.enhance.templateSave")}
						</Button>
					</div>
				</div>
			</SettingRow>
		</SettingsSection>
	);
}
