import { useCallback, useState } from "react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import type { useCloudSync } from "./useCloudSync";

/**
 * 云同步「本地备份」域 hook：导出 / 导入（.pideckbackup，离线兜底，无需云服务）。
 * 导出成功/取消给 toast；导入按结果聚合会话/资源/跳过/待映射提示。
 */

/** useCloudSync 中备份相关的稳定回调集合（窄接口，避免整包透传）。 */
export type CloudSyncBackupApi = Pick<ReturnType<typeof useCloudSync>, "exportBackup" | "importBackup">;

export function useCloudSyncBackup(api: CloudSyncBackupApi) {
	const [importFilePath, setImportFilePath] = useState("");
	const [importPassword, setImportPassword] = useState("");
	const [importMode, setImportMode] = useState<"merge" | "overwrite" | "restoreMissing">("merge");

	const handleExport = useCallback(async () => {
		const result = await api.exportBackup({ title: t("cloudSync.backup.exportTitle") });
		if (result === undefined) return; // 失败已写入 error
		if (result === null) {
			showNotice(t("cloudSync.backup.exportCanceled"), 2000, "info");
			return;
		}
		showNotice(
			t("cloudSync.backup.exportDone", { path: result.filePath, sessions: result.sessionCount, resources: result.resourceCount }),
			5000,
			"info",
		);
	}, [api]);

	const handlePickImportFile = useCallback(async () => {
		const picked = await desktopApi.dialog.pickFiles({ title: t("cloudSync.backup.importPick") });
		if (picked.length > 0) setImportFilePath(picked[0]);
	}, []);

	const handleImport = useCallback(async () => {
		if (!importFilePath || !importPassword) return;
		const result = await api.importBackup({ filePath: importFilePath, password: importPassword, mode: importMode });
		if (!result) return; // 失败已写入 error
		const skipped = result.sessionsSkipped + result.resourcesSkipped;
		const pending = result.pendingProjects.length;
		const message = t("cloudSync.backup.importDone", {
			restored: result.sessionsRestored,
			resourcesRestored: result.resourcesRestored,
			skipped,
		}) + (pending > 0 ? t("cloudSync.backup.importPending", { count: pending }) : "");
		showNotice(message, 5000, "info");
	}, [api, importFilePath, importPassword, importMode]);

	return {
		importFilePath,
		setImportFilePath,
		importPassword,
		setImportPassword,
		importMode,
		setImportMode,
		handleExport,
		handlePickImportFile,
		handleImport,
	};
}
