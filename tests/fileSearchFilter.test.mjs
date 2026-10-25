import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// filterSnapshotResults / findFileNameMatchIndex 是纯函数（零依赖），
// 直接从源码加载即可测；它们承载「前端即时过滤」与「高亮定位」两条规则，
// 语义必须与主进程 searchNames 的小写子串匹配严格一致。
const { filterSnapshotResults, findFileNameMatchIndex } = loadTsCommonJs("src/renderer/src/utils/fileSearchFilter.ts");

const snapshot = {
	query: "authservice",
	results: [
		{ name: "AuthService.ts", path: "D:/p/AuthService.ts", relativePath: "AuthService.ts", type: "file" },
		{ name: "authService.test.ts", path: "D:/p/authService.test.ts", relativePath: "authService.test.ts", type: "file" },
		{ name: "README.md", path: "D:/p/README.md", relativePath: "README.md", type: "file" },
	],
};

test("prefix query filters snapshot client-side without IPC", () => {
	// "authservice.t" 是快照查询 "authservice" 的延长 → 走前端过滤，仍是两个文件的子串
	const filtered = filterSnapshotResults(snapshot, "authservice.t");
	assert.equal(filtered?.length, 2);
	assert.ok(filtered.every((r) => r.name.toLowerCase().includes("authservice.t")));
});

test("non-prefix query returns null so caller falls back to server results", () => {
	// "serv" 不是快照查询的前缀：子集关系不成立，必须返回 null 改走服务端
	assert.equal(filterSnapshotResults(snapshot, "serv"), null);
	assert.equal(filterSnapshotResults(snapshot, ""), null);
});

test("findFileNameMatchIndex is case-insensitive and trims the query", () => {
	assert.equal(findFileNameMatchIndex("AuthService.ts", " "), -1); // 纯空白查询无匹配
	assert.equal(findFileNameMatchIndex("AuthService.ts", " SERVICE "), 4);
	assert.equal(findFileNameMatchIndex("auth-guard.ts", "GUARD"), 5);
	assert.equal(findFileNameMatchIndex("readme.md", "zzz"), -1);
});
