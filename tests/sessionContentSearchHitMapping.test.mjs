/**
 * 跨会话正文搜索：sidecar 命中按「会话文件路径」映射回 catalog 记录。
 *
 * 回归背景：`SessionRecord.id` 是跨重启稳定的 UUID，`filePath` 是独立字段；
 * 渲染层曾用 `records[hit.filePath]` 取值，而 `sessionRecordsAtom` 以 id 为键，
 * 于是映射恒为 undefined、所有命中被过滤掉，侧栏正文结果区块永远不渲染。
 *
 * 这里把映射策略抽成纯函数钉住（组件只做呈现），同时覆盖 Windows 分隔符/盘符大小写
 * 与 POSIX 大小写敏感两条路径。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionContentSearchHits, sessionFilePathKey } = loadTsCommonJs("src/renderer/src/utils/sessionContentSearchHits.ts");

/** 完整 SessionRecord 工厂：测试数据不依赖运行时缺省字段。 */
function record(id, filePath, extra = {}) {
	return {
		id,
		projectId: "p1",
		title: `会话 ${id}`,
		source: "pi",
		environment: "windows",
		filePath,
		preview: "",
		messageCount: 1,
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		...extra,
	};
}

function hit(filePath, matches = [{ messageId: "m1", role: "user", timestampMs: 1, snippet: "alpha 命中" }], extra = {}) {
	return { filePath, updatedAtMs: 1, matches, ...extra };
}

test("按 filePath 映射回以 UUID id 为键的记录（不再依赖 records[filePath]）", () => {
	const records = { "uuid-1": record("uuid-1", "C:\\sessions\\a.jsonl") };
	const result = { sessions: [hit("C:\\sessions\\a.jsonl", undefined, { hitCount: 3 })], totalHitSessions: 1, truncated: false };

	const hits = buildSessionContentSearchHits(result, records);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].record.id, "uuid-1");
	assert.equal(hits[0].matchCount, 3);
	assert.equal(hits[0].firstMessageId, "m1");
	assert.equal(hits[0].snippet, "alpha 命中");
});

test("没有 hitCount 时回退到 matches.length（与组件展示口径一致）", () => {
	const records = { "uuid-1": record("uuid-1", "/home/u/.pi/a.jsonl") };
	const result = {
		sessions: [
			hit("/home/u/.pi/a.jsonl", [
				{ messageId: "m1", role: "user", timestampMs: 1, snippet: "x" },
				{ messageId: "m2", role: "assistant", timestampMs: 2, snippet: "y" },
			]),
		],
		totalHitSessions: 1,
		truncated: false,
	};

	const hits = buildSessionContentSearchHits(result, records);
	assert.equal(hits[0].matchCount, 2);
});

test("Windows 分隔符与盘符大小写不同也能命中（sidecar 与 catalog 的写法可能不一致）", () => {
	const records = { "uuid-1": record("uuid-1", "C:\\Users\\u\\a.jsonl") };
	const result = { sessions: [hit("c:/users/u/a.jsonl")], totalHitSessions: 1, truncated: false };

	assert.equal(buildSessionContentSearchHits(result, records).length, 1);
});

test("POSIX 路径大小写敏感：不因大小写折叠误配另一个文件", () => {
	const records = { "uuid-1": record("uuid-1", "/home/u/A.jsonl") };
	const result = { sessions: [hit("/home/u/a.jsonl")], totalHitSessions: 1, truncated: false };

	assert.equal(buildSessionContentSearchHits(result, records).length, 0);
});

test("映射缺失与空命中的条目被丢弃，其余命中保留", () => {
	const records = {
		"uuid-1": record("uuid-1", "C:\\sessions\\a.jsonl"),
		// 匿名/DSH 会话没有 filePath，不参与映射
		"uuid-2": record("uuid-2", undefined, { noSession: true }),
	};
	const result = {
		sessions: [hit("C:\\sessions\\a.jsonl"), hit("C:\\sessions\\missing.jsonl"), hit("C:\\sessions\\empty.jsonl", [])],
		totalHitSessions: 3,
		truncated: false,
	};

	const hits = buildSessionContentSearchHits(result, records);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].record.id, "uuid-1");
});

test("降级（result 为 null）返回空数组，不抛错", () => {
	const hits = buildSessionContentSearchHits(null, { "uuid-1": record("uuid-1", "C:\\a.jsonl") });
	assert.equal(Array.isArray(hits), true);
	assert.equal(hits.length, 0);
});

test("路径键：Windows 路径折叠分隔符与盘符大小写，POSIX 原样", () => {
	assert.equal(sessionFilePathKey("C:\\Sessions\\A.jsonl"), "c:/sessions/a.jsonl");
	assert.equal(sessionFilePathKey("/home/u/A.jsonl"), "/home/u/A.jsonl");
});
