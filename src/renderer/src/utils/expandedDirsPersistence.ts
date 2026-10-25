import type { AgentTab } from "../../../shared/types";

/** 项目展开目录的持久化 key 前缀（localStorage） */
const PROJECT_EXPANDED_DIRS_KEY_PREFIX = "pid:project-expanded-dirs:";

/**
 * 展开目录持久化（纯 localStorage 读写，便于单测与复用）。
 * - save：整个 Set 序列化落盘，写失败静默（隐私模式/配额满不阻塞交互）。
 * - load：优先读项目级 key；缺失时做一次旧版 per-agent key 的 legacy 迁移
 *   （读取后搬进项目 key 并删除旧 key，只搬第一个命中的 agent，保持与历史行为一致）。
 */
export function saveExpandedDirsToStorage(projectId: string, dirs: Set<string>) {
	try {
		localStorage.setItem(PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId, JSON.stringify([...dirs]));
	} catch {
		/* ignore */
	}
}

export function loadExpandedDirsFromStorage(projectId: string, legacyAgentIds: string[]): Set<string> {
	try {
		const key = PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId;
		let raw = localStorage.getItem(key);
		if (!raw) {
			for (const agentId of legacyAgentIds) {
				const oldKey = `pid:agent-expanded-dirs:${agentId}`;
				const value = localStorage.getItem(oldKey);
				if (value) {
					if (!localStorage.getItem(key)) localStorage.setItem(key, value);
					localStorage.removeItem(oldKey);
					raw = value;
					break;
				}
			}
		}
		if (raw) {
			const arr = JSON.parse(raw);
			if (Array.isArray(arr)) return new Set(arr);
		}
	} catch {
		/* ignore */
	}
	return new Set();
}

/** 供测试与调用方拼接 legacy agent id 列表（agentsRef 由调用方持有） */
export function legacyAgentIdsForProject(agents: AgentTab[], projectId: string): string[] {
	return agents.filter((a) => a.projectId === projectId).map((a) => a.id);
}
