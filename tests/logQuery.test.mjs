// logQuery.ts 纯函数行为测试（无 electron 依赖，真实执行）：
// 分页/时间筛选/日期文件收敛/limit 兼容/hasMore 推导
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const logQuery = loadTsCommonJs("src/main/logging/logQuery.ts");

const day = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function entry(id, time, level, scope, message, detail) {
	return JSON.stringify({ id, time, level, scope, message, ...(detail !== undefined && { detail }) });
}

test("filterLogFiles keeps only date files inside [from, to]", () => {
	const files = ["app-2025-01-01.log", "app-2025-01-02.log", "app-2025-01-03.log", "junk.txt"];
	const from = day(2025, 1, 2);
	assert.deepEqual(logQuery.filterLogFiles(files, from), ["app-2025-01-02.log", "app-2025-01-03.log"]);
	// to 按当天结束：选「到 1/2」应包含 1/2 整天
	assert.deepEqual(logQuery.filterLogFiles(files, undefined, day(2025, 1, 2)), ["app-2025-01-01.log", "app-2025-01-02.log"]);
	assert.deepEqual(logQuery.filterLogFiles(files, day(2025, 1, 2), day(2025, 1, 2)), ["app-2025-01-02.log"]);
});

test("parseLogLine skips corrupted lines without throwing", () => {
	assert.equal(logQuery.parseLogLine("not-json"), null);
	assert.equal(logQuery.parseLogLine('{"id":1}'), null); // 缺必填字段
	const parsed = logQuery.parseLogLine(entry("a1", 1000, "info", "git", "ok"));
	// VM realm 对象不能 deepStrictEqual，逐字段断言
	assert.equal(parsed.id, "a1");
	assert.equal(parsed.time, 1000);
	assert.equal(parsed.level, "info");
	assert.equal(parsed.scope, "git");
	assert.equal(parsed.message, "ok");
});

test("queryLogLines filters by time range and level and search, newest first", () => {
	const lines = [entry("1", day(2025, 6, 1, 10), "info", "git", "commit created"), entry("2", day(2025, 6, 1, 11), "warn", "fs:trash", "文件移入回收站", { path: "C:/x" }), entry("3", day(2025, 6, 2, 9), "error", "git", "push failed")];
	const byTime = logQuery.queryLogLines(lines, { from: day(2025, 6, 2) });
	assert.equal(byTime.entries.map((e) => e.id).join(","), "3");

	const byLevel = logQuery.queryLogLines(lines, { level: "warn" });
	assert.equal(byLevel.entries.map((e) => e.id).join(","), "2");

	const bySearch = logQuery.queryLogLines(lines, { search: "C:/x" }); // detail 可搜
	assert.equal(bySearch.entries.map((e) => e.id).join(","), "2");

	const all = logQuery.queryLogLines(lines, {});
	assert.equal(all.entries.map((e) => e.id).join(","), "3,2,1"); // 倒序
	assert.equal(all.total, 3);
});

test("queryLogLines paginates after filtering without truncating history", () => {
	const lines = Array.from({ length: 120 }, (_, i) => entry(String(i), 1000 + i, "info", "git", `msg ${i}`));
	const page0 = logQuery.queryLogLines(lines, { page: 0, pageSize: 50 });
	assert.equal(page0.total, 120);
	assert.equal(page0.entries.length, 50);
	assert.equal(page0.entries[0].id, "119"); // 最新在前
	const page2 = logQuery.queryLogLines(lines, { page: 2, pageSize: 50 });
	assert.equal(page2.entries.length, 20); // 最后一页余量
	assert.equal(page2.entries[19].id, "0"); // 最旧一条仍能翻到（旧实现 5000 行截断查不到）
});

test("queryLogLines legacy limit mode keeps recent N", () => {
	const lines = Array.from({ length: 30 }, (_, i) => entry(String(i), 1000 + i, "info", "git", `msg ${i}`));
	const result = logQuery.queryLogLines(lines, { limit: 10 });
	assert.equal(result.entries.length, 10);
	assert.equal(result.entries[0].id, "29");
	assert.equal(result.total, 30);
});

test("toAppLogPage derives hasMore from total and page", () => {
	const page = (p) => logQuery.toAppLogPage({ entries: [], total: 120 }, p, 50);
	assert.equal(page(0).hasMore, true);
	assert.equal(page(2).hasMore, false);
	assert.equal(page(3).hasMore, false); // 越界页不报错
});
