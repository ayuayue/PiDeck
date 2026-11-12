/**
 * 会话消息改写 IPC：复制 / HTML 导出 / 消息图片移除 / 消息编辑、删除、重发准备。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { registerSessionImageMutationIpc } from "./sessionImageMutationIpc";
import { REMOTE_SESSION_EXPORT_CODES } from "../remote/RemoteSessionHtmlExport";
import { logSessionCommandFailure, parseSessionId } from "./sessionIpcInputGuards";
import type { SessionIpcDeps } from "./sessionIpc";

export type SessionMessageMutationIpcDeps = Pick<SessionIpcDeps, "sessionCatalog" | "sessionRuntimeCoordinator" | "appLogger" | "copyCatalogSession" | "exportCatalogSessionHtml" | "exportRemoteCatalogSessionHtml">;

export function registerSessionMessageMutationIpc(deps: SessionMessageMutationIpcDeps): void {
	const { sessionCatalog, sessionRuntimeCoordinator, appLogger, copyCatalogSession, exportCatalogSessionHtml, exportRemoteCatalogSessionHtml } = deps;
	const localSessionFilePath = (sessionId: string) => sessionCatalog.getLocalFilePath(sessionId);
	ipcMain.handle(ipcChannels.sessionsCatalogCopy, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		localSessionFilePath(sessionId);
		const result = await copyCatalogSession(sessionId);
		void appLogger.info("session", "Session copied", {
			sessionId,
			targetSessionId: result.cancelled ? undefined : result.targetSessionId,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogExportHtml, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		// 远端会话是 ssh locator：`localSessionFilePath` 对它抛 UNSUPPORTED_PROJECT_LOCATION，所以**不能**先过
		// 本机守卫再导出。远端导出 = 远端有界窗口分页读（RemoteSessionHistoryReader）+ 本机写文件，HTML 渲染复用
		// DSH 投影式导出的同一个渲染器（不为远端再造模板）；端口未装配（远端实验开关关闭）时只抛稳定码，
		// 不回退成本机导出（那会把远端历史导成一份本机路径读不到的失败，或更糟：导出别人的本机会话）。
		if (sessionCatalog.getLocator(sessionId)?.kind === "ssh") {
			if (!exportRemoteCatalogSessionHtml) throw new Error(REMOTE_SESSION_EXPORT_CODES.unavailable);
			const remoteResult = await exportRemoteCatalogSessionHtml(sessionId);
			void appLogger.info("session", "Session exported (remote catalog HTML)", {
				sessionId,
				path: remoteResult.path,
				truncated: remoteResult.truncated,
			});
			return remoteResult;
		}
		localSessionFilePath(sessionId);
		const result = await exportCatalogSessionHtml(sessionId);
		void appLogger.info("session", "Session exported (catalog HTML)", {
			sessionId,
			path: result.path,
		});
		return result;
	});
	registerSessionImageMutationIpc(ipcMain, sessionRuntimeCoordinator, (error, context) => {
		logSessionCommandFailure(appLogger, error, { operation: "removeCatalogMessageImage", ...context });
	});
	// catalog 级消息改写：按 sessionId 操作 JSONL，不要求 live runtime。
	// 运行中必须先停（coordinator 拒绝 SESSION_RUNTIME_BUSY）；入参在边界校验。
	ipcMain.handle(ipcChannels.sessionsCatalogEditMessage, async (_event, sessionId: unknown, messageId: unknown, newText: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog edit-message request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog edit-message request");
		}
		if (typeof newText !== "string") {
			throw new Error("Invalid catalog edit-message request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog edit-message request");
		}
		const result = await sessionRuntimeCoordinator.editCatalogMessage(sessionId, messageId, newText, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "editCatalogMessage",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteMessage, async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog delete-message request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog delete-message request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog delete-message request");
		}
		const result = await sessionRuntimeCoordinator.deleteCatalogMessage(sessionId, messageId, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "deleteCatalogMessage",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogPrepareResend, async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog prepare-resend request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog prepare-resend request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog prepare-resend request");
		}
		const result = await sessionRuntimeCoordinator.prepareCatalogResend(sessionId, messageId, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "prepareCatalogResend",
				sessionId,
				messageId,
			});
		}
		return result;
	});
}
