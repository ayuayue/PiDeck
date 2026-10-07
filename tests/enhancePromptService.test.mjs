/**
 * 提示词增强宿主服务（EnhancePromptService）的回归测试。
 *
 * 用假子进程替换 spawn，锁定常驻单进程多 run 的生命周期语义：新 run 打断旧
 * run、取消、超时、进程死亡都会结算回调（每个回调恰好一次），旧 id 的迟到
 * 记录被丢弃。这些是「点了增强没反应/回填错会话」类反馈的直接防线。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { EnhancePromptService, ENHANCE_SYSTEM_PROMPT, MAX_ENHANCE_HOST_LINE_CHARS } = loadTsCommonJs("src/main/pi/enhance/EnhancePromptService.ts");

const OK_LAUNCH = { ok: true, nodeExe: "node", helperPath: "/tmp/pi-enhance-host.mjs", sdkEntry: "/tmp/pi/dist/index.js", env: { PIDECK_PI_SDK_ENTRY: "/tmp/pi/dist/index.js" } };

/** 假子进程：stdin 记录指令，stdout 供测试按行注入协议记录。 */
function createHarness() {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = new EventEmitter();
	const writes = [];
	child.stdout = stdout;
	child.stderr = stderr;
	child.stdin = {
		destroyed: false,
		write: (chunk) => {
			writes.push(String(chunk));
			return true;
		},
	};
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		return true;
	};
	return {
		child,
		writes,
		commands: () => writes.map((line) => JSON.parse(line)),
		emitLine: (message) => stdout.write(`${JSON.stringify(message)}\n`),
		emitRaw: (text) => stdout.write(text),
		emitClose: (code) => child.emit("close", code),
	};
}

function createRecorder() {
	const events = [];
	return {
		events,
		callbacks: {
			onDelta: (text) => events.push({ kind: "delta", text }),
			onDone: (text) => events.push({ kind: "done", text }),
			onAborted: () => events.push({ kind: "aborted" }),
			onError: (errorKind, message) => events.push({ kind: "error", errorKind, message }),
		},
	};
}

function createService(overrides = {}) {
	const harnesses = [];
	const spawnCalls = [];
	const service = new EnhancePromptService({
		resolveLaunch: overrides.resolveLaunch ?? (() => OK_LAUNCH),
		spawnFn: (command, args, options) => {
			spawnCalls.push({ command, args, options });
			const harness = createHarness();
			harnesses.push(harness);
			return harness.child;
		},
		timeouts: { boot: overrides.bootTimeout ?? 500, run: overrides.runTimeout ?? 5_000 },
	});
	return { service, harnesses, spawnCalls, latest: () => harnesses.at(-1) };
}

/** 受理一个 run：spawn → ready → enhance → 等受理结果。 */
async function acceptRun(service, latest, input) {
	const recorder = createRecorder();
	const pending = service.enhance(input ?? { provider: "kimi-coding", modelId: "kimi-k2", userText: "帮我写个爬虫" }, recorder.callbacks);
	// 受理路径经 acceptChain 串行化（微任务）后才 spawn；先冲刷微任务队列再注入 ready。
	await new Promise((resolve) => setImmediate(resolve));
	latest().emitLine({ type: "ready", protocolVersion: 1 });
	const result = await pending;
	return { recorder, result };
}

test("受理：下发 complete 指令并转发 started/delta/done", async () => {
	const { service, latest } = createService();
	const { recorder, result } = await acceptRun(service, latest);
	assert.equal(result.ok, true);
	const command = latest().commands().at(-1);
	assert.equal(command.cmd, "complete");
	assert.equal(command.provider, "kimi-coding");
	assert.equal(command.modelId, "kimi-k2");
	assert.equal(command.userText, "帮我写个爬虫");
	// 内置模板必须随指令下发（workbuddy 风格增强提示词，含语言一致硬约束）。
	assert.ok(command.systemPrompt.includes("提示词工程专家"));
	assert.ok(command.systemPrompt.includes("语言一致"));

	latest().emitLine({ type: "delta", id: result.runId, text: "增强后" });
	latest().emitLine({ type: "delta", id: result.runId, text: "的提示词" });
	latest().emitLine({ type: "done", id: result.runId, text: "增强后的提示词" });
	await Promise.resolve();
	assert.deepEqual(recorder.events, [
		{ kind: "delta", text: "增强后" },
		{ kind: "delta", text: "的提示词" },
		{ kind: "done", text: "增强后的提示词" },
	]);
});

test("新 run 打断旧 run：旧回调立即 aborted，旧 id 迟到记录被丢弃", async () => {
	const { service, latest } = createService();
	const first = await acceptRun(service, latest);
	const second = await acceptRun(service, latest);
	// 旧 run 在新 run 受理路径里被本地结算（不等助手响应）。
	assert.deepEqual(first.recorder.events, [{ kind: "aborted" }]);

	// 旧 id 的迟到 delta/done 不产生任何回调。
	latest().emitLine({ type: "delta", id: first.result.runId, text: "过期输出" });
	latest().emitLine({ type: "done", id: first.result.runId, text: "过期结果" });
	latest().emitLine({ type: "delta", id: second.result.runId, text: "新输出" });
	await Promise.resolve();
	assert.deepEqual(second.recorder.events, [{ kind: "delta", text: "新输出" }]);
	// 第二次受理没有重新 spawn：常驻进程复用。
});

test("cancel：下发 cancel 指令并本地结算为 aborted", async () => {
	const { service, latest } = createService();
	const { recorder, result } = await acceptRun(service, latest);
	service.cancel();
	assert.deepEqual(recorder.events, [{ kind: "aborted" }]);
	assert.deepEqual(latest().commands().at(-1), { cmd: "cancel", id: result.runId });
	// 助手稍后补发的 aborted 因 runId 已清空被忽略，不会二次回调。
	latest().emitLine({ type: "error", id: result.runId, errorKind: "aborted", message: "aborted" });
	await Promise.resolve();
	assert.deepEqual(recorder.events, [{ kind: "aborted" }]);
});

test("run 超时：下发 cancel 并结算为 timeout", async () => {
	const { service, latest } = createService({ runTimeout: 40 });
	const { recorder, result } = await acceptRun(service, latest);
	const events = await new Promise((resolve) => {
		const original = recorder.callbacks.onError;
		recorder.callbacks.onError = (kind, message) => {
			original(kind, message);
			resolve(recorder.events);
		};
	});
	assert.deepEqual(events, [{ kind: "error", errorKind: "timeout", message: "增强请求超时，已自动停止" }]);
	assert.deepEqual(latest().commands().at(-1), { cmd: "cancel", id: result.runId });
});

test("助手进程退出：run 结算为 protocol，下次调用重新 spawn", async () => {
	const { service, harnesses, spawnCalls, latest } = createService();
	const { recorder } = await acceptRun(service, latest);
	latest().emitClose(1);
	assert.deepEqual(recorder.events, [{ kind: "error", errorKind: "protocol", message: "增强助手意外退出（code 1）" }]);

	const again = await acceptRun(service, latest);
	assert.equal(again.result.ok, true);
	assert.equal(spawnCalls.length, 2);
	assert.notEqual(harnesses.at(-1), harnesses[0]);
});

test("boot 超时：受理失败 sdk-unavailable，且不残留占位", async () => {
	const { service, latest } = createService({ bootTimeout: 40 });
	const recorder = createRecorder();
	const result = await service.enhance({ provider: "p", modelId: "m", userText: "草稿" }, recorder.callbacks);
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "sdk-unavailable");
	assert.deepEqual(recorder.events, []);
	// boot 失败后下次调用重试新进程（childReady 复位路径）。
	const retry = await acceptRun(service, latest);
	assert.equal(retry.result.ok, true);
});

test("协议版本不匹配：杀进程并按 protocol 结算", async () => {
	const { service, harnesses, latest } = createService();
	const recorder = createRecorder();
	const pending = service.enhance({ provider: "p", modelId: "m", userText: "草稿" }, recorder.callbacks);
	await new Promise((resolve) => setImmediate(resolve));
	latest().emitLine({ type: "ready", protocolVersion: 99 });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "sdk-unavailable");
	assert.equal(harnesses[0].child.killed, true);
});

test("stdout 行缓冲溢出：按 protocol 结算并杀进程", async () => {
	const { service, harnesses, latest } = createService();
	const { recorder } = await acceptRun(service, latest);
	latest().emitRaw("x".repeat(MAX_ENHANCE_HOST_LINE_CHARS + 1));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(recorder.events, [{ kind: "error", errorKind: "protocol", message: "增强助手 stdout 行缓冲溢出" }]);
	assert.equal(harnesses[0].child.killed, true);
});

test("启动参数解析失败：受理直接拒绝，不 spawn", async () => {
	const { service, spawnCalls } = createService({ resolveLaunch: () => ({ ok: false, reason: "helper-missing", detail: "/missing" }) });
	const recorder = createRecorder();
	const result = await service.enhance({ provider: "p", modelId: "m", userText: "草稿" }, recorder.callbacks);
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "sdk-unavailable");
	assert.deepEqual(recorder.events, []);
	assert.deepEqual(spawnCalls, []);
});

test("dispose：结算进行中的 run 并杀掉助手进程", async () => {
	const { service, latest } = createService();
	const { recorder } = await acceptRun(service, latest);
	service.dispose();
	assert.deepEqual(recorder.events, [{ kind: "aborted" }]);
	assert.equal(latest().child.killed, true);
	// dispose 后再受理直接拒绝。
	const after = await service.enhance({ provider: "p", modelId: "m", userText: "草稿" }, createRecorder().callbacks);
	assert.equal(after.ok, false);
	assert.equal(after.errorKind, "sdk-unavailable");
});

test("fatal：结算为 sdk-unavailable 并杀进程", async () => {
	const { service, harnesses, latest } = createService();
	const { recorder } = await acceptRun(service, latest);
	latest().emitLine({ type: "fatal", stage: "sdk-load", message: "cannot import pi" });
	await Promise.resolve();
	assert.deepEqual(recorder.events, [{ kind: "error", errorKind: "sdk-unavailable", message: "cannot import pi" }]);
	assert.equal(harnesses[0].child.killed, true);
});
