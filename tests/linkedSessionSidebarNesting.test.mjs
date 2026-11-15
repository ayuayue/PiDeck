import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 侧栏「活动」页与「最近」区的关联子会话嵌套（activitySessionsModel.nestLinkedSessionRows）。
 * 「聊天 / 项目」树由 SessionTree 自己嵌套；活动页两段列表共用这个纯函数。
 */
const { nestLinkedSessionRows, groupLinkedChildren } = loadTsCommonJs("src/renderer/src/components/sidebar/activitySessionsModel.ts");

/** 被测模块跑在沙箱 realm 里：展开成本 realm 的数组再比较。 */
function nestIds(rows, idOf, parents) {
	return [...nestLinkedSessionRows(rows, idOf, (id) => parents[id])].map(({ row, depth }) => `${idOf(row) ?? "-"}:${depth}`);
}

const nest = (ids, parents) =>
	nestIds(
		ids.map((id) => ({ id })),
		(row) => row.id,
		parents,
	);

test("子会话挪到父会话正下方并缩进一层，兄弟保留原排序", () => {
	// 活动区按更新时间倒序：子会话更新得比父会话新，原本排在父会话上面
	assert.deepEqual(nest(["c2", "x", "c1", "p", "y"], { c1: "p", c2: "p" }), ["x:0", "p:0", "c2:1", "c1:1", "y:0"]);
});

test("孙会话再缩进一层", () => {
	assert.deepEqual(nest(["g", "c", "p"], { c: "p", g: "c" }), ["p:0", "c:1", "g:2"]);
});

test("父会话不在本列表：子会话原位不动，层级 0", () => {
	assert.deepEqual(nest(["a", "c", "b"], { c: "elsewhere" }), ["a:0", "c:0", "b:0"]);
});

test("关系成环（外部文件被改坏）：不丢行、不死循环", () => {
	assert.deepEqual(nest(["a", "b", "z"], { a: "b", b: "a" }), ["z:0", "a:0", "b:1"]);
	assert.deepEqual(nest(["s"], { s: "s" }), ["s:0"]);
});

test("没有会话 id 的行（全新 Agent）原样保留", () => {
	assert.deepEqual(
		nestIds([{ id: undefined }, { id: "c" }, { id: "p" }], (row) => row.id, { c: "p" }),
		["-:0", "p:0", "c:1"],
	);
});

/** 「聊天 / 项目」树：按 parentSessionId 分组，孙会话挂在子会话下面（SessionTree 递归渲染）。 */
function group(ids, links) {
	const { childrenByParent, childIds } = groupLinkedChildren(
		ids.map((id) => ({ id })),
		(id) => links[id],
	);
	// 被测模块跑在沙箱 realm：经 JSON 展开成本 realm 的普通对象再比较。
	return JSON.parse(
		JSON.stringify({
			children: Object.fromEntries([...childrenByParent].map(([parent, rows]) => [parent, rows.map((row) => row.id)])),
			childIds: [...childIds].sort(),
		}),
	);
}

const link = (parentSessionId, createdAt = 0, archived = false) => ({ parentSessionId, createdAt, archived });

test("树视图：A > B > C 三层都挂靠，孙会话挂在子会话下面而不是丢失", () => {
	const result = group(["a", "b", "c", "x"], { b: link("a"), c: link("b") });
	assert.deepEqual(result.children, { a: ["b"], b: ["c"] });
	assert.deepEqual(result.childIds, ["b", "c"]);
});

test("树视图：兄弟按关系创建时间排序；已归档 / 父会话不在列表的关系不挂靠", () => {
	const result = group(["p", "late", "early", "gone", "archived"], { late: link("p", 20), early: link("p", 10), gone: link("elsewhere"), archived: link("p", 5, true) });
	assert.deepEqual(result.children, { p: ["early", "late"] });
	assert.deepEqual(result.childIds, ["early", "late"]);
});

test("树视图：关系成环（外部文件被改坏）时环上的行按普通会话显示，不丢行", () => {
	const result = group(["a", "b", "c"], { a: link("b"), b: link("a"), c: link("a") });
	assert.deepEqual(result.children, { a: ["c"] }, "c 挂在 a 下面，a/b 自己不挂靠");
	assert.deepEqual(result.childIds, ["c"]);
	assert.deepEqual(group(["s"], { s: link("s") }).childIds, []);
});

/**
 * 回归（standby 认领路径实测）：池化进程当时没带 deckSessionId，而 SessionTree 的
 * 「关联子会话 agent 行隐藏」只认 deckSessionId → 同一子会话在父会话下面挂着一行，
 * 顶层又冒出一条同名 agent 行。身份可能缺失，绑定关系（runtimeBySessionId）不会。
 */
test("项目树：子会话的运行时行即使缺 deckSessionId 也不在顶层重复出现", () => {
	const { filterLinkedChildAgents } = loadTsCommonJs("src/renderer/src/agentListDisplay.ts");
	const child = { id: "agent-child", projectId: "p1", cwd: "C:/p1", title: "子会话", status: "running", deckSessionId: undefined, sessionPath: "C:/sessions/child.jsonl", createdAt: 1 };
	const parent = { ...child, id: "agent-parent", title: "父会话", deckSessionId: "parent" };
	const ids = (agents) => [...agents].map((agent) => agent.id);

	assert.deepEqual(ids(filterLinkedChildAgents([child], new Set(["child"]), { child: { agentId: "agent-child" } })), [], "缺身份时按 runtime 绑定识别子会话运行时");
	assert.deepEqual(ids(filterLinkedChildAgents([{ ...child, deckSessionId: "child" }], new Set(["child"]), {})), [], "有 deckSessionId 时同样隐藏");
	assert.deepEqual(ids(filterLinkedChildAgents([parent, child], new Set(["child"]), { parent: { agentId: "agent-parent" }, child: { agentId: "agent-child" } })), ["agent-parent"], "父会话行不受影响");
	assert.deepEqual(ids(filterLinkedChildAgents([child], new Set(), {})), ["agent-child"], "没有关联关系时原样保留");
});
