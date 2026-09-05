/**
 * 会话 Tab 栏「按项目分组」纯逻辑（浏览器标签组风格）。
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
export function buildProjectTabGroups(
	tabs: readonly string[],
	pinned: readonly string[],
	projectOf: (sessionId: string) => SessionProjectRef | undefined,
): { pinned: string[]; groups: ProjectTabGroup[]; loose: string[] } {
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
