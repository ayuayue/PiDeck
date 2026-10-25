import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import vm from "node:vm";
import { parseTodoSnapshotData } from "../src/shared/sessionTodo.ts";
import { runtimeTodosToItems, sessionTodoSnapshotToItems } from "../src/renderer/src/components/session/agentTodoParser.ts";

// 与 piDeckTodoExtension.test.mjs 相同的编译替身：resources/extensions 不在 tsconfig
// include 内，测试期才 transpile；本文件用它验证两条解码链对同一输入的 parity。
const statePath = "resources/extensions/pi-deck-todo-state.ts";

function compileStateModule() {
	const source = readFileSync(statePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: statePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => {
		throw new Error(`pi-deck-todo-state must stay dependency-free, got require("${specifier}")`);
	};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
		},
		{ filename: statePath },
	);
	return module.exports;
}

test("decode 链 parity：扩展 decodeTodoState 与历史 parseTodoSnapshotData 对同一输入结论一致", () => {
	// 两条解码链（resources/extensions 独立分发 vs src/shared 历史契约）对同一输入必须
	// 给出相同的「有无计划」结论：合法 v3 两者都恢复，legacy {todos,nextId} / v2 done /
	// 未知版本 / clear 后无 activePlan 都返回 undefined。坏项聚合差异（扩展整体拒绝 vs
	// 历史丢坏项继续）是有意设计，不属于本 parity 覆盖的一致子集，这里不覆盖。
	const { decodeTodoState } = compileStateModule();
	const cases = [
		// 合法 v3：两者都恢复
		{
			version: 3,
			activePlan: { id: 1, todos: [{ id: 1, text: "ok", status: "pending" }] },
			nextPlanId: 2,
			nextTodoId: 2,
		},
		// legacy {todos,nextId}
		{ todos: [{ id: 4, text: "旧任务", done: false }], nextId: 5 },
		// v2 done
		{
			version: 2,
			activePlan: { id: 3, todos: [{ id: 9, text: "旧计划", done: true }] },
			nextPlanId: 4,
			nextTodoId: 10,
		},
		// 未知版本
		{
			version: 7,
			activePlan: { id: 3, todos: [{ id: 9, text: "未来版本", status: "pending" }] },
			nextPlanId: 4,
			nextTodoId: 10,
		},
		// clear 后无 activePlan
		{ version: 3, nextPlanId: 4, nextTodoId: 5 },
	];
	for (const data of cases) {
		const decoded = decodeTodoState(data);
		const parsed = parseTodoSnapshotData(data);
		// 「有无计划」结论一致：扩展侧恢复 = 解码出 activePlan，历史侧恢复 = 非 undefined。
		// 注：clear 后无 activePlan 时扩展返回合法空 v3 状态（无 activePlan），历史返回
		// undefined——两边都表达「无计划」，结论一致但返回值形态不同，属设计内差异。
		const hasPlan = decoded?.activePlan !== undefined;
		const parsedHasPlan = parsed !== undefined;
		assert.equal(hasPlan, parsedHasPlan, `decoders disagree on input ${JSON.stringify(data)}`);
	}
	// 合法 v3 两份解码都必须恢复（非 undefined / 带 activePlan）
	assert.ok(decodeTodoState(cases[0])?.activePlan);
	assert.ok(parseTodoSnapshotData(cases[0]));
});

test("parseTodoSnapshotData: version-3 快照解析出计划与三态待办", () => {
	const snapshot = parseTodoSnapshotData({
		version: 3,
		activePlan: {
			id: 3,
			todos: [
				{ id: 15, text: "主进程读取", status: "pending" },
				{ id: 22, text: "文件 tab", status: "in_progress" },
				{ id: 26, text: "发版", status: "completed" },
			],
		},
		nextPlanId: 4,
		nextTodoId: 27,
	});
	assert.deepEqual(snapshot, {
		planId: 3,
		todos: [
			{ id: 15, text: "主进程读取", status: "pending" },
			{ id: 22, text: "文件 tab", status: "in_progress" },
			{ id: 26, text: "发版", status: "completed" },
		],
	});
});

test("parseTodoSnapshotData: 旧格式（legacy/v2/未知版本）解析为 undefined 且不抛错", () => {
	// legacy {todos,nextId}（无 version 字段）
	assert.equal(parseTodoSnapshotData({ todos: [{ id: 4, text: "旧任务", done: false }], nextId: 5 }), undefined);
	// v2 done 布尔
	assert.equal(
		parseTodoSnapshotData({
			version: 2,
			activePlan: { id: 3, todos: [{ id: 9, text: "旧计划", done: true }] },
			nextPlanId: 4,
			nextTodoId: 10,
		}),
		undefined,
	);
	// 未知版本
	assert.equal(
		parseTodoSnapshotData({
			version: 7,
			activePlan: { id: 3, todos: [{ id: 9, text: "未来版本", status: "pending" }] },
			nextPlanId: 4,
			nextTodoId: 10,
		}),
		undefined,
	);
	// 缺 version 字段（v3 断言严格）
	assert.equal(
		parseTodoSnapshotData({
			activePlan: { id: 1, todos: [{ id: 1, text: "ok", status: "pending" }] },
		}),
		undefined,
	);
});

test("parseTodoSnapshotData: clear 后无 activePlan 返回 undefined", () => {
	assert.equal(parseTodoSnapshotData({ version: 3, nextPlanId: 4, nextTodoId: 5 }), undefined);
});

test("parseTodoSnapshotData: 非对象输入返回 undefined", () => {
	assert.equal(parseTodoSnapshotData(undefined), undefined);
	assert.equal(parseTodoSnapshotData("nope"), undefined);
	assert.equal(parseTodoSnapshotData(null), undefined);
});

test("parseTodoSnapshotData: 坏项丢弃而非整体失败", () => {
	const snapshot = parseTodoSnapshotData({
		version: 3,
		activePlan: {
			id: 1,
			todos: [
				{ id: 1, text: "ok", status: "pending" },
				{ text: "no id" },
				{ id: 2, text: "", status: "pending" },
				{ id: "x", text: "string id", status: "pending" },
				"garbage",
				{ id: 3, text: "also ok", status: "completed" },
				{ id: 4, text: "bad status", status: "bogus" },
				{ id: 0, text: "zero id", status: "pending" },
				{ id: 5, text: "old done shape", done: true },
			],
		},
	});
	assert.deepEqual(snapshot?.todos, [
		{ id: 1, text: "ok", status: "pending" },
		{ id: 3, text: "also ok", status: "completed" },
	]);
});

test("parseTodoSnapshotData: todos 非数组视为空计划", () => {
	assert.deepEqual(parseTodoSnapshotData({ version: 3, activePlan: { id: 2 } }), {
		planId: 2,
		todos: [],
	});
});

test("sessionTodoSnapshotToItems: 快照转 TodoItem（三态映射与解析口径同 widget 路径）", () => {
	const items = sessionTodoSnapshotToItems({
		planId: 3,
		todos: [
			{ id: 15, text: "主进程读取", status: "pending" },
			{ id: 22, text: "文件 tab", status: "in_progress" },
			{ id: 26, text: "发版", status: "completed" },
		],
	});
	assert.deepEqual(items, [
		{ id: "主进程读取", title: "主进程读取", status: "pending" },
		{ id: "文件 tab", title: "文件 tab", status: "in-progress" },
		{ id: "发版", title: "发版", status: "completed" },
	]);
});

test("sessionTodoSnapshotToItems: undefined / 空快照返回空数组", () => {
	assert.deepEqual(sessionTodoSnapshotToItems(undefined), []);
	assert.deepEqual(sessionTodoSnapshotToItems({ planId: 1, todos: [] }), []);
});

test("runtimeTodosToItems: DSH 结构化 todo 保留三态并为重复正文生成稳定 key", () => {
	assert.deepEqual(
		runtimeTodosToItems([
			{ content: "读取会话", status: "pending" },
			{ content: "读取会话", status: "in_progress" },
			{ content: "补充测试", status: "completed" },
		]),
		[
			{ id: "读取会话", title: "读取会话", status: "pending" },
			{ id: "读取会话#2", title: "读取会话", status: "in-progress" },
			{ id: "补充测试", title: "补充测试", status: "completed" },
		],
	);
	assert.deepEqual(runtimeTodosToItems(null), []);
});
