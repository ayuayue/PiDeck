/**
 * 侧栏分组树的装配模型（纯函数，可单测）。
 *
 * 分组存的是会话 id 引用；这里负责把引用解析成「分组 → 目录（项目）→ 会话」三层树：
 * - 失效引用（会话已删除 / 项目已移除）直接丢弃，store 不追删（与插件页同语义）；
 * - 一个会话属于多个分组时会重复出现（分组本就允许多组归属）；
 * - 「目录」= 会话所属项目：名字用项目名，tooltip 给完整路径（远端给远端路径）。
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

export type SessionGroupDirNode = {
	/** 分组内去重键：项目 id。 */
	key: string;
	/** 项目名；项目已移除时退回 id（这批会话马上会被丢弃，正常不会露出来）。 */
	name: string;
	/** 项目根路径（远端为远端路径），tooltip 用；拿不到为 undefined。 */
	path: string | undefined;
	projectId: string;
	/** 组内该项目下的会话，按 updatedAt 降序（最近在上）。 */
	sessions: SessionRecord[];
};

export type SessionGroupNode = {
	group: SessionGroup;
	/** 解析后仍存活的会话数（< sessionIds.length 说明有失效引用）。 */
	total: number;
	dirs: SessionGroupDirNode[];
};

export function projectDirectoryLabel(project: Project | undefined, projectId: string): { name: string; path: string | undefined } {
	if (!project) return { name: projectId, path: undefined };
	return { name: project.name, path: "locator" in project && project.locator ? project.locator.remotePath : project.path };
}

/** 把分组引用解析成树；groups 顺序即用户拖拽出的显示顺序，原样保留。 */
export function buildSessionGroupNodes(groups: readonly SessionGroup[], records: Readonly<Record<string, SessionRecord>>, projectsById: Readonly<Record<string, Project>>): SessionGroupNode[] {
	return groups.map((group) => {
		const byProject = new Map<string, SessionRecord[]>();
		const seen = new Set<string>();
		for (const sessionId of group.sessionIds) {
			if (seen.has(sessionId)) continue;
			seen.add(sessionId);
			const record = records[sessionId];
			// 会话已删/项目已移除（含虚拟会话）：引用失效，直接丢弃——点了也打不开。
			if (!record || record.noSession || !projectsById[record.projectId]) continue;
			const bucket = byProject.get(record.projectId);
			if (bucket) bucket.push(record);
			else byProject.set(record.projectId, [record]);
		}
		const dirs: SessionGroupDirNode[] = [...byProject.entries()].map(([projectId, sessions]) => {
			const label = projectDirectoryLabel(projectsById[projectId], projectId);
			return {
				key: projectId,
				name: label.name,
				path: label.path,
				projectId,
				sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
			};
		});
		return { group, total: [...byProject.values()].reduce((sum, bucket) => sum + bucket.length, 0), dirs };
	});
}
