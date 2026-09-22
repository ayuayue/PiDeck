import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 侧栏「活动」页「最近会话」区：模型纯函数 + 组件契约。
 *
 * 背景：活动区只显示 runtime 绑定的 Agent，应用重启后活动区会空，
 * 用户找不到刚才用过的会话。于是活动行下面补一个「最近会话」（默认 10 条 + 手动加载更多）。
 * 这里守两类不变量：
 * 1. 模型规则（谁算最近、排除谁、排多少条）——纯函数，可直接断言；
 * 2. 组件契约（与 SessionTree 行样式逐字一致、分段顺序、空态与计数）——源码扫描断言。
 */

const sidebarDir = "src/renderer/src/components/sidebar/";
const activeSessionsTree = readFileSync(`${sidebarDir}ActiveSessionsTree.tsx`, "utf8");
const recentSessionsSection = readFileSync(`${sidebarDir}RecentSessionsSection.tsx`, "utf8");
const sessionTree = readFileSync(`${sidebarDir}SessionTree.tsx`, "utf8");
const foundationStyles = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const workspaceStyles = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
const sidebarContent = readFileSync(`${sidebarDir}SidebarContent.tsx`, "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const { RECENT_SESSIONS_INITIAL_VISIBLE, RECENT_SESSIONS_PAGE_SIZE, collectActiveSessionRows, collectRecentSessionRows, growRecentVisible, canCollapseRecent } = loadTsCommonJs("src/renderer/src/components/sidebar/activitySessionsModel.ts");

/** 按 `const name = "..."` 抽取类名常量：不做正则转义，避免格式改动让断言整组失效。 */
function extractStringConst(source, name) {
	const start = source.indexOf(`const ${name} =`);
	assert.notEqual(start, -1, `${name} must exist`);
	const quoteStart = source.indexOf('"', start);
	const quoteEnd = source.indexOf('";', quoteStart);
	assert.ok(quoteStart !== -1 && quoteEnd !== -1, `${name} must be a double-quoted string`);
	return source.slice(quoteStart + 1, quoteEnd);
}

// ── 测试数据工厂：只用模型真正读取的字段，其余给稳定默认值 ──────────────────
const makeProject = (id) => ({ id, name: id, path: `/code/${id}` });
const makeSession = (overrides = {}) => ({
	id: "s1",
	projectId: "p1",
	title: "会话",
	updatedAt: 1,
	source: "pi",
	environment: "local",
	status: "ready",
	filePath: "/sessions/s1.jsonl",
	...overrides,
});
const makeAgent = (overrides = {}) => ({
	id: "a1",
	projectId: "p1",
	title: "Agent",
	status: "idle",
	backend: "pi",
	createdAt: 1,
	sessionPath: undefined,
	...overrides,
});
const makeCatalog = ({ projects = ["p1"], agents = [], sessionsByProject = {}, runtimeBySessionId = {} } = {}) => ({
	projects: projects.map(makeProject),
	agents,
	sessionsByProject,
	runtimeBySessionId,
});

describe("collectActiveSessionRows（活动行收集）", () => {
	test("按 runtimeBySessionId 反查到绑定会话，并用会话更新时间排序", () => {
		const older = makeSession({ id: "old", updatedAt: 10 });
		const newer = makeSession({ id: "new", updatedAt: 99 });
		const rows = collectActiveSessionRows(
			makeCatalog({
				agents: [makeAgent({ id: "a-old", sessionPath: "/sessions/old.jsonl", createdAt: 1 }), makeAgent({ id: "a-new", sessionPath: "/sessions/new.jsonl", createdAt: 2 })],
				sessionsByProject: { p1: [older, newer] },
				runtimeBySessionId: { old: { agentId: "a-old" }, new: { agentId: "a-new" } },
			}),
		);
		// 模型在 vm 沙箱里求值，数组原型与测试不同 realm：用 join 断言顺序而非 deepEqual。
		assert.equal(rows.map((row) => row.record?.id).join(","), "new,old");
	});

	test("runtime 未绑定时回退按 sessionPath 匹配历史会话", () => {
		const bound = makeSession({ id: "s-path", updatedAt: 5, filePath: "/sessions/path.jsonl" });
		const rows = collectActiveSessionRows(makeCatalog({ agents: [makeAgent({ sessionPath: "/sessions/path.jsonl" })], sessionsByProject: { p1: [bound] }, runtimeBySessionId: {} }));
		assert.equal(rows[0]?.record?.id, "s-path");
	});

	test("无绑定会话的全新 Agent 用 createdAt 排序（排在有会话的行之后）", () => {
		const rows = collectActiveSessionRows(makeCatalog({ agents: [makeAgent({ id: "a-new-agent", createdAt: 1000, sessionPath: undefined })], sessionsByProject: { p1: [makeSession({ updatedAt: 5 })] }, runtimeBySessionId: {} }));
		// sessionPath 不匹配任何会话 => record 为空，sortAt 取 createdAt
		assert.equal(rows[0]?.record, undefined);
		assert.equal(rows[0]?.sortAt, 1000);
	});

	test("终态（error/closed）Agent 仍出现在活动行，便于从活动页重启失败会话", () => {
		const rows = collectActiveSessionRows(makeCatalog({ agents: [makeAgent({ id: "a-err", status: "error" }), makeAgent({ id: "a-closed", status: "closed" })] }));
		assert.equal(
			rows
				.map((row) => row.agent.id)
				.sort()
				.join(","),
			"a-closed,a-err",
		);
	});

	test("项目已删除但 Agent 清单未刷新时跳过该行（不渲染孤儿行）", () => {
		const rows = collectActiveSessionRows(makeCatalog({ projects: ["p1"], agents: [makeAgent({ id: "a-orphan", projectId: "gone" }), makeAgent({ id: "a-ok", projectId: "p1" })] }));
		assert.equal(rows.map((row) => row.agent.id).join(","), "a-ok");
	});
});

describe("collectRecentSessionRows（最近会话收集）", () => {
	test("默认只返回 10 条，但回传总条数供「加载更多」显示 x/y", () => {
		const sessions = Array.from({ length: 25 }, (_, index) => makeSession({ id: `s${index}`, updatedAt: 100 - index }));
		const { rows, totalCount } = collectRecentSessionRows({ catalog: makeCatalog({ sessionsByProject: { p1: sessions } }), activeRows: [], visibleCount: RECENT_SESSIONS_INITIAL_VISIBLE });
		assert.equal(RECENT_SESSIONS_INITIAL_VISIBLE, 10);
		assert.equal(rows.length, 10);
		assert.equal(totalCount, 25);
		// 最新的排最前
		assert.equal(rows[0]?.session.id, "s0");
	});

	test("已在活动行出现的会话不会在「最近」里重复出现", () => {
		const shared = makeSession({ id: "shared", updatedAt: 50 });
		const onlyHistory = makeSession({ id: "history", updatedAt: 40 });
		const activeRows = collectActiveSessionRows(makeCatalog({ agents: [makeAgent({ status: "running" })], sessionsByProject: { p1: [shared] }, runtimeBySessionId: { shared: { agentId: "a1" } } }));
		const { rows } = collectRecentSessionRows({ catalog: makeCatalog({ sessionsByProject: { p1: [shared, onlyHistory] }, runtimeBySessionId: { shared: { agentId: "a1" } } }), activeRows, visibleCount: 10 });
		assert.equal(rows.map((row) => row.session.id).join(","), "history");
	});

	test("排除草稿 / 匿名会话 / 嵌套子会话 / 无文件且非 dsh·生图的记录", () => {
		const sessions = [
			makeSession({ id: "draft", status: "draft", updatedAt: 9 }),
			makeSession({ id: "no-session", noSession: true, updatedAt: 8 }),
			makeSession({ id: "child", parentSessionPath: "/sessions/parent.jsonl", updatedAt: 7 }),
			// 没有会话文件又不是 dsh/生图：sessionRecordToSummary 会返回 undefined，渲染出来是空标题行
			makeSession({ id: "orphan", filePath: undefined, backend: "pi", updatedAt: 6 }),
			makeSession({ id: "keep", updatedAt: 5 }),
		];
		const { rows, totalCount } = collectRecentSessionRows({ catalog: makeCatalog({ sessionsByProject: { p1: sessions } }), activeRows: [], visibleCount: 10 });
		assert.equal(rows.map((row) => row.session.id).join(","), "keep");
		assert.equal(totalCount, 1);
	});

	test("dsh / 生图会话即使没有会话文件也算最近会话", () => {
		const sessions = [makeSession({ id: "dsh", backend: "dsh", filePath: undefined, updatedAt: 3 }), makeSession({ id: "imagegen", backend: "imagegen", filePath: undefined, updatedAt: 2 })];
		const { rows } = collectRecentSessionRows({ catalog: makeCatalog({ sessionsByProject: { p1: sessions } }), activeRows: [], visibleCount: 10 });
		assert.equal(
			rows
				.map((row) => row.session.id)
				.sort()
				.join(","),
			"dsh,imagegen",
		);
	});

	test("跨项目平铺，并按 id 兜底排序保证同时间戳会话次序稳定", () => {
		const catalog = makeCatalog({
			projects: ["p1", "p2"],
			sessionsByProject: {
				p1: [makeSession({ id: "b", projectId: "p1", updatedAt: 10 }), makeSession({ id: "a", projectId: "p1", updatedAt: 10 })],
				p2: [makeSession({ id: "c", projectId: "p2", updatedAt: 20 })],
			},
		});
		const first = collectRecentSessionRows({ catalog, activeRows: [], visibleCount: 10 });
		const second = collectRecentSessionRows({ catalog, activeRows: [], visibleCount: 10 });
		assert.equal(first.rows.map((row) => row.session.id).join(","), "c,a,b");
		assert.equal(first.rows.map((row) => row.session.id).join(","), second.rows.map((row) => row.session.id).join(","));
		assert.equal(first.rows.map((row) => row.projectId).join(","), "p2,p1,p1");
	});

	test("visibleCount 为 0/负数时不渲染任何行", () => {
		const catalog = makeCatalog({ sessionsByProject: { p1: [makeSession({ id: "s1" })] } });
		assert.equal(collectRecentSessionRows({ catalog, activeRows: [], visibleCount: 0 }).rows.length, 0);
		assert.equal(collectRecentSessionRows({ catalog, activeRows: [], visibleCount: -5 }).rows.length, 0);
	});
});

describe("growRecentVisible（加载更多）", () => {
	test("每次一页（+10）", () => {
		assert.equal(RECENT_SESSIONS_PAGE_SIZE, 10);
		assert.equal(growRecentVisible(10, 100), 20);
	});

	test("封顶总数：总数因会话删除变小时不会超过它", () => {
		assert.equal(growRecentVisible(20, 24), 24);
		assert.equal(growRecentVisible(20, 0), 0);
	});
});

describe("最近会话区渲染契约", () => {
	test("行样式与 SessionTree 会话行逐字一致（同段列表不能有两种行皮）", () => {
		assert.equal(extractStringConst(recentSessionsSection, "recentRowClass"), extractStringConst(sessionTree, "sessionRowClass"), "RecentSessionsSection.recentRowClass 必须与 SessionTree.sessionRowClass 逐字一致");
		assert.equal(extractStringConst(recentSessionsSection, "selectedRowClass"), extractStringConst(sessionTree, "selectedRowClass"), "选中底必须与 SessionTree.selectedRowClass 逐字一致");
		assert.equal(extractStringConst(recentSessionsSection, "rowMoreActionsClass"), extractStringConst(sessionTree, "rowMoreActionsClass"), "行尾「⋯」浮层必须与 SessionTree.rowMoreActionsClass 逐字一致");
	});

	test("最近会话行沿用历史会话行标识（history-session-row / session-row）", () => {
		assert.match(recentSessionsSection, /history-session-row/);
		assert.match(recentSessionsSection, /session-row/);
		// 同一个 TitleScrollText 标题截断 + hover 滚动组件，不另起一套截断逻辑
		assert.match(recentSessionsSection, /<TitleScrollText\s+text=\{displayTitle\}/);
		assert.doesNotMatch(recentSessionsSection, /<TitleScrollText\b[^>]*\bdisabled\b/);
	});

	test("分段顺序：活动行在上、最近会话在下，两段各自成区（下半部分常驻）", () => {
		const paneStart = activeSessionsTree.indexOf('className="active-sessions-pane');
		const listStart = activeSessionsTree.indexOf('className="active-sessions-list');
		const activeRowsIndex = activeSessionsTree.indexOf("liveRows.map(");
		const recentPaneIndex = activeSessionsTree.indexOf('className="recent-sessions-pane');
		const recentIndex = activeSessionsTree.indexOf("<RecentSessionsSection");
		assert.ok(paneStart !== -1, "活动页需要一个上下分区的容器");
		assert.ok(listStart !== -1, "活动页需要上半列表容器");
		assert.ok(activeRowsIndex !== -1, "活动行仍在该组件内渲染");
		assert.ok(recentIndex !== -1, "最近会话区区必须挂在活动页");
		assert.ok(paneStart < listStart, "上半列表包在分区容器内");
		assert.ok(listStart < activeRowsIndex, "上半列表容器必须包裹活动行");
		assert.ok(recentPaneIndex !== -1 && recentIndex !== -1, "最近会话需要自己的下半区容器");
		assert.ok(activeRowsIndex < recentIndex, "最近会话区必须排在活动行下方");
		// 上下两半共用 1fr 平分：行数多时不会把另一半挤走，各自滚动
		assert.ok((activeSessionsTree.match(/flex min-h-0 flex-1 flex-col/g) ?? []).length >= 2, "上下两半都要 min-h-0 + flex-1");
		assert.ok((activeSessionsTree.match(/overflow-y-auto/g) ?? []).length >= 2, "上下两半各自滚动");
	});

	test("分页条常驻本区下缘（悬浮，不用滚到底）", () => {
		assert.match(recentSessionsSection, /sticky bottom-0/);
	});

	test("两段之间有分界线与段落标题，并显示已显示/总数计数", () => {
		// 分界线：上边框 + 段落标题、计数行；标题在计数左侧（标题左对齐、计数右对齐）
		assert.match(recentSessionsSection, /border-t border-border\/40/);
		const headerIndex = recentSessionsSection.indexOf('t("app.sidebarRecentSessions")');
		const countIndex = recentSessionsSection.indexOf("props.visibleCount}/{props.totalCount}");
		assert.ok(headerIndex !== -1, "段落标题必须显示「最近会话」");
		assert.ok(countIndex !== -1, "段落标题必须显示 x/y 计数");
		assert.ok(headerIndex < countIndex, "标题在计数之前");
		// 标题加粗：与项目页分组标题同档（否则会被当成又一行会话）
		assert.match(recentSessionsSection, /text-caption font-semibold text-muted-foreground">\{t\("app\.sidebarRecentSessions"\)\}/);
	});

	test("默认 10 条由 RECENT_SESSIONS_INITIAL_VISIBLE 驱动，不写死数字", () => {
		assert.match(activeSessionsTree, /useState\(RECENT_SESSIONS_INITIAL_VISIBLE\)/);
		assert.match(activeSessionsTree, /RECENT_SESSIONS_INITIAL_VISIBLE/);
	});

	test("「加载更多」按页递增可见条数（懒加载，不一次性渲染全部）", () => {
		assert.match(recentSessionsSection, /onClick=\{props\.onLoadMore\}/);
		assert.match(recentSessionsSection, /remainingCount > 0/);
		assert.match(activeSessionsTree, /setRecentVisibleCount\(\(current\) => growRecentVisible\(current, recent\.totalCount\)\)/);
	});

	test("展开过就并列给「收起」，回到首页条数（与项目页「查看更多 / 收起」同语义）", () => {
		assert.match(recentSessionsSection, /onClick=\{props\.onCollapse\}/);
		assert.match(recentSessionsSection, /canCollapse &&/);
		assert.match(activeSessionsTree, /onCollapse=\{\(\) => setRecentVisibleCount\(RECENT_SESSIONS_INITIAL_VISIBLE\)\}/);
		// 收起门槛与服务端模型同源：默认 10 条本身收不起来，故以「超过首页」为准
		assert.equal(canCollapseRecent(RECENT_SESSIONS_INITIAL_VISIBLE), false);
		assert.equal(canCollapseRecent(RECENT_SESSIONS_INITIAL_VISIBLE + RECENT_SESSIONS_PAGE_SIZE), true);
	});

	test("分页行与项目页「查看更多 / 收起」逐字同款（行高/布局必须一致）", () => {
		// 基座逐字相等：同一功能在两页不能长出两套行皮
		assert.equal(extractStringConst(recentSessionsSection, "moreRowClass"), "session-more-btn session-more-row h-auto min-w-0 w-auto flex-1 justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100");
		assert.equal(extractStringConst(recentSessionsSection, "collapseRowClass"), "session-more-row h-auto shrink-0 w-auto justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100");
		assert.match(sessionTree, /className=\{`session-more-btn h-auto min-w-0 w-auto flex-1 justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100/);
		assert.match(sessionTree, /className=\{`h-auto shrink-0 w-auto justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100/);
	});

	test("分页行比会话行矮一档（26px 对 32px，两处共用同一条高度）", () => {
		// 项目页（legacy 作用域）+ 活动页（基座）都得压到 26px，否则两处又会长短不一
		assert.match(foundationStyles, /\.session-more-row,\s*\n\.session-more-btn\s*\{[\s\S]{0,300}?min-height:\s*26px/);
		assert.match(workspaceStyles, /\.chat-list-pane\.v3-braun[\s\S]{0,400}?\.worktree-sessions-more\s*\{[\s\S]{0,200}?min-height:\s*26px/);
		// 会话行仍是 32px（min-h-8）：层级差不能被反转
		assert.match(sessionTree, /min-h-8/);
	});

	test("分页行与会话行左对齐（不再往右推 14px）", () => {
		// 基座不能再用 margin-left / padding-left 把入口推离会话标题列
		assert.doesNotMatch(foundationStyles, /\.session-more-row\s*\{[\s\S]{0,200}?margin-left:\s*8px/);
		// 基座（.agent-more-row, .session-more-row）也不得再往右推；`.worktree-sessions-more`
		// 是子树专用类（width: calc(100% - 8px)），不在本次对齐范围内。
		assert.doesNotMatch(foundationStyles, /\.agent-more-row,\s*\n\.session-more-row\s*\{[\s\S]{0,600}?margin:[^;]*8px/);
		assert.doesNotMatch(foundationStyles, /\.agent-more-row,\s*\n\.session-more-row\s*\{[\s\S]{0,600}?padding:[^;]*14px/);
	});

	test("最近会话为空时整段消失（不留悬空分界线）", () => {
		assert.match(recentSessionsSection, /if\s*\(\s*props\.rows\.length === 0\s*\)\s*return null/);
	});

	test("只有活动区与最近区都空时才显示整页空态", () => {
		assert.match(activeSessionsTree, /if\s*\(\s*liveRows\.length === 0\s*&&\s*!hasRecent\s*\)/);
		// 活动区为空但最近区有数据时，改用一行提示顶替活动区，不占满高度
		assert.match(activeSessionsTree, /liveRows\.length === 0 \?/);
	});

	test("最近会话跨项目展示：活动页挂载时按需预加载尚未扫描的项目 catalog", () => {
		assert.match(activeSessionsTree, /props\.actions\.sessions\.ensureCatalogsLoaded/);
		// 只请求一次，避免动作引用变化时反复触发扫描
		assert.match(activeSessionsTree, /requestedProjectIdsRef/);
		// 三处同步：类型声明 + App 实现 + 组件调用
		assert.match(sidebarContent, /ensureCatalogsLoaded: \(projectIds: readonly string\[\]\) => void/);
		assert.match(appSource, /ensureCatalogsLoaded: \(projectIds\) => \{/);
		assert.match(appSource, /ensureProjectCatalogLoaded/);
	});

	test("新增文案在中英文两份 copy 中都存在", () => {
		for (const key of ["app.sidebarRecentSessions", "app.sidebarRecentShown", "app.sidebarRecentLoadMore", "app.sidebarRecentLoadMoreHint", "app.sidebarRecentCollapse", "app.sidebarRecentCollapseHint"]) {
			assert.match(zhCopy, new RegExp(`"${key}":`), `zh-CN 缺少 ${key}`);
			assert.match(enCopy, new RegExp(`"${key}":`), `en-US 缺少 ${key}`);
		}
		// 收起文案与项目页「收起」同字面，两处入口名字一致
		assert.match(zhCopy, /"app\.sidebarRecentCollapse": "收起"/);
		assert.match(enCopy, /"app\.sidebarRecentCollapse": "Collapse"/);
	});
});
