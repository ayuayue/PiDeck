import { useState } from "react";
import { useAtomValue } from "jotai";
import { Sliders } from "lucide-react";
import { automationSettingsAtom } from "../../atoms/automation-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";

/**
 * 定时任务全局设置选项卡（控制全局并发执行数与运行历史保留条数）。
 */
export function AutomationSettingsTab() {
	const currentSettings = useAtomValue(automationSettingsAtom);

	const [maxConcurrentRuns, setMaxConcurrentRuns] = useState<number>(currentSettings.maxConcurrentRuns ?? 1);
	const [historyLimit, setHistoryLimit] = useState<number>(currentSettings.historyLimit ?? 100);
	const [isSaving, setIsSaving] = useState(false);

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsSaving(true);
		try {
			await desktopApi.automation.updateSettings({
				maxConcurrentRuns: Math.max(1, Math.min(10, Number(maxConcurrentRuns) || 1)),
				historyLimit: Math.max(10, Math.min(1000, Number(historyLimit) || 100)),
			});
			showNotice(t("automation.settingsSaved"), 2000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3000);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<form onSubmit={handleSave} className="flex flex-col gap-4 py-2 max-w-md">
			<div className="flex items-center gap-2 text-xs font-semibold text-foreground">
				<Sliders className="size-4 text-muted-foreground" />
				{t("automation.settingsTab")}
			</div>

			<div className="flex flex-col gap-3 rounded-lg border border-border/50 bg-bg-panel/30 p-3">
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs font-medium">{t("automation.maxConcurrentRuns")}</Label>
					<Input type="number" min="1" max="10" value={maxConcurrentRuns} onChange={(e) => setMaxConcurrentRuns(Number(e.target.value))} className="h-8 text-xs max-w-[140px]" />
					<span className="text-micro text-muted-foreground">同时处于启动或运行中的最大自动化会话数（默认 1）。</span>
				</div>

				<div className="flex flex-col gap-1.5 border-t border-border/30 pt-3">
					<Label className="text-xs font-medium">{t("automation.historyLimit")}</Label>
					<Input type="number" min="10" max="1000" value={historyLimit} onChange={(e) => setHistoryLimit(Number(e.target.value))} className="h-8 text-xs max-w-[140px]" />
					<span className="text-micro text-muted-foreground">全局持久化保留的最近运行历史记录条数（默认 100）。</span>
				</div>
			</div>

			<div className="flex justify-end pt-1">
				<Button type="submit" size="sm" disabled={isSaving}>
					{t("common.save")}
				</Button>
			</div>
		</form>
	);
}
