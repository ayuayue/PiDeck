import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

const read = (path) => readFileSync(path, "utf8");

test("Windows native selection capture uses UIAutomation, never clipboard or key injection", () => {
	const source = read("src/main/selection/windowsSelectionCapture.ts");

	const main = mainIpcSource;
	// Magpie Windows 同款能力：UIAutomationCore 是系统自带程序集，不需要额外 DLL。
	assert.match(source, /UIAutomationClient/);
	assert.match(source, /TextPattern/);
	assert.match(source, /GetAsyncKeyState/);
	assert.match(source, /spawn\("powershell\.exe"/);
	assert.doesNotMatch(source, /Set-Clipboard|SendInput|SendKeys|keystroke/);
	assert.match(main, /WindowsSelectionCapture/);
	assert.match(main, /windowsSelectionCapture\?\.setEnabled\(systemEnabled\)/);
});
