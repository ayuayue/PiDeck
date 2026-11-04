import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 会话定位轴（右缘刻度）的条目规划：**一轮两条** —— 用户提问一条、本轮最终回答一条。
 *
 * 回归 2026-11 真机反馈两条：
 *  1. 「好几个助手的回复才隔着用户一个回复」：pi 一轮里每次调工具都是一条独立 assistant
 *     消息，按消息出刻度时一轮能冒出 4~9 根助手刻度，最近 30 根的窗口只装得下五六轮。
 *  2. 「助手的思考不应该算」：投影层把 thinking 内联成 <thinking> 标签混进 text，
 *     按首行取标题时 53 条助手刻度的标题全部是思考内容。
 *
 * 断言的是 buildOutline 的行为，不是实现细节：中间回复 / thinking-only 不产生刻度，
 * 最终回答的标题必须是可见正文。
 */

const { buildOutline } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");

let seq = 0;
function message(role, text, extra = {}) {
	seq += 1;
	return { id: `m${seq}`, agentId: "agent", role, text, timestamp: seq, ...extra };
}

// vm 沙箱里的数组原型与测试进程不同：先摊平到本 realm 再比较。
const roles = (items) => Array.from(items, (item) => item.role);
const titles = (items) => Array.from(items, (item) => item.title);

test("一轮多条助手消息只留最终回答（中间回复不进刻度）", () => {
	const items = buildOutline([
		message("user", "帮我改一下这个文件"),
		message("assistant", "<thinking>先看看文件</thinking>", { stopReason: "toolUse" }),
		message("assistant", "我先看看文件内容。", { stopReason: "toolUse" }),
		message("assistant", "<thinking>改这里</thinking>\n改好了，共 2 处。", { stopReason: "stop" }),
		message("user", "谢谢"),
		message("assistant", "不客气。", { stopReason: "stop" }),
	]);

	assert.deepEqual(roles(items), ["user", "assistant", "user", "assistant"]);
	assert.deepEqual(titles(items), ["帮我改一下这个文件", "改好了，共 2 处。", "谢谢", "不客气。"]);
});

test("thinking-only 消息不进刻度，思考内容也不会变成标题", () => {
	const items = buildOutline([message("user", "问题"), message("assistant", "<thinking>让我想想</thinking>", { stopReason: "toolUse" }), message("assistant", "<thinking>再想想</thinking>\n\n真正的回答", { stopReason: "stop" })]);

	assert.deepEqual(roles(items), ["user", "assistant"]);
	assert.equal(items[1].title, "真正的回答");
	assert.ok(items.every((item) => !item.title.includes("<thinking>")));
});

test("流式占位（空正文 pending）不进刻度", () => {
	const items = buildOutline([message("user", "问题"), message("assistant", "", { stopReason: "pending" })]);
	assert.deepEqual(roles(items), ["user"]);
});

test("无提问的新回合（后台子代理唤醒）单独成一条刻度", () => {
	const items = buildOutline([message("user", "跑一下"), message("assistant", "第一轮回答", { stopReason: "stop" }), message("assistant", "后台任务完成后的第二轮回答", { stopReason: "stop" })]);

	assert.deepEqual(roles(items), ["user", "assistant", "assistant"]);
	assert.deepEqual(titles(items), ["跑一下", "第一轮回答", "后台任务完成后的第二轮回答"]);
});

test("长会话的刻度条数 = 用户提问数 + 有回答的轮数", () => {
	const messages = [];
	for (let turn = 0; turn < 20; turn += 1) {
		messages.push(message("user", `第 ${turn} 个问题`));
		for (let step = 0; step < 4; step += 1) messages.push(message("assistant", `中间回复 ${step}`, { stopReason: "toolUse" }));
		messages.push(message("assistant", `第 ${turn} 个最终回答`, { stopReason: "stop" }));
	}

	const items = buildOutline(messages);
	assert.equal(items.length, 40);
	assert.equal(items.filter((item) => item.role === "user").length, 20);
	assert.equal(items.filter((item) => item.role === "assistant").length, 20);
	assert.equal(items[1].title, "第 0 个最终回答");
});
