import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildProjectTabGroups, buildSessionTabBarEntries, flattenSessionTabBarEntries, projectGroupColor, GROUP_COLOR_VALUES } = loadTsCommonJs("src/renderer/src/utils/sessionTabGroups.ts");
const { cycleSessionTab } = loadTsCommonJs("src/renderer/src/utils/sessionTabs.ts");

const projectOf = (map) => (sessionId) => (map[sessionId] ? { projectId: map[sessionId].id, name: map[sessionId].name } : undefined);

test("buildProjectTabGroups: 组顺序按首个 tab 出现顺序，组内保持 tabs 原序", () => {
	// tabs: A1(A), B1(B), A2(A) → 组序 A,B；A 组内 A1,A2（新打开的自然在组末尾）
	const result = buildProjectTabGroups(["a1", "b1", "a2"], [], projectOf({ a1: { id: "A", name: "alpha" }, b1: { id: "B", name: "beta" }, a2: { id: "A", name: "alpha" } }));
	assert.equal(result.pinned.length, 0);
	assert.equal(result.loose.length, 0);
	assert.equal(result.groups.length, 2);
	assert.equal(JSON.stringify(result.groups[0].sessionIds), JSON.stringify(["a1", "a2"]));
	assert.equal(JSON.stringify(result.groups[1].sessionIds), JSON.stringify(["b1"]));
	assert.equal(result.groups[0].name, "alpha");
	assert.equal(result.groups[0].color, projectGroupColor("A"));
});

test("buildProjectTabGroups: 后打开的会话归回其项目组尾（不追加全局末尾）", () => {
	// 回归：a1,a2,a3 / b3,b4 已开，再开 a4（tabs 追加到末尾）→ a4 必须归入 A 组尾、
	// 排在 b 组之前，而不是落在全局最后。正是“新会话自动加到自己项目尾部”的用户诉求。
	const result = buildProjectTabGroups(["a1", "a2", "a3", "b3", "b4", "a4"], [], projectOf({ a1: { id: "A" }, a2: { id: "A" }, a3: { id: "A" }, b3: { id: "B" }, b4: { id: "B" }, a4: { id: "A" } }));
	assert.equal(
		JSON.stringify(result.groups.map((g) => g.sessionIds)),
		JSON.stringify([
			["a1", "a2", "a3", "a4"],
			["b3", "b4"],
		]),
	);
});

test("buildProjectTabGroups: 固定 tab 平铺在前，不进入分组", () => {
	const result = buildProjectTabGroups(["p1", "a1", "p2", "b1"], ["p1", "p2"], projectOf({ a1: { id: "A", name: "alpha" }, b1: { id: "B", name: "beta" }, p1: { id: "A", name: "alpha" }, p2: { id: "B", name: "beta" } }));
	assert.equal(JSON.stringify(result.pinned), JSON.stringify(["p1", "p2"]));
	assert.equal(JSON.stringify(result.groups.map((g) => g.sessionIds)), JSON.stringify([["a1"], ["b1"]]));
});

test("buildProjectTabGroups: 无项目归属的会话平铺在组后", () => {
	const result = buildProjectTabGroups(["a1", "loose1", "a2"], [], projectOf({ a1: { id: "A", name: "alpha" }, a2: { id: "A", name: "alpha" }, loose1: undefined }));
	assert.equal(JSON.stringify(result.loose), JSON.stringify(["loose1"]));
	assert.equal(JSON.stringify(result.groups[0].sessionIds), JSON.stringify(["a1", "a2"]));
});

test("buildProjectTabGroups: projectId 缺失/项目名缺失时回退", () => {
	const result = buildProjectTabGroups(["s1"], [], () => ({ projectId: "P-123", name: "  " }));
	assert.equal(result.groups[0].name, "P-123"); // 名称为空回退 id
});

test("projectGroupColor: 同一 projectId 恒同色且落在色板内", () => {
	const c1 = projectGroupColor("project-a");
	const c2 = projectGroupColor("project-a");
	assert.equal(c1, c2);
	assert.ok(GROUP_COLOR_VALUES.includes(c1));
});

test("buildProjectTabGroups: 组内数量与全部 tab 覆盖（pinned+groups+loose = 输入，无重复无丢失）", () => {
	const tabs = ["p1", "a1", "b1", "a2", "loose"];
	const result = buildProjectTabGroups(tabs, ["p1"], projectOf({ a1: { id: "A", name: "alpha" }, b1: { id: "B", name: "beta" }, a2: { id: "A", name: "alpha" } }));
	const all = [...result.pinned, ...result.groups.flatMap((g) => g.sessionIds), ...result.loose];
	assert.equal(JSON.stringify(all.sort()), JSON.stringify([...tabs].sort()));
});

test("buildSessionTabBarEntries: issue #346 场景——Ctrl+Tab 顺序与标签栏显示顺序同源", () => {
	// tabs 是打开顺序 a,b,c；c 属于 P1，显示时被聚拢到 a 旁边 → 屏幕上 a c | b
	const tabs = ["a", "b", "c"];
	const of = projectOf({ a: { id: "P1" }, b: { id: "P2" }, c: { id: "P1" } });
	const entries = buildSessionTabBarEntries(tabs, [], [], of);
	assert.equal(JSON.stringify(entries.map((e) => e.kind)), JSON.stringify(["project", "project"]));
	assert.equal(JSON.stringify(flattenSessionTabBarEntries(entries)), JSON.stringify(["a", "c", "b"]));
	// 循环切换必须走显示顺序：a 的下一个是 c（直接喂底层数组会跳到屏幕上不相邻的 b）
	const order = flattenSessionTabBarEntries(entries);
	assert.equal(cycleSessionTab(order, "a", 1), "c");
	assert.equal(cycleSessionTab(order, "c", 1), "b");
	assert.equal(cycleSessionTab(order, "b", 1), "a");
	assert.equal(cycleSessionTab(order, "a", -1), "b");
});

test("buildSessionTabBarEntries: 分屏组折叠为一个单元，落在锚点槽位且组内保持 layout 顺序", () => {
	const tabs = ["a", "b", "c", "d"];
	const of = projectOf({ a: { id: "P1" }, b: { id: "P2" }, c: { id: "P1" }, d: { id: "P2" } });
	// 分屏组成员不参与项目分组；单元落在 layout 首个在場成员 c 的槽位
	const entries = buildSessionTabBarEntries(tabs, [], ["c", "a"], of);
	assert.equal(JSON.stringify(entries.map((e) => e.kind)), JSON.stringify(["project", "split"]));
	assert.equal(JSON.stringify(entries[1].sessionIds), JSON.stringify(["c", "a"]));
	assert.equal(JSON.stringify(flattenSessionTabBarEntries(entries)), JSON.stringify(["b", "d", "c", "a"]));
});

test("buildSessionTabBarEntries: 每个 tab 恰好出现一次（pinned/项目组/无归属混排）", () => {
	const tabs = ["p1", "a1", "loose", "b1", "a2"];
	const of = projectOf({ p1: { id: "A" }, a1: { id: "A" }, b1: { id: "B" }, a2: { id: "A" } });
	const order = flattenSessionTabBarEntries(buildSessionTabBarEntries(tabs, ["p1"], [], of));
	assert.equal(order.length, tabs.length);
	assert.equal(JSON.stringify([...order].sort()), JSON.stringify([...tabs].sort()));
	// 固定 Tab 平铺在前，不进入项目分组
	assert.equal(JSON.stringify(order), JSON.stringify(["p1", "a1", "a2", "loose", "b1"]));
});

test("buildSessionTabBarEntries: 分屏成员不在 tabs 时安全降级（不消失、不重复）", () => {
	// layout 里有已从 tabs 移除的 x：按在場成员折叠，锚点回退到首个在場成员
	const ofBoth = projectOf({ a: { id: "P1" }, c: { id: "P1" } });
	const entries = buildSessionTabBarEntries(["a", "c"], [], ["x", "c", "a"], ofBoth);
	assert.equal(JSON.stringify(entries.map((e) => e.kind)), JSON.stringify(["split"]));
	assert.equal(JSON.stringify(flattenSessionTabBarEntries(entries)), JSON.stringify(["c", "a"]));
	// 在場成员不足 2：分屏组不成立，成员按普通 Tab 参与项目分组
	const single = buildSessionTabBarEntries(["a", "b"], [], ["x", "b"], projectOf({ a: { id: "P1" }, b: { id: "P1" } }));
	assert.equal(JSON.stringify(single.map((e) => e.kind)), JSON.stringify(["project"]));
	assert.equal(JSON.stringify(flattenSessionTabBarEntries(single)), JSON.stringify(["a", "b"]));
});

test("Ctrl+Tab 接线：循环顺序必须消费共享显示顺序（不得直接喂底层 tabs 数组）", () => {
	const hook = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
	assert.match(hook, /buildSessionTabBarEntries\s*\(/, "必须经共享 selector 构建显示顺序");
	assert.match(hook, /flattenSessionTabBarEntries\s*\(/, "必须展开为显示顺序序列");
	assert.doesNotMatch(hook, /cycleSessionTab\s*\(\s*store\.get\(\s*sessionTabIdsAtom\s*\)/, "不得再把保存打开顺序的底层数组直接当循环顺序（issue #346）");
});

test("标签栏渲染：显示单元来自共享 selector（与 Ctrl+Tab 同源）", () => {
	const bar = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	assert.match(bar, /buildSessionTabBarEntries\s*\(/);
	// 渲染循环必须消费 selector 的结果，不得再自行 in-loop 聚拢（那是分叉的来源）
	assert.match(bar, /for\s*\(\s*const entry of tabBarEntries\s*\)/);
});
