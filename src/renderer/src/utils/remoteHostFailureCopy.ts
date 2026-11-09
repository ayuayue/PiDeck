import { t } from "../i18n";

/**
 * 远端连接失败稳定码 → 人话（添加、测试连接、保存后重试都用同一份）。
 *
 * 以前只有一个 `{ code }` 占位：用户看到 SSH_HOST_AUTHENTICATION_FAILED 完全不知道该改哪个字段。
 * 私钥被拒、私钥读不了、私钥带口令、网络不通，这四类的下一步动作完全不同，必须分开讲。
 */
export function remoteHostFailureReason(code: string): string {
	switch (code) {
		case "SSH_AUTH_KEY_REJECTED":
			return t("settings.connections.add.reason.keyRejected");
		case "SSH_AUTH_KEY_UNREADABLE":
		case "SSH_HOST_KEY_INVALID":
			return t("settings.connections.add.reason.keyUnreadable");
		case "SSH_AUTH_PASSPHRASE_REQUIRED":
			return t("settings.connections.add.reason.passphraseRequired");
		case "SSH_HOST_UNREACHABLE":
			return t("settings.connections.add.reason.unreachable");
		case "SSH_HOST_COMMAND_TIMEOUT":
			return t("settings.connections.add.reason.timeout");
		case "SSH_HOST_AUTHENTICATION_FAILED":
			return t("settings.connections.add.reason.authFailed");
		case "SSH_PASSWORD_REQUIRED":
			return t("settings.connections.add.reason.passwordRequired");
		case "REMOTE_HOST_IDENTITY_FILE_INVALID":
		case "INVALID_SSH_LOCAL_PATH":
			return t("settings.connections.add.reason.keyPathInvalid");
		case "REMOTE_NODE_VERSION_UNSUPPORTED":
			return t("settings.connections.add.reason.nodeTooOld");
		case "REMOTE_FEATURE_DISABLED":
			return t("settings.connections.add.disabled");
		default:
			return t("settings.connections.add.failed", { code });
	}
}

/**
 * 远端 pi 探测稳定码 → 人话（添加/编辑连接的内联检测用）。
 *
 * 与 SSH 握手失败分开：这里的下一步动作是「装 pi / 升级 pi / 指定路径 / 先让会话就绪」，
 * 而不是改主机名或私钥。任何认不出的码仍然只回稳定码，不编原因。
 */
export function remotePiProbeReason(code: string): string {
	switch (code) {
		case "REMOTE_PI_NOT_FOUND":
			return t("settings.connections.add.piNotFound");
		case "REMOTE_PI_TOO_OLD":
			return t("settings.connections.add.piTooOld");
		case "REMOTE_PI_VERSION_UNREADABLE":
			return t("settings.connections.add.piUnreadable");
		case "REMOTE_PI_SHELL_PATH_UNREADABLE":
			return t("settings.connections.add.piShellUnreadable");
		case "REMOTE_PI_NODE_PATH_INVALID":
			return t("settings.connections.add.piNodeInvalid");
		case "REMOTE_PI_PATH_INVALID":
			return t("settings.connections.add.piPathInvalid");
		case "SSH_HOST_NOT_READY":
		case "SSH_HOST_DISCONNECTED":
			return t("settings.connections.add.piNotReady");
		case "REMOTE_PI_VERSION_UNVERIFIED":
			return t("settings.connections.add.piWarning");
		default:
			return t("settings.connections.add.piFailed", { code });
	}
}
