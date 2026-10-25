import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 启动遮罩撤除的行为与契约守卫。
 *
 * 背景：冷启动首帧工作区还没有会话（currentSessionId/sessionTabIds 异步恢复），
 * 若按挂载帧撤遮罩，用户会看到「闪一下引导页空态」。所以撤除实现收口到
 * utils/bootOverlay.ts（幂等），时机由 useBootOverlayReady 的内容就绪信号决定，
 * main.tsx 只留硬兜底超时。
 */

const mainSource = readFileSync("src/renderer/src/main.tsx", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const hookSource = readFileSync("src/renderer/src/hooks/app/useBootOverlayReady.ts", "utf8");

/** 极简遮罩替身：记录 class、监听器与移除状态。 */
function createOverlayStub() {
	const classes = new Set();
	const listeners = [];
	return {
		dataset: {},
		removed: false,
		classes,
		listeners,
		classList: {
			add: (name) => classes.add(name),
		},
		addEventListener: (type, handler) => listeners.push({ type, handler }),
		remove() {
			this.removed = true;
		},
	};
}

/** 用自定义 document/window 加载生产模块；定时器不真跑，交由测试手动触发。 */
function loadBootOverlay({ overlays = [] } = {}) {
	const scheduled = [];
	const load = createTsSandbox({
		globals: {
			document: { getElementById: (id) => (id === "boot-overlay" ? (overlays[0] ?? null) : null) },
			window: {
				setTimeout: (fn, ms) => {
					scheduled.push({ fn, ms });
					return scheduled.length;
				},
				clearTimeout: () => undefined,
			},
		},
	});
	return { module: load("src/renderer/src/utils/bootOverlay.ts"), scheduled };
}

test("遮罩不在 DOM 中时撤除调用静默返回", () => {
	const { module } = loadBootOverlay({ overlays: [] });
	assert.doesNotThrow(() => module.dismissBootOverlay());
});

test("首次撤除：标记待撤除、加 fade-out，过渡结束移除节点", () => {
	const overlay = createOverlayStub();
	const { module, scheduled } = loadBootOverlay({ overlays: [overlay] });

	module.dismissBootOverlay();

	assert.equal(overlay.dataset.dismissing, "true");
	assert.ok(overlay.classes.has("fade-out"));
	assert.equal(overlay.removed, false, "过渡期间不能提前移除，否则淡出动画丢失");
	assert.deepEqual(
		overlay.listeners.map((entry) => entry.type),
		["transitionend"],
	);
	// 兜底定时器 700ms 注册到位（transitionend 不触发时的保险）
	assert.deepEqual(
		scheduled.map((entry) => entry.ms),
		[700],
	);

	overlay.listeners[0].handler();
	assert.equal(overlay.removed, true);
	// transitionend 已移除后，兜底定时器再跑一次不应抛错
	assert.doesNotThrow(() => scheduled[0].fn());
});

test("重复调用幂等：不重复加 class、不重复注册过渡监听", () => {
	const overlay = createOverlayStub();
	const { module, scheduled } = loadBootOverlay({ overlays: [overlay] });

	module.dismissBootOverlay();
	module.dismissBootOverlay();
	module.dismissBootOverlay();

	assert.equal(overlay.listeners.length, 1, "过渡监听必须只注册一次");
	assert.equal(scheduled.length, 1, "兜底定时器必须只注册一次");
});

test("transitionend 缺失时兜底定时器移除节点", () => {
	const overlay = createOverlayStub();
	const { module, scheduled } = loadBootOverlay({ overlays: [overlay] });

	module.dismissBootOverlay();
	scheduled[0].fn();

	assert.equal(overlay.removed, true);
});

test("main.tsx 不在挂载帧撤遮罩，只保留硬兜底超时", () => {
	assert.doesNotMatch(mainSource, /requestAnimationFrame\(\s*dismissBootOverlay\s*\)/);
	assert.match(mainSource, /import \{ dismissBootOverlay \} from "\.\/utils\/bootOverlay"/);
	assert.match(mainSource, /window\.setTimeout\(dismissBootOverlay, 1500\)/);
	// 迁移后 main.tsx 不再自带实现（避免两份淡出逻辑漂移）
	assert.doesNotMatch(mainSource, /overlay\.classList\.add\("fade-out"\)/);
});

test("App.tsx 以内容就绪信号驱动撤除，hook 未就绪时走宽限定时器", () => {
	assert.match(appSource, /import \{ useBootOverlayReady \} from "\.\/hooks\/app\/useBootOverlayReady"/);
	// 就绪判据必须是「已聚焦会话」，否则会闪引导页空态
	assert.match(appSource, /useBootOverlayReady\(currentSessionId !== undefined\)/);
	assert.match(hookSource, /dismissBootOverlay\(\)/);
	assert.match(hookSource, /window\.setTimeout\(dismissBootOverlay, graceMs\)/);
	assert.match(hookSource, /window\.clearTimeout\(timer\)/);
});
