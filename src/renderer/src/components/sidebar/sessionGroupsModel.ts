/**
 * 侧栏分组树的装配模型（纯函数，可单测）。
 *
 * 分组存的是会话 id 引用；这里负责把引用解析成「分组 → 会话」两层列表：
 * - 失效引用（会话已删除 / 项目已移除）直接丢弃，store 不追删（与插件页同语义）；
 * - 一个会话属于多个分组时会重复出现（分组本就允许多组归属）；
 * - 不再按项目插一层文件夹：项目信息只作为行内标签（多项目分组才显示），避免三层缩进把
 *   会话标题挤到窄侧栏放不下。
 */
import type { Project, SessionGroup, SessionRecord } from "../../../../shared/types";
import type { HostPluginCatalog } from "../../../../shared/types/hostPlugin";

/** 侧栏分组树的产出方：session-groups 宿主插件（示例包在 docs/examples/host-plugins/，目录名 = manifest.id）。 */
export const SESSION_GROUPS_PLUGIN_ID = "session-groups";

/**
 * 分组插件开关：只有插件处于已启用（且代码指纹一致）状态时，侧栏才展示分组的会话。
 * 未安装 / 已停用 / catalog 尚未加载都按关闭处理（fail-closed），避免插件关掉后还留着可点的旧分组。
 */
export function isSessionGroupsPluginEnabled(catalog: HostPluginCatalog | undefined): boolean {
	return catalog?.plugins.some((plugin) => plugin.enabled && plugin.manifest.id === SESSION_GROUPS_PLUGIN_ID) === true;
}

export type SessionGroupNode = {
	group: SessionGroup;
	/** 解析后仍存活的会话数（< sessionIds.length 说明有失效引用）。 */
	total: number;
	/** 组内会话覆盖的项目数：>1 时行内标出项目名，单项目组不重复项目名。 */
	projectCount: number;
	/** 组内会话，按 updatedAt 降序（最近在上）。 */
	sessions: SessionRecord[];
};

export function projectDirectoryLabel(project: Project | undefined, projectId: string): { name: string; path: string | undefined } {
	if (!project) return { name: projectId, path: undefined };
	return { name: project.name, path: "locator" in project && project.locator ? project.locator.remotePath : project.path };
}

/** 把分组引用解析成两层列表；groups 顺序即用户拖拽出的显示顺序，原样保留。 */
export function buildSessionGroupNodes(groups: readonly SessionGroup[], records: Readonly<Record<string, SessionRecord>>, projectsById: Readonly<Record<string, Project>>): SessionGroupNode[] {
	return groups.map((group) => {
		const seen = new Set<string>();
		const sessions: SessionRecord[] = [];
		for (const sessionId of group.sessionIds) {
			if (seen.has(sessionId)) continue;
			seen.add(sessionId);
			const record = records[sessionId];
			// 会话已删/项目已移除（含虚拟会话）：引用失效，直接丢弃——点了也打不开。
			if (!record || record.noSession || !projectsById[record.projectId]) continue;
			sessions.push(record);
		}
		sessions.sort((left, right) => right.updatedAt - left.updatedAt);
		const projectCount = new Set(sessions.map((session) => session.projectId)).size;
		return { group, total: sessions.length, projectCount, sessions };
	});
}

/**
 * 项目列表要隐藏的会话 id：来自解析后的分组节点，而不是 group.sessionIds。
 *
 * 只用节点是因为「分组树里看得见」才是隐藏的前提：未展开项目的 catalog 还没加载，
 * 那些会话没有记录、也不会出现在分组树里；若照样从项目列表隐藏，它会两边都不出现。
 */
export function collectGroupedSessionIds(nodes: readonly SessionGroupNode[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const node of nodes) for (const session of node.sessions) ids.add(session.id);
	return ids;
}

/**
 * 项目列表是否隐藏某会话：已进入分组、且当前没有搜索词时隐藏。
 * 搜索是「按名字找回会话」的入口，命中时必须也能在项目列表里看到，否则越搜越找不到。
 */
export function shouldHideGroupedSession(sessionId: string, groupedSessionIds: ReadonlySet<string> | undefined, search: string): boolean {
	if (!groupedSessionIds?.has(sessionId)) return false;
	return search.trim().length === 0;
}
