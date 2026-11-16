/**
 * 会话历史读取 IPC：过程事件（轨迹）/ 导轨目录 / 引用消息 / 消息全文 / DSH 会话路径与搜索。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionFactsCoverage, SessionFactsResult } from "../../shared/types";
import type { SessionOutlineSnapshot as OutlineSnapshot } from "../../shared/types/outline";
import { parseSessionProcessEventsFromFile } from "../sessions/sessionProcessEventsFile";
import type { DshBackendIpcDeps, SessionIpcDeps } from "./sessionIpc";
import { parseSessionId } from "./sessionIpcInputGuards";

/** 本组 handler 真正用到的依赖：catalog / runtime 绑定 / pi 会话读取 / DSH 轨迹与搜索。 */
export type SessionHistoryReadIpcDeps = Pick<SessionIpcDeps, "sessionCatalog" | "sessionRuntimeCoordinator" | "agentManager" | "appLogger" | "readCatalogSessionReferenceMessages"> &
	Pick<DshBackendIpcDeps, "readDshProcessEvents" | "readSessionFacts" | "readSessionOutline" | "readDshMessageFullText" | "resolveDshSessionFilePath" | "searchDshSessions"> & {
		/** 按后端分流（全文读取走 dsh 内存投影还是 pi 会话文件）；未装配 dshBackend 时按「非 dsh」处理。 */
		isDshAgent?: (agentId: string) => boolean;
	};

export function registerSessionHistoryReadIpc(deps: SessionHistoryReadIpcDeps): void {
	const { sessionCatalog, sessionRuntimeCoordinator, agentManager, appLogger, readCatalogSessionReferenceMessages, readDshProcessEvents, readSessionFacts, readSessionOutline, readDshMessageFullText, resolveDshSessionFilePath, searchDshSessions, isDshAgent = () => false } = deps;
	const localSessionFilePath = (sessionId: string) => sessionCatalog.getLocalFilePath(sessionId);
	ipcMain.handle(ipcChannels.sessionsCatalogReadProcessEvents, async (_event, sessionId: string): Promise<SessionFactsResult> => {
		const unavailable = (reason: SessionFactsCoverage["reason"]): SessionFactsResult => ({ events: [], version: "", coverage: { fromStart: true, chainComplete: true, readComplete: true, eventsTrimmed: false, ...(reason ? { reason } : {}) } });
		if (typeof sessionId !== "string" || !sessionId.trim()) return unavailable("unavailable");
		const entry = sessionCatalog.get(sessionId);
		const sessionFilePath = localSessionFilePath(sessionId);
		// DSH 会话没有 pi 会话文件：过程事件由运行时会话按 mux/重放收集，
		// 历史（未激活）会话从 host history 事件流推导（轨迹账本的
		// modelChange/permission/plan/goal/compaction 记录）。
		if (entry?.backend === "dsh" && readDshProcessEvents) {
			const target = sessionRuntimeCoordinator.getTarget(sessionId);
			const { events, fromStart, unavailable } = await readDshProcessEvents(target?.agentId, entry.dshSessionId);
			const last = events.at(-1);
			if (events.length === 0) appLogger.debug("trajectory", "DSH process events empty", { sessionId, dshSessionId: entry.dshSessionId, unavailable: unavailable === true });
			return {
				events,
				version: `dsh:${events.length}:${last?.id ?? ""}:${last?.seq ?? ""}`,
				coverage: {
					fromStart,
					chainComplete: true,
					readComplete: true,
					eventsTrimmed: false,
					...(unavailable ? { reason: "unavailable" as const } : fromStart ? {} : { reason: "history-window" as const }),
				},
			};
		}
		if (!entry?.filePath) return unavailable("unavailable");
		if (readSessionFacts) {
			// 索引候选 + 小批读 + 内容版本缓存：文件未变时不读正文（见 trajectoryFactsReader）。
			try {
				const facts = await readSessionFacts(entry.filePath);
				if (facts.events.length === 0) appLogger.debug("trajectory", "pi process events empty", { sessionId, filePath: entry.filePath, reason: facts.coverage.reason ?? null });
				return facts;
			} catch (error) {
				appLogger.warn("trajectory", "Read session facts failed", {
					sessionId,
					filePath: entry.filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				return unavailable("unavailable");
			}
		}
		// 无索引入口时回退流式扫描（有界尾巴，仍受事件保留上限约束）。
		return { events: await parseSessionProcessEventsFromFile(entry.filePath), version: "", coverage: { fromStart: true, chainComplete: true, readComplete: true, eventsTrimmed: false } };
	});
	// 导轨目录：只给用户检查点坐标（entryId + messageIndex + turnOrdinal），不带正文。
	// 入参只有 sessionId 与可选上限（渲染层数据不可信，上限在边界夹紧）。
	ipcMain.handle(ipcChannels.sessionsCatalogReadOutline, async (_event, sessionId: unknown, limit?: unknown): Promise<OutlineSnapshot> => {
		const empty: OutlineSnapshot = { entries: [], total: 0, truncated: false };
		if (typeof sessionId !== "string" || !sessionId.trim()) return empty;
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath || !readSessionOutline) return empty;
		const bounded = typeof limit === "number" && Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 10_000) : undefined;
		return readSessionOutline(entry.filePath, bounded);
	});
	// 边界校验 + 本地会话文件存在性判定：远端/DSH 会话没有本机文件，直接返回空（引用面板不展示）。
	ipcMain.handle(ipcChannels.sessionsCatalogReadReferenceMessages, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const filePath = localSessionFilePath(sessionId);
		return filePath ? readCatalogSessionReferenceMessages(sessionId) : [];
	});
	// 按需读取消息完整文本（工具结果截断后的「查看完整输出」）：
	// 入参校验在边界（渲染层数据不可信），agentId/messageId 必须为非空字符串。
	// 运行期路径（agentId 绑定）不可用时（历史会话 _viewer 投影 / agent 已退出）
	// 回退会话文件定位（sessionId → catalog filePath），保证历史浏览同样可展开全文。
	ipcMain.handle(ipcChannels.sessionsCatalogReadMessageFullText, async (_event, sessionId: unknown, agentId: unknown, messageId: unknown, entryId?: unknown) => {
		if (typeof agentId !== "string" || !agentId.trim() || typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid message full-text request");
		}
		const requestedSessionId = sessionId === undefined ? undefined : parseSessionId(sessionId);
		if (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim() || entryId.length > 256)) {
			throw new Error("Invalid entryId");
		}
		const messageEntryId = typeof entryId === "string" ? entryId : undefined;
		const requestedSessionPath = requestedSessionId ? localSessionFilePath(requestedSessionId) : undefined;
		try {
			// DSH 会话：工具结果全文随投影消息存内存（meta.fullText），
			// 走 DshAgentManager 直接读取；pi 走运行时缓存/会话文件。
			if (isDshAgent(agentId)) {
				if (!readDshMessageFullText) {
					throw new Error("dsh message full-text is not available");
				}
				return await readDshMessageFullText(agentId, messageId);
			}
			return await agentManager.readMessageFullText(agentId, messageId, messageEntryId);
		} catch (error) {
			if (requestedSessionPath) {
				return agentManager.readMessageFullTextFromFile(requestedSessionPath, messageId, messageEntryId);
			}
			throw error;
		}
	});
	// DSH 会话文件路径推导（F5：渲染层右键「复制会话文件路径」，历史会话无运行时 tab 也适用）
	ipcMain.handle(ipcChannels.sessionsGetDshSessionPath, async (_event, sessionId: unknown): Promise<string | undefined> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
		if (!resolveDshSessionFilePath) return undefined;
		return resolveDshSessionFilePath(sessionId);
	});
	// DSH 会话内容搜索（G9：侧栏搜索框全文搜索，结果按 dshSessionId 映射回 catalog）
	ipcMain.handle(ipcChannels.sessionsSearchDsh, async (_event, query: unknown): Promise<Array<{ sessionId: string; snippet: string }>> => {
		if (typeof query !== "string" || !query.trim()) return [];
		if (!searchDshSessions) return [];
		return searchDshSessions(query);
	});
}
