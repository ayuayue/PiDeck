import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const terminalDock = readFileSync("src/renderer/src/components/terminal/TerminalDock.tsx", "utf8");

test("defers terminal initialization until the dock opening animation completes", () => {
	assert.match(terminalDock, /const TERMINAL_OPEN_ANIMATION_MS = 300;/);
	assert.match(terminalDock, /const \[contentReady, setContentReady\] = useState\(false\);/);
	// setTimeout 回调实参可能被格式化到多行：用 \s* 容忍、并允许尾逗号。
	assert.match(terminalDock, /window\.setTimeout\(\s*\(\) => setContentReady\(true\),\s*TERMINAL_OPEN_ANIMATION_MS,?\s*\)/);
	assert.match(terminalDock, /if \(!open \|\| !contentReady\) return;/);
	// 初始化 effect 改按 effectTabId 门控（切换标签时重建，见 TerminalDock.tsx）。
	assert.match(terminalDock, /if \(collapsed \|\| !contentReady \|\| !effectTabId \|\| !containerRef\.current\) return;/);
});
