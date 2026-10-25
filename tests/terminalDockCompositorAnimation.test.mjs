import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const terminalHook = readFileSync("src/renderer/src/hooks/useTerminalDock.ts", "utf8");
const runtimeDock = readFileSync("src/renderer/src/components/session/SessionRuntimeDock.tsx", "utf8");
const styles = readRendererStyles();

function cssRule(selector) {
	return styles.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1];
}

test("terminal dock combines panel layout with composited motion", () => {
	const chatPane = cssRule("\\.chat-pane");
	const terminalDock = cssRule("\\.terminal-dock");

	assert.ok(chatPane, "chat pane styles must exist");
	// #115 U5：纵向三段已交 react-resizable-panels，chat-pane 是纯 flex 列容器，
	// 不再有 grid-template-rows 过渡（回归锁：不得把旧 grid 动画加回来）
	assert.match(chatPane, /display:\s*flex;/);
	assert.match(chatPane, /flex-direction:\s*column;/);
	assert.doesNotMatch(chatPane, /grid-template-rows/);
	assert.ok(terminalDock, "terminal dock styles must exist");
	assert.match(terminalDock, /will-change:\s*transform;/);
	assert.match(terminalDock, /transition:\s*transform/);
	assert.match(styles, /\.terminal-dock\[data-motion-state="hidden"\][\s\S]*?translate3d\(0, 100%, 0\)/);
});

test("terminal dock remains mounted while its exit transform runs", () => {
	assert.match(terminalHook, /const TERMINAL_DOCK_MOTION_MS = 180;/);
	assert.match(terminalHook, /const \[terminalDockMounted, setTerminalDockMounted\] = useState\(false\);/);
	assert.match(terminalHook, /const \[terminalDockClosing, setTerminalDockClosing\] = useState\(false\);/);
	// 回调体可能被格式化到多行/带尾逗号：用 \s* 与可选逗号容忍。
	assert.match(terminalHook, /window\.setTimeout\(\s*\(\) => \{\s*setTerminalDockMounted\(false\);\s*setTerminalDockClosing\(false\);\s*\},\s*TERMINAL_DOCK_MOTION_MS,?\s*\)/);
	assert.match(runtimeDock, /mounted: boolean;/);
	assert.match(runtimeDock, /closing: boolean;/);
	assert.match(runtimeDock, /closing=\{props\.closing\}/);
});
