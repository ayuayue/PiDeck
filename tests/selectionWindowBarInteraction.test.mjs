import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("system selection window is a Magpie-style bar first, result panel after action", () => {
	const view = read("src/renderer/src/components/selectionWindow/SelectionToolWindowView.tsx");
	const windowSource = read("src/main/selection/SelectionToolWindow.ts");
	const ipc = read("src/main/ipc/selectionToolIpc.ts");

	// 复制触发只弹折叠条：捕获时展开条件只看「有没有读到文本」，不再有自动调用 effect。
	assert.match(view, /setExpanded\(!payload\.text\.trim\(\)\)/);
	assert.doesNotMatch(view, /autoRunKey/);
	assert.match(view, /SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT/);
	assert.match(view, /SELECTION_TOOL_WINDOW_EXPANDED_HEIGHT/);
	assert.match(view, /desktopApi\.selectionTool\s*\.resize\(/);
	assert.match(view, /SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH/);
	assert.match(view, /compact=\{!expanded\}/);
	assert.match(view, /折叠条只留智能体/);

	// 不抢焦点 + 非聚焦自动收起 + 折叠/展开窗口尺寸。
	assert.match(windowSource, /showInactive\(\)/);
	assert.doesNotMatch(windowSource, /win\.focus\(\)/);
	assert.match(windowSource, /SELECTION_TOOL_AUTO_HIDE_MS/);
	assert.match(windowSource, /SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH/);
	assert.match(windowSource, /resize\(input: SelectionToolResizeInput\)/);
	assert.match(ipc, /selectionToolResize/);
	assert.match(ipc, /parseSelectionToolResizeInput/);
});
