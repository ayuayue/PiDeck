/**
 * PetPatrol 业务空闲守卫测试（node --test）。
 *
 * 背景：多任务并发下，宠物巡游（每 50ms 直推 running-left/right）可能覆盖
 * bridge 推送的 failed/review/waiting 动画。修复后巡游只在业务态为 idle 时
 * 行进：beginWalk 前检查一次（停顿期业务转非 idle 不起步），tick 中检查
 * （行进中业务转非 idle 立即停）。本文件用 vm 加载 PetPatrol.ts（mock
 * electron.screen 与 ipc 常量、伪时钟），验证这两处守卫与正常巡游不回归。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 伪时钟：setTimeout/setInterval 全部可推进；Date.now() 跟随同一时钟，
 * 保证 tick 步长（speed × delta）确定（50ms → 2px），否则真实时间下步长≈0。
 * 注意 Math 方法不可枚举，不能用展开复制；Object.create 保留原型链再覆盖 random。
 */
function createClock() {
	let now = 0;
	let nextId = 1;
	const tasks = new Map();
	return {
		get now() {
			return now;
		},
		Date: { now: () => now },
		Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
		timers: {
			setTimeout: (fn, ms) => {
				const id = nextId++;
				tasks.set(id, { fn, at: now + ms, interval: false });
				return id;
			},
			clearTimeout: (id) => {
				tasks.delete(id);
			},
			setInterval: (fn, ms) => {
				const id = nextId++;
				tasks.set(id, { fn, at: now + ms, interval: true, ms });
				return id;
			},
			clearInterval: (id) => {
				tasks.delete(id);
			},
		},
		advance(ms) {
			const target = now + ms;
			// 时钟按任务到期时刻逐条推进：回调中新排的 timer/interval 以当前任务时间
			// 为基准（否则一次性跳到 target 会让新 interval 落在窗口外，永远不触发）
			for (let pass = 0; pass < 10000; pass++) {
				const due = [...tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
				if (due.length === 0) break;
				const [id, t] = due[0];
				now = t.at;
				if (t.interval) tasks.set(id, { ...t, at: t.at + t.ms });
				else tasks.delete(id);
				t.fn();
			}
			now = target;
		},
	};
}

/** 用 vm 加载 PetPatrol.ts：mock electron.screen、ipc 常量与伪时钟 */
function loadPatrol(clock) {
	const source = readFileSync("src/main/pet/PetPatrol.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	const sandbox = {
		module,
		exports: module.exports,
		...clock.timers,
		Date: clock.Date,
		Math: clock.Math,
		require: (id) => {
			if (id === "electron") {
				return {
					screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
				};
			}
			if (id.endsWith("shared/ipc")) {
				return { ipcChannels: { petState: "pet:state" } };
			}
			throw new Error(`unexpected require: ${id}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "PetPatrol.ts" });
	return module.exports;
}

/** 场景骨架：伪窗口 + 状态/位移记录 + 业务空闲开关 */
function createScenario() {
	const clock = createClock();
	const { PetPatrol } = loadPatrol(clock);
	// 起始 x 落在 workArea 内（leftEdge=16 之内会触发 clampX 首帧跳变 → 被巡游自身的
	// 「异常跳变」守卫误判为外部搬动而 halt；从 100 起步模拟真实场景）
	let x = 100,
		y = 400;
	const states = [];
	const moves = [];
	const win = {
		getPosition: () => [x, y],
		getSize: () => [192, 208],
		setPosition: (nx, ny) => {
			x = nx;
			y = ny;
		},
		isDestroyed: () => false,
		webContents: {
			send: (ch, p) => {
				if (ch === "pet:state") states.push(p);
			},
		},
	};
	let businessIdle = true;
	const patrol = new PetPatrol(
		() => win,
		() => 1, // 停顿 1 分钟（random=0.5 → 恰好 60000ms）
		(nx, ny) => {
			moves.push([nx, ny]);
			win.setPosition(nx, ny);
		},
	);
	patrol.setBusinessIdleCheck(() => businessIdle);
	return {
		clock,
		patrol,
		states,
		moves,
		getX: () => x,
		setBusinessIdle: (v) => {
			businessIdle = v;
		},
	};
}

test("正常巡游：停顿结束后开始行走，走到边界返回 idle", () => {
	const { clock, patrol, states, moves, getX } = createScenario();
	patrol.start();
	// 停顿期只有 idle 状态，无位移
	assert.equal(states.at(-1).mode, "idle");
	assert.equal(moves.length, 0);
	// 停顿结束（60000ms）→ 开始行走
	clock.advance(61000);
	assert.equal(states.at(-1).mode, "running-right");
	assert.ok(moves.length > 0, "行走开始后应有位移");
	assert.ok(getX() > 100, "应向右移动过");
	// 继续走到右边界（100→1712，2px/50ms）→ 回到 idle 待机
	clock.advance(50000);
	assert.equal(states.at(-1).mode, "idle");
});

test("停顿期业务转非 idle：不起步行走", () => {
	const { clock, patrol, states, moves, setBusinessIdle } = createScenario();
	patrol.start();
	// 停顿中业务转 running（出错/待输入同理）
	clock.advance(59000);
	setBusinessIdle(false);
	clock.advance(3000); // 越过停顿到期点
	assert.equal(states.at(-1).mode, "idle", "不起步，不推 running-left/right");
	assert.equal(moves.length, 0, "无任何位移");
});

test("行进中业务转非 idle：立即停止，不再产生位移与状态推送", () => {
	const { clock, patrol, states, moves, setBusinessIdle } = createScenario();
	patrol.start();
	clock.advance(61000); // 已开始行走
	assert.equal(states.at(-1).mode, "running-right");
	assert.ok(moves.length > 0);
	setBusinessIdle(false);
	clock.advance(60); // 下一个 tick：守卫生效，停巡游
	const movesAfterStop = moves.length;
	clock.advance(500); // 不再有 tick
	assert.equal(moves.length, movesAfterStop, "停止后不再移动");
	assert.equal(states.at(-1).mode, "running-right", "停止后不再推送新状态（状态由桥接层接管）");
});

test("业务恢复 idle 后可再次起巡游", () => {
	const { clock, patrol, states, setBusinessIdle } = createScenario();
	patrol.start();
	clock.advance(61000); // 行走中
	setBusinessIdle(false);
	clock.advance(100);
	// 业务恢复 idle → 重新 start 巡游
	setBusinessIdle(true);
	patrol.start();
	clock.advance(61000);
	assert.equal(states.at(-1).mode, "running-right", "业务 idle 后恢复行走");
});
