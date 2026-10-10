import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionCommandError, SessionMessageImageTarget } from "../../shared/types";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";

/** 单图移除只接受有界身份与图片快照；不接受会话文件路径或图片原始字节。 */
function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\p{Cc}]/u.test(value);
}

/** 快照由 main 在文件锁内再次验证；IPC 只过滤无效类型、序号和哈希形态。 */
function isImageTarget(value: unknown): value is SessionMessageImageTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		"index" in value &&
		typeof value.index === "number" &&
		Number.isSafeInteger(value.index) &&
		value.index >= 0 &&
		"expectedImageCount" in value &&
		typeof value.expectedImageCount === "number" &&
		Number.isSafeInteger(value.expectedImageCount) &&
		value.expectedImageCount > value.index &&
		"expectedHash" in value &&
		typeof value.expectedHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.expectedHash)
	);
}

/** catalog 图片改写的薄 IPC 适配，复用 coordinator 的停止/后端/文件安全闸。 */
export function registerSessionImageMutationIpc(ipc: IpcMain, coordinator: Pick<SessionRuntimeCoordinator, "removeCatalogMessageImage">, reportFailure: (error: SessionCommandError, context: { sessionId: string; messageId: string }) => void): void {
	ipc.handle(ipcChannels.sessionsCatalogRemoveMessageImage, async (_event, sessionId: unknown, messageId: unknown, imageTarget: unknown, entryId: unknown) => {
		if (!validId(sessionId) || !validId(messageId) || !isImageTarget(imageTarget) || (entryId !== undefined && !validId(entryId))) {
			throw new Error("Invalid catalog remove-message-image request");
		}
		const result = await coordinator.removeCatalogMessageImage(sessionId, messageId, imageTarget, entryId);
		if (!result.ok) reportFailure(result.error, { sessionId, messageId });
		return result;
	});
}
