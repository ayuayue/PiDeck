import { memo } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { HIDEABLE_COMPOSER_FEATURE_IDS, toggleHiddenComposerFeature, type HideableComposerFeatureId } from "../../../../../shared/composerFeatures";
import { t, type TranslationKey } from "../../../i18n";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow } from "./SettingRows";
import { Switch } from "../../ui-shadcn/switch";

type ComposerFeaturesSectionProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
};

/** 每行的标题 key（顺序即 shared/composerFeatures.ts 清单顺序）。 */
const FEATURE_LABEL_KEYS: Record<HideableComposerFeatureId, TranslationKey> = {
	security: "settings.composer.security",
	quickMessages: "settings.composer.quickMessages",
	gitBranch: "settings.composer.gitBranch",
	enhance: "settings.composer.enhance",
	voice: "settings.composer.voice",
};

/**
 * 外观设置「输入框功能显示」分区：每个可隐藏的输入框底栏入口一行开关（开 = 显示）。
 *
 * 与「功能模块」分区同一套交互：只隐藏入口，不清配置、不停功能——快捷消息的全局快捷键、
 * 提示词增强的 sidecar、语音转写配置、实际生效的安全等级都照常工作。整组共用一个
 * AppSettings 字段（hiddenComposerFeatures），黄点挂分区标题而非逐行。
 */
export const ComposerFeaturesSection = memo(function ComposerFeaturesSection(props: ComposerFeaturesSectionProps) {
	const { draft, updateDraft, isDirty } = props;
	const hiddenFeatures = draft.hiddenComposerFeatures ?? [];

	return (
		<SettingsSection
			title={
				<span className="inline-flex items-center gap-1.5">
					{t("settings.composer.title")}
					<DirtyMarker dirty={isDirty("hiddenComposerFeatures")} label={t("settings.composer.title")} />
				</span>
			}
			description={t("settings.composer.sectionDesc")}
		>
			{HIDEABLE_COMPOSER_FEATURE_IDS.map((featureId) => {
				const hidden = hiddenFeatures.includes(featureId);
				const label = t(FEATURE_LABEL_KEYS[featureId]);
				return (
					<SettingRow key={featureId} title={<span>{label}</span>}>
						<Switch checked={!hidden} onCheckedChange={(checked) => updateDraft({ hiddenComposerFeatures: toggleHiddenComposerFeature(hiddenFeatures, featureId, !checked) })} aria-label={label} />
					</SettingRow>
				);
			})}
		</SettingsSection>
	);
});
