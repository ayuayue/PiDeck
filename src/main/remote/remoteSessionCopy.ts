/**
 * 远端会话身份相关稳定码 → main 进程文案键。
 *
 * 这些码会让「远端会话起不来」，而它们的 message 只是一个裸码（跨层后只剩 message/debugDetails），
 * 用户看到 `REMOTE_SESSION_LOCATOR_UNRESOLVED` 无从下手。映射集中在这里的理由与
 * `remotePiDiscoveryCopy.ts` 相同：认码只允许一处，测试可以逐码钉住「每个码都有可读文案」。
 *
 * 不在这里的码：
 * - `REMOTE_RUNTIME_UNAVAILABLE`（门禁/装配问题，由远端运行时自己的错误面呈现）；
 * - `REMOTE_SESSION_IDENTITY_INVALID`（写入边界拒绝，属于程序错误）。
 */
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { REMOTE_RUNTIME_CODES } from "../pi/remoteRuntimePort";
import { REMOTE_SESSION_CODES } from "../sessions/RemoteSessionScanner";

const COPY_KEY_BY_CODE: Record<string, MainProcessTranslationKey> = {
	[REMOTE_RUNTIME_CODES.locatorUnresolved]: "remote.sessionLocatorUnresolved",
	[REMOTE_SESSION_CODES.sessionDirInvalid]: "remote.sessionDirInvalid",
};

/** 从异常消息里认出会话身份码；认不出返回 undefined（调用方回落到通用启动失败文案）。 */
export function remoteSessionCodeCopyKey(message: string): MainProcessTranslationKey | undefined {
	for (const [code, key] of Object.entries(COPY_KEY_BY_CODE)) {
		if (message.includes(code)) return key;
	}
	return undefined;
}
