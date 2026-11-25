import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// issue #310：同一轮含多条 assistant 消息（中间回复 A → 工具 → 最终回复 B）时，
// 编辑入口曾用聚合全部正文的 mergedText 当初值、却只写回末条 entry——原样保存会把
// A 重复写进 B，污染 JSONL 后续上下文。守护两层：
//   1) 纯函数语义：编辑目标 = 最后一条有可见正文的 assistant 消息，初值 = 目标自身正文；
//   2) TurnRow 源码契约：编辑初值不得来自 mergedText，保存/按钮显隐与加载同源。
// 正则全部空白容忍（AGENTS.md 门禁）。

const { visibleAssistantText, pickEditableAssistantMessage } = loadTsCommonJs("src/renderer/src/components/session/timeline/editableAnswerTarget.ts");
const turnRowSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
// 操作栏（复制/收藏/编辑/删除/耗时）2026-10 抽成 TurnRowActions：
// 「按钮长什么样」搬走了，「门槛与编辑目标同源」仍由 TurnRow 把关。
const actionsSource = readFileSync("src/renderer/src/components/session/turn/TurnRowActions.tsx", "utf8");

function assistantMessage(id, text) {
	return { kind: "message", message: { id, role: "assistant", text, entryId: `entry-${id}` } };
}

test("issue #310: 编辑目标选最后一条有可见正文的 assistant 消息（跳过 thinking-only 尾巴）", () => {
	const interim = assistantMessage("a1", "A: interim answer");
	const final = assistantMessage("a2", "B: final answer");
	// A → 工具 → B 的轮：工具项已在 TurnRow 侧过滤，这里只喂 assistant 序列
	assert.equal(pickEditableAssistantMessage([interim, final])?.message.id, "a2");
	// 末条 thinking-only（无可见正文）时回退到更早的正文消息
	const thinkingOnlyTail = assistantMessage("a3", "<thinking>reasoning</thinking>");
	assert.equal(pickEditableAssistantMessage([interim, final, thinkingOnlyTail])?.message.id, "a2");
	// 整轮没有可见正文 → 无编辑目标（按钮随之隐藏）
	assert.equal(pickEditableAssistantMessage([thinkingOnlyTail]), null);
	assert.equal(pickEditableAssistantMessage([]), null);
});

test("issue #310: 编辑初值 = 目标消息自身正文，原样保存不再产生 A+B 重复", () => {
	const interim = assistantMessage("a1", "A: interim answer");
	const final = assistantMessage("a2", "B: final answer");
	const target = pickEditableAssistantMessage([interim, final]);
	// startEditing 的初值来源：目标消息可见正文，而不是聚合文本 "A: interim answer\n\nB: final answer"
	const initialEditText = visibleAssistantText(target?.message.text ?? "");
	assert.equal(initialEditText, "B: final answer");
	assert.notEqual(initialEditText, [interim, final].map((item) => visibleAssistantText(item.message.text)).join("\n\n"));
	// 保存目标与初值是同一条消息（saveEdit 写 editableMessage 的 messageId/entryId）
	assert.equal(target?.message.id, "a2");
	assert.equal(target?.message.entryId, "entry-a2");
});

test("visibleAssistantText 剥内联 thinking 标签并收两端空白", () => {
	assert.equal(visibleAssistantText("<thinking>plan</thinking>Hello"), "Hello");
	assert.equal(visibleAssistantText("  <thinking>plan</thinking>\nWorld  "), "World");
	assert.equal(visibleAssistantText("plain"), "plain");
	assert.equal(visibleAssistantText("<thinking>only</thinking>"), "");
});

test("issue #310 源码契约：TurnRow 编辑初值不得来自 mergedText，保存与加载同源", () => {
	// 初值：来自 visibleAssistantText(editableMessage...)，setEditText(mergedText) 永不回归
	assert.doesNotMatch(turnRowSource, /setEditText\(\s*mergedText\s*\)/);
	assert.match(turnRowSource, /setEditText\(\s*visibleAssistantText\(editableMessage\?\.message\.text\s*\?\?\s*""\)\s*\)/);
	// 保存：整个 editableMessage 传给 hook（fork 化编辑需要 text/images/meta 解析 fork 锚点），
	// 加载/保存同源，不再取 at(-1)
	const saveEditBlock = turnRowSource.slice(turnRowSource.indexOf("const saveEdit"), turnRowSource.indexOf("const deleteMessage"));
	assert.ok(saveEditBlock.length > 0, "saveEdit block must exist");
	assert.match(saveEditBlock, /props\.onEditMessage\(\s*editableMessage\.message,\s*editText\s*\)/);
	assert.doesNotMatch(saveEditBlock, /assistantMessages\.at\(-1\)/);
	// 编辑按钮显隐门槛与编辑目标同源（delete 仍按末条删整轮，不在此约束内）
	// 编辑门槛由 TurnRow 计算后以 onStartEdit 传给操作栏：门槛表达式必须与编辑目标同源
	// （editableMessage），不能退回「末条 assistant 消息」——那是 issue #310 的原始病症。
	// 起点锚 onStartEdit={! ：TurnRow 里 FinalAnswer 也有同名 prop（onStartEdit={startEditing}），
	// 只写 onStartEdit={ 会从常驻区开始切，覆盖面变成一大段无关代码。
	const editGate = turnRowSource.slice(turnRowSource.indexOf("onStartEdit={!"), turnRowSource.indexOf("onDeleteReply={"));
	assert.ok(editGate.length > 0, "edit button gate must exist");
	assert.match(editGate, /editableMessage\?\.message\.id/);
	assert.doesNotMatch(editGate, /assistantMessages\.at\(-1\)/);
	// 复制入口的正文口径是 replyText（最终回答，没有时回退整轮聚合，见 #601），
	// 与编辑初值仍然隔离：编辑走 editableMessage，复制/收藏走 replyText。
	assert.match(actionsSource, /markdown=\{props\.replyText\}/);
	assert.doesNotMatch(actionsSource, /markdown=\{props\.mergedText\}/);
	// 正文口径（#601）：有最终回答就只给最终回答，缺失（中断轮/纯工具轮）才回退整轮聚合
	assert.match(turnRowSource, /const replyText = finalText \|\| mergedText;/);
});
