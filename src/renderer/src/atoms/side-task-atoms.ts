import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { sessionRecordsAtom } from "./session-atoms";

/**
 * 侧边任务面板当前展示的会话 id。
 * 刻意与 currentSessionIdAtom 正交：面板里切任务不改主工作区的焦点，
 * 否则「在侧边发一条追问」会把用户正在看的主会话顶掉。
 */
export const sideTaskActiveIdAtom = atom<string | null>(null);

function isSameIdList(a: readonly string[], b: readonly string[]) {
	if (a === b) return true;
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * catalog 里全部侧边任务会话的稳定 id 列表（最近活跃在前）。
 * 只导出 id：记录内容（标题/preview/updatedAt 之外的字段）抖动不会换列表身份，
 * 面板订阅它去逐个按 id 取记录，不会因为无关会话更新而重渲染整条会话树。
 */
export const sideTaskIdsAtom = selectAtom(
	sessionRecordsAtom,
	(records) =>
		Object.values(records)
			.filter((record) => record.sideTask === true)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((record) => record.id),
	isSameIdList,
);
