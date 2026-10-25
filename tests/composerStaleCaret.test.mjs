import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const typesSource = readFileSync("src/renderer/src/components/session/composer/types.ts", "utf8");
const editorSource = readFileSync("src/renderer/src/components/session/composer/useTipTapComposerEditor.ts", "utf8");
const controllerSource = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");

/**
 * 复现：点开一个从未点过的会话（草稿为空），在 composer 输入第一个字/粘贴/
 * 语音输入后，光标被重置到最前面。
 *
 * 本质：caretRef 是「即写即忘」的旁路通道，写方（控制器被动 effect）与读方
 * （编辑器 layout effect，只在 value 变化时重跑）之间没有配对约束。任何没有
 * 伴随对应 value 渲染的写入都会变成过期值，在下一次输入时被误消费——
 * 旧实现里 [sessionId] effect 写 `caretRef.current = draft.length`（本意是
 * 切会话后光标回文末），写入落在 layout pass 之后，等用户第一次输入触发
 * layout effect 时被消费，选区被重置回 draft.length；新会话 draft 为空，
 * 光标直接回到 0。
 *
 * 本质解法：契约升级为带归属的光标请求 { pos, forValue }，编辑器只在
 * forValue === value（光标与其所属文本同一次变更、同一趟 layout pass）时
 * 配对消费，不匹配的一律丢弃；外部同步（无配对请求）兜底恢复文末。
 */
test("caret contract is a value-bound request, not a bare offset", () => {
	assert.match(typesSource, /ComposerCaretRequest = \{ pos: number; forValue: string \}/);
	assert.match(typesSource, /caretRef\?: MutableRefObject<ComposerCaretRequest \| null>/);
});

test("editor consumes a caret request only when it belongs to the current value", () => {
	// 配对消费：请求的 forValue 必须等于本次渲染的 value，否则视为过期。
	assert.match(editorSource, /const caret = pending && pending\.forValue === value \? pending\.pos : null;/);
	// 过期请求必须丢弃而非保留，防止污染下一次输入。
	assert.match(editorSource, /if \(pending && caretRef && pending\.forValue !== value\) \{[\s\S]*?caretRef\.current = null;/);
});

test("external content sync restores caret to the end without a pending request", () => {
	// setContent 会把选区映射到旧文档的任意位置；外部同步（切换会话/草稿回填/
	// 发送清空）若没有配对光标请求，必须兜底恢复到文末，而不是把光标留在 0。
	assert.match(editorSource, /needsContentSync = value !== lastEmittedRef\.current;/);
	assert.match(editorSource, /else if \(needsContentSync\) \{[\s\S]*?setTextSelection\([\s\S]*?value\.length[\s\S]*?\}/);
});

test("controller writes tagged caret requests alongside the draft they belong to", () => {
	// 所有程序化写入必须带 forValue（与同 tick 的 setDraft 文本一致），
	// 不得再出现裸偏移写入。
	const taggedWrites = controllerSource.match(/caretRef\.current = \{ pos: [^}]+\};/g) ?? [];
	assert.ok(taggedWrites.length >= 6, `expected tagged caret writes, got ${taggedWrites.length}`);
	assert.doesNotMatch(controllerSource, /caretRef\.current = [a-zA-Z_][\w.]*(?!\{)/);
});

test("session-switch effect must not write a stale pending caret", () => {
	// 光标恢复由编辑器在内容同步时兜底完成；控制器 [sessionId] effect 再写
	// caretRef 只会留下一条无人消费的过期值，污染下一次输入的选区。
	assert.doesNotMatch(controllerSource, /caretRef\.current = draft\.length/);
});
