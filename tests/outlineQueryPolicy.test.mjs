// 非 strict 的 deepEqual：返回值来自 vm 沙箱（另一个 realm），
// 原型不同，deepStrictEqual 会以「结构相同但不是同一个引用」判红。
import assert from "node:assert";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const { planOutlineQuery } = load("src/renderer/src/components/session/timeline/outlineQueryPolicy.ts");

test("空输入不出手：列表不动、不提示", () => {
	assert.deepEqual(planOutlineQuery("", 147), { kind: "none" });
	assert.deepEqual(planOutlineQuery("   ", 147), { kind: "none" });
	assert.deepEqual(planOutlineQuery("\t", 147), { kind: "none" });
});

test("范围内的条数 -> 跳到第 n 条（下标从 0 起）", () => {
	assert.deepEqual(planOutlineQuery("3", 147), { kind: "jump", index: 2 });
	assert.deepEqual(planOutlineQuery("147", 147), { kind: "jump", index: 146 });
	assert.deepEqual(planOutlineQuery("1", 147), { kind: "jump", index: 0 });
});

test("带空格的数字仍能跳：trim 先于判型", () => {
	// 回归靶子：先判类型再 trim 时这条会红。
	assert.deepEqual(planOutlineQuery(" 12 ", 147), { kind: "jump", index: 11 });
});

test("超范围数字判 invalid，不能退化成文字过滤", () => {
	// 回归靶子：两态实现会把 0 / 999 当成文字去过滤标题，用户只看到「命中 0 条」。
	assert.deepEqual(planOutlineQuery("0", 147), { kind: "invalid" });
	assert.deepEqual(planOutlineQuery("999", 147), { kind: "invalid" });
	assert.deepEqual(planOutlineQuery("999", 0), { kind: "invalid" });
});

test("负号与混字母按文字处理（不是「无效数字」）", () => {
	// "-1" 不是「输入了不存在的条数」，是「想搜 -1」，两者给用户的反馈不同。
	assert.deepEqual(planOutlineQuery("-1", 147), { kind: "filter", text: "-1" });
	assert.deepEqual(planOutlineQuery("12a", 147), { kind: "filter", text: "12a" });
});

test("全角数字当文字，不当数字 —— 口径固定，改之前先改这条测试", () => {
	// /^\d+$/ 只认 ASCII；Number("０") 是 NaN。刻意不 normalize：
	// 一旦 normalize，全角输入会突然变成「跳转」，而这条行为从没被要求过。
	assert.deepEqual(planOutlineQuery("０", 147), { kind: "filter", text: "０" });
	assert.deepEqual(planOutlineQuery("１２", 147), { kind: "filter", text: "１２" });
});

test("文字统一转小写，供 includes 过滤", () => {
	assert.deepEqual(planOutlineQuery("  PR  ", 147), { kind: "filter", text: "pr" });
	assert.deepEqual(planOutlineQuery("原神", 147), { kind: "filter", text: "原神" });
});
