import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { nextMainWindowVisualIntent, planMainWindowReveal } = loadTsCommonJs("src/main/windowReveal.ts");
const main = readFileSync("src/main/index.ts", "utf8");
const pet = readFileSync("src/main/pet/index.ts", "utf8");
const windowState = readFileSync("src/main/windowState.ts", "utf8");

/**
 * 窗口唤起回归（全屏/最大化「变小」）：
 * - 全屏要跟最大化一起持久化，否则关窗即退出的机器重启后只剩最大化；
 * - 每条唤回路径（托盘双击/任务栏激活/桌面宠物/通知握手）必须走同一个 revealMainWindow，
 *   否则「最小化 → show()」会把窗口留在非最大化的伪全屏状态，下一次还原就掉回正常尺寸。
 * 纯策略在 windowReveal.ts 里断言，接线用源码契约钉住。
 */

const state = (overrides = {}) => ({ minimized: false, maximized: false, fullscreen: false, ...overrides });
/** 纯模块跑在独立 VM realm 里：展开成普通对象才能用 deepStrictEqual 比对。 */
const plan = (...args) => ({ ...planMainWindowReveal(...args) });

test("windowState: 全屏与最大化分别持久化", () => {
	assert.match(windowState, /fullscreen\?: boolean;/);
	assert.match(windowState, /data\.fullscreen === true \? \{ fullscreen: true \}/);
	assert.match(windowState, /bounds\.fullscreen === true \? \{ fullscreen: true \}/);
});

test("planMainWindowReveal: 最小化的最大化窗口会被重新最大化（点通知后变小）", () => {
	assert.deepEqual(plan("maximized", state({ minimized: true })), { restore: true, maximizeBeforeShow: true, fullscreenAfterShow: false });
	// 已经是最大化/全屏时不要重复调用（避免打断用户当下的状态）
	assert.deepEqual(plan("maximized", state({ maximized: true })), { restore: false, maximizeBeforeShow: false, fullscreenAfterShow: false });
	// 全屏时不能被「最大化」意图踢出全屏
	assert.deepEqual(plan("maximized", state({ fullscreen: true })), { restore: false, maximizeBeforeShow: false, fullscreenAfterShow: false });
});

test("planMainWindowReveal: 全屏意图先 maximize 再进全屏，且不重复进入", () => {
	// 先 maximize：退出全屏时才能回到最大化，而不是掉回 1522×857 的正常尺寸
	assert.deepEqual(plan("fullscreen", state()), { restore: false, maximizeBeforeShow: true, fullscreenAfterShow: true });
	assert.deepEqual(plan("fullscreen", state({ maximized: true })), { restore: false, maximizeBeforeShow: false, fullscreenAfterShow: true });
	assert.deepEqual(plan("fullscreen", state({ fullscreen: true })), { restore: false, maximizeBeforeShow: false, fullscreenAfterShow: false });
	// 最小化 + 全屏：先 restore 再走同一条路
	assert.deepEqual(plan("fullscreen", state({ minimized: true })), { restore: true, maximizeBeforeShow: true, fullscreenAfterShow: true });
});

test("planMainWindowReveal: 普通意图只恢复窗口，不改几何", () => {
	assert.deepEqual(plan("normal", state({ minimized: true })), { restore: true, maximizeBeforeShow: false, fullscreenAfterShow: false });
	assert.deepEqual(plan("normal", state()), { restore: false, maximizeBeforeShow: false, fullscreenAfterShow: false });
});

test("planMainWindowReveal: e2e 只做 restore，不铺满屏", () => {
	assert.deepEqual(plan("maximized", state({ minimized: true }), { e2e: true }), { restore: true, maximizeBeforeShow: false, fullscreenAfterShow: false });
	assert.deepEqual(plan("fullscreen", state(), { e2e: true }), { restore: false, maximizeBeforeShow: false, fullscreenAfterShow: false });
});

test("nextMainWindowVisualIntent: 全屏期间的 maximize/unmaximize 不改写全屏意图", () => {
	assert.equal(nextMainWindowVisualIntent("normal", state(), "maximize"), "maximized");
	assert.equal(nextMainWindowVisualIntent("maximized", state({ maximized: true }), "unmaximize"), "normal");
	assert.equal(nextMainWindowVisualIntent("fullscreen", state({ fullscreen: true }), "unmaximize"), "fullscreen");
	assert.equal(nextMainWindowVisualIntent("fullscreen", state({ fullscreen: true }), "maximize"), "fullscreen");
	assert.equal(nextMainWindowVisualIntent("maximized", state(), "enter-full-screen"), "fullscreen");
	// Windows 退出全屏回到最大化；从普通窗口直接退出时保持普通
	assert.equal(nextMainWindowVisualIntent("fullscreen", state({ maximized: true }), "leave-full-screen"), "maximized");
	assert.equal(nextMainWindowVisualIntent("fullscreen", state(), "leave-full-screen"), "normal");
});

test("startup: last 记录里的全屏优先于最大化，并同步呈现态意图", () => {
	assert.match(main, /if \(last\.fullscreen\) effectiveStartupMode = "fullscreen";/);
	assert.match(main, /else if \(last\.maximized\) effectiveStartupMode = "maximized";/);
	assert.match(main, /mainWindowVisualIntent = effectiveStartupMode === "fullscreen" \? "fullscreen" : effectiveStartupMode === "maximized" \? "maximized" : "normal";/);
	assert.match(main, /trackMainWindowVisualIntent\(createdWindow\);/);
});

test("revealMainWindow: 按 plan 执行 restore / maximize / show / setFullScreen / focus", () => {
	const body = main.slice(main.indexOf("function revealMainWindow(window: BrowserWindow): void {"), main.indexOf("function focusMainWindow()"));
	const planIndex = body.indexOf("const plan = planMainWindowReveal(");
	const restoreIndex = body.indexOf("if (plan.restore) window.restore();");
	const maximizeIndex = body.indexOf("if (plan.maximizeBeforeShow) window.maximize();");
	const showIndex = body.indexOf("window.show();");
	const fullscreenIndex = body.indexOf("if (plan.fullscreenAfterShow) window.setFullScreen(true);");
	const focusIndex = body.indexOf("window.focus();");
	assert.ok(planIndex > -1 && restoreIndex > planIndex && maximizeIndex > restoreIndex && showIndex > maximizeIndex && fullscreenIndex > showIndex && focusIndex > fullscreenIndex);
	// E2E 静默交给 plan，不在调用点再写一次 if
	assert.match(body, /planMainWindowReveal\(mainWindowVisualIntent, \{[\s\S]{0,160}\{ e2e: isE2E \}/);
	// win32 抢前台 hack 仍必须还原用户置顶状态
	assert.match(body, /setAlwaysOnTop\(true\)[\s\S]{0,80}setAlwaysOnTop\(false\)/);
});

test("所有唤回路径共用 revealMainWindow（不能再直接 show()）", () => {
	assert.match(main, /function focusMainWindow\(\) \{[\s\S]{0,200}revealMainWindow\(mainWindow\);/);
	assert.match(main, /instance\.on\("double-click", \(\) => \{[\s\S]{0,120}revealMainWindow\(mainWindow\);/);
	assert.match(main, /app\.on\("activate", \(\) => \{[\s\S]{0,400}revealMainWindow\(mainWindow\);/);
	assert.match(main, /revealMainWindow: \(window\) => revealMainWindow\(window\),/);
	assert.match(pet, /revealMainWindow\?: \(window: BrowserWindow\) => void;/);
	assert.match(pet, /if \(revealMainWindow\) revealMainWindow\(main\);/);
});
