import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 终端设置归一化回归测试。
 *
 * 背景：settings.json 落盘无类型，旧版本升级/手工编辑可能给终端字段塞任意脏值；
 * xterm 对 scrollback/fontSize 等字段非法值会直接抛错。SettingsStore 在 load 与
 * patch 两条路径都走同一组白名单/钳制纯函数，这里锁住它们的行为。
 */
function loadSettingsStore() {
	const electronStub = {
		app: { getPath: () => process.env.TEMP ?? ".", getLocale: () => "zh-CN", on: () => {}, getVersion: () => "0.0.0", isReady: () => true, whenReady: () => Promise.resolve() },
		BrowserWindow: class {},
		Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
	};
	return loadTsCommonJs("src/main/settings/SettingsStore.ts", { stubs: { electron: electronStub } });
}

test("clampNumber：非有限数回落默认，有限数钳到区间并取整", () => {
	const { clampNumber } = loadSettingsStore();
	assert.equal(clampNumber(undefined, 0, 10, 5), 5);
	assert.equal(clampNumber("x", 0, 10, 5), 5);
	assert.equal(clampNumber(Number.NaN, 0, 10, 5), 5);
	assert.equal(clampNumber(Number.POSITIVE_INFINITY, 0, 10, 5), 5);
	assert.equal(clampNumber(-5, 0, 10, 5), 0);
	assert.equal(clampNumber(99, 0, 10, 5), 10);
	assert.equal(clampNumber(7.6, 0, 10, 5), 8);
	assert.equal(clampNumber(3, 0, 10, 5), 3);
});

test("parseTerminalTheme：白名单外（含非字符串脏值）一律回 inherit", () => {
	const { parseTerminalTheme } = loadSettingsStore();
	assert.equal(parseTerminalTheme("inherit"), "inherit");
	assert.equal(parseTerminalTheme("solarized-light"), "solarized-light");
	assert.equal(parseTerminalTheme("solarized-dark"), "solarized-dark");
	assert.equal(parseTerminalTheme("one-dark"), "one-dark");
	assert.equal(parseTerminalTheme("monokai"), "monokai");
	assert.equal(parseTerminalTheme("dracula"), "inherit");
	assert.equal(parseTerminalTheme(""), "inherit");
	assert.equal(parseTerminalTheme(42), "inherit");
	assert.equal(parseTerminalTheme(null), "inherit");
});

test("parseTerminalCursorStyle：白名单外回 block", () => {
	const { parseTerminalCursorStyle } = loadSettingsStore();
	assert.equal(parseTerminalCursorStyle("block"), "block");
	assert.equal(parseTerminalCursorStyle("bar"), "bar");
	assert.equal(parseTerminalCursorStyle("underline"), "underline");
	assert.equal(parseTerminalCursorStyle("blinking"), "block");
	assert.equal(parseTerminalCursorStyle(undefined), "block");
});

test("parseTerminalConfirmClose：白名单外回 running（升级用户默认档不弹窗以外的保守语义）", () => {
	const { parseTerminalConfirmClose } = loadSettingsStore();
	assert.equal(parseTerminalConfirmClose("never"), "never");
	assert.equal(parseTerminalConfirmClose("running"), "running");
	assert.equal(parseTerminalConfirmClose("always"), "always");
	assert.equal(parseTerminalConfirmClose("sometimes"), "running");
	assert.equal(parseTerminalConfirmClose(0), "running");
	assert.equal(parseTerminalConfirmClose(undefined), "running");
});
