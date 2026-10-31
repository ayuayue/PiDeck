import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端搜索的渲染层状态流转（F2）单测：纯状态机 + IPC 返回收窄，不挂 React。
 *
 * 重点覆盖「迟到结果作废」：切项目、发起新搜索之后，旧代次的结果**绝不能**覆盖新查询——
 * settle 必须返回 false 且状态对象引用不变。也覆盖三种终态的边界：空结果、被截断（必须明说是截断，
 * 不能假装完整）、错误（稳定码 / IPC reject）。
 */

const { createRemoteProjectSearchController, readSearchResponse, remoteSearchOutcomeFromService } = loadTsCommonJs("src/renderer/src/components/session/remoteProjectSearchState.ts");

// 生产模块在 vm 里加载，产出的对象原型与测试 realm 不同——deepStrictEqual 会因原型不等而失败。
// 这里把结果复制成测试 realm 的普通对象再做严格比较（不是放宽断言：结构与类型仍然逐字段比对）。
const plain = (value) => JSON.parse(JSON.stringify(value));

const entry = (path, kind = "file", bytes) => (kind === "file" ? { path, name: path.split("/").pop(), kind, bytes: bytes ?? 10 } : { path, name: path.split("/").pop(), kind });
const ok = (entries, overrides = {}) => ({ kind: "ok", entries, scanned: entries.length, truncated: false, ...overrides });

test("start enters searching, clears the previous result and returns a new generation", () => {
	const controller = createRemoteProjectSearchController();
	assert.equal(controller.getState().phase, "idle");

	const first = controller.start("auth");
	assert.equal(controller.getState().phase, "searching");
	assert.equal(controller.getState().query, "auth");
	controller.settle(first, ok([entry("src/auth.ts")]));

	const second = controller.start("session");
	assert.equal(second > first, true);
	const searching = controller.getState();
	assert.equal(searching.phase, "searching");
	assert.deepEqual(plain(searching.entries), []);
	assert.equal(searching.errorCode, null);
	assert.equal(searching.query, "session");
});

test("an empty result settles as empty, a match settles as results", () => {
	const controller = createRemoteProjectSearchController();
	const first = controller.start("zzz");
	assert.equal(controller.settle(first, ok([])), true);
	assert.equal(controller.getState().phase, "empty");

	const second = controller.start("auth");
	assert.equal(controller.settle(second, ok([entry("src/auth.ts", "file", 42)])), true);
	const state = controller.getState();
	assert.equal(state.phase, "results");
	assert.deepEqual(plain(state.entries), [{ path: "src/auth.ts", name: "auth.ts", kind: "file", bytes: 42 }]);
	assert.equal(state.truncated, false);
});

test("a truncated result is never presented as complete or as empty", () => {
	const controller = createRemoteProjectSearchController();
	const first = controller.start("a");
	assert.equal(controller.settle(first, ok([entry("a.ts")], { truncated: true })), true);
	assert.equal(controller.getState().phase, "results");
	assert.equal(controller.getState().truncated, true);

	// 零匹配 + truncated：不是「没有匹配」，而是「被截断的零结果」。
	const second = controller.start("b");
	assert.equal(controller.settle(second, ok([], { scanned: 20000, truncated: true })), true);
	assert.equal(controller.getState().phase, "results");
	assert.equal(controller.getState().truncated, true);
	assert.equal(controller.getState().scanned, 20000);
});

test("a late result from an older generation cannot overwrite a newer query", () => {
	const controller = createRemoteProjectSearchController();
	const stale = controller.start("auth");
	const current = controller.start("session");
	const before = controller.getState();
	assert.equal(controller.settle(stale, ok([entry("src/auth.ts")])), false);
	assert.equal(controller.getState(), before, "a stale settlement must not touch the state object");
	assert.equal(controller.getState().query, "session");
	assert.equal(controller.getState().phase, "searching");

	// 同一代次（新查询）仍然正常落地。
	assert.equal(controller.settle(current, ok([entry("src/session.ts")])), true);
	assert.deepEqual(plain(controller.getState().entries), [{ path: "src/session.ts", name: "session.ts", kind: "file", bytes: 10 }]);
});

test("reset invalidates in-flight results (project switch) and returns to idle", () => {
	const controller = createRemoteProjectSearchController();
	const generation = controller.start("auth");
	controller.settle(generation, ok([entry("src/auth.ts")]));
	controller.reset();
	assert.equal(controller.getState().phase, "idle");
	assert.deepEqual(plain(controller.getState().entries), []);

	const stale = controller.start("other");
	controller.reset();
	assert.equal(controller.settle(stale, ok([entry("src/other.ts")])), false);
	assert.equal(controller.getState().phase, "idle");
	assert.deepEqual(plain(controller.getState().entries), []);
});

test("failures surface the stable code; an IPC rejection surfaces without inventing one", () => {
	const controller = createRemoteProjectSearchController();
	const failed = controller.start("a");
	controller.settle(failed, { kind: "failed", code: "PATH_NOT_FOUND" });
	assert.equal(controller.getState().phase, "error");
	assert.equal(controller.getState().errorCode, "PATH_NOT_FOUND");

	const rejected = controller.start("b");
	controller.settle(rejected, { kind: "rejected" });
	assert.equal(controller.getState().phase, "error");
	assert.equal(controller.getState().errorCode, null);
	assert.deepEqual(plain(controller.getState().entries), []);
});

test("readSearchResponse accepts a well-formed payload and copies only known fields", () => {
	const outcome = readSearchResponse({
		ok: true,
		entries: [{ path: "src/auth.ts", name: "auth.ts", kind: "file", bytes: 12, size: 12 }],
		scanned: 30,
		truncated: true,
	});
	assert.deepEqual(plain(outcome), { kind: "ok", entries: [{ path: "src/auth.ts", name: "auth.ts", kind: "file", bytes: 12 }], scanned: 30, truncated: true });
	assert.equal(Object.hasOwn(outcome.entries[0], "size"), false);
});

test("readSearchResponse refuses malformed payloads instead of rendering them", () => {
	const cases = [
		["a non-record", 42],
		["missing ok", { entries: [], scanned: 0, truncated: false }],
		["an unknown ok value", { ok: "yes", entries: [], scanned: 0, truncated: false }],
		["a missing scanned", { ok: true, entries: [], truncated: false }],
		["a fractional scanned", { ok: true, entries: [], scanned: 1.5, truncated: false }],
		["a non-boolean truncated", { ok: true, entries: [], scanned: 0, truncated: "true" }],
		["entries that is not an array", { ok: true, entries: {}, scanned: 0, truncated: false }],
		["an entry that is not a record", { ok: true, entries: [7], scanned: 1, truncated: false }],
		["an entry with an unsafe path", { ok: true, entries: [{ path: "../etc", name: "etc", kind: "directory" }], scanned: 1, truncated: false }],
		["an unknown kind", { ok: true, entries: [{ path: "a.ts", name: "a.ts", kind: "symlink" }], scanned: 1, truncated: false }],
		["bytes missing on a file", { ok: true, entries: [{ path: "a.ts", name: "a.ts", kind: "file" }], scanned: 1, truncated: false }],
		["bytes on a directory", { ok: true, entries: [{ path: "src", name: "src", kind: "directory", bytes: 3 }], scanned: 1, truncated: false }],
		["a free-text failure code", { ok: false, code: "boom /home/user/secret" }],
		["a failure without a code", { ok: false }],
	];
	for (const [label, payload] of cases) {
		assert.deepEqual(plain(readSearchResponse(payload)), { kind: "rejected" }, label);
	}

	assert.deepEqual(plain(readSearchResponse({ ok: false, code: "PATH_NOT_FOUND" })), { kind: "failed", code: "PATH_NOT_FOUND" });
});
test("service results are narrowed at the boundary: only safe relative paths/types survive", () => {
	const mapped = remoteSearchOutcomeFromService({
		results: [
			{ name: "a.ts", relativePath: "src/a.ts", type: "file" },
			{ name: "lib", relativePath: "src/lib", type: "directory" },
		],
		scanned: 12,
		truncated: true,
	});
	assert.deepEqual(plain(mapped), {
		kind: "ok",
		entries: [
			{ path: "src/a.ts", name: "a.ts", kind: "file" },
			{ path: "src/lib", name: "lib", kind: "directory" },
		],
		scanned: 12,
		truncated: true,
	});

	const malformed = [
		["a non-array results", { results: null }],
		["a traversal path", { results: [{ name: "etc", relativePath: "../etc", type: "directory" }] }],
		["a name that does not match the path", { results: [{ name: "b.ts", relativePath: "src/a.ts", type: "file" }] }],
		["an unknown type", { results: [{ name: "a.ts", relativePath: "a.ts", type: "symlink" }] }],
		["a non-boolean truncated", { results: [], truncated: "yes" }],
		["a fractional scanned", { results: [], scanned: 1.5 }],
	];
	for (const [label, payload] of malformed) {
		assert.deepEqual(plain(remoteSearchOutcomeFromService(payload)), { kind: "rejected" }, label);
	}
	// 契约目前不携带 bytes / "other"：缺省不是 undefined 冒充，而是由 S 扩展后才会出现。
	assert.deepEqual(plain(remoteSearchOutcomeFromService({ results: [{ name: "a.ts", relativePath: "a.ts", type: "file" }] })), {
		kind: "ok",
		entries: [{ path: "a.ts", name: "a.ts", kind: "file" }],
		scanned: 0,
		truncated: false,
	});
});
test("service entries keep remote kind=other and bytes; normalized results are the fallback", () => {
	const mapped = remoteSearchOutcomeFromService({
		results: [
			{ name: "a.ts", relativePath: "a.ts", type: "file" },
			{ name: "link", relativePath: "link", type: "file" },
		],
		entries: [
			{ path: "a.ts", name: "a.ts", kind: "file", bytes: 9 },
			{ path: "link", name: "link", kind: "other" },
		],
		scanned: 2,
		truncated: false,
	});
	assert.deepEqual(plain(mapped), {
		kind: "ok",
		entries: [
			{ path: "a.ts", name: "a.ts", kind: "file", bytes: 9 },
			{ path: "link", name: "link", kind: "other" },
		],
		scanned: 2,
		truncated: false,
	});

	// 原始 entries 是外部数据：畸形条目依然整条 rejected，不降级成空结果。
	assert.deepEqual(plain(remoteSearchOutcomeFromService({ results: [], entries: [{ path: "../escape", name: "escape", kind: "file", bytes: 1 }] })), { kind: "rejected" });
});
