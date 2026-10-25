import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionIdAliasMap, migrateSessionIdList, readMergedSessionIds, remapSessionIdActivities, remapSessionIds } = loadTsCommonJs("src/shared/sessionIdAliases.ts");

/**
 * #354：身份归并别名表是「旧 ID → 现存 ID」的解析入口，主进程迁移 settings 置顶与
 * 渲染层迁移 Tab 置顶/最近活动都用它；这些用例锁的是坏数据下的解析规则，不是实现细节。
 */
test("session id aliases resolve a merged history id to the surviving record", () => {
	const records = [{ id: "survivor", mergedSessionIds: ["old-a", "old-b"] }, { id: "other" }];
	const aliases = buildSessionIdAliasMap(records);
	assert.equal(aliases.get("old-a"), "survivor");
	assert.equal(aliases.get("old-b"), "survivor");
	assert.equal(aliases.has("survivor"), false);
	assert.equal(aliases.has("other"), false);
	assert.deepEqual([...migrateSessionIdList(["old-b"], records)], ["survivor"]);
});

test("an alias never shadows a real session id, itself or a first owner", () => {
	const aliases = buildSessionIdAliasMap([{ id: "survivor", mergedSessionIds: ["survivor", "other", "shared", ""] }, { id: "other" }, { id: "second", mergedSessionIds: ["shared"] }]);
	assert.deepEqual(
		[...aliases].map(([alias, target]) => [alias, target]),
		[["shared", "survivor"]],
	);
});

test("remapping keeps order, dedupes into one surviving id and reuses the input when nothing changes", () => {
	const aliases = new Map([
		["old", "survivor"],
		["stale", "survivor"],
	]);
	assert.deepEqual([...remapSessionIds(["stale", "keep", "old"], aliases)], ["survivor", "keep"]);
	const unchanged = ["keep"];
	assert.equal(remapSessionIds(unchanged, new Map()), unchanged);
	assert.equal(remapSessionIds(unchanged, aliases), unchanged);
});

test("activity entries are remapped and deduped by surviving id", () => {
	const aliases = new Map([["old", "survivor"]]);
	const entries = [
		{ sessionId: "old", projectId: "project-1", at: 2 },
		{ sessionId: "survivor", projectId: "project-1", at: 1 },
	];
	assert.deepEqual(
		[...remapSessionIdActivities(entries, aliases)].map((entry) => ({ ...entry })),
		[{ sessionId: "survivor", projectId: "project-1", at: 2 }],
	);
	assert.equal(remapSessionIdActivities(entries, new Map()), entries);
});

test("a malformed alias field is dropped instead of exploding into per-character aliases", () => {
	// session-catalog.json 是用户可手改的输入：非数组/非字符串既不能抛 TypeError 中断启动，
	// 也不能被当作可迭代字符串拆成 `4`/`2` 这样的别名。
	assert.equal(readMergedSessionIds(42), undefined);
	assert.equal(readMergedSessionIds("old"), undefined);
	assert.equal(readMergedSessionIds([]), undefined);
	assert.deepEqual([...readMergedSessionIds(["old", 42, "", null, "older"])], ["old", "older"]);
	const aliases = buildSessionIdAliasMap([
		{ id: "survivor", mergedSessionIds: "old" },
		{ id: "numeric", mergedSessionIds: 42 },
	]);
	assert.equal(aliases.size, 0);
});
