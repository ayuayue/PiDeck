import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 2026-09 缓存问题的两轮修复迭代，最终形态 = **零失效**设计：
// 1) 浮动尾提醒曾把中转站缓存冻结在 36,480 / 19,200（前缀在浮动插入点分歧，
//    中转站甚至不为该类提示写缓存条目）；
// 2) 固定早位修复了冻结，但计划每次变更（含状态勾选）重写提醒文本，缓存跌落
//    到提醒槽位边界 17,024（= 首部 developer 块结束处），每 3-7 轮一次；
// 3) 现在正常对话零注入：计划全文由最近一次变更的 toolResult 携带（append-only，
//    前缀缓存零影响，同 pi 官方示例 todo.ts 模式）；仅当压缩/分支摘要比最后一
//    次计划可见点更新时，before_agent_start 持久追加一条简报——该事件本身已使
//    缓存全部失效，补注零成本，且幂等、下次压缩后自愈。

function compile(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{ module, exports: module.exports, require: () => ({}), console },
		{ filename: filePath },
	);
	return module.exports;
}

const statePath = "resources/extensions/pi-deck-todo-state.ts";
const extPath = "resources/extensions/pi-deck-todo.ts";

function snapshotEntry(index) {
	return { type: "custom", customType: "pi-deck-todo", index };
}

function briefEntry(index) {
	return { type: "custom", customType: "pi-deck-todo-brief", index };
}

function compactionEntry(index) {
	return { type: "compaction", index };
}

test("todoBriefNeededAfterCompaction: no compaction means never re-inject", () => {
	const { todoBriefNeededAfterCompaction } = compile(statePath);
	// 没有任何压缩：计划视图由 toolResult 历史（append-only）携带，不补注
	assert.equal(todoBriefNeededAfterCompaction([snapshotEntry(0), { type: "message" }]), false);
	assert.equal(todoBriefNeededAfterCompaction([]), false);
});

test("todoBriefNeededAfterCompaction: compaction newer than last visibility marker", () => {
	const { todoBriefNeededAfterCompaction } = compile(statePath);
	// 压缩在最后一次快照之后：历史里的计划视图被摘要替换 → 需要补注
	assert.equal(todoBriefNeededAfterCompaction([snapshotEntry(0), compactionEntry(1)]), true);
	// 多次压缩，最后一次在标记之后 → 仍需补注
	assert.equal(
		todoBriefNeededAfterCompaction([snapshotEntry(0), compactionEntry(1), snapshotEntry(2), compactionEntry(3)]),
		true,
	);
});

test("todoBriefNeededAfterCompaction: visibility marker newer than compaction is sufficient", () => {
	const { todoBriefNeededAfterCompaction } = compile(statePath);
	// 压缩后发生过一次真实变更（快照在压缩条目之后）→ 该 toolResult 在保留区内
	assert.equal(todoBriefNeededAfterCompaction([compactionEntry(0), snapshotEntry(1)]), false);
	// 已补注过简报（标记在压缩之后）→ 幂等，不重复追加
	assert.equal(todoBriefNeededAfterCompaction([compactionEntry(0), briefEntry(1)]), false);
	assert.equal(
		todoBriefNeededAfterCompaction([compactionEntry(0), snapshotEntry(1), compactionEntry(2)]),
		true,
	);
});

test("todoBriefNeededAfterCompaction: branch_summary invalidates like compaction", () => {
	const { todoBriefNeededAfterCompaction } = compile(statePath);
	assert.equal(todoBriefNeededAfterCompaction([snapshotEntry(0), { type: "branch_summary", index: 1 }]), true);
});

test("todoBriefNeededAfterCompaction: tolerates non-record entries", () => {
	const { todoBriefNeededAfterCompaction } = compile(statePath);
	assert.equal(todoBriefNeededAfterCompaction([null, undefined, compactionEntry(2)]), true);
	assert.equal(todoBriefNeededAfterCompaction([null, snapshotEntry(1), compactionEntry(2)]), true);
});

test("todo extension no longer injects anything per model call", () => {
	const ext = readFileSync(extPath, "utf8");
	// 固定槽位注入形状必须彻底消失
	assert.doesNotMatch(ext, /todoReminderInsertIndex/);
	assert.doesNotMatch(ext, /messages\.slice\(0, insertAt\)/);
	// 末尾追加形状（...messages, {role:"custom"}）也必须不存在
	assert.doesNotMatch(ext, /\.\.\.messages,\s*\r?\n\s*\{\s*\r?\n\s*role: "custom" as const,/);
	// context handler 只做旧类型防御剥离与让位维护，不再构造注入消息
	const contextBlock = ext.match(/pi\.on\("context"[\s\S]*?\n\t\}\);/);
	assert.ok(contextBlock, "context handler should stay registered");
	assert.doesNotMatch(contextBlock[0], /formatTodoPlanModelText/);
});

test("todo extension carries the plan text in mutation tool results", () => {
	const ext = readFileSync(extPath, "utf8");
	// 变更后向 toolResult 附加计划全文（模型可见视图的唯一常态来源）
	assert.match(ext, /result\.changed && state\.activePlan/);
	assert.match(ext, /text \+= `\\n\\n\$\{formatTodoPlanModelText\(state\.activePlan\)\}`/);
	// replace 不再内嵌全文（由统一后缀附加，避免重复）
	assert.doesNotMatch(ext, /Replaced the current plan with \$\{result\.todoCount\} todos\\n\$\{/);
});

test("todo extension re-injects a persisted brief only after compaction", () => {
	const ext = readFileSync(extPath, "utf8");
	// before_agent_start 走压缩检测，且只在需要时返回持久 message
	assert.match(ext, /pi\.on\("before_agent_start"/);
	assert.match(ext, /todoBriefNeededAfterCompaction\(ctx\.sessionManager\.getBranch\(\)\)/);
	const briefBlock = ext.match(/pi\.on\("before_agent_start"[\s\S]*?\n\t\}\);/);
	assert.ok(briefBlock, "before_agent_start handler should be registered");
	assert.match(briefBlock[0], /TODO_BRIEF_ENTRY_TYPE/);
	assert.match(briefBlock[0], /planBriefContent\(state\.activePlan\)/);
	// 补注前必须有幂等标记（appendEntry），否则每轮重复追加
	assert.match(briefBlock[0], /pi\.appendEntry\(TODO_BRIEF_ENTRY_TYPE/);
	// 压缩后补注的「零缓存成本」理由必须留在注释里，防止后人改回每轮注入
	assert.match(ext, /零缓存成本|前缀缓存/);
	assert.match(ext, /36,480 \/ 19,200/);
	assert.match(ext, /17,024/);
});

test("state module stays dependency-free after adding the compaction helper", () => {
	const state = readFileSync(statePath, "utf8");
	assert.doesNotMatch(state, /from "@earendil-works\/pi/);
	assert.doesNotMatch(state, /from "typebox"/);
});
