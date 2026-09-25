import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export type RecentSessionActivity = { sessionId: string; projectId: string; at: number };

/** 仅记录实际启动/运行的Agent。旧v1混有浏览记录，不能据此冒充启动历史。 */
export const recentSessionActivityAtom = atomWithStorage<RecentSessionActivity[]>("pideck:recent-agent-activity:v2", [], undefined, { getOnInit: true });

export const touchRecentSessionAtom = atom(null, (get, set, input: { sessionId: string; projectId: string }) => {
	set(recentSessionActivityAtom, [{ ...input, at: Date.now() }, ...get(recentSessionActivityAtom).filter((entry) => entry.sessionId !== input.sessionId)].slice(0, 20));
});

export const forgetRecentSessionAtom = atom(null, (get, set, sessionId: string) => {
	const previous = get(recentSessionActivityAtom);
	if (previous.some((entry) => entry.sessionId === sessionId))
		set(
			recentSessionActivityAtom,
			previous.filter((entry) => entry.sessionId !== sessionId),
		);
});
