import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 「仅失焦时提醒」门控（src/main/notifications/alertFocusGate.ts）的判定契约：
 * 开关决定是否看焦点，窗口不存在/已销毁一律按失焦处理（宁可多响一次，不静默丢提醒）。
 * 系统通知、Ask 通知、定时任务通知、提示音四条链路共用本模块，判定漂移会直接打扰用户。
 */
function loadGate() {
	return loadTsCommonJs("src/main/notifications/alertFocusGate.ts");
}

test("开关关闭（默认）：不管焦点都在，永远提醒", () => {
	const { shouldAlertNow } = loadGate();
	assert.equal(shouldAlertNow(false, true), true);
	assert.equal(shouldAlertNow(false, false), true);
});

test("开关打开：窗口有焦点时不提醒，失焦才提醒", () => {
	const { shouldAlertNow } = loadGate();
	assert.equal(shouldAlertNow(true, true), false);
	assert.equal(shouldAlertNow(true, false), true);
});

test("窗口缺失/已销毁按失焦处理（不静默丢提醒）", () => {
	const { isMainWindowFocused } = loadGate();
	assert.equal(isMainWindowFocused(null), false);
	assert.equal(isMainWindowFocused(undefined), false);
	const destroyed = {
		isFocused() {
			throw new Error("Object has been destroyed");
		},
	};
	assert.equal(isMainWindowFocused(destroyed), false);
});

test("窗口存在时取真实焦点状态", () => {
	const { isMainWindowFocused } = loadGate();
	assert.equal(isMainWindowFocused({ isFocused: () => true }), true);
	assert.equal(isMainWindowFocused({ isFocused: () => false }), false);
});

test("品牌名常量与 package.json build.productName 一致（安装版通知标题不随 asar 内的 npm 包名漂移）", () => {
	const { APP_DISPLAY_NAME } = loadTsCommonJs("src/main/utils/appBrand.ts");
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(APP_DISPLAY_NAME, "PiDeck");
	assert.equal(APP_DISPLAY_NAME, pkg.build.productName, "APP_DISPLAY_NAME 必须与 electron-builder 的 productName 保持同一品牌名");
	assert.notEqual(pkg.name, APP_DISPLAY_NAME, "npm 包名与产品显示名独立，通知标题固定使用品牌常量");
});
