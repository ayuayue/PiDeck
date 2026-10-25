import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const bounds = loadTsCommonJs("src/main/selection/selectionToolBounds.ts");
const { clampSelectionToolPosition, SELECTION_TOOL_CURSOR_OFFSET, SELECTION_TOOL_SCREEN_MARGIN, SELECTION_TOOL_WINDOW_WIDTH, SELECTION_TOOL_WINDOW_HEIGHT } = bounds;

const SIZE = { width: SELECTION_TOOL_WINDOW_WIDTH, height: SELECTION_TOOL_WINDOW_HEIGHT };
/** 主显示器 1920×1080，底部 40px 任务栏 → workArea 1040 高。 */
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/** 生产模块在 vm 沙箱里创建的对象原型属于另一个 realm，深度比较前转成本 realm 的普通对象。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function place(cursor, workArea = WORK_AREA, overrides = {}) {
	return plain(clampSelectionToolPosition({ cursor, workArea, size: SIZE, ...overrides }));
}

test("window size defaults match the designed compact card", () => {
	assert.equal(SELECTION_TOOL_WINDOW_WIDTH, 440);
	assert.equal(SELECTION_TOOL_WINDOW_HEIGHT, 280);
	assert.equal(SELECTION_TOOL_CURSOR_OFFSET, 14);
	assert.equal(SELECTION_TOOL_SCREEN_MARGIN, 8);
});

test("places the window at the cursor's bottom-right when there is room", () => {
	assert.deepEqual(place({ x: 400, y: 300 }), { x: 414, y: 314 });
	assert.deepEqual(place({ x: 0, y: 0 }), { x: 14, y: 14 });
});

test("flips left/above near the screen edges instead of overflowing", () => {
	// 右侧放不下 → 翻到光标左侧（1900 - 14 - 440 = 1446，仍在 workArea 内）。
	assert.deepEqual(place({ x: 1900, y: 400 }), { x: 1446, y: 414 });
	// 下方放不下 → 翻到光标上方（1020 - 14 - 280 = 726）。
	assert.deepEqual(place({ x: 600, y: 1020 }), { x: 614, y: 726 });
	// 右下角：两个方向都翻转。
	assert.deepEqual(place({ x: 1910, y: 1030 }), { x: 1456, y: 736 });
});

test("keeps negative workArea coordinates inside a left/top secondary display", () => {
	const workArea = { x: -1920, y: -200, width: 1920, height: 1040 };
	assert.deepEqual(place({ x: -1900, y: -190 }, workArea), { x: -1886, y: -176 });
	// 副屏右下角：翻转后仍在副屏内，不会跳回主屏。
	const flipped = place({ x: -100, y: 800 }, workArea);
	assert.equal(flipped.x, -114 - 440);
	assert.equal(flipped.y, 786 - 280);
	assert.ok(flipped.x >= workArea.x + SELECTION_TOOL_SCREEN_MARGIN);
});

test("clamps when the display is smaller than the floating window", () => {
	const workArea = { x: 0, y: 0, width: 400, height: 200 };
	// 宽度 440 > 400 - 2*margin：两侧都放不下，只能贴左上留白边界，绝不越界成负坐标。
	assert.deepEqual(place({ x: 100, y: 100 }, workArea), { x: 8, y: 8 });
});

test("rounds fractional cursor coordinates and honours offset/margin overrides", () => {
	assert.deepEqual(place({ x: 100.6, y: 200.4 }), { x: 115, y: 214 });
	assert.deepEqual(place({ x: 0, y: 0 }, WORK_AREA, { offset: 0, margin: 0 }), { x: 0, y: 0 });
});
