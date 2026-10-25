/**
 * Web 侧栏项目会话列表的分页窗口策略（webSidebarPaging）。
 *
 * 修正动机：初始 5 条 + IntersectionObserver 哨兵自动补 50 的写法，在移动端抽屉首次布局
 * 就会连续命中 rootMargin（实测「聊天」115 条展开即渲染 57 行），体感等于「一次性全加载」。
 * 现在对齐桌面「最近会话」：首页 10、每次 +20、可收起；这里把边界逐条钉死。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WEB_SIDEBAR_INITIAL_VISIBLE, WEB_SIDEBAR_PAGE_STEP, resolveSidebarWindow, growSidebarWindow } = loadTsCommonJs("src/renderer/src/web/webSidebarPaging.ts");

test("首页 10 条、每页 +20（对齐桌面 RECENT_SESSIONS_INITIAL_VISIBLE）", () => {
	assert.equal(WEB_SIDEBAR_INITIAL_VISIBLE, 10);
	assert.equal(WEB_SIDEBAR_PAGE_STEP, 20);
});

/** vm 沙箱返回的对象与宿主不同源，deepStrictEqual 会因原型链失配误报；逐字段断言。 */
function expectWindow(input, expected) {
	const actual = resolveSidebarWindow(input);
	assert.equal(actual.visibleCount, expected.visibleCount, "visibleCount");
	assert.equal(actual.remaining, expected.remaining, "remaining");
	assert.equal(actual.canCollapse, expected.canCollapse, "canCollapse");
}

test("展开大项目：首屏只给 10 条，剩余量按总数算", () => {
	expectWindow({ total: 416, requested: 10, searching: false }, { visibleCount: 10, remaining: 406, canCollapse: false });
});

test("点一次查看更多：+20 且给出收起入口", () => {
	assert.equal(growSidebarWindow(10), 30);
	expectWindow({ total: 416, requested: 30, searching: false }, { visibleCount: 30, remaining: 386, canCollapse: true });
});

test("requested 超过总数时钳到总数（remaining=0，不能再『查看更多』）", () => {
	expectWindow({ total: 12, requested: 999, searching: false }, { visibleCount: 12, remaining: 0, canCollapse: true });
});

test("少于首页条数：全部显示且不给收起（收起回到同一状态没有意义）", () => {
	expectWindow({ total: 3, requested: 10, searching: false }, { visibleCount: 3, remaining: 0, canCollapse: false });
	expectWindow({ total: 0, requested: 10, searching: false }, { visibleCount: 0, remaining: 0, canCollapse: false });
});

test("搜索态：一次显示全部命中（命中集合通常很小，用户预期『搜到即列出』）", () => {
	expectWindow({ total: 120, requested: 10, searching: true }, { visibleCount: 120, remaining: 0, canCollapse: false });
});

test("requested 小于首页（如切换会话重置为 0）时按首页兜底", () => {
	assert.equal(resolveSidebarWindow({ total: 100, requested: 0, searching: false }).visibleCount, 10);
	assert.equal(resolveSidebarWindow({ total: 100, requested: -5, searching: false }).visibleCount, 10);
});

test("grow 从任意已显示条数继续 +20，且不会因小数/负数抖动", () => {
	assert.equal(growSidebarWindow(30), 50);
	assert.equal(growSidebarWindow(7.9), 30);
	assert.equal(growSidebarWindow(-3), 30);
});
