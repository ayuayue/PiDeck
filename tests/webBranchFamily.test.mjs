/**
 * Web 分支家族推导纯函数单测（P3 分支条）。
 * 覆盖：单会话、fork 链上溯/下收集、createdAt 排序、脏数据防环、
 * 断链（parent 不存在）视为根、未知会话返回空。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { deriveWebBranchFamily } = loadTsCommonJs("src/renderer/src/web/webBranchFamily.ts");

function session(id, overrides = {}) {
	return { id, title: id, createdAt: 1, ...overrides };
}

test("a lone session with no parent and no forks is its own family", () => {
	const family = deriveWebBranchFamily([session("a")], "a");
	// vm realm 数组与宿主数组原型不同，deepEqual 前先 Array.from 归一
	assert.deepEqual(Array.from(family.map((item) => item.id)), ["a"]);
});

test("collects root plus all fork descendants ordered by createdAt asc", () => {
	// 故意乱序输入：f3 最老、root 最新，输出必须按 createdAt 升序（根不依赖输入顺序）
	const sessions = [session("f3", { parentSessionId: "f2", createdAt: 30 }), session("root", { createdAt: 10 }), session("f2", { parentSessionId: "root", createdAt: 20 }), session("other", { createdAt: 15 })];
	for (const active of ["root", "f2", "f3"]) {
		assert.deepEqual(Array.from(deriveWebBranchFamily(sessions, active).map((item) => item.id)), ["root", "f2", "f3"], `family seen from ${active}`);
	}
});

test("a broken parent pointer (missing record) is treated as the root", () => {
	const sessions = [session("orphan", { parentSessionId: "gone", createdAt: 2 }), session("child", { parentSessionId: "orphan", createdAt: 3 })];
	assert.deepEqual(Array.from(deriveWebBranchFamily(sessions, "child").map((item) => item.id)), ["orphan", "child"]);
});

test("cyclic parent pointers terminate instead of hanging", () => {
	const sessions = [session("a", { parentSessionId: "b", createdAt: 1 }), session("b", { parentSessionId: "a", createdAt: 2 })];
	const family = deriveWebBranchFamily(sessions, "a");
	// 环上两个节点都应出现且不重复；上溯在环处断开，BFS 从断点根收集
	assert.deepEqual(Array.from(family.map((item) => item.id).sort()), ["a", "b"]);
});

test("unknown session id yields an empty family (caller hides the bar)", () => {
	const unknown = deriveWebBranchFamily([session("a")], "nope");
	assert.equal(unknown.length, 0);
});
