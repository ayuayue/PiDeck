import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：入口拿到「未知空间」的 id 时，两个空间都要试。
 *
 * 事故（真机 2026-11-27，用户原话「我点击任何刻度，直接不跳转了」）：
 * `resolveJumpMessageIndex` 的签名从 `(messages, targetId)` 改成 `(messages, { messageId })` 后，
 * 调用点只能猜空间。而入口 id 可能正是 **entryId**（导轨来自目录，entryId 才是稳定身份）。
 *
 * ```
 * 目标 525018cf（entryId）  旧两趟 -> 1    新签名只传 messageId -> -1
 * controller 里 index = -1 -> jumpToMessage 静默 return -> 点了没反应
 * ```
 *
 * 反例（能红）：把 unknown 分支改成只 `return byMessage(target.id)`。
 */

const load = () => loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");

/** 真实形态：messageId 是投影 id，meta.entryId 是文件条目 id（8 位 hex）。 */
const messages = () => [
	{ id: "m-100", meta: { entryId: "509d3a49" } },
	{ id: "m-101", meta: { entryId: "525018cf" } },
	{ id: "m-102", meta: { entryId: "0ab3bdcb" } },
];

test("unknown + entryId 形态：必须命中（这就是「点任何刻度都不跳」的回归锁）", () => {
	const { resolveJumpMessageIndex } = load();
	assert.equal(resolveJumpMessageIndex(messages(), { kind: "unknown", id: "525018cf" }), 1, "入口拿到的 id 可能是 entryId；只按 messageId 找会给 -1，跳转静默失败");
});
test("同一数组原地追加后，新 entryId 也必须能被刻度定位", () => {
	const { resolveJumpMessageIndex } = load();
	const appended = messages();
	assert.equal(resolveJumpMessageIndex(appended, { kind: "entry", id: "entry-later" }), -1);
	appended.push({ id: "m-later", meta: { entryId: "entry-later" } });
	assert.equal(resolveJumpMessageIndex(appended, { kind: "unknown", id: "entry-later" }), 3);
});

test("unknown + messageId 形态：必须命中", () => {
	const { resolveJumpMessageIndex } = load();
	assert.equal(resolveJumpMessageIndex(messages(), { kind: "unknown", id: "m-101" }), 1);
});

test("unknown + 都没有：-1（不抛，不返回 0 冒充第一条）", () => {
	const { resolveJumpMessageIndex } = load();
	const got = resolveJumpMessageIndex(messages(), { kind: "unknown", id: "nope" });
	assert.equal(got, -1);
	assert.notEqual(got, 0);
});

test("显式 space 只认自己那一路：entry 空间不回答 messageId 的查询", () => {
	const { resolveJumpMessageIndex } = load();
	assert.equal(resolveJumpMessageIndex(messages(), { kind: "entry", id: "525018cf" }), 1);
	assert.equal(resolveJumpMessageIndex(messages(), { kind: "entry", id: "m-101" }), -1);
	assert.equal(resolveJumpMessageIndex(messages(), { kind: "message", id: "m-101" }), 1);
	assert.equal(resolveJumpMessageIndex(messages(), { kind: "message", id: "525018cf" }), -1);
});

test("空 id：-1（三个构造子都一样）", () => {
	const { resolveJumpMessageIndex } = load();
	for (const kind of ["message", "entry", "unknown"]) {
		assert.equal(resolveJumpMessageIndex(messages(), { kind, id: "" }), -1, kind);
	}
});
