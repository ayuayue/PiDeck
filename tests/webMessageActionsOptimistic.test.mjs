import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * Web 端消息编辑/删除乐观更新的两道闸：
 * 1) 纯函数行为——replaceMessageTextOptimistic / removeMessageOptimistic 必须与
 *    SessionFileEditor 的终态语义一致（编辑只换文本 part 不截断；删除只摘目标一条）。
 * 2) 接线契约——WebChatApp 必须先乐观落地再 await 服务端（否则「过好久才刷新」回归），
 *    WebTimeline 必须把 pending/exiting/flash 传到气泡，web.css 必须有对应动画类。
 */

const load = createTsSandbox();
const { replaceMessageTextOptimistic, removeMessageOptimistic } = load("src/renderer/src/web/webMessageOptimistic.ts");

const textPart = (text) => ({ type: "text", text });
const userMessage = (id, text) => ({ id, role: "user", parts: [textPart(text)] });
const assistantMessage = (id, text) => ({ id, role: "assistant", parts: [textPart(text)] });

test("replaceMessageTextOptimistic 替换 user 消息的首个文本 part，其余消息原样", () => {
	const messages = [userMessage("u1", "old question"), assistantMessage("a1", "answer")];
	const next = replaceMessageTextOptimistic(messages, "u1", "new question");
	assert.notEqual(next, messages);
	assert.equal(next[0].parts[0].text, "new question");
	assert.equal(next[1].parts[0].text, "answer");
	// 不截断后续消息（与 SessionFileEditor.setMessageText 语义一致）
	assert.equal(next.length, 2);
});

test("replaceMessageTextOptimistic 替换 assistant 消息的最后一个 text part（思考/工具 part 不动）", () => {
	const message = {
		id: "a1",
		role: "assistant",
		parts: [{ type: "reasoning", text: "thinking" }, { type: "tool-bash", state: "output-available" }, textPart("draft"), textPart("final answer")],
	};
	const next = replaceMessageTextOptimistic([message], "a1", "edited answer");
	const parts = next[0].parts;
	assert.equal(parts[0].text, "thinking");
	assert.equal(parts[1].type, "tool-bash");
	assert.equal(parts[2].text, "draft");
	assert.equal(parts[3].text, "edited answer");
});

test("replaceMessageTextOptimistic 找不到目标或目标无文本 part 时原样返回", () => {
	const messages = [userMessage("u1", "text")];
	assert.equal(replaceMessageTextOptimistic(messages, "missing", "x"), messages);
	const noText = [{ id: "u2", role: "user", parts: [{ type: "file", url: "data:image/png;base64,x" }] }];
	assert.equal(replaceMessageTextOptimistic(noText, "u2", "x"), noText);
});

test("removeMessageOptimistic 只摘目标一条，后续回复保留（墓碑 reparent 语义）", () => {
	const messages = [userMessage("u1", "q1"), assistantMessage("a1", "a1"), userMessage("u2", "q2"), assistantMessage("a2", "a2")];
	const next = removeMessageOptimistic(messages, "u2");
	// vm 沙箱 realm 的数组原型与测试 realm 不同，deepStrictEqual 会误红，用 join 比较
	assert.equal(next.map((message) => message.id).join(","), "u1,a1,a2");
	assert.equal(removeMessageOptimistic(messages, "missing"), messages);
});

test("接线契约：WebChatApp 先乐观落地再 await 服务端，删除先播退场动画", () => {
	const source = readFileSync(new URL("../src/renderer/src/web/WebChatApp.tsx", import.meta.url), "utf8");
	const editApply = source.indexOf("replaceMessageTextOptimistic(messages, messageId, newText)");
	const editAwait = source.indexOf("await editRuntimeMessage(");
	assert.ok(editApply > 0 && editAwait > 0 && editApply < editAwait, "编辑必须先乐观替换文本，再 await editRuntimeMessage");
	const exitMark = source.indexOf("setExitingMessageIds(new Set([messageId]))");
	const deleteApply = source.indexOf("removeMessageOptimistic(messages, messageId)");
	const deleteAwait = source.indexOf("await deleteRuntimeMessage(");
	assert.ok(exitMark > 0 && deleteApply > 0 && deleteAwait > 0, "删除必须标记退场 + 乐观移除 + await 服务端");
	assert.ok(exitMark < deleteApply && deleteApply < deleteAwait, "删除顺序必须是：退场动画 → 本地摘除 → await deleteRuntimeMessage");
	// 失败路径必须回滚到服务端真相（reloadActiveHistory 在 catch 内）
	const editCatch = source.indexOf("await reloadActiveHistory();\n\t\t\tsetCommandError", editAwait);
	assert.ok(editCatch > 0, "编辑失败必须先 reloadActiveHistory 回滚再报错");
});

test("接线契约：WebTimeline 下传 pending/exiting/flash，气泡渲染状态指示", () => {
	const source = readFileSync(new URL("../src/renderer/src/web/WebTimeline.tsx", import.meta.url), "utf8");
	assert.match(source, /pendingAction=\{props\.pendingMessageAction\?\.id === entry\.message\.id/);
	assert.match(source, /flash=\{props\.flashMessageId === entry\.message\.id\}/);
	assert.match(source, /"web-msg-exiting"/);
	assert.match(source, /t\("web\.msgSaving"\)/);
	assert.match(source, /t\("web\.msgDeleting"\)/);
	// 动画中的条目不可再交互
	const css = readFileSync(new URL("../src/renderer/src/web/web.css", import.meta.url), "utf8");
	assert.match(css, /@keyframes\s+web-msg-exit/);
	assert.match(css, /@keyframes\s+web-msg-flash-ring/);
	assert.match(css, /\.web-app\s+\.web-msg-exiting\s*\{[^}]*pointer-events:\s*none/s);
});

test("接线契约：pending 文案双语齐备", () => {
	const zh = readFileSync(new URL("../src/renderer/src/i18n/rendererCopy.zh-CN.ts", import.meta.url), "utf8");
	const en = readFileSync(new URL("../src/renderer/src/i18n/rendererCopy.en-US.ts", import.meta.url), "utf8");
	for (const key of ['"web.msgSaving"', '"web.msgDeleting"']) {
		assert.ok(zh.includes(key), `zh-CN 缺 ${key}`);
		assert.ok(en.includes(key), `en-US 缺 ${key}`);
	}
});
