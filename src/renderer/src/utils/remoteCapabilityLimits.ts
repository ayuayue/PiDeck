import type { RemoteProjectUploadResult } from "../../../shared/types/remoteHost";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";

/**
 * 远端能力边界的 UI 判定（渲染层唯一出处）。
 *
 * 这里只决定「用户看到什么」，不复制主进程的强制边界：
 * - 当前上传上限 8 GiB 的强制在 `main/remote/RemoteProjectUploadJob.ts`
 *   （REMOTE_PROJECT_UPLOAD_MAX_BYTES）；文件夹上传被系统对话框的 openFile 与主进程
 *   `info.isFile()` 拒绝。渲染层提前把限制说清楚，避免用户选完文件/拖完目录才看到失败。
 * - 远端会话固定 pi 由会话创建与 composer controller 钳制；底栏据此给出准确的锁定原因，
 *   而不是复用「已发送消息后不可切换」的通用文案。
 */

/** 上传结果 → UI 反馈类别；失败永远走 error/partial，绝不落进 success。 */
export type RemoteUploadNotice = { kind: "none" } | { kind: "success" } | { kind: "error"; code: string } | { kind: "partial"; failedCount: number; code: string };

export function readRemoteUploadNotice(result: RemoteProjectUploadResult): RemoteUploadNotice {
	if (!result.ok) return { kind: "error", code: result.code };
	if (result.value.canceled === true) return { kind: "none" };
	const failed = result.value.failed;
	if (failed.length > 0) return { kind: "partial", failedCount: failed.length, code: failed[0].code };
	return { kind: "success" };
}

/** 上传失败码 → 文案 key；未知码保留代码展示（绝不把失败静默成成功）。 */
export function remoteUploadFailureCopy(code: string): { key: TranslationKey; withCode: boolean } {
	switch (code) {
		case "REMOTE_UPLOAD_NOT_A_FILE":
			return { key: "project.remote.uploadNotAFile", withCode: false };
		case "REMOTE_FILE_TOO_LARGE":
			return { key: "project.remote.uploadTooLarge", withCode: false };
		case "REMOTE_FILE_TARGET_EXISTS":
			return { key: "project.remote.uploadExists", withCode: false };
		case "REMOTE_UPLOAD_INVALID_PATHS":
			return { key: "project.remote.dropUnsupported", withCode: false };
		case "REMOTE_UPLOAD_LOCAL_IO_TIMEOUT":
			return { key: "project.remote.uploadLocalIoTimeout", withCode: false };
		default:
			return { key: "project.remote.uploadFailed", withCode: true };
	}
}

/** 锁定后端按钮的文案：远端项目是「只支持 pi」，其它情况才是「会话已开始」。 */
export function backendLockCopyKeys(backendFixedToPi: boolean): { hint: TranslationKey; notice: TranslationKey } {
	return backendFixedToPi ? { hint: "session.backendRemotePiOnlyHint", notice: "session.backendRemotePiOnlyNotice" } : { hint: "session.backendLockedHint", notice: "session.backendLockedNotice" };
}
