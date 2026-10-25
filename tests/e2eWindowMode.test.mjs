import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * E2E 窗口「不打扰」摆放（e2eWindowMode.ts）：
 * 默认把 Playwright 启动的应用窗口摆到屏幕外，避免每个用例的新窗口弹到用户桌面最前、
 * 打断其他工作；需要真实窗口几何的用例通过 PIDECK_E2E_WINDOW_MODE=visible 回退。
 * 纯逻辑 + 接线契约一起锁（真实窗口行为由 e2e/window-background.spec.ts 兜底）。
 */

const { E2E_OFFSCREEN_WINDOW_POSITION, E2E_RENDERING_SWITCHES, applyE2EWindowPlacement, resolveE2EWindowPlacement } = loadTsCommonJs("src/main/e2eWindowMode.ts");

function recordingWindow() {
	const calls = [];
	return {
		calls,
		setPosition: (x, y) => calls.push(["setPosition", x, y]),
		setSkipTaskbar: (skip) => calls.push(["setSkipTaskbar", skip]),
	};
}

test("non-e2e launches keep the normal on-screen placement", () => {
	assert.deepEqual({ ...resolveE2EWindowPlacement(false, undefined) }, { mode: "visible" });
	assert.deepEqual({ ...resolveE2EWindowPlacement(false, "quiet") }, { mode: "visible" });
});

test("e2e windows are placed off-screen by default", () => {
	const placement = resolveE2EWindowPlacement(true, undefined);
	assert.equal(placement.mode, "offscreen");
	assert.deepEqual({ ...placement.position }, { ...E2E_OFFSCREEN_WINDOW_POSITION });
	// 远离常见多屏虚拟桌面范围，避免被窗口管理器钳回屏内
	assert.ok(placement.position.x <= -10000);
	assert.ok(placement.position.y <= -10000);
	// 未设置 / 任意非 visible 值都保持安静模式（夹具默认传 quiet）
	assert.equal(resolveE2EWindowPlacement(true, "quiet").mode, "offscreen");
	assert.equal(resolveE2EWindowPlacement(true, " QUIET ").mode, "offscreen");
});

test("PIDECK_E2E_WINDOW_MODE=visible opts back in to a normal window (geometry tests)", () => {
	assert.deepEqual({ ...resolveE2EWindowPlacement(true, "visible") }, { mode: "visible" });
	assert.deepEqual({ ...resolveE2EWindowPlacement(true, "VISIBLE ") }, { mode: "visible" });
});

test("applying the off-screen plan moves the window out of the desktop and taskbar", () => {
	const win = recordingWindow();
	applyE2EWindowPlacement(win, resolveE2EWindowPlacement(true, undefined));
	assert.deepEqual(win.calls, [
		["setSkipTaskbar", true],
		["setPosition", E2E_OFFSCREEN_WINDOW_POSITION.x, E2E_OFFSCREEN_WINDOW_POSITION.y],
	]);
});

test("apply is a no-op for visible mode and never throws when the window manager refuses", () => {
	const visibleWin = recordingWindow();
	applyE2EWindowPlacement(visibleWin, { mode: "visible" });
	assert.deepEqual(visibleWin.calls, []);

	const refusingWin = {
		setSkipTaskbar: () => {
			throw new Error("not supported");
		},
		setPosition: () => {
			throw new Error("never reached");
		},
	};
	assert.doesNotThrow(() => applyE2EWindowPlacement(refusingWin, resolveE2EWindowPlacement(true, undefined)));
});

test("E2E rendering switches keep off-screen windows painting (Playwright clicks/screenshots depend on it)", () => {
	for (const required of ["disable-background-timer-throttling", "disable-renderer-backgrounding", "disable-backgrounding-occluded-windows"]) {
		assert.ok(E2E_RENDERING_SWITCHES.includes(required), "missing switch: " + required);
	}
});

test("wiring: main process applies the plan to the main window and disables throttling in E2E", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /resolveE2EWindowPlacement\(\s*isE2E\s*,\s*process\.env\.PIDECK_E2E_WINDOW_MODE\s*\)/);
	assert.match(main, /applyE2EWindowPlacement\(createdWindow, e2eWindowPlacement\)/);
	assert.match(main, /for \(const switchName of E2E_RENDERING_SWITCHES\) app\.commandLine\.appendSwitch\(switchName\);/);
	// disable-features 收敛到 src/main/chromiumFeatureFlags.ts 单点拼装（同名 switch 后值覆盖前值），
	// 这里只核对 E2E 把遮挡判定条目交给了那个入口；合并行为由 chromiumFeatureFlags.test.mjs 覆盖。
	assert.match(main, /applyChromiumFeatureFlags\(\s*app\.commandLine\s*,\s*isE2E \? \["CalculateNativeWinOcclusion"\] : \[\]\s*\)/);
	// 屏幕外窗口不节流：webPreferences 只允许 E2E 分支关掉 backgroundThrottling
	assert.match(main, /\.\.\.\(isE2E \? \{ backgroundThrottling: false \} : \{\}\)/);
	// 必须设置在 showInactive 之前（窗口显示后再挪位置会闪一下到前台）
	const placementIndex = main.indexOf("applyE2EWindowPlacement(createdWindow, e2eWindowPlacement)");
	const showIndex = main.indexOf("showMainWindowOnce()", placementIndex);
	assert.ok(showIndex > placementIndex, "placement must be applied before the window is shown");
});

test("wiring: fixtures default to quiet and geometry-sensitive specs opt out", () => {
	for (const fixture of ["e2e/fixtures.ts", "e2e/mock-pi-fixture.ts"]) {
		const source = readFileSync(fixture, "utf8");
		assert.match(source, /e2eWindowMode: \["quiet", \{ option: true \}\]/, fixture + " must default to quiet e2e windows");
		assert.match(source, /PIDECK_E2E_WINDOW_MODE: e2eWindowMode/, fixture + " must forward the window mode to the app");
	}
	const windowMemory = readFileSync("e2e/window-memory.spec.ts", "utf8");
	assert.match(windowMemory, /e2eWindowMode: "visible"/);
	assert.match(windowMemory, /PIDECK_E2E_WINDOW_MODE: "visible"/);
	const quickTask = readFileSync("e2e/quick-task.spec.ts", "utf8");
	assert.match(quickTask, /e2eWindowMode: "visible"/);
	assert.match(quickTask, /PIDECK_E2E_WINDOW_MODE: "visible"/);
	// 自管 launch 的历史恢复用例也走 E2E 静默模式，否则窗口会直接抢焦点
	const historyRestore = readFileSync("e2e/history-restore.spec.ts", "utf8");
	assert.match(historyRestore, /PIDECK_E2E: "1"/);
	assert.match(historyRestore, /PIDECK_E2E_WINDOW_MODE: "quiet"/);
});
