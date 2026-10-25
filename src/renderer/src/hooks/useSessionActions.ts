import type { MutableRefObject } from "react";
import type { AgentBackend, ArchivedPiSession, CreateAnonymousSessionResult, Project, SessionRecord, SessionLaunchPreferences, SessionSummary } from "../../../shared/types";
import { collectSessionSubtreeIds, getSessionEnvironment } from "../../../shared/sessionIdentity";
import { isSameSessionPath } from "../agentListDisplay";
import { t } from "../i18n";

/**
 * 新建会话默认后端（C21 统一真相源）：缺省为 pi（经典后端，2026-12 兼容期
 * 从 dsh 回调）。用户可在设置「默认 Agent 后端」中切换为 dsh；运行时值由
 * useSessionActions 的 options.defaultBackend 注入（App 从 settings 读取）。
 * 引导页/匿名会话/侧栏「+」都经这里或显式传值，避免后端默认值分裂（F2）。
 */
export const DEFAULT_AGENT_BACKEND: AgentBackend = "pi";

/** 归档 toast 略加长：路径提示比短句更长，2200ms 不够读完。 */
export const ARCHIVED_SESSION_TOAST_MS = 4500;

/**
 * 归档成功提示按后端分流。
 * pi/jsonl 会话恢复入口在项目右键「会话管理」→「已归档」；
 * DSH 会话不进该弹窗，要去「配置管理」DSH 页的「归档区」。
 */
export function archivedSessionToastMessage(session: { backend?: AgentBackend }): string {
	return session.backend === "dsh" ? t("app.sessionArchivedDsh") : t("app.sessionArchived");
}

export type RefreshProjectSessions = (projectId: string, silent?: boolean) => Promise<SessionSummary[] | SessionRecord[] | undefined>;

export interface UseSessionActionsOptions {
	openSessionRequestRef: MutableRefObject<number>;
	creatingSessionDraftRef: MutableRefObject<Set<string>>;
	activeProjectId: string | undefined;
	sessionsProjectId: string | undefined;
	projects: Project[];
	setActiveProjectId: (value: React.SetStateAction<string | undefined>) => void;
	setCurrentSessionId: (value: React.SetStateAction<string | undefined>) => void;
	getSessionRecord: (sessionId: string) => SessionRecord | undefined;
	getProjectSessionRecords: (projectId: string) => SessionRecord[];
	upsertSession: (session: SessionRecord) => void;
	removeSessionState: (sessionId: string) => void;
	removeSessionComposerState: (sessionId: string) => void;
	/** 归档/删除前批量关 Tab；必须在清 session state 之前调用，否则焦点切不到邻居。 */
	closeTabs: (sessionIds: string[]) => void;
	refreshProjectSessions: RefreshProjectSessions;
	/** 新建会话默认后端（设置项 defaultAgentBackend；缺省走 DEFAULT_AGENT_BACKEND）。 */
	defaultBackend?: AgentBackend;
	api: {
		sessions: {
			copyRecord: (sessionId: string) => Promise<{ cancelled?: boolean; targetSessionId?: string }>;
			exportRecordHtml: (sessionId: string) => Promise<{ path: string }>;
			deleteRecord: (sessionId: string) => Promise<boolean>;
			archiveRecord: (sessionId: string) => Promise<boolean>;
			unarchiveRecord: (archivedPath: string) => Promise<boolean>;
			listArchived: () => Promise<ArchivedPiSession[]>;
			deleteArchivedRecord: (archivedPath: string) => Promise<boolean>;
			deleteArchivedDshSession: (dshSessionId: string) => Promise<boolean>;
			createDraft: (input: { projectId: string; title: string; backend?: AgentBackend } & SessionLaunchPreferences) => Promise<SessionRecord>;
			createAnonymous: (input: { projectId: string; title: string; backend?: AgentBackend } & SessionLaunchPreferences) => Promise<CreateAnonymousSessionResult>;
		};
	};
	showToast: (message: string, duration?: number) => void;
}

/**
 * 会话选择与草稿创建。只负责「当前会话是谁」，不登记 Tab 预览/常驻——
 * 那是 workspace chrome 的事，由 App / 侧栏在边界组合。
 */
export function useSessionActions(options: UseSessionActionsOptions) {
	const { openSessionRequestRef, creatingSessionDraftRef, activeProjectId, sessionsProjectId, projects, setActiveProjectId, setCurrentSessionId, getSessionRecord, getProjectSessionRecords, upsertSession, removeSessionState, removeSessionComposerState, closeTabs, refreshProjectSessions, api, showToast } = options;

	function commitSessionSelection(projectId: string, sessionId: string | undefined, scrollToEnd: boolean) {
		setActiveProjectId(projectId);
		setCurrentSessionId(sessionId);
		void scrollToEnd;
	}

	function selectProject(projectId: string) {
		++openSessionRequestRef.current;
		commitSessionSelection(projectId, undefined, false);
	}

	function selectSession(projectId: string, sessionId: string, scrollToEnd = true) {
		++openSessionRequestRef.current;
		commitSessionSelection(projectId, sessionId, scrollToEnd);
	}

	async function copySession(sessionId: string, projectId = sessionsProjectId ?? activeProjectId) {
		if (!projectId) return;
		const result = await api.sessions.copyRecord(sessionId);
		if (result.cancelled) {
			showToast(t("app.sessionCopyCancelled"));
			return;
		}
		showToast(t("app.sessionCopied"));
		await refreshProjectSessions(projectId);
	}

	async function exportHistorySession(session: SessionSummary) {
		const result = await api.sessions.exportRecordHtml(session.id);
		showToast(t("app.exportedPath", { path: result.path }), 3500);
	}

	/**
	 * 关掉会话树对应的聊天框：先批量关 Tab（此时 currentSessionId 还在，才能切到邻居），
	 * 再清 record/composer。只摘父 id 会留下子 agent Tab，或在 current 被清空后露出空态输入框。
	 */
	function dismissSessionTree(
		session: {
			id: string;
			filePath?: string;
			parentSessionPath?: string;
			environment?: SessionRecord["environment"];
			wsl?: boolean;
		},
		projectId = sessionsProjectId ?? activeProjectId,
	) {
		const records = projectId ? getProjectSessionRecords(projectId) : [];
		const ids = collectSessionSubtreeIds(records, {
			id: session.id,
			filePath: session.filePath,
			parentSessionPath: session.parentSessionPath,
			environment: session.environment ?? getSessionEnvironment(session),
		});
		closeTabs(ids);
		for (const id of ids) {
			removeSessionState(id);
			removeSessionComposerState(id);
		}
	}

	async function deleteHistorySession(session: SessionSummary) {
		try {
			await api.sessions.deleteRecord(session.id);
		} catch (error) {
			// 主进程拦截（会话正在使用中/删除失败）必须转成友好 toast，避免未处理 rejection
			// （全局"未处理异常"弹窗）。剥离 Electron invoke 前缀只保留真实原因。
			const raw = error instanceof Error ? error.message : String(error ?? "");
			const reason = raw
				.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
				.replace(/^Error:\s*/i, "")
				.trim();
			showToast(reason || t("app.sessionDeleteFailed"), 5000);
			return;
		}
		dismissSessionTree(session);
		// DSH 删除会记墓碑：刷新/自动导入不再把同一 host 会话导回侧栏。
		showToast(t("app.sessionDeleted"), 3200);
		const projectId = sessionsProjectId ?? activeProjectId;
		// 删除结果已经应用到本地；保留对账但不让其它会话再次进入 loading 布局。
		if (projectId) await refreshProjectSessions(projectId, true);
	}

	/** 归档历史会话：文件移入归档目录并从列表移除（可恢复，区别于删除） */
	async function archiveHistorySession(session: SessionSummary) {
		await api.sessions.archiveRecord(session.id);
		dismissSessionTree(session);
		showToast(archivedSessionToastMessage(session), ARCHIVED_SESSION_TOAST_MS);
		const projectId = sessionsProjectId ?? activeProjectId;
		if (projectId) await refreshProjectSessions(projectId);
	}

	/** 恢复归档会话：文件移回原路径并重新入目录 */
	async function unarchiveHistorySession(archivedPath: string) {
		await api.sessions.unarchiveRecord(archivedPath);
		showToast(t("app.sessionRestored"), 2200);
		const projectId = sessionsProjectId ?? activeProjectId;
		if (projectId) await refreshProjectSessions(projectId);
	}

	/** 列出已归档会话（恢复管理 UI 用） */
	async function listArchivedSessions() {
		return api.sessions.listArchived();
	}

	/** 永久删除已归档会话（pi 文件归档；文件移入回收站并移出归档索引） */
	async function deleteArchivedSession(archivedPath: string) {
		await api.sessions.deleteArchivedRecord(archivedPath);
		showToast(t("app.sessionDeletedFromArchive"), 2200);
		const projectId = sessionsProjectId ?? activeProjectId;
		if (projectId) await refreshProjectSessions(projectId);
	}

	/** 永久删除已归档 DSH 会话（host 目录移入回收站） */
	async function deleteArchivedDshSession(dshSessionId: string) {
		await api.sessions.deleteArchivedDshSession(dshSessionId);
		showToast(t("app.sessionDeletedFromArchive"), 2200);
		const projectId = sessionsProjectId ?? activeProjectId;
		if (projectId) await refreshProjectSessions(projectId);
	}

	// ── Sidebar session actions ──
	async function openSidebarSession(projectId: string, session: SessionSummary): Promise<string | undefined> {
		const requestSequence = ++openSessionRequestRef.current;
		const cachedRecord = getSessionRecord(session.id);
		let record: SessionRecord | undefined = cachedRecord?.projectId === projectId ? cachedRecord : getProjectSessionRecords(projectId).find((candidate) => candidate.filePath && isSameSessionPath(candidate.filePath, session.filePath, candidate.environment));
		if (!record) {
			try {
				await refreshProjectSessions(projectId, true);
				if (requestSequence !== openSessionRequestRef.current) return undefined;
				record = getProjectSessionRecords(projectId).find((candidate) => candidate.filePath && isSameSessionPath(candidate.filePath, session.filePath, candidate.environment));
			} catch (error) {
				if (requestSequence !== openSessionRequestRef.current) return undefined;
				showToast(error instanceof Error ? error.message : String(error), 4000);
				return undefined;
			}
		}
		if (!record || requestSequence !== openSessionRequestRef.current) return undefined;
		commitSessionSelection(projectId, record.id, true);
		return record.id;
	}

	async function openSidebarSessionById(projectId: string, sessionId: string): Promise<string | undefined> {
		const requestSequence = ++openSessionRequestRef.current;
		let record: SessionRecord | undefined = getSessionRecord(sessionId);
		if (!record || record.projectId !== projectId) {
			try {
				await refreshProjectSessions(projectId, true);
				if (requestSequence !== openSessionRequestRef.current) return undefined;
				record = getProjectSessionRecords(projectId).find((candidate) => candidate.id === sessionId);
			} catch (error) {
				if (requestSequence !== openSessionRequestRef.current) return undefined;
				showToast(error instanceof Error ? error.message : String(error), 4000);
				return undefined;
			}
		}
		if (!record || requestSequence !== openSessionRequestRef.current) return undefined;
		commitSessionSelection(projectId, record.id, true);
		return record.id;
	}

	async function copySidebarSession(projectId: string, session: SessionSummary) {
		await copySession(session.id, projectId);
	}

	async function exportSidebarSession(_projectId: string, session: SessionSummary) {
		const result = await api.sessions.exportRecordHtml(session.id);
		showToast(t("app.exportedPath", { path: result.path }), 3500);
	}

	async function createSessionDraft(
		projectId = activeProjectId,
		preferences: SessionLaunchPreferences = {},
		// 新建会话默认后端：设置项 defaultAgentBackend（C21 统一真相源；旧会话缺省仍按 pi 语义读取）。
		backend: AgentBackend = options.defaultBackend ?? DEFAULT_AGENT_BACKEND,
	): Promise<SessionRecord | undefined> {
		if (!projectId || creatingSessionDraftRef.current.has(projectId)) return undefined;
		const project = projects.find((item) => item.id === projectId);
		if (!project) return undefined;
		creatingSessionDraftRef.current.add(projectId);
		try {
			const session = await api.sessions.createDraft({
				projectId,
				title: backend === "dsh" ? `${project.name} DSH` : `${project.name} agent`,
				backend,
				...preferences,
			});
			upsertSession(session);
			commitSessionSelection(projectId, session.id, true);
			return session;
		} catch (error) {
			showToast(error instanceof Error ? error.message : String(error), 4000);
			return undefined;
		} finally {
			creatingSessionDraftRef.current.delete(projectId);
		}
	}

	async function createAnonymousSession(projectId = activeProjectId, preferences: SessionLaunchPreferences = {}, backend: AgentBackend = options.defaultBackend ?? DEFAULT_AGENT_BACKEND): Promise<SessionRecord | undefined> {
		if (!projectId || creatingSessionDraftRef.current.has(projectId)) return undefined;
		const project = projects.find((item) => item.id === projectId);
		if (!project) return undefined;
		creatingSessionDraftRef.current.add(projectId);
		try {
			const { session } = await api.sessions.createAnonymous({
				projectId,
				title: t("app.anonymousChatTitle", { name: project.name }),
				backend,
				...preferences,
			});
			upsertSession(session);
			commitSessionSelection(projectId, session.id, true);
			return session;
		} catch (error) {
			showToast(error instanceof Error ? error.message : String(error), 4000);
			return undefined;
		} finally {
			creatingSessionDraftRef.current.delete(projectId);
		}
	}

	return {
		selectProject,
		selectSession,
		copySession,
		exportHistorySession,
		deleteHistorySession,
		archiveHistorySession,
		unarchiveHistorySession,
		listArchivedSessions,
		deleteArchivedSession,
		deleteArchivedDshSession,
		openSidebarSession,
		openSidebarSessionById,
		copySidebarSession,
		exportSidebarSession,
		createSessionDraft,
		createAnonymousSession,
		dismissSessionTree,
	};
}
