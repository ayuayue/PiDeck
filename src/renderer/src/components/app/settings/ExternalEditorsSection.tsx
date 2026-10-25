import { useState } from "react";
import { SUPPORTED_EXTERNAL_EDITORS, type AppSettings, type ExternalEditorId, type ExternalEditorSetting, type ExternalEditorSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { SettingRow } from "./SettingRows";

/**
 * 外部编辑器配置（由 Pi 管理界面「编辑器」tab 迁入设置）。
 * 读写走设置草稿（onChange = updateDraft），随全局「保存/取消」统一提交；
 * 每个编辑器一行（名称 + 启用 + 路径 + 操作），保持紧凑。
 */
export function ExternalEditorsSection(props: { editors: ExternalEditorSettings; onChange: (patch: Partial<AppSettings>) => void }) {
	const [detecting, setDetecting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const setEditor = (editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) => {
		props.onChange({
			externalEditors: {
				...props.editors,
				[editorId]: { ...props.editors[editorId], ...patch },
			},
		});
	};

	/** 重新自动检测所有编辑器路径：检测结果并入草稿，随全局保存生效 */
	const redetect = async () => {
		setDetecting(true);
		setError(null);
		try {
			const next = await desktopApi.editors.redetect();
			props.onChange({ externalEditors: next.externalEditors });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setDetecting(false);
		}
	};

	const chooseExecutable = async (editorId: ExternalEditorId) => {
		try {
			const selected = await desktopApi.editors.chooseExecutable();
			if (!selected) return;
			setEditor(editorId, { command: selected });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<>
			<SettingRow title={<span>{t("editors.redetect")}</span>} description={t("editors.hint")}>
				<Button variant="outline" size="sm" onClick={() => void redetect()} disabled={detecting}>
					{detecting ? t("editors.detecting") : t("editors.redetect")}
				</Button>
			</SettingRow>
			{SUPPORTED_EXTERNAL_EDITORS.map((editor) => {
				const setting = props.editors[editor.id];
				return (
					<div key={editor.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border-subtle/60 px-0.5 py-1.5 first:border-t-0">
						<div className="min-w-0">
							<span className="block truncate text-control font-medium text-foreground">{editor.name}</span>
							<small className="block truncate text-caption text-muted-foreground">{setting.command ? t("editors.detectedFrom", { source: setting.detectedFrom ?? "manual" }) : t("editors.notConfigured")}</small>
						</div>
						<div className="flex flex-wrap items-center justify-end gap-2">
							<Label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-caption text-muted-foreground">
								<Checkbox checked={setting.enabled} onCheckedChange={(checked) => setEditor(editor.id, { enabled: checked === true })} />
								{t("editors.enabled")}
							</Label>
							<Input className="w-56 min-w-0" value={setting.command} onChange={(event) => setEditor(editor.id, { command: event.target.value })} placeholder={t("editors.pathPlaceholder")} />
							<Button size="sm" variant="outline" onClick={() => void chooseExecutable(editor.id)}>
								{t("editors.browse")}
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setEditor(editor.id, { command: "", enabled: false })} disabled={!setting.enabled && !setting.command}>
								{t("editors.clear")}
							</Button>
						</div>
					</div>
				);
			})}
			{error && (
				<div className="px-0.5 pt-2">
					<small className="text-caption text-danger">{error}</small>
				</div>
			)}
		</>
	);
}
