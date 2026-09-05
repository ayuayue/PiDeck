import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  buildProjectTabGroups,
  projectGroupColor,
  GROUP_COLOR_VALUES,
} = loadTsCommonJs("src/renderer/src/utils/sessionTabGroups.ts");

const projectOf = (map) => (sessionId) =>
  map[sessionId] ? { projectId: map[sessionId].id, name: map[sessionId].name } : undefined;

test("buildProjectTabGroups: 组顺序按首个 tab 出现顺序，组内保持 tabs 原序", () => {
  // tabs: A1(A), B1(B), A2(A) → 组序 A,B；A 组内 A1,A2（新打开的自然在组末尾）
  const result = buildProjectTabGroups(
    ["a1", "b1", "a2"],
    [],
    projectOf({ a1: { id: "A", name: "alpha" }, b1: { id: "B", name: "beta" }, a2: { id: "A", name: "alpha" } }),
  );
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
  const result = buildProjectTabGroups(
    ["a1", "a2", "a3", "b3", "b4", "a4"],
    [],
    projectOf({ a1: { id: "A" }, a2: { id: "A" }, a3: { id: "A" }, b3: { id: "B" }, b4: { id: "B" }, a4: { id: "A" } }),
  );
  assert.equal(JSON.stringify(result.groups.map((g) => g.sessionIds)), JSON.stringify([["a1", "a2", "a3", "a4"], ["b3", "b4"]]));
});

test("buildProjectTabGroups: 固定 tab 平铺在前，不进入分组", () => {
  const result = buildProjectTabGroups(
    ["p1", "a1", "p2", "b1"],
    ["p1", "p2"],
    projectOf({ a1: { id: "A", name: "alpha" }, b1: { id: "B", name: "beta" }, p1: { id: "A", name: "alpha" }, p2: { id: "B", name: "beta" } }),
  );
  assert.equal(JSON.stringify(result.pinned), JSON.stringify(["p1", "p2"]));
  assert.equal(JSON.stringify(result.groups.map((g) => g.sessionIds)), JSON.stringify([["a1"], ["b1"]]));
});

test("buildProjectTabGroups: 无项目归属的会话平铺在组后", () => {
  const result = buildProjectTabGroups(
    ["a1", "loose1", "a2"],
    [],
    projectOf({ a1: { id: "A", name: "alpha" }, a2: { id: "A", name: "alpha" }, loose1: undefined }),
  );
  assert.equal(JSON.stringify(result.loose), JSON.stringify(["loose1"]));
  assert.equal(JSON.stringify(result.groups[0].sessionIds), JSON.stringify(["a1", "a2"]));
});

test("buildProjectTabGroups: projectId 缺失/项目名缺失时回退", () => {
  const result = buildProjectTabGroups(
    ["s1"],
    [],
    () => ({ projectId: "P-123", name: "  " }),
  );
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
  const result = buildProjectTabGroups(
    tabs,
    ["p1"],
    projectOf({ a1: { id: "A", name: "alpha" }, b1: { id: "B", name: "beta" }, a2: { id: "A", name: "alpha" } }),
  );
  const all = [
    ...result.pinned,
    ...result.groups.flatMap((g) => g.sessionIds),
    ...result.loose,
  ];
  assert.equal(JSON.stringify(all.sort()), JSON.stringify([...tabs].sort()));
});
