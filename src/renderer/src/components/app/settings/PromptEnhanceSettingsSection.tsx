/**
 * 提示词增强设置区（设置 → 通用 tab 内的 section）。
 *
 * 模型策略：默认「跟随会话模型」；也可指定固定模型（复用会话的 ModelPicker，
 * 数据源 projects.listModelsReport 全量模型）。保存即写 settings.enhanceModel
 * 并写穿 enhanceModelAtom（composer 点击增强时读 atom，无需重启/重开会话）。
 * 自管理保存（不进 CommonTab 草稿），与 VoiceTranscriptionSettingsSection 同模式。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { showNotice } from "../../../utils/notice";
import { useSetAtom } from "jotai";
import { enhanceModelAtom } from "../../../atoms/composer-atoms";
import { ModelPicker } from "../../session/ComposerComponents";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import type { AvailableModel } from "../../../../../shared/types";
import type { EnhanceModelSelection } from "../../../../../shared/enhanceModelPreference";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingsModelPickerControl } from "./SettingRows";

export function PromptEnhanceSettingsSection() {
	const setEnhanceModel = useSetAtom(enhanceModelAtom);
	const [configured, setConfigured] = useState<EnhanceModelSelection | null>(null);
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
			const previous = configured;
			setConfigured(next);
			setSaving(true);
			try {
				await desktopApi.settings.update({ enhanceModel: next });
				setEnhanceModel(next);
			} catch {
				setConfigured(previous);
				showNotice(t("settings.enhance.saveFailed"), 6000);
			} finally {
				setSaving(false);
			}
		},
		[configured, setEnhanceModel],
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
						<SelectItem value="session">{t("settings.enhance.followSession")}</SelectItem>
						<SelectItem value="custom">{t("settings.enhance.customModel")}</SelectItem>
					</SelectContent>
				</Select>
			</SettingRow>

			{configured && (
				<SettingRow title={<span>{t("settings.enhance.model")}</span>} description={saving ? <span className="text-muted-foreground">{t("common.saving")}</span> : undefined} alignEnd={false}>
					<SettingsModelPickerControl value={selectedLabel} placeholder={t("settings.enhance.modelPlaceholder")} onOpen={() => void openPicker()} onClear={() => void persist(null)} />
				</SettingRow>
			)}

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
