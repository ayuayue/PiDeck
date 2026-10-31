/**
 * 目录页的 watch 降级字段（W3）：main 只在 watcher 真降级时把缺口带出去。
 *
 * 断言的是公共页面形状：未降级不带字段（旧读者零影响），降级时只带计数 + 原因，
 * 不把内部路径数组灌进每个目录页。链路其余部分（remoteProjectIpc.directoryPage → 文件树）由
 * remoteProjectIpc 的每页读取和 lazyDirTree 的透传测试覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const reads = loadTsCommonJs("src/main/ipc/remoteProjectDirectoryReads.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function snapshot(entries = []) {
	return { ok: true, snapshot: { value: entries, revision: 7 } };
}

const READ = async () => snapshot([{ name: "src", kind: "directory" }]);

test("未降级时目录页不带 dirWatch（旧读者与正常路径零影响）", async () => {
	const page = await reads.projectDirectoryPage({ projectId: "p1", path: "", force: false, readDirSnapshot: READ, generationOf: () => "g1", dirWatch: () => undefined });
	assert.equal(page.ok, true);
	assert.equal(Object.hasOwn(page.value, "dirWatch"), false);
});

test("降级时目录页带原因与计数，不携带内部路径数组", async () => {
	const page = await reads.projectDirectoryPage({
		projectId: "p1",
		path: "",
		force: false,
		readDirSnapshot: READ,
		generationOf: () => "g1",
		dirWatch: () => ({ degraded: true, reason: "watcher-capacity", desired: 40, covered: 32, dropped: 8 }),
	});
	assert.equal(page.ok, true);
	assert.deepEqual(plain(page.value.dirWatch), { degraded: true, reason: "watcher-capacity", desired: 40, covered: 32, dropped: 8 });
	assert.equal(Object.hasOwn(page.value.dirWatch, "desiredPaths"), false);
	assert.equal(Object.hasOwn(page.value.dirWatch, "coveredPaths"), false);
});

test("订阅失败时页面带 watch-failed 与 helper 的稳定失败码", () => {
	const projected = reads.projectDirectoryWatchDegradation({
		desired: ["", "src"],
		covered: [],
		degraded: { projectId: "p1", hostId: "h1", reason: "watch-failed", code: "PERMISSION_DENIED", desired: 2, covered: 0, dropped: 2 },
	});
	assert.deepEqual(plain(projected), { degraded: true, reason: "watch-failed", desired: 2, covered: 0, dropped: 2, code: "PERMISSION_DENIED" });
	// 没有失败码（旧装配/预算拒绝）时不多造字段，保持旧页面形状。
	assert.equal(Object.hasOwn(reads.projectDirectoryWatchDegradation({ desired: [], covered: [], degraded: { projectId: "p1", hostId: "h1", reason: "watcher-capacity", desired: 40, covered: 32, dropped: 8 } }), "code"), false);
});

test("旧装配没有注入降级读取器时页面形状不变", async () => {
	const page = await reads.projectDirectoryPage({ projectId: "p1", path: "", force: false, readDirSnapshot: READ, generationOf: () => "g1" });
	assert.equal(page.ok, true);
	assert.equal(Object.hasOwn(page.value, "dirWatch"), false);
	assert.deepEqual(plain(page.value.entries.map((entry) => entry.relativePath)), ["src"]);
});

test("深层 watch 状态 → 页面字段的投影只认 degraded", () => {
	assert.equal(reads.projectDirectoryWatchDegradation({ desired: [], covered: [] }), undefined);
	assert.deepEqual(plain(reads.projectDirectoryWatchDegradation({ desired: [], covered: [], degraded: { projectId: "p1", hostId: "h1", reason: "paths-over-limit", desired: 500, covered: 128, dropped: 372 } })), {
		degraded: true,
		reason: "paths-over-limit",
		desired: 500,
		covered: 128,
		dropped: 372,
	});
});
