import { t } from "../../i18n";

/**
 * 远端上传的硬限制提示：单文件 ≤ 8 GiB、单批 ≤ 32 个文件、不支持文件夹。
 *
 * 强制边界在主进程（SFTP job / openFile 对话框 / info.isFile()），
 * 这里只提前把限制说清楚，避免用户选完大文件或拖入目录后才从失败 toast 得知。
 */
export function RemoteUploadLimitsHint() {
	return (
		<p data-testid="remote-upload-limits-hint" className="px-2 text-label text-muted-foreground">
			{t("project.remote.uploadLimitHint")}
		</p>
	);
}
