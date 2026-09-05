import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { AgentRuntimeState, AgentStatus, AgentTab } from "../../../shared/types";
import { sessionRecordsAtom, sessionRuntimeByIdAtom } from "./session-atoms";
import { sessionIdByRuntimeAgentIdAtomFamily } from "./session-selectors";
import { sessionDisplayName } from "../utils/sessionDisplayName";

function areAgentTabsEqual(left: AgentTab[], right: AgentTab[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((tab, index) => {
    const other = right[index];
    return tab.id === other.id &&
      tab.projectId === other.projectId &&
      tab.cwd === other.cwd &&
      tab.title === other.title &&
      tab.status === other.status &&
      tab.sessionId === other.sessionId &&
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
      tab.backend === other.backend;
  });
}

const agentInventorySourceAtom = atom((get) => {
  const records = get(sessionRecordsAtom);
  return Object.entries(get(sessionRuntimeByIdAtom))
    .filter((entry): entry is [string, typeof entry[1] & {
      agentId: string;
      projectId: string;
      cwd: string;
      createdAt: number;
      status: AgentStatus;
    }] => Boolean(
      entry[1].agentId &&
      entry[1].projectId &&
      entry[1].cwd &&
      entry[1].createdAt != null &&
      entry[1].status !== "detached",
    ))
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
});

// runtime 事件常带 updatedAt 新对象，但库存字段未变。selectAtom 保引用，
// 避免 App useEffect([agents]) 每帧 setState 把设置/关窗点死。
export const agentInventoryAtom = selectAtom(
  agentInventorySourceAtom,
  (tabs) => tabs,
  areAgentTabsEqual,
);

export const agentByIdAtomFamily = atomFamily((agentId: string) =>
  atom((get) => get(agentInventoryAtom).find((agent) => agent.id === agentId)),
);

export const agentsByProjectIdAtomFamily = atomFamily((projectId: string) =>
  atom((get) => get(agentInventoryAtom).filter((agent) => agent.projectId === projectId)),
);

export const runtimeCapabilityByAgentIdAtomFamily = atomFamily((agentId: string) =>
  atom((get) => Object.values(get(sessionRuntimeByIdAtom))
    .find((runtime) => runtime.agentId === agentId)?.state),
);

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

function areRuntimeCapabilityRecordsEqual(
  left: Record<string, AgentRuntimeState>,
  right: Record<string, AgentRuntimeState>,
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length &&
    leftIds.every((agentId) => left[agentId] === right[agentId]);
}

export const runtimeCapabilitiesByProjectIdAtomFamily = atomFamily((projectId: string) => {
  const projectCapabilitiesAtom = atom((get) => Object.fromEntries(
    get(agentsByProjectIdAtomFamily(projectId))
      .map((agent) => {
        const runtime = Object.values(get(sessionRuntimeByIdAtom))
          .find((candidate) => candidate.agentId === agent.id);
        return [agent.id, runtime?.state] as const;
      })
      .filter((entry): entry is readonly [string, AgentRuntimeState] => Boolean(entry[1])),
  ));
  return selectAtom(
    projectCapabilitiesAtom,
    (capabilities) => capabilities,
    areRuntimeCapabilityRecordsEqual,
  );
});
