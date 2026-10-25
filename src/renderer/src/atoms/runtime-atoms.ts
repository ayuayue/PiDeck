import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { AgentRuntimeState, AgentStatus, AgentTab } from "../../../shared/types";
import { sessionRecordsAtom, sessionRuntimeByIdAtom, type SessionRuntimeViewState } from "./session-atoms";
import { sessionIdByRuntimeAgentIdAtomFamily } from "./session-selectors";
import { sessionDisplayName } from "../utils/sessionDisplayName";

function areAgentTabsEqual(left: AgentTab[], right: AgentTab[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	return left.every((tab, index) => {
		const other = right[index];
		return (
			tab.id === other.id &&
			tab.projectId === other.projectId &&
			tab.cwd === other.cwd &&
			tab.title === other.title &&
			tab.status === other.status &&
			tab.sessionId === other.sessionId &&
			tab.deckSessionId === other.deckSessionId &&
			tab.sessionPath === other.sessionPath &&
			tab.sessionEnvironment === other.sessionEnvironment &&
			tab.sessionSource === other.sessionSource &&
			tab.wslDistro === other.wslDistro &&
			tab.wslUser === other.wslUser &&
			tab.importedSourceId === other.importedSourceId &&
			tab.noSession === other.noSession &&
			tab.runtimeGeneration === other.runtimeGeneration &&
			tab.createdAt === other.createdAt &&
			tab.compactionCount === other.compactionCount &&
			tab.backend === other.backend
		);
	});
}

/**
 * agentId → runtime 反向索引（2027-02 性能审计）。
 *
 * 原先 runtimeCapabilityByAgentId / runtimeCapabilitiesByProjectId 每次读都对
 * Object.values(sessionRuntimeByIdAtom) 做线性 find，项目里 N 个 agent 各自订阅时
 * 每次 runtime 事件就是 N×R 次扫描。索引按「runtime map 引用」缓存：该 map 只在
 * 有 runtime 事件时才换引用，正常读取直接命中。
 * 语义与 find 一致：同一 agentId 取插入序第一个（用 has 判断，不覆盖）。
 */
let runtimeIndexCache: { source: Record<string, SessionRuntimeViewState>; index: Map<string, SessionRuntimeViewState> } | null = null;

function runtimeIndexByAgentId(runtimes: Record<string, SessionRuntimeViewState>): Map<string, SessionRuntimeViewState> {
	if (runtimeIndexCache?.source === runtimes) return runtimeIndexCache.index;
	const index = new Map<string, SessionRuntimeViewState>();
	for (const runtime of Object.values(runtimes)) {
		const agentId = runtime.agentId;
		if (!agentId || index.has(agentId)) continue;
		index.set(agentId, runtime);
	}
	runtimeIndexCache = { source: runtimes, index };
	return index;
}

/**
 * 库存列表缓存（2027-02）：输入（runtime map + 会话记录 map）引用未变时直接复用
 * 上一次结果——下游 selectAtom(areAgentTabsEqual) 只能挡住重渲，挡不住这里的
 * O(N log N) 建数组 + 每次 runtime 写入都分配全新 AgentTab 对象。
 */
let inventoryCache: { runtimes: object; records: object; tabs: AgentTab[] } | null = null;

const agentInventorySourceAtom = atom((get) => {
	const records = get(sessionRecordsAtom);
	const runtimes = get(sessionRuntimeByIdAtom);
	if (inventoryCache && inventoryCache.runtimes === runtimes && inventoryCache.records === records) {
		return inventoryCache.tabs;
	}
	const tabs = Object.entries(runtimes)
		.filter(
			(
				entry,
			): entry is [
				string,
				(typeof entry)[1] & {
					agentId: string;
					projectId: string;
					cwd: string;
					createdAt: number;
					status: AgentStatus;
				},
			] => Boolean(entry[1].agentId && entry[1].projectId && entry[1].cwd && entry[1].createdAt != null && entry[1].status !== "detached"),
		)
		.sort((left, right) => left[1].createdAt - right[1].createdAt)
		.map(([sessionId, runtime]): AgentTab => {
			const record = records[sessionId];
			return {
				id: runtime.agentId,
				projectId: runtime.projectId,
				cwd: runtime.cwd,
				title: record ? (sessionDisplayName(record.title, record.forked) ?? record.title) : (runtime.title ?? "Session"),
				status: runtime.status,
				sessionId: runtime.piSessionId,
				sessionPath: runtime.sessionPath,
				// PiDeck 会话身份：侧栏把 ACP agent 行与 catalog 会话行配对（同 DSH 的 dshSessionId 配对）依赖它，
				// 缺失时同一会话会被画成「agent 行 + 会话行」两行（2027-03 重复会话事故）。
				deckSessionId: runtime.deckSessionId,
				sessionEnvironment: record?.environment,
				sessionSource: record?.source,
				wslDistro: record?.wslDistro,
				wslUser: record?.wslUser,
				importedSourceId: record?.importedSourceId,
				noSession: runtime.noSession ?? record?.noSession,
				runtimeGeneration: runtime.runtimeGeneration,
				createdAt: runtime.createdAt,
				compactionCount: runtime.compactionCount,
				// DSH 会话的 piSessionId 存的是 host 的 dshSessionId（agents:state 事件透传）；
				// backend 标记运行时后端，侧栏徽章与「agent↔会话」配对依赖它。
				backend: runtime.backend ?? "pi",
			};
		});
	inventoryCache = { runtimes, records, tabs };
	return tabs;
});

// runtime 事件常带 updatedAt 新对象，但库存字段未变。selectAtom 保引用，
// 避免 App useEffect([agents]) 每帧 setState 把设置/关窗点死。
export const agentInventoryAtom = selectAtom(agentInventorySourceAtom, (tabs) => tabs, areAgentTabsEqual);

export const agentByIdAtomFamily = atomFamily((agentId: string) => atom((get) => get(agentInventoryAtom).find((agent) => agent.id === agentId)));

export const agentsByProjectIdAtomFamily = atomFamily((projectId: string) => atom((get) => get(agentInventoryAtom).filter((agent) => agent.projectId === projectId)));

export const runtimeCapabilityByAgentIdAtomFamily = atomFamily((agentId: string) => atom((get) => runtimeIndexByAgentId(get(sessionRuntimeByIdAtom)).get(agentId)?.state));

/**
 * agent 退出（closed）时释放 agentId 维度 atomFamily 缓存：
 * agentId 每次都是新 UUID，不复用则 family 内部 Map 只增不清（2026-10 泄漏修复）。
 * 由 useSessionRuntimeBridge 在 agents:state 全量推送中检测 closed 后触发；
 * atomFamily 惰性重建，后续同 id 重新出现时无副作用。
 */
export const agentExitedAtom = atom(null, (_get, _set, agentId: string) => {
	agentByIdAtomFamily.remove(agentId);
	runtimeCapabilityByAgentIdAtomFamily.remove(agentId);
	sessionIdByRuntimeAgentIdAtomFamily.remove(agentId);
});

function areRuntimeCapabilityRecordsEqual(left: Record<string, AgentRuntimeState>, right: Record<string, AgentRuntimeState>): boolean {
	const leftIds = Object.keys(left);
	const rightIds = Object.keys(right);
	return leftIds.length === rightIds.length && leftIds.every((agentId) => left[agentId] === right[agentId]);
}

export const runtimeCapabilitiesByProjectIdAtomFamily = atomFamily((projectId: string) => {
	const projectCapabilitiesAtom = atom((get) =>
		Object.fromEntries(
			get(agentsByProjectIdAtomFamily(projectId))
				.map((agent) => {
					// 一次 get 内建好反查表（2027-02）：原先每个 agent 都 Object.values(...).find(...)，
					// N 个 agent 就是 N×R 次扫描，且每次 runtime 事件都重算。
					const runtime = runtimeIndexByAgentId(get(sessionRuntimeByIdAtom)).get(agent.id);
					return [agent.id, runtime?.state] as const;
				})
				.filter((entry): entry is readonly [string, AgentRuntimeState] => Boolean(entry[1])),
		),
	);
	return selectAtom(projectCapabilitiesAtom, (capabilities) => capabilities, areRuntimeCapabilityRecordsEqual);
});
