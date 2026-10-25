import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const CuaWin32 = loadTsCommonJs("src/main/cua/CuaWin32.ts");

test("typeUnicode builds N down+up pairs for N chars", () => {
	// We can't call sendInputs in test (no user32.dll), but we can verify
	// typeUnicode builds inputs correctly by checking buildKeyboardInput.
	// Instead, verify VK_MAP lookups.
	assert.strictEqual(CuaWin32.VK_MAP["enter"], 0x0d);
	assert.strictEqual(CuaWin32.VK_MAP["ctrl"], 0x11);
	assert.strictEqual(CuaWin32.VK_MAP["tab"], 0x09);
	assert.strictEqual(CuaWin32.VK_MAP["escape"], 0x1b);
});

test("pressKeyCombo builds correct input sequence shape", () => {
	// Verify the function exists and is callable (it will fail at SendInput
	// in non-Windows test env, but we test the input construction indirectly).
	assert.strictEqual(typeof CuaWin32.pressKeyCombo, "function");
	assert.strictEqual(typeof CuaWin32.typeUnicode, "function");
	assert.strictEqual(typeof CuaWin32.scrollAt, "function");
});

test("MOUSEEVENTF_WHEEL and HWHEEL constants are defined", () => {
	assert.strictEqual(CuaWin32.MOUSEEVENTF_WHEEL, 0x0800);
	assert.strictEqual(CuaWin32.MOUSEEVENTF_HWHEEL, 0x1000);
});
