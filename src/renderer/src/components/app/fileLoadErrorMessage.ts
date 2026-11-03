import { formatBytes } from "../../../../shared/formatBytes";
import { t } from "../../i18n";

/** 将文件读写错误前缀转成可读文案，未知错误仍保留诊断。 */
export function fileLoadErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const tooLarge = /FILE_TOO_LARGE:(\d+):(\d+)/.exec(raw);
	if (tooLarge) {
		return t("editor.fileTooLarge", { size: (Number(tooLarge[1]) / 1024 / 1024).toFixed(1), max: (Number(tooLarge[2]) / 1024 / 1024).toFixed(0) });
	}
	const unreadableSize = /FILE_SIZE_UNREADABLE:([^\s'";)]+)/.exec(raw);
	if (unreadableSize) return t("editor.fileSizeUnreadable", { size: unreadableSize[1] });
	const denied = /FILE_ACCESS_DENIED:([A-Z_]+)/.exec(raw);
	if (denied) return t("editor.fileAccessDenied", { code: denied[1] });
	const notText = /FILE_NOT_TEXT:(\d+)/.exec(raw);
	if (notText) return t("editor.fileNotText", { size: formatBytes(Number(notText[1])) });
	const writeBlocked = /FILE_WRITE_BLOCKED_ENCRYPTED:(\d+)/.exec(raw);
	if (writeBlocked) return t("editor.writeBlockedEncrypted", { size: formatBytes(Number(writeBlocked[1])) });
	return raw;
}
