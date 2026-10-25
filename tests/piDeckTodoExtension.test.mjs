import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const extensionPath = "resources/extensions/pi-deck-todo.ts";
const statePath = "resources/extensions/pi-deck-todo-state.ts";
const selfPath = "C:/PiDeck/resources/extensions/pi-deck-todo.ts";

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

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
	const module2 = { exports: {} };
	const localRequire = (specifier) => {
		throw new Error(`pi-deck-todo-state must stay dependency-free, got require("${specifier}")`);
	};
	vm.runInNewContext(
		output,
		{
			module: module2,
			exports: module2.exports,
			require: localRequire,
			console,
		},
		{ filename: statePath },
	);
	return module2.exports;
}

let stateModule;
function getStateModule() {
	if (!stateModule) stateModule = compileStateModule();
	return stateModule;
}

function compileExtension() {
	const source = readFileSync(extensionPath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: extensionPath,
	}).outputText;
	const Type = {
		Object: (properties, options = {}) => ({ properties, ...options }),
		Optional: (schema) => ({ ...schema, optional: true }),
		String: (options = {}) => ({ type: "string", ...options }),
		Number: (options = {}) => ({ type: "number", ...options }),
		Boolean: (options = {}) => ({ type: "boolean", ...options }),
		Array: (items, options = {}) => ({ type: "array", items, ...options }),
	};
	const module2 = { exports: {} };
	const localRequire = (specifier) => {
		if (specifier === "./pi-deck-todo-state" || specifier === "./pi-deck-todo-state.ts") {
			return getStateModule();
		}
		if (specifier === "@earendil-works/pi-ai") {
			return { StringEnum: (values) => ({ enum: values }) };
		}
		if (specifier === "typebox") return { Type };
		return {};
	};
	vm.runInNewContext(
		output,
		{
			module: module2,
			exports: module2.exports,
			require: localRequire,
			__filename: selfPath,
			console,
		},
		{ filename: extensionPath },
	);
	return module2.exports.default;
}

function createHarness(entries = []) {
	let sessionEntries = entries;
	let allEntries = entries;
	let leafId = "branch-root";
	let todoSourcePath = selfPath;
	const handlers = new Map();
	const commands = new Map();
	const snapshots = [];
	const widgets = new Map();
	const notifications = [];
	let todoTool;

	const api = {
		getAllTools() {
			return [
				{
					name: "todo",
					sourceInfo: { path: todoSourcePath },
				},
			];
		},
		appendEntry(customType, data) {
			const entry = { type: "custom", customType, data: clone(data) };
			snapshots.push(entry);
			// 模拟 pi 真实行为：appendEntry 的条目进入会话分支历史
			// （压缩后补注简报的幂等判定扫描的就是分支条目）
			sessionEntries.push(entry);
			allEntries.push(entry);
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerTool(tool) {
			todoTool = tool;
		},
	};
	const extension = compileExtension();
	extension(api);

	const context = {
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setWidget(key, lines) {
				if (lines?.length) widgets.set(key, [...lines]);
				else widgets.delete(key);
			},
		},
		sessionManager: {
			getEntries() {
				return allEntries;
			},
			getBranch() {
				return sessionEntries;
			},
			getLeafId() {
				return leafId;
			},
		},
	};

	return {
		commands,
		context,
		handlers,
		notifications,
		setEntries(nextEntries) {
			sessionEntries = nextEntries;
			allEntries = nextEntries;
		},
		setAllEntries(nextEntries) {
			allEntries = nextEntries;
		},
		setLeafId(nextLeafId) {
			leafId = nextLeafId;
		},
		setTodoSourcePath(path) {
			todoSourcePath = path;
		},
		snapshots,
		widgets,
		async execute(params) {
			return todoTool.execute("todo-call", params, undefined, undefined, context);
		},
	};
}

function todoEntry(data) {
	return { type: "custom", customType: "pi-deck-todo", data };
}

function v3TodoEntry(overrides = {}) {
	return todoEntry({
		version: 3,
		activePlan: { id: 1, todos: [{ id: 1, text: "默认任务", status: "pending" }] },
		nextPlanId: 2,
		nextTodoId: 2,
		...overrides,
	});
}

async function start(harness) {
	await harness.handlers.get("session_start")({}, harness.context);
}

async function reminder(harness, messages = []) {
	const result = await harness.handlers.get("context")({ messages }, harness.context);
	const contextualMessages = result?.messages ?? messages;
	const message = contextualMessages.findLast((candidate) => candidate.customType === "pi-deck-todo-context");
	return message ? { message, messages: contextualMessages } : undefined;
}

// ---------------------------------------------------------------------------
// 恢复边界与工具归属
// ---------------------------------------------------------------------------

test("legacy, v2, unknown-version, and invalid v3 snapshots never restore a plan", async () => {
	const staleFormats = [
		{ todos: [{ id: 4, text: "旧任务", done: false }], nextId: 5 }, // legacy {todos,nextId}
		{
			version: 2,
			activePlan: { id: 3, todos: [{ id: 9, text: "旧计划", done: true }] },
			nextPlanId: 4,
			nextTodoId: 10,
		},
		{
			version: 7,
			activePlan: { id: 3, todos: [{ id: 9, text: "未来版本", status: "pending" }] },
			nextPlanId: 4,
			nextTodoId: 10,
		},
		{
			version: 3,
			activePlan: { id: 1, todos: [{ id: 1, text: "坏状态", status: "bogus" }] },
			nextPlanId: 2,
			nextTodoId: 2,
		},
		{
			version: 3,
			activePlan: { id: 1, todos: [{ id: 0, text: "坏 id", status: "pending" }] },
			nextPlanId: 2,
			nextTodoId: 2,
		},
		{
			version: 3,
			activePlan: { id: 1, todos: [{ id: 1, text: "   ", status: "pending" }] },
			nextPlanId: 2,
			nextTodoId: 2,
		},
	];
	for (const data of staleFormats) {
		const harness = createHarness([todoEntry(data)]);
		await start(harness);
		assert.equal(harness.widgets.has("pi-deck-todo"), false, JSON.stringify(data));
		assert.equal(harness.snapshots.length, 0, "reading an old snapshot must not write back");
	}
});

test("todo ownership rejects near-miss and same-name third-party paths", async () => {
	const harness = createHarness();
	await start(harness);
	await harness.execute({ action: "replace", items: [{ text: "任务" }] });
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:1]]", "☐ #1 任务"]);

	// 近似文件名和不同目录下的同名文件都不是本扩展。
	for (const fakePath of ["C:/extensions/my-pi-deck-todo-tool.ts", "C:/extensions/tools/ellepi-deck-todo-helper.ts", "C:/extensions/pi-deck-todo.ts"]) {
		harness.setTodoSourcePath(fakePath);
		const contextReminder = await reminder(harness);
		assert.equal(contextReminder, undefined, `${fakePath} must be treated as third-party`);
		assert.equal(harness.widgets.has("pi-deck-todo"), false, fakePath);
		const contextResult = await harness.handlers.get("context")(
			{
				messages: [{ role: "custom", customType: "pi-deck-todo-context", content: "stale" }],
			},
			harness.context,
		);
		assert.deepEqual(contextResult.messages, [], `${fakePath} must drop our reminder`);
	}
});

// ---------------------------------------------------------------------------
// 新契约：三态、幂等、预算、错误与生命周期
// ---------------------------------------------------------------------------

test("isOwnTodo treats normalized self paths (backslash, case) as owned", async () => {
	const harness = createHarness();
	await start(harness);
	await harness.execute({ action: "replace", items: [{ text: "任务" }] });
	// 规范化后与自身路径相等：Windows 反斜杠 + 大小写变体仍属本扩展。
	// 新契约（零失效）下 context 不再注入提醒，归属判定由 widget 发布状态体现：
	// 若被误判为第三方，context 处理器会清空 widget（yielded 让位流程）。
	harness.setTodoSourcePath("c:\\pideck\\resources\\extensions\\PI-DECK-TODO.ts");
	const contextResult = await harness.handlers.get("context")(
		{
			messages: [{ role: "user", content: "request" }],
		},
		harness.context,
	);
	assert.equal(contextResult, undefined, "owned tool must not yield on context");
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:1]]", "☐ #1 任务"]);
});

test("replace with in_progress initial, update to completed, and redundant update persists nothing extra", async () => {
	const harness = createHarness();
	await start(harness);

	await harness.execute({
		action: "replace",
		items: [{ text: "设计 schema", status: "in_progress" }, { text: "补测试" }],
	});
	let snapshot = harness.snapshots.at(-1).data;
	assert.equal(snapshot.activePlan.id, 1);
	assert.deepEqual(snapshot.activePlan.todos, [
		{ id: 1, text: "设计 schema", status: "in_progress" },
		{ id: 2, text: "补测试", status: "pending" },
	]);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:1]]", "◐ #1 设计 schema", "☐ #2 补测试"]);

	const updated = await harness.execute({ action: "update", id: 2, status: "completed" });
	assert.match(updated.content[0].text, /#2/);
	assert.match(updated.content[0].text, /completed/);
	assert.match(updated.content[0].text, /2 todos in plan/);
	snapshot = harness.snapshots.at(-1).data;
	assert.deepEqual(snapshot.activePlan.todos, [
		{ id: 1, text: "设计 schema", status: "in_progress" },
		{ id: 2, text: "补测试", status: "completed" },
	]);

	// 幂等：同一 update 重复执行不产生新快照、不换任务 ID
	const before = harness.snapshots.length;
	const again = await harness.execute({ action: "update", id: 2, status: "completed" });
	assert.equal(harness.snapshots.length, before);
	assert.equal(harness.snapshots.at(-1).data.activePlan.todos[1].id, 2);
	assert.match(again.content[0].text, /#2 already completed/);
});

test("update also rewrites text and keeps ids stable; empty branch clears the widget", async () => {
	const harness = createHarness([v3TodoEntry()]);
	await start(harness);

	// 状态 + 正文同改：ID 与顺序保持，变更项与计数可见
	const combined = await harness.execute({
		action: "update",
		id: 1,
		status: "completed",
		text: "重写后的正文",
	});
	assert.match(combined.content[0].text, /#1/);
	assert.match(combined.content[0].text, /重写后的正文/);
	assert.match(combined.content[0].text, /→ completed/);
	const snapshot = harness.snapshots.at(-1).data;
	assert.deepEqual(snapshot.activePlan.todos, [{ id: 1, text: "重写后的正文", status: "completed" }]);

	// 纯正文更新：状态不受牵连
	const textOnly = await harness.execute({ action: "update", id: 1, text: "只改正文" });
	assert.match(textOnly.content[0].text, /text: 只改正文/);
	assert.equal(harness.snapshots.at(-1).data.activePlan.todos[0].status, "completed");

	// 空分支（无快照）恢复：widget 不残留任何旧计划
	harness.setEntries([]);
	await harness.handlers.get("session_tree")({}, harness.context);
	assert.equal(harness.widgets.has("pi-deck-todo"), false);
});

test("list and replace expose item ids and statuses to the model", async () => {
	const harness = createHarness();
	await start(harness);

	const replaced = await harness.execute({
		action: "replace",
		items: [{ text: "设计 schema", status: "in_progress" }, { text: "实现迁移" }],
	});
	assert.match(replaced.content[0].text, /#1/);
	assert.match(replaced.content[0].text, /#2/);
	assert.match(replaced.content[0].text, /in_progress/);
	assert.match(replaced.content[0].text, /设计 schema/);

	const listed = await harness.execute({ action: "list" });
	assert.match(listed.content[0].text, /\[in_progress\] #1: 设计 schema/);
	assert.match(listed.content[0].text, /\[pending\] #2: 实现迁移/);
	assert.match(listed.content[0].text, /1 in progress/);
});

test("budget limits reject oversize text and more than 100 items without touching the plan", async () => {
	const harness = createHarness();
	await start(harness);
	await harness.execute({ action: "replace", items: [{ text: "保留事项" }] });
	harness.snapshots.length = 0;
	const beforeWidget = harness.widgets.get("pi-deck-todo");

	await assert.rejects(harness.execute({ action: "add", text: "x".repeat(1001) }), /exceeds 1000/);
	await assert.rejects(harness.execute({ action: "replace", items: [{ text: "x".repeat(1001) }] }), /exceeds 1000/);
	await assert.rejects(harness.execute({ action: "update", id: 1, text: "y".repeat(1001) }), /exceeds 1000/);
	await assert.rejects(harness.execute({ action: "replace", items: Array.from({ length: 101 }, (_, i) => ({ text: `item ${i}` })) }), /exceeds 100 items/);
	await assert.rejects(harness.execute({ action: "replace", items: [] }), /items required/);
	await assert.rejects(harness.execute({ action: "replace", items: [{ text: "   " }] }), /items\[0\]\.text required/);

	assert.equal(harness.snapshots.length, 0, "rejected mutations must not persist");
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), beforeWidget);
});

test("unknown action and illegal params reject without side effects", async () => {
	const harness = createHarness();
	await start(harness);
	await harness.execute({ action: "replace", items: [{ text: "任务" }] });
	harness.snapshots.length = 0;
	const beforeWidget = harness.widgets.get("pi-deck-todo");

	await assert.rejects(harness.execute({ action: "toggle", id: 1 }), /unknown action: toggle; valid actions: list, add, update, delete, replace, restore, clear/);
	await assert.rejects(harness.execute({ action: "done" }), /unknown action: done; valid actions: list, add, update, delete, replace, restore, clear/);
	await assert.rejects(harness.execute({ action: "delete" }), /id required for delete/);
	await assert.rejects(harness.execute({ action: "delete", id: 0 }), /positive safe integer/);
	await assert.rejects(harness.execute({ action: "delete", id: -3 }), /positive safe integer/);
	await assert.rejects(harness.execute({ action: "delete", id: "1" }), /positive safe integer/);
	await assert.rejects(harness.execute({ action: "update", status: "completed" }), /id required/);
	await assert.rejects(harness.execute({ action: "update", id: 999, status: "completed" }), /#999 not found; current ids: 1/);
	await assert.rejects(harness.execute({ action: "update", id: 1 }), /status or text/);
	await assert.rejects(harness.execute({ action: "update", id: 0, status: "pending" }), /positive safe integer/);
	await assert.rejects(harness.execute({ action: "update", id: 1, status: "bogus" }), /status/);
	await assert.rejects(harness.execute({ action: "update", id: 1, text: "   " }), /text required for update/);
	await assert.rejects(harness.execute({ action: "replace", items: [{ text: "x", done: true }] }), /done is not supported/);
	await assert.rejects(harness.execute({ action: "add", status: "completed" }), /text required for add/);
	await assert.rejects(harness.execute({ action: "restore" }), /no replaced plan/);

	assert.equal(harness.snapshots.length, 0);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), beforeWidget);
});

test("delete removes a single item, reports the deleted item and remaining count", async () => {
	const harness = createHarness();
	await start(harness);
	await harness.execute({
		action: "replace",
		items: [{ text: "任务A", status: "in_progress" }, { text: "任务B" }],
	});
	const deleted = await harness.execute({ action: "delete", id: 1 });
	assert.match(deleted.content[0].text, /Deleted todo #1: 任务A \(1 todo in plan\)/);
	const snapshot = harness.snapshots.at(-1).data;
	assert.deepEqual(snapshot.activePlan.todos, [{ id: 2, text: "任务B", status: "pending" }]);
	// 编号不回收：删除后 nextTodoId 继续单调
	assert.equal(snapshot.nextTodoId, 3);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:1]]", "☐ #2 任务B"]);

	const added = await harness.execute({ action: "add", text: "新任务" });
	assert.match(added.content[0].text, /Added todo #3/);
	assert.deepEqual(harness.snapshots.at(-1).data.activePlan.todos, [
		{ id: 2, text: "任务B", status: "pending" },
		{ id: 3, text: "新任务", status: "pending" },
	]);
});

test("delete with unknown id rejects with the current id list and persists nothing", async () => {
	const harness = createHarness();
	await start(harness);
	await harness.execute({
		action: "replace",
		items: [{ text: "任务A" }, { text: "任务B" }],
	});
	harness.snapshots.length = 0;
	const beforeWidget = harness.widgets.get("pi-deck-todo");
	await assert.rejects(harness.execute({ action: "delete", id: 99 }), /#99 not found; current ids: 1, 2/);
	assert.equal(harness.snapshots.length, 0, "failed delete must not persist");
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), beforeWidget);
});

test("delete id error truncates long id lists and points to call list", async () => {
	const harness = createHarness();
	await start(harness);
	await harness.execute({
		action: "replace",
		items: Array.from({ length: 12 }, (_, i) => ({ text: `事项${i + 1}` })),
	});
	await assert.rejects(harness.execute({ action: "delete", id: 999 }), (error) => {
		assert.match(error.message, /#999 not found; current ids: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …/);
		assert.match(error.message, /\(2 more; call list\)/);
		// 截断：第 11 项起不再逐项列出，避免无限拼接
		assert.doesNotMatch(error.message, /#11/);
		return true;
	});
});

test("deleting the last item ends the plan and restart keeps ids monotonic", async () => {
	const harness = createHarness([v3TodoEntry()]);
	await start(harness);
	const deleted = await harness.execute({ action: "delete", id: 1 });
	assert.match(deleted.content[0].text, /Deleted todo #1: 默认任务 \(0 todos in plan\)/);
	assert.equal(harness.widgets.has("pi-deck-todo"), false);

	// 零项不是一个有意义的活跃计划；结束计划，但计数器不能回收。
	const snapshot = harness.snapshots.at(-1).data;
	assert.equal(snapshot.activePlan, undefined);
	assert.equal(snapshot.nextPlanId, 2);
	assert.equal(snapshot.nextTodoId, 2);

	// 真实重启恢复后再新增，必须继续使用新计划和新任务编号。
	const restarted = createHarness([todoEntry(snapshot)]);
	await start(restarted);
	const added = await restarted.execute({ action: "add", text: "新任务" });
	assert.match(added.content[0].text, /Added todo #2/);
	assert.deepEqual(restarted.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:2]]", "☐ #2 新任务"]);
	assert.equal(restarted.snapshots.at(-1).data.activePlan.id, 2);
});

test("delete does not touch previousPlan; restore after delete brings back the pre-replace plan", async () => {
	const harness = createHarness([v3TodoEntry()]);
	await start(harness);
	// replace 把原计划（plan #1）推入 previousPlan 撤销槽
	await harness.execute({ action: "replace", items: [{ text: "替换计划" }] });
	assert.deepEqual(harness.snapshots.at(-1).data.previousPlan, {
		id: 1,
		todos: [{ id: 1, text: "默认任务", status: "pending" }],
	});
	// delete 不覆盖 previousPlan（撤销槽不动）
	await harness.execute({ action: "delete", id: 2 });
	assert.deepEqual(harness.snapshots.at(-1).data.previousPlan, {
		id: 1,
		todos: [{ id: 1, text: "默认任务", status: "pending" }],
	});
	// restore 恢复的是 replace 之前的计划，而不是删除后的空计划
	await harness.execute({ action: "restore" });
	assert.equal(harness.snapshots.at(-1).data.activePlan.id, 1);
	assert.deepEqual(harness.snapshots.at(-1).data.activePlan.todos, [{ id: 1, text: "默认任务", status: "pending" }]);
});

test("delete guidance is present in schema, description, guidelines and model brief", async () => {
	const ext = readFileSync(extensionPath, "utf8");
	// schema / description / snippet 统一含 delete
	assert.match(ext, /action: StringEnum\(VALID_TODO_ACTIONS\)/);
	assert.match(ext, /delete \(id, removing a single item\)/);
	assert.match(ext, /add \/ update \/ delete \/ replace/);
	// guidelines：完成一项立即 update completed / 不要的项 delete / 整表才 replace / 不确定先 list
	assert.match(ext, /action=update/);
	assert.match(ext, /status=completed/);
	assert.match(ext, /action=delete/);
	assert.match(ext, /action=replace/);
	assert.match(ext, /action=list first/);
	// 旧 toggle/done 契约不得回归
	assert.doesNotMatch(ext, /toggle/);
	assert.doesNotMatch(ext, /\.done/);
	// 新契约（零失效）：提醒不再每轮注入，delete 指引由压缩补注简报携带（同口径）
	assert.match(ext, /Remove one obsolete item with action=delete/);
});

test("add defaulting to pending, explicit statuses, and count suffix", async () => {
	const harness = createHarness();
	await start(harness);
	const added = await harness.execute({ action: "add", text: "继续事项" });
	assert.match(added.content[0].text, /Added todo #1: 继续事项 \(1 todo in plan\)/);
	const addedInProgress = await harness.execute({ action: "add", text: "并行进行", status: "in_progress" });
	assert.match(addedInProgress.content[0].text, /Added todo #2: 并行进行 \(2 todos in plan\)/);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:1]]", "☐ #1 继续事项", "◐ #2 并行进行"]);
	const snapshot = harness.snapshots.at(-1).data;
	assert.deepEqual(snapshot.activePlan.todos, [
		{ id: 1, text: "继续事项", status: "pending" },
		{ id: 2, text: "并行进行", status: "in_progress" },
	]);
});

test("restore swaps the latest superseded plan and clear is an explicit boundary", async () => {
	const harness = createHarness([
		todoEntry({
			version: 3,
			activePlan: { id: 8, todos: [{ id: 19, text: "原计划", status: "completed" }] },
			previousPlan: { id: 4, todos: [{ id: 5, text: "更早计划", status: "pending" }] },
			nextPlanId: 9,
			nextTodoId: 20,
		}),
	]);

	await start(harness);
	await harness.execute({ action: "replace", items: [{ text: "替换后的计划", status: "in_progress" }] });
	await harness.execute({ action: "restore" });
	const snapshot = harness.snapshots.at(-1).data;
	assert.equal(snapshot.activePlan.id, 8);
	assert.deepEqual(snapshot.activePlan.todos, [{ id: 19, text: "原计划", status: "completed" }]);
	assert.deepEqual(snapshot.previousPlan, {
		id: 9,
		todos: [{ id: 20, text: "替换后的计划", status: "in_progress" }],
	});
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:8]]", "☑ #19 原计划"]);

	// clear：移除计划与撤销槽，widget 与提醒全部消失
	await harness.execute({ action: "clear" });
	const clearedSnapshot = harness.snapshots.at(-1).data;
	assert.equal(clearedSnapshot.activePlan, undefined);
	assert.equal(clearedSnapshot.previousPlan, undefined);
	assert.equal(harness.widgets.has("pi-deck-todo"), false);
	const clearedContext = await harness.handlers.get("context")(
		{
			messages: [{ role: "custom", customType: "pi-deck-todo-context", content: "stale" }],
		},
		harness.context,
	);
	assert.deepEqual(clearedContext.messages, []);

	// 明确清空后 add 开启新计划，计数器延续
	await harness.execute({ action: "add", text: "清空后的新计划" });
	const addSnapshot = harness.snapshots.at(-1).data;
	assert.equal(addSnapshot.activePlan.id, 10);
	assert.equal(addSnapshot.nextPlanId, 11);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:10]]", "☐ #21 清空后的新计划"]);
});

test("widget identity uses the current branch without persisting UI scope", async () => {
	const harness = createHarness([
		todoEntry({
			version: 3,
			activePlan: { id: 7, todos: [{ id: 11, text: "两条分支都继承的计划", status: "in_progress" }] },
			nextPlanId: 8,
			nextTodoId: 12,
		}),
	]);

	await start(harness);
	harness.setLeafId("branch-b");
	await harness.execute({ action: "update", id: 11, status: "completed" });
	const snapshot = harness.snapshots.at(-1).data;
	assert.equal(snapshot.widgetScopeId, undefined);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-b:7]]", "☑ #11 两条分支都继承的计划"]);
});

test("session restoration reads the selected branch rather than all session entries", async () => {
	const harness = createHarness([
		todoEntry({
			version: 3,
			activePlan: { id: 1, todos: [{ id: 1, text: "选中分支", status: "pending" }] },
			nextPlanId: 2,
			nextTodoId: 2,
		}),
	]);
	harness.setAllEntries([
		todoEntry({
			version: 3,
			activePlan: { id: 9, todos: [{ id: 99, text: "其他分支", status: "in_progress" }] },
			nextPlanId: 10,
			nextTodoId: 100,
		}),
	]);

	await start(harness);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:1]]", "☐ #1 选中分支"]);
});

test("v3 snapshots roundtrip through persistence and restore without rewrite", async () => {
	const snapshotData = {
		version: 3,
		activePlan: {
			id: 5,
			todos: [
				{ id: 12, text: "进行中", status: "in_progress" },
				{ id: 13, text: "已完成", status: "completed" },
			],
		},
		previousPlan: { id: 4, todos: [{ id: 10, text: "旧计划", status: "pending" }] },
		nextPlanId: 6,
		nextTodoId: 14,
	};
	const harness = createHarness([todoEntry(snapshotData)]);
	await start(harness);

	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:5]]", "◐ #12 进行中", "☑ #13 已完成"]);
	assert.equal(harness.snapshots.length, 0, "restoring a v3 snapshot must not re-persist it");

	// 恢复后的分支上继续 update，计数器延续
	await harness.execute({ action: "update", id: 13, status: "in_progress" });
	assert.equal(harness.snapshots.at(-1).data.nextTodoId, 14);
	assert.equal(harness.snapshots.at(-1).data.nextPlanId, 6);
});

test("context injects nothing per-turn and strips legacy reminder copies", async () => {
	const harness = createHarness([v3TodoEntry()]);
	await start(harness);

	// 有活跃计划时 context 也不注入任何提醒（零失效设计：计划视图由最近一次
	// 变更的 toolResult 携带，见扩展文件头）
	const result = await harness.handlers.get("context")(
		{
			messages: [{ role: "user", content: "request" }],
		},
		harness.context,
	);
	assert.equal(result, undefined, "context must not inject per-turn reminders");

	// 状态变更后，历史里的旧提醒副本被防御性剥离（防降级混入），不追加新提醒
	await harness.execute({ action: "replace", items: [{ text: "新计划" }] });
	const refreshed = await harness.handlers.get("context")(
		{
			messages: [
				{ role: "custom", customType: "pi-deck-todo-context", content: "旧提醒 A" },
				{ role: "user", content: "request" },
				{ role: "custom", customType: "pi-deck-todo-context", content: "旧提醒 B" },
			],
		},
		harness.context,
	);
	assert.ok(refreshed, "legacy reminder copies must be stripped from context");
	assert.equal(refreshed.messages.length, 1);
	assert.deepEqual(refreshed.messages[0], { role: "user", content: "request" });
});

test("session_tree restores the selected branch and third-party ownership clears the built-in widget", async () => {
	const harness = createHarness([
		todoEntry({
			version: 3,
			activePlan: { id: 1, todos: [{ id: 1, text: "分支 A 的计划", status: "pending" }] },
			nextPlanId: 2,
			nextTodoId: 2,
		}),
	]);

	await start(harness);
	harness.setEntries([
		todoEntry({
			version: 3,
			activePlan: { id: 7, todos: [{ id: 22, text: "分支 B 的计划", status: "completed" }] },
			nextPlanId: 8,
			nextTodoId: 23,
		}),
	]);
	await harness.handlers.get("session_tree")({}, harness.context);
	assert.deepEqual(harness.widgets.get("pi-deck-todo"), ["[[pid:todo-plan:branch-root:7]]", "☑ #22 分支 B 的计划"]);

	harness.setTodoSourcePath("C:/extensions/third-party-todo.ts");
	const beforeStartResult = await reminder(harness);
	assert.equal(beforeStartResult, undefined);
	assert.equal(harness.widgets.has("pi-deck-todo"), false);
	const contextResult = await harness.handlers.get("context")(
		{
			messages: [{ role: "custom", customType: "pi-deck-todo-context", content: "stale" }],
		},
		harness.context,
	);
	assert.deepEqual(contextResult.messages, []);

	await harness.handlers.get("session_tree")({}, harness.context);
	assert.equal(harness.widgets.has("pi-deck-todo"), false);
	assert.equal(harness.snapshots.length, 0);
});

// ---------------------------------------------------------------------------
// 有限修正回归：上下文压缩恢复（P1）+ 模型可见正文截断（P3）
// ---------------------------------------------------------------------------

test("before_agent_start appends a persistent plan brief after compaction, idempotently", async () => {
	// 分支：v3 快照（计划可见标记）之后发生压缩 → 标记被摘要冲掉，需要补注
	const harness = createHarness([v3TodoEntry(), { type: "compaction" }]);
	await start(harness);

	const brief = await harness.handlers.get("before_agent_start")({}, harness.context);
	assert.ok(brief?.message, "post-compaction turn must append a persistent plan brief");
	assert.equal(brief.message.customType, "pi-deck-todo-brief");
	assert.equal(brief.message.display, false);
	assert.match(brief.message.content, /\[CURRENT TODO PLAN #1\]/);
	assert.match(brief.message.content, /\[pending\] #1: 默认任务/);

	// 补注自身写入新的可见性标记（appendEntry 进分支历史）→ 下轮判定幂等不重复
	const again = await harness.handlers.get("before_agent_start")({}, harness.context);
	assert.equal(again, undefined, "brief must be idempotent until the next compaction");
	const briefSnapshots = harness.snapshots.filter((snapshot) => snapshot.customType === "pi-deck-todo-brief");
	assert.equal(briefSnapshots.length, 1);

	// 无活跃计划时零注入
	await harness.execute({ action: "clear" });
	const noPlan = await harness.handlers.get("before_agent_start")({}, harness.context);
	assert.equal(noPlan, undefined, "no active plan must not append a brief");
	// clear 后回到无计划：context 同样零注入
	const clearedResult = await harness.handlers.get("context")(
		{
			messages: [{ role: "user", content: "request" }],
		},
		harness.context,
	);
	assert.equal(clearedResult, undefined);
});

test("formatTodoPlanModelText truncates the model-visible list at 30 with an explicit notice", () => {
	const { formatTodoPlanModelText } = getStateModule();
	const todos = Array.from({ length: 31 }, (_, i) => ({
		id: i + 1,
		text: `item ${i + 1}`,
		status: "pending",
	}));
	const text = formatTodoPlanModelText({ id: 1, todos });
	assert.match(text, /^Todo plan #1: 0 completed, 0 in progress, 31 pending \(31 items\)/);
	// 前 30 项完整可见
	assert.match(text, /\[pending\] #1: item 1/);
	assert.match(text, /\[pending\] #30: item 30/);
	// 第 31 项不进入模型可见正文，截断提示明确给出剩余数量
	assert.doesNotMatch(text, /\[pending\] #31: item 31/);
	assert.match(text, /… 1 more items \(output truncated\)/);
});
