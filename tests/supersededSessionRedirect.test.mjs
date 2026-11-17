import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 纯函数模块：无运行时依赖，直接按源码加载。 */
function loadResolver() {
	return loadTsCommonJs("src/main/sessions/supersededSession.ts");
}

/**
 * 造一个 id → supersededBy 的查询口，模拟 catalog.get。
 * 键存在 = 条目在；值 undefined = 条目存在但没被接替；键缺失 = 条目不存在。
 */
function lookupFrom(map) {
	return (id) => (Object.prototype.hasOwnProperty.call(map, id) ? { supersededBy: map[id] } : undefined);
}

test("被接替的会话解析到直接接替者", () => {
	const { resolveSupersededSessionId } = loadResolver();
	const lookup = lookupFrom({ old: "new", new: undefined });
	assert.equal(resolveSupersededSessionId("old", lookup), "new");
});

test("连续两次替换跟到最末端会话", () => {
	const { resolveSupersededSessionId } = loadResolver();
	const lookup = lookupFrom({ a: "b", b: "c", c: undefined });
	assert.equal(resolveSupersededSessionId("a", lookup), "c");
});

test("没被接替的会话不做重定向", () => {
	const { resolveSupersededSessionId } = loadResolver();
	assert.equal(resolveSupersededSessionId("plain", lookupFrom({ plain: undefined })), undefined);
	assert.equal(resolveSupersededSessionId("plain", lookupFrom({ other: "x", x: undefined })), undefined);
});

test("链成环时不重定向，也不死循环", () => {
	const { resolveSupersededSessionId } = loadResolver();
	const lookup = lookupFrom({ a: "b", b: "a" });
	assert.equal(resolveSupersededSessionId("a", lookup), undefined);
});

test("接替者条目已被清理时不重定向", () => {
	const { resolveSupersededSessionId } = loadResolver();
	// a 指向 gone，但 gone 不在表里 = catalog 里已经没有这条记录。
	assert.equal(resolveSupersededSessionId("a", lookupFrom({ a: "gone" })), undefined);
});

test("链长度超过上限时不替用户猜终点", () => {
	const { resolveSupersededSessionId } = loadResolver();
	const lookup = lookupFrom({ a: "b", b: "c", c: undefined });
	// maxHops=1 只走一步，走到 b 但 b 自己还带标记 → 视为没走完，返回 undefined。
	assert.equal(resolveSupersededSessionId("a", lookup, 1), undefined);
});

test("自指标记（a→a）当作没有标记", () => {
	const { resolveSupersededSessionId } = loadResolver();
	assert.equal(resolveSupersededSessionId("a", lookupFrom({ a: "a" })), undefined);
});
