import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 页面式工作区 Tab（定时任务 / 智能体）的状态机：
 * - 打开即登记 + 激活；重复打开只激活，不重复建 Tab；
 * - 切到会话只失活（Tab 保留），关闭才移除并回到会话；
 * - 纯函数必须可离开 React 单测（AGENTS.md「纯策略可单测」）。
 */
const { EMPTY_WORKSPACE_PAGE_TAB_STATE, closeWorkspacePage, deactivateWorkspacePage, isWorkspacePageId, openWorkspacePage, sortWorkspacePageIds } = loadTsCommonJs("src/renderer/src/utils/workspacePageTabs.ts");

test("打开页面：登记 Tab 并激活", () => {
	const state = openWorkspacePage(EMPTY_WORKSPACE_PAGE_TAB_STATE, "automation");
	assert.deepEqual(Array.from(state.tabs), ["automation"]);
	assert.equal(state.active, "automation");
});

test("重复打开已登记页面：只激活，不重复建 Tab、不改 Tab 顺序", () => {
	const first = openWorkspacePage(openWorkspacePage(EMPTY_WORKSPACE_PAGE_TAB_STATE, "automation"), "agents");
	assert.deepEqual(Array.from(first.tabs), ["automation", "agents"]);
	const reactivated = openWorkspacePage(first, "automation");
	assert.deepEqual(Array.from(reactivated.tabs), ["automation", "agents"]);
	assert.equal(reactivated.active, "automation");
});

test("打开/激活结果幂等：已是当前页面时返回同一引用", () => {
	const state = openWorkspacePage(EMPTY_WORKSPACE_PAGE_TAB_STATE, "agents");
	assert.equal(openWorkspacePage(state, "agents"), state);
});

test("切到会话：只失活，页面 Tab 与顺序都保留", () => {
	const state = openWorkspacePage(openWorkspacePage(EMPTY_WORKSPACE_PAGE_TAB_STATE, "automation"), "agents");
	const inactive = deactivateWorkspacePage(state);
	assert.deepEqual(Array.from(inactive.tabs), ["automation", "agents"]);
	assert.equal(inactive.active, null);
	assert.equal(deactivateWorkspacePage(inactive), inactive, "已经不在页面时是 no-op");
});

test("关闭非当前页面：只移除该 Tab，呈现页面不变", () => {
	const state = openWorkspacePage(openWorkspacePage(EMPTY_WORKSPACE_PAGE_TAB_STATE, "automation"), "agents");
	const closed = closeWorkspacePage(state, "automation");
	assert.deepEqual(Array.from(closed.tabs), ["agents"]);
	assert.equal(closed.active, "agents");
});

test("关闭当前页面：回到会话（active=null）", () => {
	const state = openWorkspacePage(EMPTY_WORKSPACE_PAGE_TAB_STATE, "agents");
	const closed = closeWorkspacePage(state, "agents");
	assert.equal(closed.tabs.length, 0);
	assert.equal(closed.active, null);
});

test("关闭未打开的页面是 no-op（保持引用）", () => {
	const state = openWorkspacePage(EMPTY_WORKSPACE_PAGE_TAB_STATE, "agents");
	assert.equal(closeWorkspacePage(state, "automation"), state);
});

test("isWorkspacePageId 只认三个页面 id", () => {
	assert.equal(isWorkspacePageId("automation"), true);
	assert.equal(isWorkspacePageId("agents"), true);
	assert.equal(isWorkspacePageId("favorites"), true);
	assert.equal(isWorkspacePageId("session"), false);
	assert.equal(isWorkspacePageId(null), false);
});

test("sortWorkspacePageIds 固定展示顺序：定时任务 → 智能体 → 收藏（与打开顺序无关）", () => {
	assert.deepEqual([...sortWorkspacePageIds(["favorites", "agents", "automation"])], ["automation", "agents", "favorites"]);
	assert.deepEqual([...sortWorkspacePageIds(["favorites", "agents"])], ["agents", "favorites"]);
	assert.deepEqual([...sortWorkspacePageIds([])], []);
});
