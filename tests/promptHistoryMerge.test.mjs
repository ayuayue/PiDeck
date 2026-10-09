import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { extractUserPrompts, mergePromptHistory } = loadTsCommonJs("src/renderer/src/composerBehavior.ts");

// vm 沙箱 realm 的数组原型与宿主不同，deepStrictEqual 会因原型不等而失败，
// 统一转成宿主数组再比较（元素为字符串原始值，跨 realm 可直接比较）。
function hostArray(value) {
	return Array.from(value);
}

test("extractUserPrompts: only user messages with real text, newest first", () => {
	const messages = [
		{ role: "assistant", text: "回答" },
		{ role: "user", text: "第一条" },
		{ role: "user", text: "" },
		{ role: "user", text: "   " },
		{ role: "user", text: "!model" },
		{ role: "tool", text: "tool result" },
		{ role: "user", text: "第二条" },
	];
	assert.deepEqual(hostArray(extractUserPrompts(messages)), ["第二条", "第一条"]);
});

test("extractUserPrompts: trims whitespace and respects limit", () => {
	const messages = [
		{ role: "user", text: "  a  " },
		{ role: "user", text: "b" },
		{ role: "user", text: "c" },
	];
	assert.deepEqual(hostArray(extractUserPrompts(messages, 2)), ["c", "b"]);
	assert.deepEqual(hostArray(extractUserPrompts([], 2)), []);
});

test("mergePromptHistory: runtime prompts keep priority, session reversed and deduped", () => {
	// runtime 最新在前（recordPromptHistory 存储顺序）；session 按时间正序传入，反转后接续
	assert.deepEqual(hostArray(mergePromptHistory(["b", "a"], ["a", "c", "d"])), ["b", "a", "d", "c"]);
});

test("mergePromptHistory: covers unstarted agents (empty runtime) with session history", () => {
	// 未启动的 Agent：无本次运行发送记录，历史完全来自会话消息
	assert.deepEqual(hostArray(mergePromptHistory([], ["旧一", "旧二"])), ["旧二", "旧一"]);
});

test("mergePromptHistory: dedupes across runtime and session, keeps runtime copy", () => {
	assert.deepEqual(hostArray(mergePromptHistory(["x", "y"], ["y", "z", "x"])), ["x", "y", "z"]);
});

test("mergePromptHistory: respects limit across both sources", () => {
	// session 反转后最新在前：截断保留的应是各源里最新的条目
	assert.deepEqual(hostArray(mergePromptHistory(["1", "2"], ["3", "4", "5"], 3)), ["1", "2", "5"]);
});

test("promptHistoryRef 必须有会话级 LRU 上限（会话删除后发送历史无人清理，桌面进程长运行无界增长）", () => {
	const composer = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	// 每会话条目已有 50 条 slice 上限，但会话键数量无界：已删除的草稿/临时会话
	// 残留在模块外 ref 里永不释放。与 stickyEmptySessionIds / latestLoadBySession 同构。
	assert.match(composer, /PROMPT_HISTORY_SESSION_LRU_LIMIT = \d+/, "发送历史必须声明会话级 LRU 上限常量");
	assert.match(composer, /markPromptHistorySessionAccess\(/, "写入路径必须走 LRU 访问标记");
	assert.match(composer, /promptHistorySessionOrder\.keys\(\)\.next\(\)\.value/, "超限必须删最早访问的会话键");
});
