/**
 * 「跟随会话模型 / 指定固定模型」两组设置行 + 模型选择弹窗。
 *
 * 提示词增强与输入预测的模型配置形态完全一致：settings 里都是 `{provider, modelId} | null`，
 * null = 跟随会话模型（优先级链见 shared/enhanceModelPreference），差别只有 settings 字段名、
 * atom 写穿目标与文案。行渲染与保存语义收在这里，各自的 section 只保留自己的开关行。
 *
 * 自管理保存（不进 CommonTab 草稿）：选中即写 settings，只认保存成功后的返回值并写穿 atom，
 * 失败回滚本地态并 toast——绝不让「界面选了、下一轮还用旧模型」这种半截状态存在。
 *
 * 收藏（settings.favoriteModels）与输入框的模型选择器同源，见 hooks/useFavoriteModels：
 * 每次打开都以磁盘为准重新读取，切换收藏当场落盘。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { showNotice } from "../../../utils/notice";
import { useFavoriteModels } from "../../../hooks/useFavoriteModels";
import { ModelPicker } from "../../session/ComposerComponents";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import type { AppSettings, AvailableModel } from "../../../../../shared/types";
import type { EnhanceModelSelection } from "../../../../../shared/enhanceModelPreference";
import { SettingRow, SettingsModelPickerControl } from "./SettingRows";

/** 共用这套行的 settings 字段（形态一致，只有字段名不同）。 */
export type FixedModelSettingKey = "enhanceModel" | "promptSuggestionModel";

/** 计算属性键会退化成索引签名，这里按字段名逐个构造，保持 Partial<AppSettings> 的类型约束。 */
function buildModelPatch(key: FixedModelSettingKey, value: EnhanceModelSelection | null): Partial<AppSettings> {
	return key === "enhanceModel" ? { enhanceModel: value } : { promptSuggestionModel: value };
}

/** 从保存返回值读回该字段（缺失/脏值都归为 null = 跟随会话模型）。 */
function readModelSetting(settings: AppSettings, key: FixedModelSettingKey): EnhanceModelSelection | null {
	const value = settings[key];
	return value ? { provider: value.provider, modelId: value.modelId } : null;
}

export function FixedModelSettingRows(props: {
	settingKey: FixedModelSettingKey;
	/** 保存成功后的写穿（渲染层 atom）；失败不调用（本地态已回滚）。 */
	onSaved: (value: EnhanceModelSelection | null) => void;
	modeTitle: string;
	modeDesc: string;
	/** 保存成功/失败的提示文案（两个功能的生效时机不同，各用自己的 i18n key）。 */
	savedNotice: string;
	failedNotice: string;
}) {
	const { settingKey, onSaved, savedNotice, failedNotice } = props;
	const savingRef = useRef(false);
	const [configured, setConfigured] = useState<EnhanceModelSelection | null>(null);
	const [hydrated, setHydrated] = useState(false);
	const [saving, setSaving] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [modelsRefreshing, setModelsRefreshing] = useState(false);
	const { favoriteModels, refreshFavoriteModels, toggleFavorite } = useFavoriteModels();

	// 挂载时以磁盘设置为基准（App 水合的 atom 可能晚于本组件挂载，这里以 get 为准）。
	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled) return;
				setConfigured(readModelSetting(settings, settingKey));
				setHydrated(true);
			})
			.catch(() => setHydrated(true));
		return () => {
			cancelled = true;
		};
	}, [settingKey]);

	const loadModels = useCallback(async (force = false) => {
		if (force) setModelsRefreshing(true);
		try {
			setModels(await desktopApi.projects.listModelsReport(undefined, force).then((report) => report.models));
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
				const saved = await desktopApi.settings.update(buildModelPatch(settingKey, next));
				const value = readModelSetting(saved, settingKey);
				setConfigured(value);
				onSaved(value);
				showNotice(savedNotice, 5000);
			} catch {
				setConfigured(previous);
				showNotice(failedNotice, 6000);
			} finally {
				savingRef.current = false;
				setSaving(false);
			}
		},
		[configured, failedNotice, onSaved, savedNotice, settingKey],
	);

	// 收藏以磁盘为唯一真相（同 hooks/useFavoriteModels）：打开选择器时重读。
	const openPicker = useCallback(async () => {
		await loadModels();
		await refreshFavoriteModels();
		setPickerOpen(true);
	}, [loadModels, refreshFavoriteModels]);

	const disabled = !hydrated || saving;
	const selectedLabel = configured ? `${configured.provider}/${configured.modelId}` : "";

	return (
		<>
			<SettingRow title={<span>{props.modeTitle}</span>} description={props.modeDesc} alignEnd={false}>
				<Select
					value={configured ? "custom" : "session"}
					disabled={disabled}
					onValueChange={(value) => {
						if (value === "session") void persist(null);
						else void openPicker();
					}}
				>
					<SelectTrigger className="w-full" aria-label={props.modeTitle}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectItem value="session">{t("settings.fixedModel.followSession")}</SelectItem>
							<SelectItem value="custom">{t("settings.fixedModel.customModel")}</SelectItem>
						</SelectGroup>
					</SelectContent>
				</Select>
			</SettingRow>

			{configured && (
				<SettingRow title={<span>{t("settings.fixedModel.model")}</span>} description={saving ? <span className="text-muted-foreground">{t("common.saving")}</span> : undefined} alignEnd={false}>
					<SettingsModelPickerControl value={selectedLabel} placeholder={t("settings.fixedModel.placeholder")} disabled={disabled} onOpen={() => void openPicker()} onClear={() => void persist(null)} />
				</SettingRow>
			)}

			{pickerOpen && (
				<ModelPicker
					models={models}
					loading={models.length === 0 && !modelsRefreshing}
					refreshing={modelsRefreshing}
					onRefresh={() => void loadModels(true)}
					current={configured ?? undefined}
					favoriteModels={favoriteModels}
					onToggleFavorite={toggleFavorite}
					onPick={(model) => {
						setPickerOpen(false);
						void persist({ provider: model.provider, modelId: model.id });
					}}
					onClose={() => setPickerOpen(false)}
				/>
			)}
		</>
	);
}
