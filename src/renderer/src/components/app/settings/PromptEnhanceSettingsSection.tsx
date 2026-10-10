/**
 * 提示词增强设置区（设置 → 通用 tab 内的 section）。
 *
 * 模型策略：默认「跟随会话模型」；也可指定固定模型（复用会话的 ModelPicker，
 * 数据源 projects.listModelsReport 全量模型）。保存即写 settings.enhanceModel
 * 并写穿 enhanceModelAtom（composer 点击增强时读 atom，无需重启/重开会话）。
 * 自管理保存（不进 CommonTab 草稿），与 VoiceTranscriptionSettingsSection 同模式。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { showNotice } from "../../../utils/notice";
import { useSetAtom } from "jotai";
import { enhanceIncludeContextAtom, enhanceModelAtom } from "../../../atoms/composer-atoms";
import { ModelPicker } from "../../session/ComposerComponents";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Switch } from "../../ui-shadcn/switch";
import { ENHANCE_CONTEXT_MAX_CHARS, ENHANCE_CONTEXT_MAX_MESSAGES } from "../../../../../shared/types/enhance";
import type { AvailableModel } from "../../../../../shared/types";
import type { EnhanceModelSelection } from "../../../../../shared/enhanceModelPreference";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingsModelPickerControl } from "./SettingRows";

export function PromptEnhanceSettingsSection() {
	const setEnhanceModel = useSetAtom(enhanceModelAtom);
	const setEnhanceIncludeContext = useSetAtom(enhanceIncludeContextAtom);
	const contextSwitchId = useId();
	const savingRef = useRef(false);
	const [configured, setConfigured] = useState<EnhanceModelSelection | null>(null);
	const [includeContext, setIncludeContext] = useState(false);
	const [hydrated, setHydrated] = useState(false);
	const [saving, setSaving] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [modelsRefreshing, setModelsRefreshing] = useState(false);

	// 挂载时以磁盘设置为基准（App 水合的 atom 可能晚于本组件挂载，这里以 get 为准）
	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled) return;
				setConfigured(settings.enhanceModel ?? null);
				setIncludeContext(settings.enhanceIncludeContext === true);
				setHydrated(true);
			})
			.catch(() => setHydrated(true));
		return () => {
			cancelled = true;
		};
	}, []);

	const loadModels = useCallback(async (force = false) => {
		if (force) setModelsRefreshing(true);
		try {
			setModels(await desktopApi.projects.listModelsReport(undefined, force).then((r) => r.models));
		} catch {
			setModels([]);
		} finally {
			setModelsRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void loadModels();
	}, [loadModels]);

	/** 选择即保存：写 settings + 写穿 atom；失败回滚本地态并 toast。 */
	const persist = useCallback(
		async (next: EnhanceModelSelection | null) => {
			if (savingRef.current) return;
			savingRef.current = true;
			const previous = configured;
			setConfigured(next);
			setSaving(true);
			try {
				const saved = await desktopApi.settings.update({ enhanceModel: next });
				setConfigured(saved.enhanceModel ?? null);
				setEnhanceModel(saved.enhanceModel ?? null);
				showNotice(t("settings.enhance.saved"), 5000);
			} catch {
				setConfigured(previous);
				showNotice(t("settings.enhance.saveFailed"), 6000);
			} finally {
				savingRef.current = false;
				setSaving(false);
			}
		},
		[configured, setEnhanceModel],
	);

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

	const openPicker = useCallback(async () => {
		await loadModels();
		setPickerOpen(true);
	}, [loadModels]);

	const selectedLabel = useMemo(() => (configured ? `${configured.provider}/${configured.modelId}` : ""), [configured]);

	return (
		<SettingsSection title={t("settings.enhance.section")} description={t("settings.enhance.sectionDesc")}>
			<SettingRow title={<span>{t("settings.enhance.modelMode")}</span>} description={t("settings.enhance.modelModeDesc")} alignEnd={false}>
				<Select
					value={configured ? "custom" : "session"}
					disabled={!hydrated || saving}
					onValueChange={(value) => {
						if (value === "session") void persist(null);
						else void openPicker();
					}}
				>
					<SelectTrigger className="w-full" aria-label={t("settings.enhance.modelMode")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectItem value="session">{t("settings.enhance.followSession")}</SelectItem>
							<SelectItem value="custom">{t("settings.enhance.customModel")}</SelectItem>
						</SelectGroup>
					</SelectContent>
				</Select>
			</SettingRow>

			{configured && (
				<SettingRow title={<span>{t("settings.enhance.model")}</span>} description={saving ? <span className="text-muted-foreground">{t("common.saving")}</span> : undefined} alignEnd={false}>
					<SettingsModelPickerControl value={selectedLabel} placeholder={t("settings.enhance.modelPlaceholder")} disabled={!hydrated || saving} onOpen={() => void openPicker()} onClear={() => void persist(null)} />
				</SettingRow>
			)}

			<SettingRow title={<label htmlFor={contextSwitchId}>{t("settings.enhance.includeContext")}</label>} description={t("settings.enhance.includeContextDesc", { messages: ENHANCE_CONTEXT_MAX_MESSAGES, chars: ENHANCE_CONTEXT_MAX_CHARS })}>
				<Switch id={contextSwitchId} checked={includeContext} disabled={!hydrated || saving} onCheckedChange={(next) => void persistContext(next)} />
			</SettingRow>

			{pickerOpen && (
				<ModelPicker
					models={models}
					loading={models.length === 0 && !modelsRefreshing}
					refreshing={modelsRefreshing}
					onRefresh={() => void loadModels(true)}
					current={configured ?? undefined}
					favoriteModels={[]}
					onToggleFavorite={() => undefined}
					onPick={(model) => {
						setPickerOpen(false);
						void persist({ provider: model.provider, modelId: model.id });
					}}
					onClose={() => setPickerOpen(false)}
				/>
			)}
		</SettingsSection>
	);
}
