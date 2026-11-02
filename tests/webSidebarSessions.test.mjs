/**
 * Web 侧栏「父会话 + 子代理会话」归组（webSidebarSessions）。
 *
 * 修正动机：/api/state 的会话列表是平铺的，一个项目 80+ 条子代理会话把侧栏撑得
 * 一眼看不到头（桌面端按 parentSessionPath 折叠到父行下）。这里把归组语义钉死：
 * 子会话不占顶层行，父会话缺失时降级回顶层，多级嵌套统一挂到顶层祖先。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { groupWebSessionsByParent } = loadTsCommonJs("src/renderer/src/web/webSidebarSessions.ts");

function session(id, overrides = {}) {
	return { id, projectId: "p1", title: id, status: "active", updatedAt: 1, ...overrides };
}

/** vm realm 数组与宿主数组原型不同，deepEqual 前先 Array.from 归一。 */
function ids(items) {
	return Array.from(items.map((item) => item.id));
}

test("子会话归到父会话下，顶层行只剩父会话", () => {
	const parent = session("parent", { updatedAt: 9 });
	const childA = session("child-a", { parentSessionId: "parent", updatedAt: 8 });
	const childB = session("child-b", { parentSessionId: "parent", updatedAt: 7 });
	const tree = groupWebSessionsByParent([parent, childA, childB]);

	assert.deepEqual(ids(tree.roots), ["parent"]);
	// 子会话保持入参顺序（调用方已按 updatedAt 降序）
	assert.deepEqual(ids(tree.childrenByParentId.get("parent") ?? []), ["child-a", "child-b"]);
	assert.equal(tree.rootByChildId.get("child-a"), "parent");
});

test("父会话不在列表里（跨项目 / 已删除 / 被搜索过滤）时子会话降级回顶层", () => {
	const orphan = session("orphan", { parentSessionId: "gone" });
	const tree = groupWebSessionsByParent([orphan]);
	assert.deepEqual(ids(tree.roots), ["orphan"]);
	assert.equal(tree.rootByChildId.size, 0);
});

test("多级嵌套统一挂到顶层祖先，中间层不吞掉整条链", () => {
	const root = session("root");
	const middle = session("middle", { parentSessionId: "root" });
	const leaf = session("leaf", { parentSessionId: "middle" });
	const tree = groupWebSessionsByParent([root, middle, leaf]);

	assert.deepEqual(ids(tree.roots), ["root"]);
	assert.deepEqual(ids(tree.childrenByParentId.get("root") ?? []), ["middle", "leaf"]);
	assert.equal(tree.rootByChildId.get("leaf"), "root");
});

test("自引用 / 互相指父的脏数据不丢行，也不死循环", () => {
	const self = session("self", { parentSessionId: "self" });
	const a = session("a", { parentSessionId: "b" });
	const b = session("b", { parentSessionId: "a" });
	const tree = groupWebSessionsByParent([self, a, b]);

	assert.deepEqual(ids(tree.roots), ["self", "a", "b"]);
	assert.equal(tree.childrenByParentId.size, 0);
});

test("父会话自身也是子会话时，顶层祖先的行才带折叠分组", () => {
	const root = session("root");
	const middle = session("middle", { parentSessionId: "root" });
	const tree = groupWebSessionsByParent([root, middle]);

	assert.equal(tree.childrenByParentId.has("middle"), false);
	assert.deepEqual(ids(tree.childrenByParentId.get("root") ?? []), ["middle"]);
});
