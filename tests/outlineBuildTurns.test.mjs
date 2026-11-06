import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 会话定位轴（右缘刻度）的条目规划：**只收用户提问**。
 *
 * 2026-11 真机反馈三连：
 *  1. 「显示的太多了，还是回复，只显示用户的消息吧」：此前是「一轮两条」（提问 + 最终回答），
 *     一轮占两根，最近 30 根的窗口只装得下十几轮。
 *  2. 「好几个助手的回复才隔着用户一个回复」：pi 一轮里每次调工具都是一条独立 assistant
 *     消息，按消息出刻度时一轮能冒出 4~9 根助手刻度。
 *  3. 「助手的思考不应该算」：投影层把 thinking 内联成 <thinking> 标签混进 text，
 *     按首行取标题时 53 条助手刻度的标题全部是思考内容。
 *
 * 现在一根刻度 = 一条用户提问，助手消息（含中间回复、thinking、工具调用）一律不进刻度，
 * 上面三个问题同源消失。断言的是 buildOutline 的行为，不是实现细节。
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

test("只收用户提问：助手回复、thinking、工具调用都不进刻度", () => {
	const items = buildOutline([
		message("user", "帮我改一下这个文件"),
		message("assistant", "<thinking>先看看文件</thinking>", { stopReason: "toolUse" }),
		message("assistant", "我先看看文件内容。", { stopReason: "toolUse" }),
		message("tool", "文件内容"),
		message("assistant", "<thinking>改这里</thinking>\n改好了，共 2 处。", { stopReason: "stop" }),
		message("user", "谢谢"),
		message("assistant", "不客气。", { stopReason: "stop" }),
	]);

	assert.deepEqual(roles(items), ["user", "user"]);
	assert.deepEqual(titles(items), ["帮我改一下这个文件", "谢谢"]);
});

test("无提问的后台唤醒回合不产生刻度", () => {
	const items = buildOutline([message("user", "跑一下"), message("assistant", "第一轮回答", { stopReason: "stop" }), message("assistant", "后台任务完成后的第二轮回答", { stopReason: "stop" })]);

	assert.deepEqual(roles(items), ["user"]);
	assert.deepEqual(titles(items), ["跑一下"]);
});

test("长会话的刻度条数 = 用户提问数", () => {
	const messages = [];
	for (let turn = 0; turn < 20; turn += 1) {
		messages.push(message("user", `第 ${turn} 个问题`));
		for (let step = 0; step < 4; step += 1) messages.push(message("assistant", `中间回复 ${step}`, { stopReason: "toolUse" }));
		messages.push(message("assistant", `第 ${turn} 个最终回答`, { stopReason: "stop" }));
	}

	const items = buildOutline(messages);
	assert.equal(items.length, 20);
	assert.ok(items.every((item) => item.role === "user"));
	assert.equal(items[0].title, "第 0 个问题");
	assert.equal(items[19].title, "第 19 个问题");
});

test("空标题的用户消息不产生刻度，entryId 供目录对齐", () => {
	const items = buildOutline([message("user", "   "), message("user", "有内容", { meta: { entryId: "e1" } })]);

	assert.equal(items.length, 1);
	assert.equal(items[0].title, "有内容");
	assert.equal(items[0].entryId, "e1");
});
