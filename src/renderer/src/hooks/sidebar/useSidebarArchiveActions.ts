import { ARCHIVED_SESSION_TOAST_MS, archivedSessionToastMessage } from "../useSessionActions";
import { isSameSessionPath } from "../../agentListDisplay";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import type { SessionSummary } from "../../../../shared/types";
import type { NoticeKind } from "../../utils/notice";

/** 确认弹窗的最小切片（宿主 overlays 只需要这两个方法） */
export interface ArchiveConfirmOverlay {
	showConfirm: (options: { title: string; message: string; danger?: boolean; confirmLabel?: string; onConfirm: () => void }) => void;
	clearConfirm: () => void;
}

export interface SidebarArchiveActionsDeps {
	activeProjectId: string | undefined;
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	overlays: ArchiveConfirmOverlay;
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
	dismissSessionTree: (session: SessionSummary, projectId: string) => void;
	getSessionRecords: (projectId: string) => { parentSessionPath?: string | null }[];
}

/**
 * 侧栏会话归档/删除族：常规删除、归档/恢复（pi 文件归档 + DSH host 目录归档）、
 * 归档区列表与永久删除。会话管理弹窗与侧栏会话菜单共用这一套动作。
 */
export function useSidebarArchiveActions({ activeProjectId, showToast, overlays, refreshProjectSessions, dismissSessionTree, getSessionRecords }: SidebarArchiveActionsDeps) {
	/**
	 * 主进程拒绝（会话运行中/文件操作失败）统一转成可展示原因：剥掉 Electron 的
	 * "Error invoking remote method 'xxx': " 包装前缀，空原因回退到调用方给的兜底文案。
	 */
	function sessionActionErrorMessage(error: unknown, fallback: string): string {
		const raw = error instanceof Error ? error.message : String(error ?? "");
		const reason = raw
			.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
			.replace(/^Error:\s*/i, "")
			.trim();
		return reason || fallback;
	}

	async function deleteSidebarSession(projectId: string, session: SessionSummary) {
		try {
			await api.sessions.deleteRecord(session.id);
		} catch (error) {
			// 主进程可能拦截删除（会话正在使用中/删除失败），拒绝必须落成友好 toast，
			// 否则会成为未处理 rejection（全局"未处理异常"弹窗，2026-08 用户反馈）。
			showToast(sessionActionErrorMessage(error, t("app.sessionDeleteFailed")), 5000, "error");
			return;
		}
		// 先关 Tab 再清状态，并带走 sibling-dir / parentSessionPath 子会话，避免空态 Composer 残留。
		dismissSessionTree(session, projectId);
		showToast(t("app.sessionDeleted"), 2200);
		// 已按删除结果摘除子树；对账不能重新插入项目级 loading 行，挤动其它会话。
		await refreshProjectSessions(projectId, true);
	}

	/** 归档会话：从列表移除但不销毁文件；toast 按后端告知恢复入口（pi 走会话管理，DSH 走配置页归档区） */
	async function archiveSidebarSession(projectId: string, session: SessionSummary) {
		try {
			await api.sessions.archiveRecord(session.id);
		} catch (error) {
			// 运行中的会话会被主进程拒绝（先停止才能归档）；会话管理弹窗改成归档后不关闭，
			// 这个 rejection 若继续上抛会变成全局「未处理异常」并弹出无关弹窗，统一转 toast。
			showToast(sessionActionErrorMessage(error, t("app.sessionArchiveFailed")), 5000, "error");
			return;
		}
		dismissSessionTree(session, projectId);
		showToast(archivedSessionToastMessage(session), ARCHIVED_SESSION_TOAST_MS);
		await refreshProjectSessions(projectId);
	}

	/** 恢复归档会话：文件移回原路径并重新扫描 */
	async function unarchiveSidebarSession(archivedPath: string, projectId = activeProjectId) {
		await api.sessions.unarchiveRecord(archivedPath);
		showToast(t("app.sessionRestored"), 2200);
		// 归档管理弹窗可以从非当前项目打开；必须刷新弹窗所属项目，否则文件已恢复但侧栏仍沿用旧目录快照。
		if (projectId) await refreshProjectSessions(projectId);
	}

	/** 恢复 DSH 归档会话：host 目录移回 sessions 树并由主进程重建 catalog 记录 */
	async function unarchiveDshSidebarSession(dshSessionId: string, projectId = activeProjectId) {
		await api.sessions.unarchiveDshSession(dshSessionId);
		showToast(t("app.sessionRestored"), 2200);
		// 恢复目标项目由主进程按 manifest 的 cwd 决定；刷新当前弹窗项目即可让 catalog 快照更新。
		if (projectId) await refreshProjectSessions(projectId);
	}

	/** 列出已归档会话（会话管理弹窗恢复视图用） */
	function listArchivedSidebarSessions() {
		return api.sessions.listArchived();
	}

	/** 永久删除已归档会话（pi 文件归档：文件移入回收站并移出索引） */
	async function deleteArchivedSidebarSession(archivedPath: string) {
		await api.sessions.deleteArchivedRecord(archivedPath);
		showToast(t("app.sessionDeletedFromArchive"), 2200);
		// 归档删除不影响常规目录；刷新当前项目只是让 catalog 快照与磁盘一致。
		const projectId = activeProjectId;
		if (projectId) await refreshProjectSessions(projectId);
	}

	/** 列出 DSH 归档会话（会话管理弹窗归档视图用；与 pi 归档合并展示） */
	function listArchivedDshSidebarSessions() {
		return api.sessions.listArchivedDshSessions();
	}

	/** 永久删除已归档 DSH 会话（host 目录移入回收站） */
	async function deleteArchivedDshSidebarSession(dshSessionId: string) {
		await api.sessions.deleteArchivedDshSession(dshSessionId);
		showToast(t("app.sessionDeletedFromArchive"), 2200);
		const projectId = activeProjectId;
		if (projectId) await refreshProjectSessions(projectId);
	}

	function requestDeleteSidebarSession(projectId: string, session: SessionSummary) {
		const childCount = getSessionRecords(projectId).filter((candidate) => isSameSessionPath(candidate.parentSessionPath ?? undefined, session.filePath)).length;
		if (childCount === 0) {
			void deleteSidebarSession(projectId, session);
			return;
		}
		overlays.showConfirm({
			title: t("drawer.sessionDeleteTitle"),
			message: t("drawer.sessionDeleteBodyWithChildren", {
				name: session.name || t("common.untitled"),
				count: childCount,
			}),
			danger: true,
			confirmLabel: t("common.delete"),
			onConfirm: () => {
				overlays.clearConfirm();
				void deleteSidebarSession(projectId, session);
			},
		});
	}

	return {
		deleteSidebarSession,
		archiveSidebarSession,
		unarchiveSidebarSession,
		unarchiveDshSidebarSession,
		listArchivedSidebarSessions,
		deleteArchivedSidebarSession,
		listArchivedDshSidebarSessions,
		deleteArchivedDshSidebarSession,
		requestDeleteSidebarSession,
	};
}
