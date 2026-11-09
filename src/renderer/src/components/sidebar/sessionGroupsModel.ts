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
import { isChatProject } from "../../rendererUtils";

/**
 * 侧栏分组树的展示范围：分组按「聊天 / 项目」两个栏目分别展示，活动页不挂分组。
 *
 * 栏目与会话的对应关系是 1:1 的（一个会话要么属于内置 Chat，要么属于某个工作区项目），
 * 所以按范围裁剪不会让任何入组会话在两个栏目里都看不到——这也是「项目列表隐藏入组会话」
 * 仍成立的前提；范围只决定分组树在哪个栏目里出现、列出哪一半会话。
 */
export type SessionGroupScope = "chat" | "project";

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

function inScope(project: Project, scope: SessionGroupScope): boolean {
	// 栏目划分就是「Chat 项目 vs 工作区项目」，与 rendererUtils.isChatProject 同一口径。
	return scope === "chat" ? isChatProject(project) : !isChatProject(project);
}

export function projectDirectoryLabel(project: Project | undefined, projectId: string): { name: string; path: string | undefined } {
	if (!project) return { name: projectId, path: undefined };
	return { name: project.name, path: "locator" in project && project.locator ? project.locator.remotePath : project.path };
}

/**
 * 把分组引用解析成两层列表；groups 顺序即用户拖拽出的显示顺序，原样保留。
 *
 * scope 给了就只保留该栏目的会话（聊天 / 项目），并丢掉裁剪后一个会话都不剩的分组：
 * 跨栏目分组在另一栏目只显示自己那一半，剩下空气时再挂一行「组内没有可用会话」会被
 * 误读成数据损坏。scope 省略 = 全量（简洁壳侧栏与单测）。
 */
export function buildSessionGroupNodes(groups: readonly SessionGroup[], records: Readonly<Record<string, SessionRecord>>, projectsById: Readonly<Record<string, Project>>, scope?: SessionGroupScope): SessionGroupNode[] {
	const nodes = groups.map((group) => {
		const seen = new Set<string>();
		const sessions: SessionRecord[] = [];
		for (const sessionId of group.sessionIds) {
			if (seen.has(sessionId)) continue;
			seen.add(sessionId);
			const record = records[sessionId];
			// 会话已删/项目已移除（含虚拟会话）：引用失效，直接丢弃——点了也打不开。
			if (!record || record.noSession) continue;
			const project = projectsById[record.projectId];
			if (!project) continue;
			if (scope && !inScope(project, scope)) continue;
			sessions.push(record);
		}
		sessions.sort((left, right) => right.updatedAt - left.updatedAt);
		// projectCount 按裁剪后的会话算：聊天栏目恒为 1，行内不再重复标项目名。
		const projectCount = new Set(sessions.map((session) => session.projectId)).size;
		return { group, total: sessions.length, projectCount, sessions };
	});
	return scope ? nodes.filter((node) => node.total > 0) : nodes;
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
 *
 * 也用于运行时 agent 行（传 agent.deckSessionId）：运行中会话已入组时，项目列表不能再多一条
 * 同名 agent 行，否则用户看到的是「分组没生效」；未绑定 catalog 会话（无 id）的 agent 不隐藏。
 */
export function shouldHideGroupedSession(sessionId: string | undefined, groupedSessionIds: ReadonlySet<string> | undefined, search: string): boolean {
	if (!sessionId || !groupedSessionIds?.has(sessionId)) return false;
	return search.trim().length === 0;
}
