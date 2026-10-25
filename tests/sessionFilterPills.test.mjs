import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = {
		exports: {},
		require: (specifier) => {
			// 本模块只有类型导入，编译后应无运行时 require；出现即测试装载失败。
			throw new Error(`Unexpected import: ${specifier}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/sessionFilterPills.ts"), sandbox, {
		filename: "sessionFilterPills.ts",
	});
	return sandbox.exports;
}

const { sessionPillOf, filterSessionsByPills, pillsPresentIn, isSessionFilterPill, parseSessionFilterState, serializeSessionFilterState, SESSION_FILTER_PILLS } = loadModule();

test("sessionPillOf: DSH 会话按 backend 归属，不落入 Pi 类别", () => {
	assert.equal(sessionPillOf({ source: "pi", backend: "dsh" }), "dsh");
	assert.equal(sessionPillOf({ source: "pi", backend: "pi" }), "pi");
	assert.equal(sessionPillOf({ source: undefined, backend: "pi" }), "pi");
});

test("sessionPillOf: imagegen 会话按 backend 归属，不落入 Pi 类别（source 恒为 pi）", () => {
	assert.equal(sessionPillOf({ source: "pi", backend: "imagegen" }), "imagegen");
	assert.equal(sessionPillOf({ source: undefined, backend: "imagegen" }), "imagegen");
});

test("sessionPillOf: 导入来源按 source 归属", () => {
	assert.equal(sessionPillOf({ source: "codex", backend: "pi" }), "codex");
	assert.equal(sessionPillOf({ source: "claude", backend: "pi" }), "claude");
	assert.equal(sessionPillOf({ source: "opencode", backend: "pi" }), "opencode");
	assert.equal(sessionPillOf({ source: "cursor", backend: "pi" }), "cursor");
});

test("filterSessionsByPills: 只选 Pi 时 DSH 会话不出现（source=pi 不重复命中）", () => {
	const sessions = [
		{ id: "pi-1", source: "pi", backend: "pi" },
		{ id: "dsh-1", source: "pi", backend: "dsh" },
		{ id: "codex-1", source: "codex", backend: "pi" },
	];
	const onlyPi = filterSessionsByPills(sessions, new Set(["pi"]));
	assert.equal(onlyPi.map((s) => s.id).join(","), "pi-1");
	const onlyDsh = filterSessionsByPills(sessions, new Set(["dsh"]));
	assert.equal(onlyDsh.map((s) => s.id).join(","), "dsh-1");
	const all = filterSessionsByPills(sessions, new Set([...SESSION_FILTER_PILLS]));
	assert.equal(all.map((s) => s.id).join(","), "pi-1,dsh-1,codex-1");
});

test("isSessionFilterPill: 只接受已知类别（来源 + dsh + imagegen）", () => {
	assert.equal(isSessionFilterPill("dsh"), true);
	assert.equal(isSessionFilterPill("imagegen"), true);
	assert.equal(isSessionFilterPill("pi"), true);
	assert.equal(isSessionFilterPill("codex"), true);
	assert.equal(isSessionFilterPill("cursor"), true);
	assert.equal(isSessionFilterPill("foo"), false);
	assert.equal(isSessionFilterPill(1), false);
	assert.equal(isSessionFilterPill(null), false);
});

test("v2 序列化/解析往返保持显式类别集合（含用户关掉 DSH 的状态）", () => {
	const raw = serializeSessionFilterState({ project: new Set(["pi", "codex"]), all: null });
	const state = parseSessionFilterState(raw);
	assert.equal([...state.project].join(","), "pi,codex");
	assert.equal(state.all, null);
});

test("v1 旧格式迁移：含 pi 补 dsh（旧用户此前能看到 DSH 会话）", () => {
	const state = parseSessionFilterState(JSON.stringify({ project: ["pi", "codex"] }));
	assert.equal([...state.project].sort().join(","), "codex,dsh,pi");
});

test("v1 旧格式迁移：不含 pi 不补 dsh（用户此前主动过滤掉了 pi 系会话）", () => {
	const state = parseSessionFilterState(JSON.stringify({ project: ["codex"] }));
	assert.equal([...state.project].join(","), "codex");
});

test("v1 旧格式：null 项目保持全部显示", () => {
	const state = parseSessionFilterState(JSON.stringify({ project: null }));
	assert.equal(state.project, null);
});

test("损坏输入返回空配置（全部显示）", () => {
	assert.deepEqual(Object.keys(parseSessionFilterState("{bad json")), []);
	assert.deepEqual(Object.keys(parseSessionFilterState("")), []);
	assert.deepEqual(Object.keys(parseSessionFilterState(null)), []);
});

test("pillsPresentIn: 只返回当前会话实际存在的类别，按固定顺序", () => {
	const sessions = [
		{ id: "pi-1", source: "pi", backend: "pi" },
		{ id: "dsh-1", source: "pi", backend: "dsh" },
	];
	assert.equal(pillsPresentIn(sessions).join(","), "pi,dsh");
});

test("pillsPresentIn: 空会话列表返回空数组（不摆任何 pill）", () => {
	assert.equal(pillsPresentIn([]).length, 0);
});

test("pillsPresentIn: 导入来源按 sessionPillOf 去重，无重复 pill", () => {
	const sessions = [
		{ id: "c1", source: "codex", backend: "pi" },
		{ id: "c2", source: "codex", backend: "pi" },
		{ id: "ig1", source: "pi", backend: "imagegen" },
	];
	assert.equal(pillsPresentIn(sessions).join(","), "codex,imagegen");
});
