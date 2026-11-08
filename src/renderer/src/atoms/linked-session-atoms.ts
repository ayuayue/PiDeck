import { atom } from "jotai";
import type { LinkedSessionLink, LinkedSessionProposal, LinkedSessionsSnapshot } from "../../../shared/types/linkedSessions";
import { desktopApi } from "../desktopApi";

/**
 * 关联会话（子对话）快照：主进程 LinkedSessionStore 是唯一真值，这里只做镜像。
 * 首个订阅者挂载时拉一次并订阅 linked-sessions:changed，最后一个订阅者卸载时退订。
 */
const EMPTY: LinkedSessionsSnapshot = { links: [], proposals: [] };

export const linkedSessionsSnapshotAtom = atom<LinkedSessionsSnapshot>(EMPTY);

linkedSessionsSnapshotAtom.onMount = (set) => {
	let disposed = false;
	const refresh = () => {
		void desktopApi.linkedSessions
			.snapshot()
			.then((next) => {
				if (!disposed) set(next);
			})
			.catch(() => undefined);
	};
	refresh();
	const unsubscribe = desktopApi.linkedSessions.onChanged(refresh);
	return () => {
		disposed = true;
		unsubscribe();
	};
};

/** 子会话 id → 关系（含已归档；侧栏只嵌套未归档的）。 */
export const linkedSessionLinkByChildIdAtom = atom((get) => {
	const map = new Map<string, LinkedSessionLink>();
	for (const link of get(linkedSessionsSnapshotAtom).links) map.set(link.childSessionId, link);
	return map;
});

/** 提议 id / 工具调用 id → 提议：时间线卡片按工具调用 id 找到自己的提议。 */
export const linkedSessionProposalIndexAtom = atom((get) => {
	const byId = new Map<string, LinkedSessionProposal>();
	const byToolCallId = new Map<string, LinkedSessionProposal>();
	for (const proposal of get(linkedSessionsSnapshotAtom).proposals) {
		byId.set(proposal.id, proposal);
		if (proposal.toolCallId) byToolCallId.set(proposal.toolCallId, proposal);
	}
	return { byId, byToolCallId };
});
