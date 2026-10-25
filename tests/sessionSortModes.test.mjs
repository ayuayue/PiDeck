// 会话排序模式（settings.sessionSortMode）回归：
// 1. 策略目录三方案 + 未知值回落「最近活跃」。
// 2. compareProjectChildren：置顶恒优先（组内维持最近活跃）、createdAt 缺省回退 updatedAt、
//    title 字典序同名回退时间；agent 行创建时间用 agent.createdAt。
// 3. SettingsStore 边界归一：读侧/写侧非法字符串回落默认。
// 注意：模块经 loadTsCommonJs 在 vm realm 执行，数组/比较结果用本地包装断言。
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SESSION_SORT_MODES, resolveSessionSortMode, compareSessionsForSortMode } = loadTsCommonJs("src/renderer/src/sessionSortModes.ts");
const { compareProjectChildren } = loadTsCommonJs("src/renderer/src/agentListDisplay.ts");
const { normalizeSessionSortMode, DEFAULT_SESSION_SORT_MODE } = loadTsCommonJs("src/shared/sessionSort.ts");

/** 构造会话行（ProjectChildItem.session）的最小闭包：只填排序消费的字段。 */
function sessionChild(id, { updatedAt = 0, createdAt, name } = {}) {
	return {
		type: "session",
		key: id,
		session: { id, name, preview: name ? "" : id, updatedAt, createdAt, messageCount: 0 },
		sortAt: updatedAt,
		codexSubagents: [],
		piSubagents: [],
	};
}

const noPins = new Set();

test("策略目录覆盖三方案，UI 菜单由目录驱动", () => {
	assert.deepEqual([...SESSION_SORT_MODES.map((option) => option.id)], ["updatedAt", "createdAt", "title"]);
	assert.ok(SESSION_SORT_MODES.every((option) => typeof option.labelKey === "string"));
});

test("resolveSessionSortMode：合法值透传，未知/缺省回落 updatedAt", () => {
	assert.equal(resolveSessionSortMode("createdAt"), "createdAt");
	assert.equal(resolveSessionSortMode("title"), "title");
	assert.equal(resolveSessionSortMode(undefined), "updatedAt");
	assert.equal(resolveSessionSortMode("garbage"), "updatedAt");
	assert.equal(normalizeSessionSortMode("garbage"), DEFAULT_SESSION_SORT_MODE);
});

test("默认模式维持历史行为：updatedAt 降序", () => {
	const a = sessionChild("a", { updatedAt: 10 });
	const b = sessionChild("b", { updatedAt: 20 });
	assert.ok(compareProjectChildren(a, b, noPins) > 0);
	assert.ok(compareProjectChildren(b, a, noPins) < 0);
});

test("createdAt 模式：按创建时间降序，缺省 createdAt 回退 updatedAt", () => {
	const old = sessionChild("old", { updatedAt: 100, createdAt: 1 });
	const created = sessionChild("new", { updatedAt: 5, createdAt: 50 });
	const noCreated = sessionChild("fallback", { updatedAt: 30 });
	assert.ok(compareProjectChildren(created, old, noPins, "createdAt") < 0);
	assert.ok(compareProjectChildren(created, noCreated, noPins, "createdAt") < 0, "缺省 createdAt 用 updatedAt 参与排序");
});

test("title 模式：字典序升序，同名回退 updatedAt 降序", () => {
	const alpha = sessionChild("a", { updatedAt: 1, name: "beta" });
	const beta = sessionChild("b", { updatedAt: 2, name: "alpha" });
	assert.ok(compareProjectChildren(alpha, beta, noPins, "title") > 0, "beta > alpha");
	const same1 = sessionChild("x", { updatedAt: 10, name: "same" });
	const same2 = sessionChild("y", { updatedAt: 20, name: "same" });
	assert.ok(compareProjectChildren(same1, same2, noPins, "title") > 0, "同名时新的在前");
});

test("置顶恒优先且组内维持最近活跃，不跟随排序模式", () => {
	const pinned = sessionChild("p", { updatedAt: 1, name: "zzz" });
	const other = sessionChild("o", { updatedAt: 99, name: "aaa" });
	const pins = new Set(["p"]);
	assert.equal(compareProjectChildren(pinned, other, pins, "title"), -1, "置顶行在前");
	assert.equal(compareProjectChildren(other, pinned, pins, "createdAt"), 1);
	// 置顶组内两个都置顶：维持 updatedAt 序，title 模式也不重排
	const pinnedOld = sessionChild("p1", { updatedAt: 1, name: "aaa" });
	const pinnedNew = sessionChild("p2", { updatedAt: 5, name: "zzz" });
	assert.ok(compareProjectChildren(pinnedOld, pinnedNew, new Set(["p1", "p2"]), "title") > 0);
});

test("compareSessionsForSortMode：draft 区块三模式与主列表语义一致", () => {
	const s = (id, { updatedAt = 0, createdAt, name } = {}) => ({ id, name, preview: name ?? id, updatedAt, createdAt, messageCount: 0 });
	assert.equal(compareSessionsForSortMode(s("a", { updatedAt: 1 }), s("b", { updatedAt: 2 })), 1);
	assert.ok(compareSessionsForSortMode(s("a", { updatedAt: 9, createdAt: 1 }), s("b", { updatedAt: 2, createdAt: 5 }), "createdAt") > 0);
	assert.ok(compareSessionsForSortMode(s("a", { name: "b" }), s("b", { name: "a" }), "title") > 0);
});
