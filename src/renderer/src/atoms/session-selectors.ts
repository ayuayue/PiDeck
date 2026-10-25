import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import { registerSessionFamilyForDisposal } from "./session-family-registry";
import type { SessionRecord, SessionSummary } from "../../../shared/types";
import { sessionDisplayName } from "../utils/sessionDisplayName";
import { isDisplayableSessionRecord } from "../utils/sessionRecordDisplay";
import { currentSessionIdAtom, sessionHistoryMutationOverlayByIdAtom, sessionIdsByProjectAtom, sessionRecordsAtom, sessionRuntimeByIdAtom, sessionRuntimeUiByIdAtom } from "./session-atoms";

export function sessionRecordToSummary(session: SessionRecord): SessionSummary | undefined {
	// DSH 会话没有 pi 会话文件（会话由 DSH host 持久化在 $DSH_HOME，catalog 只存映射记录），
	// 生图会话无 pi 文件（历史独立存 ImageSessionStore）；两者无 filePath 也必须进侧栏列表。
	// 空 filePath 在显示管线走 unkeyedSessions 分支
	// （getSummaryKey 对空串归一化为 undefined），不会与其他会话折叠成一行；
	// 右键菜单按 hasFilePath 隐藏「复制路径/打开文件」类文件操作。
	// 判据与侧栏收集模型共用（utils/sessionRecordDisplay），两处不再各写一份。
	if (!isDisplayableSessionRecord(session)) return undefined;
	return {
		id: session.id,
		filePath: session.filePath ?? "",
		// 会话归属项目 id：会话管理弹窗 worktree 家族聚合后按它打工作区标签。
		projectId: session.projectId,
		projectPath: session.projectPath,
		name: sessionDisplayName(session.title, session.forked),
		parentSessionPath: session.parentSessionPath,
		forked: session.forked,
		preview: session.preview,
		updatedAt: session.updatedAt,
		// 创建时间排序用（settings.sessionSortMode=createdAt）；旧 catalog/扫描路径缺省时回退 updatedAt
		createdAt: session.createdAt,
		messageCount: session.messageCount,
		source: session.source,
		backend: session.backend,
		// 外部连接渠道：侧栏/标题栏据此显示微信、飞书标志（catalog 记录写入，扫描摘要不带）
		channel: session.channel,
		// 侧边任务标志：侧栏列表照常收录，只多一枚徽标（面板归属由 catalog 记录决定）
		sideTask: session.sideTask,
		dshSessionId: session.dshSessionId,
		acpToolId: session.acpToolId,
		wsl: session.environment === "wsl" || session.wsl || undefined,
		codexSessionId: session.codexSessionId,
		codexThreadSource: session.codexThreadSource,
		codexParentThreadId: session.codexParentThreadId,
		codexAgentRole: session.codexAgentRole,
		codexAgentNickname: session.codexAgentNickname,
	};
}

/** 仅通知本栏焦点进入/离开，其他栏之间的焦点切换不唤醒非聚焦栏。 */
export const sessionFocusedByIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(currentSessionIdAtom, (focusedId) => focusedId === sessionId, Object.is)));

export const sessionRecordByIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => atom((get) => get(sessionRecordsAtom)[sessionId])));

export const sessionRecordsByProjectIdAtomFamily = atomFamily((projectId: string) =>
	atom((get) => {
		const records = get(sessionRecordsAtom);
		return (get(sessionIdsByProjectAtom)[projectId] ?? []).map((sessionId) => records[sessionId]).filter((session): session is SessionRecord => Boolean(session));
	}),
);

/**
 * 每条 SessionRecord 的摘要缓存（2027-02 性能治理）：catalog 记录是不可变对象
 * （更新时整体替换），所以 WeakMap 键天然不会命中过期内容；未变化的会话在下一次
 * 派生里拿到**同一个** summary 对象引用，下游 selectAtom/memo 才能按引用跳过重渲。
 */
const summaryByRecord = new WeakMap<SessionRecord, SessionSummary | undefined>();

/** 摘要内容等价（字段投影小、条数按项目有界）：用于跨 catalog 替换沿用旧对象引用。 */
function sameSummaryContent(left: SessionSummary, right: SessionSummary): boolean {
	if (left === right) return true;
	// 逐字段浅比：全部字段都是原始值或稳定引用，字符串化比较足够且无需再维护字段清单。
	return JSON.stringify(left) === JSON.stringify(right);
}
function sessionRecordToSummaryCached(session: SessionRecord): SessionSummary | undefined {
	if (summaryByRecord.has(session)) return summaryByRecord.get(session);
	const summary = sessionRecordToSummary(session);
	summaryByRecord.set(session, summary);
	return summary;
}

/**
 * 会话摘要列表（按项目）。
 *
 * 同一 projectId 的结果按「记录对象 + 顺序数组引用」缓存：内容未变时返回**上一次的
 * 数组引用**。原先每次读都 map+filter+sort 出新数组，任何 sessionRecordsAtom 写入
 * （catalog 刷新、标题/消息数更新）都会让 App 根与 composer 侧白跑一次派生并重渲。
 */
/**
 * 每 projectId 一条缓存：记下「用到的记录对象 + 顺序数组引用」。
 * 用模块级 Map（不是挂在 sessionRecordsAtom 上的 WeakMap）：catalog 里**其它项目**
 * 的记录变化也会换掉整个 records map，WeakMap 会整份失效——而本项目的会话集合与
 * 内容其实一个都没变，数组引用必须继续稳定（否则侧栏/App 根照样白重渲）。
 * 键空间 = 项目数，有界。
 */
const summariesCacheByProject = new Map<string, { ids: readonly string[] | undefined; records: SessionRecord[]; result: SessionSummary[] }>();

export const sessionSummariesByProjectIdAtomFamily = atomFamily((projectId: string) =>
	atom((get) => {
		const records = get(sessionRecordsAtom);
		const ids = get(sessionIdsByProjectAtom)[projectId];
		const projectRecords = (ids ?? []).map((sessionId) => records[sessionId]).filter((session): session is SessionRecord => Boolean(session));
		const cached = summariesCacheByProject.get(projectId);
		// 命中判据：顺序数组同一引用 + 每个记录对象同一引用（记录不可变，引用相同即内容相同）
		if (cached && cached.ids === ids && cached.records.length === projectRecords.length && cached.records.every((record, index) => record === projectRecords[index])) {
			return cached.result;
		}
		const computed = projectRecords
			.map(sessionRecordToSummaryCached)
			.filter((session): session is SessionSummary => Boolean(session))
			.sort((left, right) => right.updatedAt - left.updatedAt);
		// 逐条沿用旧对象：catalog 换数组时未变化会话的记录对象可能也是新实例（整份替换），
		// 所以按**摘要内容**比对而不是记录引用——内容相同就复用上一条 summary 对象，
		// 下游 memo/selectAtom 才能按引用跳过重渲。
		const previousById = cached ? new Map(cached.result.map((item) => [item.id, item])) : null;
		const result = computed.map((item, index) => {
			const previous = previousById?.get(item.id);
			if (!previous) return item;
			return sameSummaryContent(previous, item) ? previous : item;
		});
		summariesCacheByProject.set(projectId, { ids, records: projectRecords, result });
		return result;
	}),
);

export const sessionRuntimeBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => atom((get) => get(sessionRuntimeByIdAtom)[sessionId])));

// A moved runtime can leave an older Session projection behind; the newest binding wins.
export const sessionIdByRuntimeAgentIdAtomFamily = atomFamily((agentId: string) =>
	atom(
		(get) =>
			Object.entries(get(sessionRuntimeByIdAtom)).reduce<{
				sessionId?: string;
				updatedAt: number;
			}>((selected, [sessionId, runtime]) => (runtime.agentId === agentId && runtime.updatedAt >= selected.updatedAt ? { sessionId, updatedAt: runtime.updatedAt } : selected), { updatedAt: -1 }).sessionId,
	),
);

/**
 * 按会话取 runtime UI 状态（含桥落点表）。
 *
 * `selectAtom` + `Object.is`：`sessionRuntimeUiByIdAtom` 的外层 map 在**任何**会话推帧时
 * 都会整体重建，但其它会话条目的引用不变 → 本会话订阅者不会因为别的会话推帧而重渲
 * （AGENTS.md「多实例必须按 session 订阅」）。
 */
export const sessionRuntimeUiBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => selectAtom(sessionRuntimeUiByIdAtom, (map) => map[sessionId], Object.is)));

export const sessionHistoryMutationOverlayBySessionIdAtomFamily = registerSessionFamilyForDisposal(atomFamily((sessionId: string) => atom((get) => get(sessionHistoryMutationOverlayByIdAtom)[sessionId])));
