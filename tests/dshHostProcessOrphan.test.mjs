/**
 * DshHostProcess 启动失败的进程收尸（孤儿进程回归）。
 *
 * 背景（2026-10 内存排查，真实日志复现）：
 * 1. host 冷启动超过 host-ready 等待上限（默认 30s）→ waitForReady 超时 reject；
 * 2. DshHost.start() 抛错 → ensureStarted 把 startPromise 置空，允许重试；
 * 3. 重试新建 DshHostProcess 并覆盖 DshHost.hostProcess 引用；
 * 4. 步骤 1 那个进程从未被 kill → 两代 host 同时存活（实测各约 250MB），
 *    并互相争抢同一个 DSH_HOME 锁。
 *
 * 契约：start() 以任何方式失败（boot 超时 / 早于 ready 退出 / dispose 打断）时，
 * 被 fork 的进程必须已终止；进程不退出时走宽限期后强制终止并返回，绝不悬挂。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshHostProcess } = loadTsCommonJs("src/main/dsh/DshHostProcess.ts");

const NOOP = () => {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 最小 utilityProcess 桩：记录 kill 次数，可模拟「kill 后立即退出」与「赖着不退」。 */
function createFakeChild({ exitsOnKill = true } = {}) {
	const listeners = new Map();
	const child = {
		pid: 4242,
		killCalls: 0,
		stderr: { on: NOOP },
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(handler);
		},
		once(event, handler) {
			this.on(event, handler);
		},
		postMessage: NOOP,
		kill() {
			this.killCalls += 1;
			if (exitsOnKill) this.emit("exit", 0);
		},
		emit(event, ...args) {
			for (const handler of listeners.get(event) ?? []) handler(...args);
		},
		/** 模拟 host 发来 host-ready。 */
		ready() {
			this.emit("message", { type: "host-ready" });
		},
	};
	return child;
}

/** 构造被测对象：fork 返回桩进程，boot 等待压到毫秒级。 */
function createProc(child, { bootReadyTimeoutMs = 30, log } = {}) {
	return new DshHostProcess("entry.js", [], {}, log ?? NOOP, () => false, {
		fork: () => child,
		bootReadyTimeoutMs,
	});
}

test("start: boot 超时必须终止已 fork 的进程（不留孤儿）", async () => {
	const child = createFakeChild();
	const proc = createProc(child);
	await assert.rejects(
		() => proc.start(),
		(error) => /did not become ready/.test(String(error?.message ?? error)),
		"超时必须以可辨识文案失败，便于调用方归因",
	);
	assert.equal(child.killCalls, 1, "超时后必须 kill 一次，否则重试会留下第二个 host 进程");
	assert.equal(proc.isRunning(), false, "kill 完成后不得再报告 host 仍在运行");
});

test("start: 迟到 host-ready 不得把已被 kill 的实例标记为 ready", async () => {
	const child = createFakeChild();
	const log = [];
	const proc = createProc(child, { bootReadyTimeoutMs: 20, log: (scope, message) => log.push(`${scope}: ${message}`) });
	await assert.rejects(() => proc.start());
	// 真实 utilityProcess 在 kill 生效前可能已经发出 host-ready（进程在途消息）。
	child.ready();
	assert.equal(proc.isReady(), false, "已被淘汰的进程迟到 ready 不应让实例回到 ready 状态");
	const readyLogs = log.filter((line) => line.includes("host ready"));
	assert.equal(readyLogs.length, 0, "迟到 ready 不得触发 onReady 订阅者（会按「启动成功」恢复崩溃前状态）");
});

test("start: host 早于 ready 退出时收敛为失败，且不留下存活进程", async () => {
	const child = createFakeChild();
	// boot 崩溃会触发自动重启（E3 限次语义另有测试）；这里让重试的 fork 直接失败，
	// 于是 start() 必须以 boot 失败文案 reject，且最终没有任何进程被认为在运行。
	let forks = 0;
	const proc = new DshHostProcess("entry.js", [], {}, NOOP, () => false, {
		fork: () => {
			forks += 1;
			if (forks > 1) throw new Error("fork refused for test");
			return child;
		},
		bootReadyTimeoutMs: 50,
	});
	const started = proc.start();
	await tick();
	child.emit("exit", 1);
	await assert.rejects(started, /exited before ready/);
	await tick();
	assert.equal(proc.isRunning(), false, "boot 失败后不得报告 host 仍在运行");
	assert.equal(child.killCalls, 0, "已经自己退出的进程不需要再 kill");
});

test("start: 成功 ready 后不产生多余 kill", async () => {
	const child = createFakeChild();
	const proc = createProc(child);
	const started = proc.start();
	await tick();
	child.ready();
	await started;
	assert.equal(proc.isReady(), true);
	assert.equal(child.killCalls, 0, "正常启动路径不得 kill 进程");
});

test("kill: 并发调用必须等待同一进程真正退出（不得复用已 settle 的 Promise 提前返回）", async () => {
	const child = createFakeChild({ exitsOnKill: false });
	const proc = createProc(child);
	const started = proc.start();
	await tick();
	// 第一次 kill：进程赖着不退 → 进入宽限期
	const first = proc.kill();
	// 第二次 kill 并发进来：必须复用同一个等待，而不是立刻返回
	const second = proc.kill();
	let secondDone = false;
	void second.then(() => {
		secondDone = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(secondDone, false, "进程未退出前第二次 kill 不得提前完成");
	// 放行进程退出，结束宽限期兜底
	child.emit("exit", 0);
	await Promise.all([first, second]);
	await started.catch(() => {});
	assert.equal(proc.isRunning(), false);
});

test("start: 进程不响应 kill 时，宽限期后强制终结并返回（不悬挂）", async () => {
	const child = createFakeChild({ exitsOnKill: false });
	const proc = createProc(child, { bootReadyTimeoutMs: 10 });
	// 直接走超时收尸：kill 无法让进程退出，必须靠宽限期兜底返回
	await assert.rejects(() => proc.start(), /did not become ready/);
	assert.ok(child.killCalls >= 2, "宽限期后必须再强制终止一次");
});
