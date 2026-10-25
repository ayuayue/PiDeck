import { memo } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker } from "./SettingRows";
import { ExternalEditorsSection } from "./ExternalEditorsSection";

type EditorsTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
};

/**
 * 设置弹框「外部编辑器」tab（原为开发设置内区块，单独成 tab 便于高频访问）。
 * 编辑器列表直接写入全局设置草稿 externalEditors，由弹框统一提交。
 */
export const EditorsTab = memo(function EditorsTab(props: EditorsTabProps) {
	const { draft, updateDraft, isDirty } = props;
	return (
		<SettingsSection
			title={
				<>
					<span>{t("settings.sectionEditors")}</span>
					<DirtyMarker dirty={isDirty("externalEditors")} label={t("settings.sectionEditors")} />
				</>
			}
		>
			<ExternalEditorsSection editors={draft.externalEditors} onChange={updateDraft} />
		</SettingsSection>
	);
});
