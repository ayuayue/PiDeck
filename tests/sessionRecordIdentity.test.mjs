import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/utils/sessionRecordIdentity.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "sessionRecordIdentity.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			Object,
			require: (specifier) => {
				throw new Error(`Unexpected import: ${specifier}`);
			},
		},
		{ filename: "sessionRecordIdentity.ts" },
	);
	return module.exports;
}

function makeRecord(overrides = {}) {
	return {
		id: "s1",
		projectId: "p1",
		title: "Session",
		source: "pi",
		environment: "local",
		preview: "hello",
		messageCount: 3,
		status: "active",
		createdAt: 100,
		updatedAt: 200,
		...overrides,
	};
}

test("identical records compare equal, including a fresh object with the same fields", () => {
	const { sameSessionRecord } = loadModule();
	const record = makeRecord();
	assert.equal(sameSessionRecord(record, record), true);
	assert.equal(sameSessionRecord(record, makeRecord()), true);
});

test("detects the fields that actually change during a poll", () => {
	const { sameSessionRecord } = loadModule();
	const base = makeRecord();
	assert.equal(sameSessionRecord(base, makeRecord({ updatedAt: 201 })), false);
	assert.equal(sameSessionRecord(base, makeRecord({ title: "Renamed" })), false);
	assert.equal(sameSessionRecord(base, makeRecord({ preview: "changed" })), false);
	assert.equal(sameSessionRecord(base, makeRecord({ messageCount: 4 })), false);
	assert.equal(sameSessionRecord(base, makeRecord({ status: "draft" })), false);
});

test("compares model by value, not by reference", () => {
	const { sameSessionRecord } = loadModule();
	const withModel = makeRecord({ model: { provider: "anthropic", modelId: "opus" } });
	const sameByValue = makeRecord({ model: { provider: "anthropic", modelId: "opus" } });
	const different = makeRecord({ model: { provider: "anthropic", modelId: "sonnet" } });
	assert.equal(sameSessionRecord(withModel, sameByValue), true);
	assert.equal(sameSessionRecord(withModel, different), false);
	assert.equal(sameSessionRecord(withModel, makeRecord()), false);
});

test("an unchanged project list is equivalent so the atoms keep their identity", () => {
	const { sameProjectSessionList } = loadModule();
	const a = makeRecord({ id: "a" });
	const b = makeRecord({ id: "b", updatedAt: 150 });
	const records = { a, b };
	// 后端每次返回新对象，比较必须按值而非引用
	const refetched = [makeRecord({ id: "a" }), makeRecord({ id: "b", updatedAt: 150 })];
	assert.equal(sameProjectSessionList(["a", "b"], records, refetched), true);
});

test("order, additions, removals and field edits all break equivalence", () => {
	const { sameProjectSessionList } = loadModule();
	const a = makeRecord({ id: "a" });
	const b = makeRecord({ id: "b" });
	const records = { a, b };
	assert.equal(sameProjectSessionList(["a", "b"], records, [b, a]), false);
	assert.equal(sameProjectSessionList(["a", "b"], records, [a]), false);
	assert.equal(sameProjectSessionList(["a", "b"], records, [a, b, makeRecord({ id: "c" })]), false);
	assert.equal(sameProjectSessionList(["a", "b"], records, [a, makeRecord({ id: "b", updatedAt: 999 })]), false);
});

test("an id present in the index but missing from the record store is not equivalent", () => {
	const { sameProjectSessionList } = loadModule();
	const a = makeRecord({ id: "a" });
	assert.equal(sameProjectSessionList(["a"], {}, [a]), false);
});

test("empty lists are equivalent so first load of an empty project does not thrash", () => {
	const { sameProjectSessionList } = loadModule();
	assert.equal(sameProjectSessionList([], {}, []), true);
});
