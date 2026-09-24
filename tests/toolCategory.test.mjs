import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 过程组活动类别归类（学 DSH process-activity 表）。
// 契约：精确名优先、`*_inspect` 后缀优先于前缀、带命名空间的未知名归 tools（不猜语义）、大小写归一小写。

const { toolActivityCategory, activityCountsFromToolNames, rankActivityCounts, topActivityKinds, activityCategoryLabelKey } = loadTsCommonJs(join(process.cwd(), "src/renderer/src/components/session/timeline/toolCategory.ts"));

// loadTsCommonJs 在独立 vm realm 里执行模块代码，返回的 Array/Object 原型不来自主 realm，
// assert/strict 的 deepStrictEqual 会因原型不同判不等。按仓库既有惯例先归一化成主 realm 普通值。
const plain = (value) => JSON.parse(JSON.stringify(value));

test("classifies exact built-in tool names into activity categories", () => {
	assert.equal(toolActivityCategory("read"), "read");
	assert.equal(toolActivityCategory("read_image"), "readImage");
	assert.equal(toolActivityCategory("write"), "write");
	assert.equal(toolActivityCategory("edit"), "edit");
	assert.equal(toolActivityCategory("multi_edit"), "edit");
	assert.equal(toolActivityCategory("apply_patch"), "edit");
	assert.equal(toolActivityCategory("bash"), "commands");
	assert.equal(toolActivityCategory("glob"), "search");
	assert.equal(toolActivityCategory("run_code"), "code");
	assert.equal(toolActivityCategory("web_search"), "webSearch");
	assert.equal(toolActivityCategory("web_fetch"), "webFetch");
	assert.equal(toolActivityCategory("todo_write"), "plan");
	assert.equal(toolActivityCategory("ask_user_question"), "questions");
});

test("web_search must not fall into the generic search category", () => {
	// 精确名表优先：`web_search` 归 webSearch，而不是被 search 规则吸走
	assert.equal(toolActivityCategory("web_search"), "webSearch");
	assert.equal(toolActivityCategory("grep"), "search");
});

test("inspect suffix wins over subagent prefix and terminal prefix", () => {
	// DSH 规则：`_inspect` 后缀先于 `subagent_` / `terminal_` 前缀命中
	assert.equal(toolActivityCategory("subagent_inspect"), "search");
	assert.equal(toolActivityCategory("terminal_inspect"), "search");
	assert.equal(toolActivityCategory("subagent_codex"), "subagents");
	assert.equal(toolActivityCategory("terminal_open"), "commands");
});

test("namespaced names fall back to tools while casing is normalized", () => {
	// 带命名空间 = 不是裸内置名 → 不猜，归 tools
	assert.equal(toolActivityCategory("mcp__fs__read"), "tools");
	assert.equal(toolActivityCategory("functions.read"), "tools");
	assert.equal(toolActivityCategory(""), "tools");
	assert.equal(toolActivityCategory("   "), "tools");
	// 纯大小写差异跟随 PiDeck 既有口径（toolIcon/getToolPhrase 都 toLowerCase）
	assert.equal(toolActivityCategory("Read"), "read");
	assert.equal(toolActivityCategory("BASH"), "commands");
});

test("counts tool calls per category and ranks by count then first appearance", () => {
	assert.deepEqual(plain(activityCountsFromToolNames(["read", "bash", "read"])), [
		{ kind: "read", count: 2 },
		{ kind: "commands", count: 1 },
	]);
	// 同次数保留成员顺序（read → commands），保证组头文字在流式增量时不来回跳
	assert.deepEqual(plain(activityCountsFromToolNames(["bash", "read"])), [
		{ kind: "commands", count: 1 },
		{ kind: "read", count: 1 },
	]);
	// 空名字不计
	assert.deepEqual(plain(activityCountsFromToolNames(["", "  "])), []);
});

test("rankActivityCounts is stable for equal counts", () => {
	assert.deepEqual(
		plain(
			rankActivityCounts([
				{ kind: "write", count: 1 },
				{ kind: "edit", count: 1 },
				{ kind: "read", count: 5 },
			]).map((entry) => entry.kind),
		),
		["read", "write", "edit"],
	);
});

test("topActivityKinds caps the header labels at three", () => {
	const counts = activityCountsFromToolNames(["read", "grep", "bash", "write"]);
	assert.equal(topActivityKinds(counts, 3).length, 3);
	assert.equal(topActivityKinds(counts, 3)[0], "read");
	assert.deepEqual(plain(topActivityKinds(activityCountsFromToolNames([]))), []);
});

test("label keys follow the running/done phase naming", () => {
	assert.equal(activityCategoryLabelKey("read", "done"), "timeline.processGroup.done.read");
	assert.equal(activityCategoryLabelKey("commands", "running"), "timeline.processGroup.running.commands");
});
