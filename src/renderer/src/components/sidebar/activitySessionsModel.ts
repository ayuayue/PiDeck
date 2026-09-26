/**
 * 活动页（侧栏「活动」分段）的行数据模型：
 * 上半部分是 runtime 绑定的活动 Agent 行，下半部分是「最近会话」（用户实际启动过的会话）。
 *
 * 为什么抽成纯函数模块：筛选 / 排序 / 条数裁剪都是产品规则（活动行按会话更新时间倒序、
 * 最近会话按访问时间倒序且必须排除已在活动区出现的会话、默认只放 10 条），这些规则必须能
 * 离开 React 单测（见 `tests/sidebarActivityRecent.test.mjs`）；组件只负责渲染与事件转发。
 *
 * 为什么自带 `ActivityCatalog` 形状而不 import `SidebarCatalog`：单测要直接加载本模块，
 * 而 `useSidebarController` 会连带拉进 Jotai。结构子集仍与 `controller.catalog` 兼容。
 */
import type { AgentTab, Project, SessionRecord } from "../../../../shared/types";
import { isDisplayableSessionRecord } from "../../utils/sessionRecordDisplay";

/** 活动行：一个已绑定 runtime 的 Agent。 */
export type ActiveSessionRow = {
	agent: AgentTab;
	projectId: string;
	/** 绑定会话记录：runtimeBySessionId 反查优先，否则按 sessionPath 匹配历史记录 */
	record?: SessionRecord;
	/** 排序基准：有绑定会话按会话更新时间，全新 Agent 按创建时间 */
	sortAt: number;
};

/** 最近会话行：用户实际启动过、但当前不在活动区的会话。 */
export type RecentSessionRow = {
	projectId: string;
	session: SessionRecord;
	/** 排序基准 = 访问时间（访问记录 entry.at），而不是会话文件更新时间。 */
	sortAt: number;
};

/** 访问记录条目：只取收集所需字段，避免 import atom 模块把 Jotai 拖进纯函数单测。 */
export type RecentActivityEntry = {
	sessionId: string;
	at: number;
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
 * 收集最近会话：从「实际启动过的会话」访问记录里取行，按访问时间倒序，返回「已裁剪的行 + 总条数」。
 *
 * 数据源是 `recent-session-atoms` 的访问记录（用户真正启动/运行过会话时才写入，最新在前、
 * 上限 20 条），而不是「catalog 里最近更新的全部历史」——后者的语义是「最近被动过的会话
 * 文件」，会把从没在 PiDeck 里打开过、只是文件时间新的会话也当成「最近」，两套模式曾经
 * 因此行为不一致。现在两种模式共用本函数。
 *
 * 总条数单独回传，让「加载更多」按钮能显示 x/y 并知道何时收起。
 *
 * 排除项（都与「不该在页面上渲染出空行或重复行」有关）：
 * - 已出现在活动行里的会话（传入 `activeRows` 时）：同一会话不能在页面上出现两次；
 * - `noSession`：运行时匿名会话不落 catalog，重启即消失，不算用过；
 * - 记录已删除 / 尚未随 catalog 扫到（`recordsById` 查不到）：跳过，不渲染空行；
 * - 无可显示身份且未绑定 runtime 的记录（`sessionRecordToSummary` 会返回 undefined，
 *   渲染出来是空标题行）；已绑定 runtime 的会话即使暂无摘要也保留，标题回落到 `session.title`。
 */
export function collectRecentActivityRows(input: { catalog: ActivityCatalog; activity: readonly RecentActivityEntry[]; activeRows: readonly ActiveSessionRow[]; visibleCount: number }): { rows: RecentSessionRow[]; totalCount: number } {
	const recordsById = new Map<string, SessionRecord>();
	for (const sessions of Object.values(input.catalog.sessionsByProject)) {
		for (const session of sessions) recordsById.set(session.id, session);
	}
	const activeSessionIds = new Set<string>();
	for (const row of input.activeRows) {
		if (row.record) activeSessionIds.add(row.record.id);
	}
	const rows: RecentSessionRow[] = [];
	for (const entry of input.activity) {
		if (activeSessionIds.has(entry.sessionId)) continue;
		const session = recordsById.get(entry.sessionId);
		if (!session || session.noSession) continue;
		if (!isDisplayableSessionRecord(session) && !input.catalog.runtimeBySessionId[session.id]) continue;
		rows.push({ projectId: session.projectId, session, sortAt: entry.at });
	}
	// 访问记录本身按时间倒序维护，这里再排序兜底：localStorage 被外部改写时不至于乱序。
	// `at` 相同时（同一毫秒内连续写入）保留输入顺序——Array#sort 稳定。
	rows.sort((left, right) => right.sortAt - left.sortAt);
	const limit = Math.max(0, input.visibleCount);
	return { rows: rows.slice(0, limit), totalCount: rows.length };
}

/** 「加载更多」后的可见条数：一次一页，并封顶总数（总数可能因会话删除而变小）。 */
export function growRecentVisible(current: number, totalCount: number): number {
	return Math.min(current + RECENT_SESSIONS_PAGE_SIZE, Math.max(0, totalCount));
}
