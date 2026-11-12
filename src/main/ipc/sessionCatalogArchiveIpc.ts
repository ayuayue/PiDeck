/**
 * 会话归档 IPC：本机归档 / 远端归档（ssh）/ 归档恢复 / 归档永久删除（含一步式确认 broker）。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */

import { ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { REMOTE_SESSION_DELETE_CODES } from "../../shared/sessionDeleteCodes";
import type { ArchivedPiSession, RemoteArchivedSessionDeleteAnswerResult, RemoteArchivedSessionDeleteRequestResult } from "../../shared/types";
import type { ArchivedRemoteSessionEntry } from "../sessions/SessionCatalog";
import { createRemoteArchivedSessionDelete } from "../sessions/RemoteArchivedSessionDelete";
import { REMOTE_SESSION_ARCHIVE_CODES } from "../remote/RemoteSessionArchive";
import { runForScatteredSubtreeFiles } from "../sessions/sessionSubtreeFiles";
import type { DshBackendIpcDeps, SessionIpcDeps } from "./sessionIpc";
import { parseSessionId } from "./sessionIpcInputGuards";

/** 本组 handler 真正用到的依赖：catalog / 运行时绑定判定 / 项目 / scanner / 归档链路 / 文案 / 日志。 */
export type SessionCatalogArchiveIpcDeps = Pick<SessionIpcDeps, "sessionCatalog" | "sessionRuntimeCoordinator" | "projectStore" | "sessionScanner" | "mainCopy" | "appLogger" | "archiveRemoteSession" | "unarchiveRemoteSession" | "deleteArchivedRemoteSession"> & Pick<DshBackendIpcDeps, "archiveDshSession">;

/**
 * 本机归档索引里的一条**远端归档**→ 列表行（`ArchivedPiSession`）。
 *
 * 为什么 `filePath` 留空而不填远端路径：本机字段里不该出现远端路径（读侧同样把 ssh 记录的 `filePath` 清空），
 * 而渲染层的本机归档行会把 `summary.filePath` 当成「要移回哪里」——填了远端路径就是一条点下去会失败的死行。
 * 远端恢复身份走 `archivedRemoteSessionId`（本机 catalog 会话 id）。
 */
function remoteArchivedRow(entry: ArchivedRemoteSessionEntry): ArchivedPiSession {
	return {
		summary: {
			id: entry.sessionId,
			filePath: "",
			name: entry.title,
			preview: "",
			updatedAt: entry.updatedAt,
			messageCount: 0,
			projectId: entry.projectId,
		},
		archivedRemoteSessionId: entry.sessionId,
	};
}

export function registerSessionCatalogArchiveIpc(deps: SessionCatalogArchiveIpcDeps): void {
	const { sessionCatalog, sessionRuntimeCoordinator, projectStore, sessionScanner, mainCopy, appLogger, archiveRemoteSession, unarchiveRemoteSession, deleteArchivedRemoteSession, archiveDshSession } = deps;
	/**
	 * 远端归档会话永久删除（Phase 5）：main 持有一步式确认状态（sender 绑定/60s/一次性），
	 * 请求只收 id，执行目标由本机归档索引给出。窗口销毁时撤销该 sender 的待确认请求。
	 */
	const remoteArchivedSessionDelete = createRemoteArchivedSessionDelete({
		catalog: sessionCatalog,
		isRuntimeBound: (sessionId) => Boolean(sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)),
		deleteRemote: deleteArchivedRemoteSession,
	});
	const watchedDeleteSenders = new Set<number>();
	function watchDeleteConfirmationSender(sender: WebContents | undefined): number | undefined {
		const senderId = sender?.id;
		if (!Number.isSafeInteger(senderId) || senderId === undefined || senderId < 1) return undefined;
		if (!watchedDeleteSenders.has(senderId) && typeof sender?.once === "function") {
			watchedDeleteSenders.add(senderId);
			sender.once("destroyed", () => {
				watchedDeleteSenders.delete(senderId);
				remoteArchivedSessionDelete.cancelSender(senderId);
			});
		}
		return senderId;
	}
	const localSessionFilePath = (sessionId: string) => sessionCatalog.getLocalFilePath(sessionId);
	ipcMain.handle(ipcChannels.sessionsCatalogArchive, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		// DSH 会话归档（G14）：host 目录移入 .pideck-archive（目录移动 + manifest，不销毁数据）。
		// 运行中的会话不能归档（同 pi：移动文件会破坏 host 对当前写入位置的引用）。
		if (entry?.backend === "dsh" && entry.dshSessionId && archiveDshSession) {
			if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
				throw new Error(mainCopy("session.stopBeforeDelete"));
			}
			const cwd = projectStore.get(entry.projectId)?.path ?? "";
			if (!cwd) throw new Error(mainCopy("project.notFound"));
			// 归档时刻把 catalog 标题写进 manifest：归档区列表与恢复后都靠它显示真实会话名
			// （旧归档缺省时由 DshHost 从日志折叠兜底，见 listArchivedSessions/unarchiveSession）。
			const archivedPath = await archiveDshSession(entry.dshSessionId, cwd, entry.title);
			if (!archivedPath) throw new Error(mainCopy("session.invalidArchivePath"));
			await sessionCatalog.removeWithDescendants(sessionId);
			void appLogger.info("session", "DSH session archived", {
				sessionId,
				dshSessionId: entry.dshSessionId,
				archivedPath,
			});
			return true;
		}
		// 远端会话归档（P4.5b）：远端文件 `mv` 进同目录旁的 `.pideck-archive/` + 本机归档索引 + 移出 catalog。
		// 必须插在 localSessionFilePath() **之前**：那个入口对 ssh locator 抛稳定码，放后面就是死代码
		// （f00977a33 的教训）。
		if (entry?.locator?.kind === "ssh") {
			const remoteLocator = entry.locator;
			if (!archiveRemoteSession) throw new Error(REMOTE_SESSION_ARCHIVE_CODES.unavailable);
			// 先判后发：运行实例绑定存在时**一个远端命令都不发**（移动正被远端 pi 追加写的文件会把历史写坏）。
			// 这里给出的是可执行文案（“先停 Agent”）而不是裸码：同一句拒绝就是用户看到的全文，
			// 稳定码留在日志里（与本机归档的拒绝文案同一机制）。
			if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
				void appLogger.warn("session", "Remote session archive refused: runtime still bound", { sessionId, hostId: remoteLocator.hostId, code: REMOTE_SESSION_ARCHIVE_CODES.busy });
				throw new Error(mainCopy("session.remoteArchiveStopFirst"));
			}
			const { originalPath, archivedPath } = await archiveRemoteSession({ hostId: remoteLocator.hostId, locator: remoteLocator });
			// 顺序固定：**远端移动成功之后**才动本机（先落索引、再移出记录）。
			// 远端失败时抛出，本机状态原样不动——绝不谎报成功（也不会留一条指向不存在归档的索引）。
			await sessionCatalog.rememberArchivedRemoteSession({
				sessionId,
				hostId: remoteLocator.hostId,
				projectId: entry.projectId,
				title: entry.title,
				updatedAt: entry.updatedAt,
				...(remoteLocator.remoteSessionId !== undefined ? { remoteSessionId: remoteLocator.remoteSessionId } : {}),
				...(remoteLocator.remotePath !== undefined ? { remotePath: remoteLocator.remotePath } : {}),
				originalRemotePath: originalPath,
				archivedRemotePath: archivedPath,
				archivedAt: Date.now(),
			});
			await sessionCatalog.removeWithDescendants(sessionId);
			// 只记身份与稳定码，不记远端路径、不记命令（与读取侧同一股敏纪律）。
			void appLogger.info("session", "Remote session archived (remote file moved into .pideck-archive)", { sessionId, hostId: remoteLocator.hostId });
			return true;
		}
		const sessionFilePath = localSessionFilePath(sessionId);
		if (!entry || !sessionFilePath) return false;
		// 运行中的会话不能归档（同删除）：移动文件会破坏 pi 对当前写入位置的引用。
		if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
			throw new Error(mainCopy("session.stopBeforeDelete"));
		}
		const archivedPath = await sessionScanner.archive(sessionFilePath);
		// 平铺子代理与父会话同目录、不在 `<stem>/` 里：archive 覆盖不到它们，
		// 不带上就会「catalog 摘了整棵子树、活动扫描目录里还留着子会话文件」（#539）。
		const leftover = await runForScatteredSubtreeFiles({
			catalog: sessionCatalog,
			sessionId,
			parentFilePath: sessionFilePath,
			environment: entry.environment,
			run: (filePath) => sessionScanner.archive(filePath),
		});
		if (leftover.length > 0) void appLogger.warn("session", "Session archive left scattered subtree files", { sessionId, failures: leftover });
		// scanner.archive 会把 sibling `<stem>/` 一并移走；catalog 同步清子树，避免幽灵子会话。
		await sessionCatalog.removeWithDescendants(sessionId);
		void appLogger.info("session", "Session archived", { sessionId, archivedPath });
		return true;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogUnarchive, async (_event, archivedPath: string) => {
		// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
		if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		const restoredPath = await sessionScanner.unarchive(archivedPath);
		void appLogger.info("session", "Session restored from archive", { restoredPath });
		return true;
	});
	/**
	 * 远端会话取消归档（P4.5b）：入参是**本机 catalog 会话 id**，不是路径。
	 *
	 * 为什么不沿用 `sessions:catalog-unarchive`：那条通道的入参是本机归档路径（`scanner.unarchive` 按它查
	 * 本机归档索引并把文件移回原位），而远端会话从来就没有本机路径——硬套进去只能是「远端绝对路径先被
	 * 当成 WSL 本机路径、然后在归档索引里找不到」。所以远端恢复按 id 走：恢复目标（归档前/后的远端
	 * 绝对路径）由本机归档索引给出。
	 */
	ipcMain.handle(ipcChannels.sessionsCatalogUnarchiveRemote, async (_event, rawSessionId: unknown): Promise<boolean> => {
		const sessionId = parseSessionId(rawSessionId);
		const archived = sessionCatalog.getArchivedRemoteSession(sessionId);
		if (!archived) throw new Error(REMOTE_SESSION_ARCHIVE_CODES.entryNotFound);
		if (!unarchiveRemoteSession) throw new Error(REMOTE_SESSION_ARCHIVE_CODES.unavailable);
		// 同归档：绑定存在就不动远端（先判后发）。
		if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
			void appLogger.warn("session", "Remote session unarchive refused: runtime still bound", { sessionId, hostId: archived.hostId, code: REMOTE_SESSION_ARCHIVE_CODES.busy });
			throw new Error(mainCopy("session.remoteUnarchiveStopFirst"));
		}
		await unarchiveRemoteSession({ hostId: archived.hostId, originalPath: archived.originalRemotePath, archivedPath: archived.archivedRemotePath });
		// 远端移回成功后才动本机：先摘索引，再按归档时刻的身份把记录登记回来
		// （稳定身份 = remoteSessionId 优先，与墓碑同口径）。ensureRemoteSession 命中同一身份时不会重复。
		await sessionCatalog.forgetArchivedRemoteSession(sessionId);
		const remoteIdentity = archived.remoteSessionId ?? archived.remotePath;
		if (remoteIdentity) {
			await sessionCatalog.ensureRemoteSession({
				projectId: archived.projectId,
				hostId: archived.hostId,
				remoteSessionId: remoteIdentity,
				remotePath: archived.remotePath ?? remoteIdentity,
				title: archived.title,
				updatedAt: archived.updatedAt,
			});
		}
		void appLogger.info("session", "Remote session restored from archive", { sessionId, hostId: archived.hostId });
		return true;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogListArchived, async (): Promise<ArchivedPiSession[]> => {
		const local = await sessionScanner.listArchived();
		// 远端归档条目：数据源是本机归档索引，**不扫远端归档区**（列一次归档就要一次 ssh 往返 + 会话根探测，
		// 而归档区本来就不在常规扫描口径里；索引就是权威）。
		return [...local, ...sessionCatalog.listArchivedRemoteSessions().map(remoteArchivedRow)];
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteArchived, async (_event, archivedPath: unknown): Promise<boolean> => {
		// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
		// 是否真的位于归档目录内由 sessionScanner.deleteArchived 兜底校验。
		// **远端归档没有这条通道**（P4.5b 明确不做）：远端没有回收站，`rm` 是永久删除；本 handler 只接受本机路径，
		// 远端归档行也只带 id（远端路径不过 IPC）⇒ 不存在一条能删掉远端数据的链路。
		if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		await sessionScanner.deleteArchived(archivedPath);
		void appLogger.info("session", "Archived session deleted", { archivedPath });
		return true;
	});
	/**
	 * 远端归档会话**永久删除**请求（Phase 5）：入参只有本机 catalog 会话 id。
	 *
	 * 为什么先请求再回答：这是不可恢复的远端数据删除，main 必须自己持有一次性确认状态
	 * （PendingConfirmationBroker）。请求阶段只做校验并签发 requestId，不执行任何远端命令；
	 * 只有携带同一 requestId 的 approve 回答才会真正删除——renderer 无法通过任何参数伪造 confirmed。
	 */
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteArchivedRemote, async (event, rawSessionId: unknown): Promise<RemoteArchivedSessionDeleteRequestResult> => {
		const senderId = watchDeleteConfirmationSender(event?.sender);
		if (senderId === undefined) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
		const sessionId = parseSessionId(rawSessionId);
		const result = await remoteArchivedSessionDelete.request({ senderId, sessionId });
		if (result.ok) {
			void appLogger.info("session", "Remote archived session delete confirmation requested", { sessionId });
		} else {
			void appLogger.warn("session", "Remote archived session delete refused", { sessionId, code: result.code });
		}
		return result;
	});
	/**
	 * 回答远端归档会话永久删除的一次性确认：requestId + approve/deny。
	 * 只有 approve 才执行远端删除；成功后由协调器摘索引/清墓碑。回执不可信 ⇒ RESULT_UNCONFIRMED，
	 * 索引保留（UI 不得自动刷新掉，必须让用户刷新核对）。
	 */
	ipcMain.handle(ipcChannels.sessionsCatalogAnswerDeleteArchivedRemote, async (event, rawRequestId: unknown, rawChoice: unknown): Promise<RemoteArchivedSessionDeleteAnswerResult> => {
		const senderId = watchDeleteConfirmationSender(event?.sender);
		if (senderId === undefined || typeof rawRequestId !== "string" || rawRequestId.length === 0 || rawRequestId.length > 128) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
		if (rawChoice !== "approve" && rawChoice !== "deny") return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
		const result = await remoteArchivedSessionDelete.answer({ senderId, requestId: rawRequestId, choice: rawChoice });
		if (result.ok && result.deleted) {
			// 只记「哪条会话被删」；不记远端路径/命令（与读/归档同一股敏纪律）。
			void appLogger.info("session", "Remote archived session data permanently deleted", { requestId: rawRequestId });
		} else if (!result.ok) {
			void appLogger.warn("session", "Remote archived session delete failed", { code: result.code });
		}
		return result;
	});
}
