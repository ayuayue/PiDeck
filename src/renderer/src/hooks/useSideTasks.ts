import { useCallback, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { AgentBackend, SessionRecord } from "../../../shared/types";
import { sideTaskActiveIdAtom, sideTaskIdsAtom, upsertSessionAtom } from "../atoms";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";

export type SideTaskController = {
	/** 面板任务条的数据源：catalog 里带 sideTask 标记的会话 id（最近活跃在前）。 */
	ids: string[];
	activeId: string | null;
	select: (sessionId: string) => void;
	create: (input: { projectId: string | undefined; backend?: AgentBackend }) => Promise<SessionRecord | undefined>;
	release: (sessionId: string) => Promise<void>;
};

/**
 * 「侧边任务」的归属状态机：建带标记的草稿会话、在任务间切换、把任务释放回普通会话。
 *
 * 两条底线：
 * 1. 不登记主区常驻 Tab、不改 currentSessionId——侧边任务与主工作区互不打扰；
 *    发消息时的 Tab 晋升由面板用 SessionPaneServices 覆盖掉（见 SideTaskPanel）。
 * 2. release 只清标记不删会话——用户点 X 的预期是「从面板里拿走」，不是丢历史。
 */
export function useSideTasks(options: { backend: AgentBackend; showToast: (message: string, duration?: number) => void; onCreated?: (session: SessionRecord) => void }): SideTaskController {
	const ids = useAtomValue(sideTaskIdsAtom);
	const activeId = useAtomValue(sideTaskActiveIdAtom);
	const setActiveId = useSetAtom(sideTaskActiveIdAtom);
	const upsertSession = useSetAtom(upsertSessionAtom);
	const creatingRef = useRef(false);
	// 异步回调里读最新值，不闭包过期列表（AGENTS.md：拖放/定时器/异步用快照 ref）。
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const idsRef = useRef(ids);
	idsRef.current = ids;
	const activeIdRef = useRef(activeId);
	activeIdRef.current = activeId;

	const select = useCallback((sessionId: string) => setActiveId(sessionId), [setActiveId]);

	const create = useCallback(
		async ({ projectId, backend }: { projectId: string | undefined; backend?: AgentBackend }) => {
			// 同一时刻只允许一条在途创建：连点菜单会建出多个空任务，任务条瞬间挤成一排且没有内容可看。
			if (!projectId || creatingRef.current) return undefined;
			creatingRef.current = true;
			try {
				const record = await api.sessions.createDraft({ projectId, backend: backend ?? optionsRef.current.backend, sideTask: true });
				upsertSession(record);
				setActiveId(record.id);
				optionsRef.current.onCreated?.(record);
				return record;
			} catch (error) {
				optionsRef.current.showToast(error instanceof Error ? error.message : String(error), 4000);
				return undefined;
			} finally {
				creatingRef.current = false;
			}
		},
		[setActiveId, upsertSession],
	);

	const release = useCallback(
		async (sessionId: string) => {
			try {
				upsertSession(await api.sessions.updateRecord(sessionId, { sideTask: null }));
			} catch (error) {
				optionsRef.current.showToast(error instanceof Error ? error.message : String(error), 4000);
				return;
			}
			// 释放的正是当前展示的任务时，立刻落到下一个；面板不能停在一条已不属于它的会话上。
			if (activeIdRef.current === sessionId) {
				setActiveId(idsRef.current.find((id) => id !== sessionId) ?? null);
			}
		},
		[setActiveId, upsertSession],
	);

	return { ids, activeId, select, create, release };
}
