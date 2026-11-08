import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 侧栏「活动」页与「最近」区的关联子会话嵌套（activitySessionsModel.nestLinkedSessionRows）。
 * 「聊天 / 项目」树由 SessionTree 自己嵌套；活动页两段列表共用这个纯函数。
 */
const { nestLinkedSessionRows } = loadTsCommonJs("src/renderer/src/components/sidebar/activitySessionsModel.ts");

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
	assert.deepEqual(nestIds([{ id: undefined }, { id: "c" }, { id: "p" }], (row) => row.id, { c: "p" }), ["-:0", "p:0", "c:1"]);
});
