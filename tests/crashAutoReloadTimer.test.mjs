import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// fake timers：Windows 上 node 的 setInterval 实际间隔受系统计时器分辨率
// （~15.6ms）影响，真实计时器会让毫秒级断言 flaky；改为注入确定性时钟。
function createFakeTimers() {
	let now = 0;
	let seq = 0;
	const tasks = new Map(); // id -> { fn, ms, next }
	return {
		globals: {
			setInterval: (fn, ms) => {
				const id = ++seq;
				tasks.set(id, { fn, ms, next: now + ms });
				return id;
			},
			clearInterval: (id) => {
				tasks.delete(id);
			},
		},
		reset() {
			now = 0;
			tasks.clear();
		},
		// 推进虚拟时钟，按 next 顺序触发到期回调（回调内可 stop/start，行为与真实 timer 一致）
		advance(ms) {
			const target = now + ms;
			let guard = 0;
			for (;;) {
				if (guard++ > 10000) throw new Error("fake timer runaway loop");
				let nextTask = null;
				for (const t of tasks.values()) {
					if (!nextTask || t.next < nextTask.next) nextTask = t;
				}
				if (!nextTask || nextTask.next > target) break;
				now = nextTask.next;
				nextTask.fn();
				nextTask.next += nextTask.ms;
			}
			now = target;
		},
	};
}

const fake = createFakeTimers();
const { AutoReloadTimer } = loadTsCommonJs("src/renderer/src/utils/crashAutoReloadTimer.ts", { globals: fake.globals });

test("StrictMode 伪生命周期后 ensure 重建 timer，倒计时继续（回归：文案停在 5 不递减）", () => {
	fake.reset();
	const ticks = [];
	let done = 0;
	const timer = new AutoReloadTimer({
		onTick: (n) => ticks.push(n),
		onDone: () => {
			done += 1;
		},
	});

	// 模拟 React 19 StrictMode 对 error fallback 的伪生命周期：
	// componentDidCatch 创建 timer → 伪卸载（componentWillUnmount 会 stop）→
	// remount（componentDidMount 必须 ensure 兜底重建，否则 timer 永久失活）
	timer.start(3);
	timer.stop();
	timer.ensure(3);

	assert.equal(timer.running, true, "remount 后 timer 必须存活");
	fake.advance(3000);
	assert.equal(done, 1, "倒计时归零后 onDone 恰好一次");
	assert.deepEqual(ticks, [2, 1], "tick 递减 3→2→1");
});

test("正常挂载（无错误/无倒计时）：ensure 不启动 timer", () => {
	fake.reset();
	const timer = new AutoReloadTimer({ onTick: () => {}, onDone: () => {} });
	timer.ensure(null);
	assert.equal(timer.running, false, "seconds=null 不启动");
	timer.ensure(0);
	assert.equal(timer.running, false, "seconds=0 不启动");
});

test("用户取消后（state.autoReloadSeconds=null）：ensure 不再启动", () => {
	fake.reset();
	const timer = new AutoReloadTimer({ onTick: () => {}, onDone: () => {} });
	timer.start(3);
	timer.stop();
	timer.ensure(null);
	assert.equal(timer.running, false);
});

test("ensure 不重复创建：已有存活 timer 时保持原计数不重置", () => {
	fake.reset();
	const ticks = [];
	const timer = new AutoReloadTimer({
		onTick: (n) => ticks.push(n),
		onDone: () => {},
	});
	timer.start(3);
	timer.ensure(3); // timer 已在跑，ensure 必须 no-op
	fake.advance(2000);
	assert.deepEqual(ticks, [2, 1], "ensure 不得把倒计时重置回 3");
	timer.stop();
});

test("start 重启：取消后再次崩溃时从新秒数重新倒计时", () => {
	fake.reset();
	const ticks = [];
	let done = 0;
	const timer = new AutoReloadTimer({
		onTick: (n) => ticks.push(n),
		onDone: () => {
			done += 1;
		},
	});
	timer.start(2);
	timer.stop(); // 用户取消
	timer.start(2); // 再次崩溃
	fake.advance(2000);
	assert.equal(done, 1);
	assert.deepEqual(ticks, [1]);
	timer.stop();
});
