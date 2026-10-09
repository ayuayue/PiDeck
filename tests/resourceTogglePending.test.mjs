import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { clearTogglePending, isTogglePending, markTogglePending, resolveToggleEnabled, settleTogglePending } = loadTsCommonJs("src/renderer/src/config/resourceTogglePending.ts");

test("乐观覆盖立刻生效：关闭动作的 false 也能盖住数据真值 true", () => {
	const pending = markTogglePending({}, "user:npm:demo", false);
	assert.equal(isTogglePending(pending, "user:npm:demo"), true);
	assert.equal(resolveToggleEnabled(pending, "user:npm:demo", true), false, "点关闭必须立刻显示为关闭");
});

test("未覆盖的行沿用数据真值", () => {
	const pending = markTogglePending({}, "user:npm:demo", true);
	assert.equal(isTogglePending(pending, "user:npm:other"), false);
	assert.equal(resolveToggleEnabled(pending, "user:npm:other", false), false);
	assert.equal(resolveToggleEnabled(pending, "user:npm:other", true), true);
});

test("清除覆盖即回滚到数据真值（失败路径不反向写盘）", () => {
	const pending = markTogglePending({}, "user:npm:demo", true);
	const cleared = clearTogglePending(pending, "user:npm:demo");
	assert.equal(isTogglePending(cleared, "user:npm:demo"), false);
	assert.equal(resolveToggleEnabled(cleared, "user:npm:demo", false), false, "刷新未拿到新值时回到真值，不留下假象");
});

test("重复标记同值 / 清除不存在的 key 返回原对象，避免多余重渲染", () => {
	const pending = markTogglePending({}, "a", true);
	assert.equal(markTogglePending(pending, "a", true), pending);
	assert.equal(clearTogglePending(pending, "missing"), pending);
});

test("多行各自独立：一行在开关中不影响另一行", () => {
	let pending = markTogglePending({}, "a", false);
	pending = markTogglePending(pending, "b", true);
	assert.equal(resolveToggleEnabled(pending, "a", true), false);
	assert.equal(resolveToggleEnabled(pending, "b", false), true);
	pending = clearTogglePending(pending, "a");
	assert.equal(resolveToggleEnabled(pending, "a", true), true, "清除后回到真值");
	assert.equal(resolveToggleEnabled(pending, "b", false), true, "另一行的覆盖不受影响");
});

test("原型链上的 key 不算覆盖（防 constructor/__proto__ 误判为进行中）", () => {
	assert.equal(isTogglePending({}, "constructor"), false);
	assert.equal(isTogglePending({}, "__proto__"), false);
	assert.equal(resolveToggleEnabled({}, "constructor", true), true);
});

test("结算：刷新还没落地（真值仍是旧值）时保留覆盖，避免开关弹回去", () => {
	const pending = markTogglePending({}, "user:npm:demo", true);
	assert.equal(settleTogglePending(pending, { "user:npm:demo": false }), pending, "真值未跟上必须保留覆盖");
});

test("结算：行真值变成目标值后清除覆盖", () => {
	const pending = markTogglePending({}, "user:npm:demo", true);
	const settled = settleTogglePending(pending, { "user:npm:demo": true });
	assert.equal(isTogglePending(settled, "user:npm:demo"), false);
	assert.equal(resolveToggleEnabled(settled, "user:npm:demo", false), false, "清除后显示数据真值");
});

test("结算：该行已从列表消失时一并清掉覆盖", () => {
	const pending = markTogglePending({}, "gone", true);
	assert.equal(isTogglePending(settleTogglePending(pending, {}), "gone"), false);
});

test("结算：只清已对齐的行，未对齐的继续保留", () => {
	let pending = markTogglePending({}, "a", true);
	pending = markTogglePending(pending, "b", false);
	const settled = settleTogglePending(pending, { a: true, b: true });
	assert.equal(isTogglePending(settled, "a"), false);
	assert.equal(isTogglePending(settled, "b"), true, "b 的真值还没变成目标值，覆盖要继续顶着");
	assert.equal(resolveToggleEnabled(settled, "b", true), false);
});
