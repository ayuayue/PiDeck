import { t } from "../i18n";

/**
 * Local Git errors retain cleaned command output because repository-specific detail is
 * actionable. Only Electron and execFile wrappers are removed.
 */
export function localGitOperationErrorText(caught: unknown): string {
	const raw = caught instanceof Error ? caught.message : String(caught);
	return raw
		.replace(/^Error invoking remote method '[^']+':\s*/i, "")
		.replace(/^Error:\s+Command failed:\s+[^\n]*\n?/i, "")
		.trim();
}

/**
 * Remote Git errors are a closed vocabulary. Raw stderr and remote paths must never
 * cross the host boundary, so unknown codes collapse to a generic localized message.
 */
export function remoteGitErrorMessage(code: string): string {
	if (code === "GIT_INDEX_LOCKED") return t("remoteGit.indexLocked");
	if (code === "GIT_COMMIT_NOTHING_STAGED") return t("remoteGit.nothingStaged");
	if (code === "GIT_COMMIT_MESSAGE_EMPTY") return t("remoteGit.messageEmpty");
	if (code === "GIT_COMMIT_IDENTITY_REQUIRED") return t("remoteGit.identityRequired");
	if (code === "GIT_COMMIT_HEAD_CHANGED") return t("remoteGit.headChanged");
	if (code === "GIT_REF_EXISTS") return t("remoteGit.refExists");
	if (code === "GIT_REF_NOT_FOUND") return t("remoteGit.refNotFound");
	if (code === "GIT_REPO_EXISTS") return t("remoteGit.repoExists");
	if (code === "GIT_SWITCH_CONFLICT") return t("remoteGit.switchConflict");
	if (code === "GIT_RECOVERY_ENTRY_NOT_FOUND") return t("remoteGit.recoveryEntryNotFound");
	if (code === "GIT_SYNC_REMOTE_UNKNOWN") return t("remoteGit.syncRemoteUnknown");
	if (code === "GIT_SYNC_DIRTY") return t("remoteGit.syncDirty");
	if (code === "GIT_PULL_STRATEGY_REQUIRED") return t("remoteGit.syncStrategyRequired");
	if (code === "GIT_PULL_CONFLICTS") return t("remoteGit.syncConflicts");
	if (code === "GIT_PUSH_REJECTED") return t("remoteGit.syncPushRejected");
	if (code === "GIT_PUSH_REMOTE_REFUSED") return t("remoteGit.syncPushRemoteRefused");
	if (code === "GIT_SYNC_FAILED") return t("remoteGit.syncFailed");
	if (code === "GIT_WRITE_UNSUPPORTED") return t("remoteGit.writeUnsupported");
	if (code === "GIT_WRITE_RESULT_UNCONFIRMED") return t("remoteGit.writeUnknown");
	if (code === "GIT_WRITE_SNAPSHOT_EXPIRED") return t("remoteGit.writeExpired");
	if (code === "GIT_TRUST_REQUIRED") return t("remoteGit.trustRequired");
	if (code === "GIT_NOT_REPOSITORY") return t("remoteGit.notRepository");
	if (code === "GIT_NOT_FOUND" || code === "GIT_VERSION_UNSUPPORTED") return t("remoteGit.gitUnavailable");
	if (code === "GIT_UNSUPPORTED_REPOSITORY" || code === "GIT_CONFIG_UNSUPPORTED" || code === "GIT_PLATFORM_UNSUPPORTED" || code === "UNSUPPORTED_CAPABILITY") return t("remoteGit.unsupported");
	if (code === "GIT_NOT_TEXT" || code === "NOT_A_FILE") return t("remoteGit.notText");
	if (code === "RESULT_TOO_LARGE") return t("remoteGit.tooLarge");
	if (code === "GIT_RESOURCE_CHANGED" || code === "GIT_TARGET_CHANGED") return t("remoteGit.changed");
	if (code === "PERMISSION_DENIED") return t("remoteGit.permission");
	if (code.startsWith("SSH_") || code === "REMOTE_CONNECTION_LOST" || code === "REMOTE_FEATURE_DISABLED") return t("remoteGit.connection");
	if (code === "REQUEST_TIMEOUT" || code === "TOO_MANY_REQUESTS") return t("remoteGit.timeout");
	return t("remoteGit.failed");
}

/**
 * 远端 Git 失败的**唯一文案出口**：每个面板、提示、toast 都走这里，不要自己拼。
 *
 * 顺序是硬约束：
 * 1. `detail`（helper 带回来的 git/hook 原文）——与本机一样能看到真正的原因；
 * 2. 闭集码词典；
 * 3. 没有稳定码 = 不是远端失败信封（编程错误或非远端异常），保留原文便于定位。
 *
 * `ProjectServiceError.internal` 永远不参与：它是内部说明，上屏就是一句英文实现细节。
 * `ProjectServiceError.message` 对一个有码的失败也不参与：那里存的就是稳定码本身。
 */
export function remoteGitErrorText(caught: unknown): string {
	const error = caught as { code?: unknown; detail?: unknown } | null;
	const detail = typeof error?.detail === "string" ? error.detail.trim() : "";
	if (detail.length > 0) return detail;
	const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : undefined;
	if (code !== undefined) return remoteGitErrorMessage(code);
	return caught instanceof Error ? caught.message : String(caught);
}
