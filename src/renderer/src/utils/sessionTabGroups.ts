/**
 * 会话 Tab 栏「按项目分组 + 分屏组折叠」纯逻辑（浏览器标签组风格）。
 *
 * 不变量：
 * - 分组只作用于普通 Tab；固定（pinned）Tab 保持平铺在最前，分组不拆固定区；
 * - 组顺序 = 该组第一个 Tab 在 tabs 中的出现顺序；组内按 tabs 原序 ——
 *   「新打开的会话追加到它所属项目分组的末尾」由这个顺序语义天然保证，
 *   不需要改动 tabs 数组本身；
 * - 无项目归属（projectId 缺失 / 项目已删除）的会话不包组，平铺在组后。
 *
 * 颜色：按 projectId 稳定哈希取色（同一项目恒同色），色值与分屏组色板同源，
 * 见 SPLIT_GROUP_COLOR_PALETTE（SessionTabsBar 引用本常量构建）。
 *
 * ⚠️ 显示顺序的唯一来源是 buildSessionTabBarEntries：渲染（SessionTabsBar）与
 * Ctrl+Tab 循环切换（useSessionWorkspaceChrome）都必须消费它。底层 tabs 数组是
 * 「打开顺序」，多项目混排/分屏折叠后与显示顺序不同（issue #346 的真因），
 * 直接拿 tabs 算循环目标会跳到屏幕上不相邻的 Tab。
 */

/** 分组色板（浏览器标签组风格 8 色；分屏组与项目分组共用，保证视觉一致）。 */
export const GROUP_COLOR_VALUES = [
	"#0091ff", // blue（默认色，与 SPLIT_GROUP_DEFAULT_COLOR 一致）
	"#30a46c", // green
	"#f5d90a", // yellow
	"#f76b15", // orange
	"#e5484d", // red
	"#8e4ec6", // purple
	"#d6409f", // pink
	"#8d8d8d", // gray
] as const;

export type SessionProjectRef = {
	projectId: string;
	/** 项目显示名（空则回退 projectId） */
	name?: string;
};

export type ProjectTabGroup = {
	projectId: string;
	name: string;
	color: string;
	sessionIds: string[];
};

/**
 * projectId → 稳定色：FNV-1a 风格 31 倍哈希取模色板。
 * 纯展示用，同一 id 永远同色；不同 id 碰撞不影响正确性（只是同色）。
 */
export function projectGroupColor(projectId: string): string {
	let hash = 0;
	for (let i = 0; i < projectId.length; i += 1) {
		hash = (hash * 31 + projectId.charCodeAt(i)) | 0;
	}
	return GROUP_COLOR_VALUES[Math.abs(hash) % GROUP_COLOR_VALUES.length];
}

/** 构建项目分组视图（分组开关开启时 Tab 栏的整体布局数据）。 */
export function buildProjectTabGroups(tabs: readonly string[], pinned: readonly string[], projectOf: (sessionId: string) => SessionProjectRef | undefined): { pinned: string[]; groups: ProjectTabGroup[]; loose: string[] } {
	const pinnedOut: string[] = [];
	const loose: string[] = [];
	const groupsByProject = new Map<string, ProjectTabGroup>();
	for (const sessionId of tabs) {
		// 固定 Tab 平铺前置，不参与分组（与「固定 Tab 前置、无关闭按钮」语义一致）。
		if (pinned.includes(sessionId)) {
			pinnedOut.push(sessionId);
			continue;
		}
		const ref = projectOf(sessionId);
		if (!ref || !ref.projectId) {
			// 会话未关联项目（如纯聊天、目录已删除）：不包组，平铺展示。
			loose.push(sessionId);
			continue;
		}
		let group = groupsByProject.get(ref.projectId);
		if (!group) {
			group = {
				projectId: ref.projectId,
				name: ref.name?.trim() || ref.projectId,
				color: projectGroupColor(ref.projectId),
				sessionIds: [],
			};
			groupsByProject.set(ref.projectId, group);
		}
		group.sessionIds.push(sessionId);
	}
	return { pinned: pinnedOut, groups: [...groupsByProject.values()], loose };
}

/**
 * 标签栏「显示单元」：一个渲染节点 + 它在显示顺序里占用的会话序列。
 * - tab：自由 Tab（固定 Tab / 无项目归属）；
 * - project：项目分组，整组连续输出（组内按 tabs 原序，新打开的回到组尾）；
 * - split：分屏组，整组折叠成一个「组头胶囊 + 组内 Tab」节点（组内按分屏 layout 视觉顺序）。
 */
export type SessionTabBarEntry = { kind: "tab"; sessionId: string } | { kind: "project"; projectId: string; sessionIds: string[] } | { kind: "split"; sessionIds: string[] };

/**
 * 构建标签栏显示单元序列 —— 渲染顺序与 Ctrl+Tab 循环顺序的唯一定义。
 *
 * 顺序语义（与旧渲染期合并逻辑逐字对齐，仅把「显示顺序」从渲染层提到共享纯函数）：
 * - 按 tabs（打开顺序）扫描；
 * - 分屏组成员不参与项目分组，其单元落在「layout 首个仍在 tabs 的成员」所在的槽位
 *  （锚点缺失时回退到首个在场成员，避免 layout 与 tabs 短暂不一致导致整组消失）；
 * - 项目分组在该组首个未消费成员处整组输出；
 * - 每个 tab 恰好出现一次（pinned / 分组 / loose 全覆盖）。
 */
export function buildSessionTabBarEntries(tabs: readonly string[], pinned: readonly string[], splitGroupIds: readonly string[], projectOf: (sessionId: string) => SessionProjectRef | undefined): SessionTabBarEntry[] {
	// 只统计确实还在 tabs 里的分屏成员：成员数不足 2 时分屏组不成立，按普通 Tab 参与项目分组。
	const splitMembers = splitGroupIds.filter((id) => tabs.includes(id));
	const hasSplit = splitMembers.length > 1;
	const splitSet = new Set(hasSplit ? splitMembers : []);
	const splitAnchor = hasSplit ? splitMembers[0] : undefined;
	// 分屏组内的 Tab 不参与项目分组（保持分屏语义），与渲染层的既有行为一致。
	const projectView = buildProjectTabGroups(hasSplit ? tabs.filter((id) => !splitSet.has(id)) : tabs, pinned, projectOf);
	const groupBySession = new Map<string, ProjectTabGroup>();
	for (const group of projectView.groups) {
		for (const id of group.sessionIds) groupBySession.set(id, group);
	}

	const entries: SessionTabBarEntry[] = [];
	const emitted = new Set<string>();
	for (const sessionId of tabs) {
		if (emitted.has(sessionId)) continue;
		if (hasSplit && splitSet.has(sessionId)) {
			// 锚点之前的成员先跳过，到锚点处整组一次输出（组内保持 layout 视觉顺序）。
			if (sessionId !== splitAnchor) continue;
			for (const id of splitMembers) emitted.add(id);
			entries.push({ kind: "split", sessionIds: [...splitMembers] });
			continue;
		}
		const group = groupBySession.get(sessionId);
		if (group) {
			const sessionIds = group.sessionIds.filter((id) => !emitted.has(id));
			for (const id of sessionIds) emitted.add(id);
			entries.push({ kind: "project", projectId: group.projectId, sessionIds });
			continue;
		}
		entries.push({ kind: "tab", sessionId });
		emitted.add(sessionId);
	}
	return entries;
}

/**
 * 折叠为「显示顺序」的会话 id 序列：与 SessionTabsBar 的渲染顺序逐项相同，
 * 供 Ctrl+Tab 循环切换取目标（分屏组从胶囊位置起按组内顺序展开）。
 */
export function flattenSessionTabBarEntries(entries: readonly SessionTabBarEntry[]): string[] {
	const order: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "tab") order.push(entry.sessionId);
		else order.push(...entry.sessionIds);
	}
	return order;
}
