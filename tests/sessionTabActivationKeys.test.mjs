import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Tab 本体的键盘激活键（会话 Tab 栏四种 Tab 共用，见 utils/tabActivationKeys.ts）。
 *
 * 修的三个真实缺陷：
 * 1) 会话 Tab 完全没有 tabIndex → 键盘序列进不去（只有内部关闭钮可达）。
 * 2) Tab 本体的 onKeyDown 不判 target，关闭钮上按 Enter 冒泡到 Tab → preventDefault 取消
 *    原生 click → 回车不关闭、反而选中 Tab。
 * 3) 不可关闭（固定）的 Tab 上按 Delete 什么都不该发生，也不能吞掉事件。
 */
const { handleTabActivationKeys, isTabCloseActivationKey } = loadTsCommonJs("src/renderer/src/utils/tabActivationKeys.ts");

function keyEvent(key, overrides = {}) {
	const target = { kind: "tab" };
	const record = { preventDefault: 0, select: 0, close: 0, handled: null };
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
	record.handled = handleTabActivationKeys(event, {
		canClose: overrides.canClose ?? true,
		onSelect: () => {
			record.select += 1;
		},
		onClose: () => {
			record.close += 1;
		},
	});
	return record;
}

test("Enter 选中 Tab 并阻止默认行为", () => {
	const result = keyEvent("Enter");
	assert.equal(result.handled, true);
	assert.equal(result.select, 1);
	assert.equal(result.close, 0);
	assert.equal(result.preventDefault, 1);
});

test("Space 选中 Tab（防止页面滚动）", () => {
	const result = keyEvent(" ");
	assert.equal(result.handled, true);
	assert.equal(result.select, 1);
	assert.equal(result.preventDefault, 1);
});

test("Delete 关闭 Tab", () => {
	const result = keyEvent("Delete");
	assert.equal(result.handled, true);
	assert.equal(result.close, 1);
	assert.equal(result.select, 0);
});

test("固定 Tab（canClose=false）上 Delete 不关闭、不吞事件", () => {
	const result = keyEvent("Delete", { canClose: false });
	assert.equal(result.handled, false);
	assert.equal(result.close, 0);
	assert.equal(result.preventDefault, 0);
});

test("关闭钮上的 Enter 冒泡进来不再算激活 Tab", () => {
	// target 是关闭钮，currentTarget 是 Tab 本体 → 必须原样放行，让原生 click 生效。
	const result = keyEvent("Enter", { target: { kind: "close" } });
	assert.equal(result.handled, false);
	assert.equal(result.select, 0);
	assert.equal(result.preventDefault, 0);
});

test("输入法组合中不拦截", () => {
	const result = keyEvent("Enter", { nativeEvent: { isComposing: true } });
	assert.equal(result.handled, false);
	assert.equal(result.select, 0);
	assert.equal(result.preventDefault, 0);
});

test("带修饰键的组合留给宿主快捷键", () => {
	for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
		const result = keyEvent("Enter", { [modifier]: true });
		assert.equal(result.handled, false, modifier);
		assert.equal(result.select, 0, modifier);
		assert.equal(result.preventDefault, 0, modifier);
	}
});

test("方向键 / Tab / Escape 不当作激活键", () => {
	for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Tab", "Escape"]) {
		const result = keyEvent(key);
		assert.equal(result.handled, false, key);
		assert.equal(result.select, 0, key);
		assert.equal(result.close, 0, key);
		assert.equal(result.preventDefault, 0, key);
	}
});

test("关闭钮需要自己吞掉 Enter/Space 的冒泡", () => {
	assert.equal(isTabCloseActivationKey("Enter"), true);
	assert.equal(isTabCloseActivationKey(" "), true);
	assert.equal(isTabCloseActivationKey("Escape"), false);
	assert.equal(isTabCloseActivationKey("Delete"), false);
});
