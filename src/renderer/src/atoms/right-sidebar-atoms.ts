import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { AgentRunItem } from "../components/session/timeline/types";

/**
 * 右侧边栏「会话状态」面板的跨组件状态。
 *
 * - rightSidebarStatusSessionIdAtom：面板当前「可见地」展示的会话（抽屉打开 + 下半区展开 +
 *   有会话），否则 null。SessionView / SessionStartSurface 据此隐藏输入框上方的
 *   待办/修改文件/子代理折叠条，避免同屏重复；只命中这一个会话，分屏另一栏不受影响。
 * - 最近一轮 run：SessionView 已从时间线算好，面板复用它拿到文件修改的实时增量，
 *   不在面板里重复解析整条时间线。视图卸载时发布 undefined 删除，避免残留过期 run。
 */
export const rightSidebarStatusSessionIdAtom = atom<string | null>(null);

export const sessionStatusInSidebarAtomFamily = atomFamily((sessionId: string) => atom((get) => get(rightSidebarStatusSessionIdAtom) === sessionId));

const sessionLatestAgentRunBySessionIdAtom = atom<Readonly<Record<string, AgentRunItem | undefined>>>({});

/** 按会话订阅：别的会话 run 变化不通知本会话（分屏流式输出时互不重渲染）。 */
export const sessionLatestAgentRunAtomFamily = atomFamily((sessionId: string) => selectAtom(sessionLatestAgentRunBySessionIdAtom, (runs) => runs[sessionId], Object.is));

export const publishSessionLatestAgentRunAtom = atom(null, (get, set, input: { sessionId: string; run: AgentRunItem | undefined }) => {
	const current = get(sessionLatestAgentRunBySessionIdAtom);
	if (input.run === undefined) {
		if (!(input.sessionId in current)) return;
		const next = { ...current };
		delete next[input.sessionId];
		set(sessionLatestAgentRunBySessionIdAtom, next);
		return;
	}
	if (current[input.sessionId] === input.run) return;
	set(sessionLatestAgentRunBySessionIdAtom, { ...current, [input.sessionId]: input.run });
});
