import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 行菜单关闭后的焦点归还判定（见 utils/menuFocusReturn.ts）。
 *
 * 修的真实缺陷：Radix 的坐标菜单没有真实 Trigger，默认关闭动作会把焦点还给那个
 * 0×0、`aria-hidden` 的占位触发器 —— 实测等于把焦点丢在不可见元素上，键盘用户
 * 按 Esc 后 Tab 从文档头开始。
 */
const { shouldRestoreMenuFocus } = loadTsCommonJs("src/renderer/src/utils/menuFocusReturn.ts");

function opener({ connected = true } = {}) {
	return {
		isConnected: connected,
		focused: 0,
		focus() {
			this.focused += 1;
		},
	};
}

function element(menuRole) {
	return { tagName: "DIV", closest: (selector) => (menuRole && selector === '[role="menu"]' ? { tag: "menu" } : null) };
}

function body() {
	return { tagName: "BODY", closest: () => null };
}

test("opener 还挂在文档里时把焦点还给它", () => {
	const row = opener();
	assert.equal(shouldRestoreMenuFocus({ opener: row, activeElement: element(true) }), true);
});

test("opener 已被卸载（远端树刷新）时不聚焦空元素", () => {
	assert.equal(shouldRestoreMenuFocus({ opener: opener({ connected: false }), activeElement: element(true) }), false);
});

test("没有记录到 opener 时不动焦点", () => {
	assert.equal(shouldRestoreMenuFocus({ opener: null, activeElement: element(true) }), false);
});

test("关闭瞬间焦点已经离开文档（activeElement 为 null）时仍还给 opener", () => {
	assert.equal(shouldRestoreMenuFocus({ opener: opener(), activeElement: null }), true);
});

test("Radix 把焦点还给已卸载的隐藏触发器后落在 body，仍还给 opener", () => {
	assert.equal(shouldRestoreMenuFocus({ opener: opener(), activeElement: body() }), true);
});

test("焦点被对话框等新目标接管时不抢回来", () => {
	assert.equal(shouldRestoreMenuFocus({ opener: opener(), activeElement: element(false) }), false);
});

test("activeElement 没有 closest（非元素）时按已接管处理", () => {
	assert.equal(shouldRestoreMenuFocus({ opener: opener(), activeElement: {} }), false);
});
