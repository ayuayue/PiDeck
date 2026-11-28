import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 收敛循环（runJumpSettle）的行为判据：用假 ports 驱动帧，断言它「写了几次滚动、第几帧停、
 * 停的时候带什么 reason」。
 *
 * 为什么要有这一条：策略判定（planJumpSettleStep）早就有测试，但那只是「单帧怎么判」。
 * 真正决定用户体验的是循环——漂移要不要追、追几帧、什么时候收手、停手时钉行怎么处理。
 * 那部分原先长在 useTimelineJumpNavigation 里，与 querySelector / getBoundingClientRect /
 * requestAnimationFrame 缠在一起，只能真机验。抽成 ports 之后，这里用假的三种输入
 * （测量 / 滚动 / 帧）就能跑出真机才会出现的时序。
 *
 * 口径：帧是手动泵的（`pump()` 一次跑一帧），不是真定时器 —— 判据要能重复跑出同一个数。
 */
const { runJumpSettle, JUMP_SETTLE_MAX_FRAMES, JUMP_SETTLE_MAX_MS, JUMP_SETTLE_TOLERANCE_PX } = (() => {
	const run = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpSettleRun.ts");
	const plan = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpSettle.ts");
	return { ...run, ...plan };
})();

function makeHarness(options = {}) {
	const drifts = options.drifts ?? [];
	const scrolls = [];
	const stops = [];
	const frames = { queued: new Map(), nextId: 1, cancelled: new Set() };
	let tick = 0;
	let measured = 0;
	let lastCallback = null;

	const ports = {
		// 每帧返回下一个漂移；drifts 用完后一直返回最后一个（模拟「追不到」）
		measure: () => {
			const index = Math.min(measured, drifts.length - 1);
			const drift = drifts.length === 0 ? null : drifts[index];
			measured += 1;
			if (drift === null || drift === undefined) return null;
			return { height: options.height ?? 100, top: drift, viewportTop: 0 };
		},
		scrollBy: (delta) => {
			scrolls.push(delta);
		},
		nextFrame: (callback) => {
			const id = frames.nextId++;
			frames.queued.set(id, callback);
			return id;
		},
		cancelFrame: (handle) => {
			frames.cancelled.add(handle);
			frames.queued.delete(handle);
		},
		measureCount: () => measured,
		now: () => {
			tick += options.msPerFrame ?? 16;
			return tick;
		},
		interrupted: () => options.interruptedAfter !== undefined && scrolls.length >= options.interruptedAfter,
	};

	const cancel = runJumpSettle(ports, { onStop: (reason) => stops.push(reason) });

	return {
		scrolls,
		stops,
		cancel,
		measureCount: () => measured,
		// 泵一帧：取出唯一在排队的回调并执行
		pump() {
			const entry = [...frames.queued.entries()][0];
			if (!entry) return false;
			frames.queued.delete(entry[0]);
			lastCallback = entry[1];
			entry[1]();
			return true;
		},
		// 重入最后一帧：模拟外部持有已取消帧的句柄又跑了一次
		reinvokeLastFrame() {
			lastCallback?.();
		},
		pumpAll(limit = 100) {
			let count = 0;
			while (count < limit && this.pump()) count += 1;
			return count;
		},
	};
}

test("漂移 100 → 50 → 0：写两次滚动后就收敛", () => {
	const h = makeHarness({ drifts: [100, 50, 0] });
	h.pumpAll();
	assert.deepEqual(h.scrolls, [100, 50], "只按实测漂移补两次，第三次量到 0 就停");
	assert.deepEqual(h.stops, [], "收敛不是 give-up，不进 onStop");
});

test("漂移在容差内直接收敛，一次都不写", () => {
	const h = makeHarness({ drifts: [JUMP_SETTLE_TOLERANCE_PX] });
	h.pumpAll();
	assert.deepEqual(h.scrolls, []);
});

test("量不到（null）→ target-missing，一次都不写", () => {
	const h = makeHarness({ drifts: [null] });
	h.pumpAll();
	assert.deepEqual(h.scrolls, []);
	assert.deepEqual(h.stops, ["target-missing"]);
});

test("高度为 0（折叠区 display:none）当作量不到，不当成巨大漂移", () => {
	const h = makeHarness({ drifts: [500], height: 0 });
	h.pumpAll();
	assert.deepEqual(h.scrolls, [], "高度 0 的 rect 全为 0，绝不能拿去算漂移");
	assert.deepEqual(h.stops, ["target-missing"]);
});

test("用户动手：下一帧就收手，且不再写滚动", () => {
	const h = makeHarness({ drifts: [100, 100, 100, 100], interruptedAfter: 1 });
	h.pumpAll();
	assert.deepEqual(h.scrolls, [100], "动手之前写完那一次，之后一次都不写");
	assert.deepEqual(h.stops, ["interrupted"]);
});

test("一直追不到：到帧数上限就放弃，不是无限循环", () => {
	const h = makeHarness({ drifts: Array.from({ length: 50 }, () => 100), msPerFrame: 1 });
	h.pumpAll(JUMP_SETTLE_MAX_FRAMES + 10);
	assert.equal(h.scrolls.length, JUMP_SETTLE_MAX_FRAMES, "写满帧数上限");
	assert.deepEqual(h.stops, ["frames"]);
});

test("低帧率设备：时间上限先到就按 timeout 收手", () => {
	const h = makeHarness({ drifts: Array.from({ length: 50 }, () => 100), msPerFrame: JUMP_SETTLE_MAX_MS });
	h.pumpAll(5);
	assert.deepEqual(h.stops, ["timeout"], "帧数还没到上限，但时间到了");
	assert.ok(h.scrolls.length < JUMP_SETTLE_MAX_FRAMES);
});

test("取消之后即使有人重入 nextFrame，回调也不再执行", () => {
	const h = makeHarness({ drifts: [100, 100, 100] });
	h.pump();
	const measuredBefore = h.measureCount();
	h.cancel();
	// 模拟「外部把上一帧的句柄又跑了一次」：这正是 cancelFrame 之外需要 stopped 标记的理由。
	// 没有 stopped 时这一下会真的再量一次、再写一次滚动。
	h.reinvokeLastFrame();
	assert.equal(h.measureCount(), measuredBefore, "重入也不测量");
	assert.deepEqual(h.scrolls, [100], "重入不再写滚动");
});

test("取消之后不再测量、不再写滚动，也不报任何 reason", () => {
	const h = makeHarness({ drifts: [100, 100, 100] });
	h.pump();
	const wrote = h.scrolls.length;
	const measuredBefore = h.measureCount();
	h.cancel();
	h.pumpAll();
	assert.equal(h.scrolls.length, wrote, "取消后一帧都不许再写");
	assert.equal(h.measureCount(), measuredBefore, "取消后连测量都不该发生（stopped 兜住，撤帧是冗余的那一层）");
	assert.deepEqual(h.stops, []);
});
