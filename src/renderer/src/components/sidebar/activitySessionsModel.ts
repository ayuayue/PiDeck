/**
 * 活动页（侧栏「活动」分段）的行数据模型：
 * 上半部分是 runtime 绑定的活动 Agent 行，下半部分是「最近会话」（无 runtime 的历史会话）。
 *
 * 为什么抽成纯函数模块：筛选 / 排序 / 条数裁剪都是产品规则（活动行按会话更新时间倒序、
 * 最近会话跨项目平铺且必须排除已在活动区出现的会话、默认只放 10 条），这些规则必须能
 * 离开 React 单测（见 `tests/sidebarActivityRecent.test.mjs`）；组件只负责渲染与事件转发。
 *
 * 为什么自带 `ActivityCatalog` 形状而不 import `SidebarCatalog`：单测要直接加载本模块，
 * 而 `useSidebarController` 会连带拉进 Jotai。结构子集仍与 `controller.catalog` 兼容。
 */
import type { AgentTab, Project, SessionRecord } from "../../../../shared/types";

/** 活动行：一个已绑定 runtime 的 Agent。 */
export type ActiveSessionRow = {
	agent: AgentTab;
	projectId: string;
	/** 绑定会话记录：runtimeBySessionId 反查优先，否则按 sessionPath 匹配历史记录 */
	record?: SessionRecord;
	/** 排序基准：有绑定会话按会话更新时间，全新 Agent 按创建时间 */
	sortAt: number;
};

/** 最近会话行：不属于活动区的历史会话。 */
export type RecentSessionRow = {
	projectId: string;
	session: SessionRecord;
	/** 排序基准 = session.updatedAt */
	sortAt: number;
};

/** 活动页需要的最小 catalog 形状（`controller.catalog` 的结构化子集）。 */
export type ActivityCatalog = {
	projects: readonly Pick<Project, "id">[];
	agents: readonly AgentTab[];
	sessionsByProject: Readonly<Record<string, readonly SessionRecord[]>>;
	runtimeBySessionId: Readonly<Record<string, { agentId?: string } | undefined>>;
};

/** 「最近」默认显示 10 条；每次手动「加载更多」再多放 10 条。 */
export const RECENT_SESSIONS_INITIAL_VISIBLE = 10;
export const RECENT_SESSIONS_PAGE_SIZE = 10;

/**
 * 「加载更多」旁「收起」入口的显示门槛：可见条数超过首页时才值得给。
 *
 * 默认 10 条本身收不起来（收起来仍是 10 条），所以只有用户点过「加载更多」
 * 才可能出现收起；与项目页 `hasExpandedChildren`（存在显式计数即视为展开过）
 * 同一语义，只是这里用「条数 > 首页」表达，避免再存一份布尔标记。
 */
export function canCollapseRecent(visibleCount: number): boolean {
	return visibleCount > RECENT_SESSIONS_INITIAL_VISIBLE;
}

/**
 * 收集活动行：跨项目取全部 runtime 绑定 Agent，按更新时间倒序。
 *
 * 不过滤终态（error/closed）：这类会话进程虽已结束，但 Tab 还开着、需要能从活动页
 * 直接重启或重载——过滤掉它们会让失败会话只能去 chats 历史里翻。
 * detached 已由 `agentInventoryAtom` 排除在 `catalog.agents` 之外。
 */
export function collectActiveSessionRows(catalog: ActivityCatalog): ActiveSessionRow[] {
	// 项目可能已被删除，而 Agent 清单还没刷新：只保留项目仍存在的行（与旧实现语义一致，
	// 但用 Set 查表代替 projects × agents 双层循环）。
	const projectIds = new Set(catalog.projects.map((project) => project.id));
	const rows: ActiveSessionRow[] = [];
	for (const agent of catalog.agents) {
		if (!projectIds.has(agent.projectId)) continue;
		const sessions = catalog.sessionsByProject[agent.projectId] ?? [];
		const bound = sessions.find((session) => catalog.runtimeBySessionId[session.id]?.agentId === agent.id) ?? sessions.find((session) => session.filePath === agent.sessionPath);
		rows.push({
			agent,
			projectId: agent.projectId,
			record: bound,
			sortAt: bound ? bound.updatedAt : agent.createdAt,
		});
	}
	rows.sort((left, right) => right.sortAt - left.sortAt);
	return rows;
}

/**
 * 收集最近会话：跨项目平铺、按更新时间倒序，返回「已裁剪的行 + 总条数」。
 *
 * 总条数单独回传，让「加载更多」按钮能显示 x/y 并知道何时收起。
 *
 * 排除项（都与「不该在活动页出现第二次或渲染出空行」有关）：
 * - 已出现在活动行里的会话：同一会话不能在页面上出现两次；
 * - 草稿（`status === "draft"`）：未落盘的临时会话，chats 分段单独渲染；
 * - `noSession`：运行时匿名会话不落 catalog，重启即消失，不算「历史」；
 * - 嵌套子会话（`parentSessionPath`）：侧栏在别处已折叠到父行下，平铺出来是噪音；
 * - 无可显示身份的记录（无 `filePath` 且非 dsh/imagegen）：`sessionRecordToSummary`
 *   对这类记录返回 undefined，渲染出来只会是空标题行。
 */
export function collectRecentSessionRows(input: { catalog: ActivityCatalog; activeRows: readonly ActiveSessionRow[]; visibleCount: number }): { rows: RecentSessionRow[]; totalCount: number } {
	const activeSessionIds = new Set<string>();
	for (const row of input.activeRows) {
		if (row.record) activeSessionIds.add(row.record.id);
	}
	const candidates: RecentSessionRow[] = [];
	for (const [projectId, sessions] of Object.entries(input.catalog.sessionsByProject)) {
		for (const session of sessions) {
			if (activeSessionIds.has(session.id)) continue;
			if (session.status === "draft") continue;
			if (session.noSession) continue;
			if (session.parentSessionPath) continue;
			// 与 sessionRecordToSummary 的可显示判据保持一致（DSH / 生图会话没有 pi 会话文件）
			if (!session.filePath && session.backend !== "dsh" && session.backend !== "imagegen") continue;
			candidates.push({ projectId, session, sortAt: session.updatedAt });
		}
	}
	// updatedAt 相同时用 id 兜底：同一批扫入的会话常共享时间戳，没有稳定次序会让行在
	// 每次 catalog 刷新后互相换位（用户看到列表自己跳动）。
	candidates.sort((left, right) => right.sortAt - left.sortAt || compareIds(left.session.id, right.session.id));
	const limit = Math.max(0, input.visibleCount);
	return { rows: candidates.slice(0, limit), totalCount: candidates.length };
}

/** 「加载更多」后的可见条数：一次一页，并封顶总数（总数可能因会话删除而变小）。 */
export function growRecentVisible(current: number, totalCount: number): number {
	return Math.min(current + RECENT_SESSIONS_PAGE_SIZE, Math.max(0, totalCount));
}

function compareIds(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
