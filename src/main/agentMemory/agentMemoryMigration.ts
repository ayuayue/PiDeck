/**
 * 记忆项目键迁移（一次性、幂等）。
 *
 * 键算法从「短路径直接用 slug」换成「slug + 路径哈希」（见 `resources/agent-memory/paths.mjs`）：
 * 老版本落下的 `projects/<旧键>/` 在新算法下再也读不到，表现为「我的项目记忆不见了」。
 * 启动时把旧目录改名到新键即可，但只能处理**宿主已知的项目路径**——键是单向派生，
 * 无法从目录名反推原来的 cwd；其余项目在对应会话启动时由 MCP 服务器自己补迁。
 *
 * 迁移失败不阻断启动：记忆读不到是降级，应用起不来是故障。
 */

import { migrateLegacyProjectDirs } from "../../../resources/agent-memory/migrate.mjs";

/** 只迁这些路径；ssh 项目传远端路径（与会话 cwd 的派生口径一致）。 */
export function migrateAgentMemoryProjectKeys(root: string, projectPaths: string[]): { moved: string[]; skipped: string[] } {
	try {
		const result = migrateLegacyProjectDirs(root, projectPaths);
		return { moved: result.moved.map((item) => `${item.from} -> ${item.to}`), skipped: result.skipped.map((item) => item.from) };
	} catch {
		return { moved: [], skipped: [] };
	}
}
