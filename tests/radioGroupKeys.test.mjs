import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * `role="radiogroup"` 的方向键语义与 roving tabindex（见 utils/radioGroupKeys.ts）。
 *
 * 修的真实缺陷：分屏组管理菜单的色板用 `role="radio"` 手写按钮，浏览器不会提供
 * 原生 input[type=radio] 的行为 —— 8 个色块各自是一个 Tab 停靠点，方向键完全无效，
 * 读屏播报「单选按钮」却按不动。
 */
const { handleRadioGroupKeys, radioGroupFocusTarget, radioGroupTabIndex } = loadTsCommonJs("src/renderer/src/utils/radioGroupKeys.ts");

const COUNT = 8;

function keyEvent(key, index, overrides = {}) {
	const target = { kind: "swatch" };
	const moves = [];
	const record = { preventDefault: 0, moves, handled: null };
	const event = {
		key,
		target,
		currentTarget: target,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		nativeEvent: {},
		preventDefault: () => {
			record.preventDefault += 1;
		},
		...overrides,
	};
	record.handled = handleRadioGroupKeys(event, {
		index,
		count: overrides.count ?? COUNT,
		onMove: (target2) => moves.push(target2),
	});
	return record;
}

test("右/下方向键移动到下一项并环绕", () => {
	for (const key of ["ArrowRight", "ArrowDown"]) {
		assert.equal(radioGroupFocusTarget(key, 0, COUNT), 1, key);
		assert.equal(radioGroupFocusTarget(key, COUNT - 1, COUNT), 0, key);
	}
});

test("左/上方向键移动到上一项并环绕", () => {
	for (const key of ["ArrowLeft", "ArrowUp"]) {
		assert.equal(radioGroupFocusTarget(key, 3, COUNT), 2, key);
		assert.equal(radioGroupFocusTarget(key, 0, COUNT), COUNT - 1, key);
	}
});

test("Home / End 到首尾", () => {
	assert.equal(radioGroupFocusTarget("Home", 5, COUNT), 0);
	assert.equal(radioGroupFocusTarget("End", 2, COUNT), COUNT - 1);
});

test("方向键被消费：preventDefault + 只移动一次", () => {
	const result = keyEvent("ArrowRight", 0);
	assert.equal(result.handled, true);
	assert.equal(result.preventDefault, 1);
	assert.equal(JSON.stringify(result.moves), "[1]");
});

test("空组或未知按键不消费事件", () => {
	for (const key of ["Tab", "Escape", "Enter", " ", "a"]) {
		const result = keyEvent(key, 0);
		assert.equal(result.handled, false, key);
		assert.equal(result.preventDefault, 0, key);
	}
	assert.equal(radioGroupFocusTarget("ArrowRight", 0, 0), null);
	assert.equal(keyEvent("ArrowRight", 0, { count: 0 }).handled, false);
});

test("组内子元素的事件不处理", () => {
	const result = keyEvent("ArrowRight", 0, { target: { kind: "child" } });
	assert.equal(result.handled, false);
	assert.equal(result.moves.length, 0);
});

test("输入法组合中与带修饰键的组合不拦截", () => {
	assert.equal(keyEvent("ArrowRight", 0, { nativeEvent: { isComposing: true } }).handled, false);
	for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
		const result = keyEvent("ArrowRight", 0, { [modifier]: true });
		assert.equal(result.handled, false, modifier);
		assert.equal(result.moves.length, 0, modifier);
	}
});

test("roving tabindex：整组只有一个 0，未进入时停在回退项", () => {
	const tabIndexes = Array.from({ length: COUNT }, (_, index) => radioGroupTabIndex(index, 2, 5));
	assert.equal(tabIndexes.filter((value) => value === 0).length, 1);
	assert.equal(tabIndexes[2], 0);
	// 尚未用键盘进入（activeIndex=null）→ 停在已选中项
	const resting = Array.from({ length: COUNT }, (_, index) => radioGroupTabIndex(index, null, 5));
	assert.equal(resting.filter((value) => value === 0).length, 1);
	assert.equal(resting[5], 0);
});
