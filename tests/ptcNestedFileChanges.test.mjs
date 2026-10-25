import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * PTC（run_code 单工具模式）的「本轮修改的文件」链路。
 *
 * 背景（用户反馈 2026-10）：preset 走 PTC 后模型只调 run_code，write/edit 发生在
 * 程序内部（DSH 只落 `tool/ptc-dispatch` 事件），顶层没有 write/edit 工具卡：
 * - 主进程对 DSH 后端固定返回 []（无 pi 会话文件可读）；
 * - 渲染层按 toolName=write/edit… 从消息收集 → run_code 不匹配。
 * 于是 composer 上方横栏与右侧「修改文件」面板恒空。
 *
 * 修复：投影器把文件类子调用投影成**隐藏**工具消息（meta.ptcNested）——
 * 时间线分组跳过（只显示外层 run_code 卡），文件汇总照常按 toolName + 实参命中。
 */

const { projectDshEvent } = loadTsCommonJs("src/main/dsh/dshEventProjector.ts");
const { groupToolMessages } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");
const { collectRunFileChanges } = loadTsCommonJs("src/renderer/src/components/session/TimelineFormat.ts");

/**
 * 取「轮末 chip 行」实际使用的文件清单（本测试的断言必须走这条真实链路）。
 *
 * 不要再拿 collectLatestTurnFileChanges 测：它按「最后一个 user 消息」切轮，是已下线的
 * 横栏时代的取数函数，与现在 chip 行使用的 collectRunFileChanges（按 run 聚合、
 * 并合并 hiddenFileMessages）不是同一条链路——用它会把 PTC 的回归测成绿的。
 */
function lastRunFiles(messages) {
	const runs = Array.from(groupToolMessages(Array.from(messages))).filter((item) => item.kind === "agent-run");
	return runs.length > 0 ? Array.from(collectRunFileChanges(runs[runs.length - 1])) : [];
}
const AGENT = "dsh:session-ptc";

/** 构造 SessionEvent：{ type, seq, time, data }（与 DSH 实测形状一致）。 */
const event = (type, seq, data = {}) => ({ type, seq, time: 1700000000000 + seq, data });

/** 实测的 dispatch 形状：arguments 是对象，subCallId = <run_code callId>:ptc:<n>。 */
function dispatchEvent(seq, name, args, extra = {}) {
	return event("tool/ptc-dispatch", seq, {
		rootCallId: "rc-1",
		parentCallId: "rc-1",
		subCallId: `rc-1:ptc:${seq}`,
		name,
		arguments: args,
		...extra,
	});
}

function projectAll(events) {
	return events.reduce((prev, item) => projectDshEvent(prev, item, AGENT), undefined);
}

test("write 子调用投影为隐藏工具消息（meta.ptcNested，含 file_path/content 实参）", () => {
	const p = projectAll([dispatchEvent(1, "write", { file_path: "D:\\repo\\a.md", content: "hello\n" })]);
	const message = Array.from(p.messages).find((item) => item.meta?.ptcNested === true);
	assert.ok(message, "文件类子调用必须投影出隐藏消息");
	assert.equal(message.id, "dsh:ptc:rc-1:ptc:1");
	assert.equal(message.role, "tool");
	assert.equal(message.text, "write");
	assert.equal(message.meta.toolName, "write");
	assert.equal(message.meta.status, "done");
	// 实参原样带过去：文件汇总的路径/diff 判定直接读 meta.args
	assert.deepEqual({ ...message.meta.args }, { file_path: "D:\\repo\\a.md", content: "hello\n" });
	assert.equal(p.messagesChanged, true);
});

test("edit 子调用带 old_string/new_string，isError 时 status=error", () => {
	const p = projectAll([dispatchEvent(1, "edit", { file_path: "a.md", old_string: "old", new_string: "new" }), dispatchEvent(2, "edit", { file_path: "b.md", old_string: "x", new_string: "y" }, { isError: true })]);
	const messages = Array.from(p.messages).filter((item) => item.meta?.ptcNested === true);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].meta.status, "done");
	assert.equal(messages[0].meta.ptcParentCallId, "rc-1");
	assert.equal(messages[1].meta.status, "error");
	assert.equal(messages[1].meta.args.old_string, "x");
});

test("非文件类子调用与 -start 事件都不投影（read/grep/pwsh、tool/ptc-dispatch-start）", () => {
	const p = projectAll([dispatchEvent(1, "read", { file_path: "a.md" }), dispatchEvent(2, "grep", { pattern: "foo" }), dispatchEvent(3, "pwsh", { command: "ls" }), event("tool/ptc-dispatch-start", 4, { subCallId: "rc-1:ptc:4", name: "write", arguments: { file_path: "a.md" } })]);
	assert.equal(Array.from(p.messages).length, 0, "只有文件修改类**完成态**子调用才投影");
});

test("没有路径的文件类子调用不投影（避免留下无主隐藏卡）", () => {
	const p = projectAll([dispatchEvent(1, "write", { content: "no path" })]);
	assert.equal(Array.from(p.messages).length, 0);
});

test("journal 重放不重复投影（同 subCallId 幂等）", () => {
	const e = dispatchEvent(1, "write", { file_path: "a.md", content: "x" });
	const p = projectAll([e, e, e]);
	assert.equal(Array.from(p.messages).filter((item) => item.meta?.ptcNested === true).length, 1);
});

test("时间线分组跳过隐藏消息：一轮 PTC 只保留外层 run_code 卡", () => {
	const p = projectAll([
		event("user/message", 1, { content: [{ type: "text", text: "改一下这两个文件" }] }),
		event("tool/call", 2, { toolName: "run_code", callId: "rc-1", arguments: "{}" }),
		dispatchEvent(3, "write", { file_path: "a.md", content: "hello\n" }),
		dispatchEvent(4, "edit", { file_path: "b.md", old_string: "old", new_string: "new" }),
		event("tool/result", 5, { message: { toolCallId: "rc-1", content: [{ type: "text", text: "done" }], isError: false } }),
	]);
	// user 消息自成一条 RenderMessage，agent-run 是它后面的那条
	const runs = Array.from(groupToolMessages(Array.from(p.messages)));
	assert.equal(runs.length, 2);
	const run = runs.find((item) => item.kind === "agent-run");
	assert.ok(run, "本轮必须成组为 agent-run");
	const toolGroups = Array.from(run.items).filter((item) => item.kind === "tool-group");
	assert.equal(toolGroups.length, 1, "嵌套子调用不得自成工具组");
	const shown = Array.from(toolGroups[0].messages).map((item) => item.meta?.toolName);
	assert.deepEqual(shown, ["run_code"], "时间线只显示外层 run_code 卡");
});

test("文件汇总命中嵌套子调用：本轮 write/edit 的路径与 diff 都拿得到", () => {
	const p = projectAll([
		event("user/message", 1, { content: [{ type: "text", text: "改一下这两个文件" }] }),
		event("tool/call", 2, { toolName: "run_code", callId: "rc-1", arguments: "{}" }),
		dispatchEvent(3, "write", { file_path: "D:\\repo\\a.md", content: "hello\n" }),
		dispatchEvent(4, "edit", { file_path: "D:\\repo\\b.md", old_string: "old", new_string: "new" }),
		event("tool/result", 5, { message: { toolCallId: "rc-1", content: [{ type: "text", text: "done" }], isError: false } }),
	]);
	const entries = lastRunFiles(p.messages);
	assert.deepEqual(
		entries.map((entry) => entry.path),
		["D:\\repo\\a.md", "D:\\repo\\b.md"],
	);
	// write：新内容即原文；edit：只存变动区域（与 pi 会话同口径）
	assert.equal(entries[0].content, "hello\n");
	assert.equal(entries[0].originalContent, "");
	assert.equal(entries[1].originalContent, "old");
	assert.equal(entries[1].content, "new");
});

test("上一轮的嵌套修改不串到本轮（两轮各自独立聚合）", () => {
	const p = projectAll([event("user/message", 1, { content: [{ type: "text", text: "第一轮" }] }), dispatchEvent(2, "write", { file_path: "old.md", content: "old\n" }), event("user/message", 3, { content: [{ type: "text", text: "第二轮" }] }), dispatchEvent(4, "write", { file_path: "new.md", content: "new\n" })]);
	const runs = Array.from(groupToolMessages(Array.from(p.messages))).filter((item) => item.kind === "agent-run");
	assert.equal(runs.length, 2, "两轮应各自成组");
	assert.deepEqual(
		Array.from(collectRunFileChanges(runs[0])).map((entry) => entry.path),
		["old.md"],
	);
	assert.deepEqual(
		lastRunFiles(p.messages).map((entry) => entry.path),
		["new.md"],
	);
});
