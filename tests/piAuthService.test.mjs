/**
 * 认证助手宿主服务（PiAuthService）的回归测试。
 *
 * 用假子进程替换 spawn，逐条锁定协议语义与生命周期：单次操作单进程、
 * 事件/提问转发、取消与超时都会回收进程。这些是「点了登录没反应」类
 * 反馈的直接防线，必须能在不启动真实 pi 的情况下断言。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiAuthService, filterSupportedAuthProviders } = loadTsCommonJs("src/main/pi/auth/PiAuthService.ts");

const OK_LAUNCH = { ok: true, nodeExe: "node", helperPath: "/tmp/pi-auth-host.mjs", sdkEntry: "/tmp/pi/dist/index.js", env: { PIDECK_PI_SDK_ENTRY: "/tmp/pi/dist/index.js" } };

/**
 * 生产模块跑在 vm 的另一个 realm 里，其对象原型与本文件不同，直接 deepEqual 会因
 * 「同结构但原型不同」失败。结构断言前先 JSON 归一化成纯数据。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 假子进程：stdin 记录指令，stdout 供测试按行注入协议消息。 */
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
		/** 解析出宿主下发的指令对象，便于断言协议内容而不是字符串。 */
		commands: () => writes.map((line) => JSON.parse(line)),
		emitLine: (message) => stdout.write(`${JSON.stringify(message)}\n`),
		emitRawLine: (line) => stdout.write(`${line}\n`),
		emitSpawnError: (error) => child.emit("error", error),
		emitClose: (code) => child.emit("close", code),
	};
}

function createService(overrides = {}) {
	const harnesses = [];
	const spawnCalls = [];
	const service = new PiAuthService({
		resolveLaunch: overrides.resolveLaunch ?? (() => OK_LAUNCH),
		spawnFn: (command, args, options) => {
			spawnCalls.push({ command, args, options });
			const harness = createHarness();
			harnesses.push(harness);
			return harness.child;
		},
		timeouts: { short: overrides.shortTimeout ?? 200, login: overrides.loginTimeout ?? 200 },
		logger: undefined,
	});
	return { service, harnesses, spawnCalls, latest: () => harnesses.at(-1) };
}

test("listProviders: 写 list 指令、回读供应商、结束即回收进程", async () => {
	const { service, spawnCalls, latest } = createService();
	const pending = service.listProviders();
	// ready 早于等待者注册：消息泵必须缓存，否则这里会退化成超时。
	latest().emitLine({ type: "ready", protocolVersion: 1, piVersion: "0.86.0" });
	latest().emitLine({ type: "providers", providers: [{ id: "kimi", name: "Kimi", oauth: { label: "Sign in with Kimi Code", isSubscription: true } }], piVersion: "0.86.0" });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.list.piVersion, "0.86.0");
	assert.deepEqual(plain(result.list.providers.map((provider) => provider.id)), ["kimi"]);
	assert.deepEqual(latest().commands(), [{ cmd: "list" }]);
	assert.equal(latest().child.killed, true);
	assert.equal(spawnCalls[0].command, "node");
	assert.deepEqual(plain(spawnCalls[0].args), ["/tmp/pi-auth-host.mjs"]);
});

test("listProviders: 滤掉 models.json 自定义供应商，只留 pi 支持的", async () => {
	const { service, latest } = createService();
	const pending = service.listProviders();
	latest().emitLine({
		type: "providers",
		// pi 的 getProviders() 把内置目录与本地自定义合成一份；自定义项自带 apiKey 认证描述，
		// 如果没有 builtIn 标记就会淹没登录列表（正是用户反馈「怎么多了好多认证供应商」）。
		providers: [
			{ id: "anthropic", name: "Anthropic", builtIn: true, oauth: { label: "Anthropic (Claude Pro/Max)", isSubscription: true } },
			{ id: "ai88", name: "ai88", builtIn: false, apiKey: { name: "API key", canLogin: true } },
			{ id: "custom-gateway", name: "Custom Gateway", builtIn: false, apiKey: { name: "API key", canLogin: true } },
		],
	});
	const result = await pending;
	assert.equal(result.ok, true);
	assert.deepEqual(plain(result.list.providers.map((provider) => provider.id)), ["anthropic"]);
});

test("filterSupportedAuthProviders: 只在明确非内置时丢弃，没有标记一律保留", () => {
	const annotated = plain(
		filterSupportedAuthProviders([
			{ id: "builtin", name: "Builtin", builtIn: true, ambientOnly: false },
			{ id: "custom", name: "Custom", builtIn: false, ambientOnly: false },
		]),
	);
	assert.deepEqual(
		annotated.map((provider) => provider.id),
		["builtin"],
	);

	// 旧助手/pi 改了内部结构 → 没有 builtIn 字段：宁可多显示，不能把列表清空。
	const unmarked = plain(filterSupportedAuthProviders([{ id: "kimi", name: "Kimi", ambientOnly: false }]));
	assert.deepEqual(
		unmarked.map((provider) => provider.id),
		["kimi"],
	);
	assert.equal(unmarked.length, 1);
});

test("listProviders: 助手 fatal（SDK 加载失败）归类为 sdk-unavailable 并带上原因", async () => {
	const { service, latest } = createService();
	const pending = service.listProviders();
	latest().emitLine({ type: "fatal", stage: "sdk-load", message: "Cannot find module '/tmp/pi/dist/index.js'" });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "sdk-unavailable");
	assert.match(result.error, /Cannot find module/);
	assert.equal(latest().child.killed, true);
});

test("login: 事件与提问转发给渲染层，回答与结果按协议回传", async () => {
	const { service, latest } = createService();
	const updates = [];
	service.setFlowSink((update) => updates.push(update));
	const pending = service.login({ providerId: "kimi", method: "oauth" });
	latest().emitLine({ type: "ready" });
	latest().emitLine({ type: "event", event: { type: "auth_url", url: "https://example.com/oauth" } });
	latest().emitLine({ type: "event", event: { type: "unknown-future-event", foo: 1 } });
	latest().emitLine({ type: "event", event: { type: "info", message: "等待浏览器授权" } });
	latest().emitLine({ type: "prompt", id: "p1", prompt: { kind: "manual_code", message: "粘贴授权码" } });
	// 提问到达后，宿主回填必须落成 answer 指令。
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(service.answerPrompt("p1", "123456"), true);
	latest().emitLine({ type: "result", ok: true, cancelled: false, command: "login", providerId: "kimi" });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.cancelled, false);
	assert.equal(result.error, undefined);
	assert.deepEqual(plain(updates), [
		{ kind: "event", event: { type: "auth_url", url: "https://example.com/oauth" } },
		{ kind: "event", event: { type: "info", message: "等待浏览器授权" } },
		{ kind: "prompt", prompt: { id: "p1", kind: "manual_code", message: "粘贴授权码" } },
	]);
	assert.deepEqual(latest().commands(), [
		{ cmd: "login", providerId: "kimi", type: "oauth" },
		{ cmd: "answer", id: "p1", value: "123456" },
	]);
});

test("login: 取消发出 cancel 指令，结果标记 cancelled 且不报错", async () => {
	const { service, latest } = createService();
	const pending = service.login({ providerId: "kimi", method: "oauth" });
	latest().emitLine({ type: "ready" });
	assert.equal(service.cancel(), true);
	latest().emitLine({ type: "result", ok: false, cancelled: true, command: "login", providerId: "kimi" });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.cancelled, true);
	assert.equal(result.error, undefined);
	assert.equal(result.errorKind, undefined);
	assert.deepEqual(latest().commands().at(-1), { cmd: "cancel" });
});

test("login: pi 侧自行解决的提问会推送 prompt-cancelled", async () => {
	const { service, latest } = createService();
	const updates = [];
	service.setFlowSink((update) => updates.push(update));
	const pending = service.login({ providerId: "kimi", method: "oauth" });
	latest().emitLine({ type: "prompt", id: "p9", prompt: { kind: "text", message: "输入" } });
	await new Promise((resolve) => setImmediate(resolve));
	latest().emitLine({ type: "prompt-cancelled", id: "p9" });
	latest().emitLine({ type: "result", ok: true, cancelled: false, providerId: "kimi" });
	await pending;
	assert.deepEqual(plain(updates.at(-1)), { kind: "prompt-cancelled", promptId: "p9" });
});

test("login: 并发登录被拒绝为 busy，且不会拉起第二个助手进程", async () => {
	const { service, spawnCalls, latest } = createService();
	const pending = service.login({ providerId: "kimi", method: "oauth" });
	const second = await service.login({ providerId: "openai", method: "api_key" });
	assert.equal(second.ok, false);
	assert.equal(second.errorKind, "busy");
	assert.equal(spawnCalls.length, 1);
	latest().emitLine({ type: "result", ok: true, cancelled: false, providerId: "kimi" });
	await pending;
	assert.equal(service.busy, false);
});

test("login: 助手进程无法启动归类为 spawn-failed", async () => {
	const { service, latest } = createService();
	const pending = service.login({ providerId: "kimi", method: "oauth" });
	latest().emitSpawnError(new Error("spawn node ENOENT"));
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "spawn-failed");
	assert.match(result.error, /ENOENT/);
});

test("login: 启动参数解析失败时给出提示且不 spawn", async () => {
	const { service, spawnCalls } = createService({ resolveLaunch: () => ({ ok: false, reason: "wsl", detail: "wsl://Ubuntu/user/usr/bin/pi" }) });
	const result = await service.login({ providerId: "kimi", method: "oauth" });
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "sdk-unavailable");
	assert.match(result.error, /WSL/);
	assert.equal(spawnCalls.length, 0);
});

test("listProviders: 助手无响应时按超时结算并杀掉进程", async () => {
	const { service, latest } = createService({ shortTimeout: 30 });
	const result = await service.listProviders();
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "timeout");
	assert.match(result.error, /30ms/);
	assert.equal(latest().child.killed, true);
});

test("助手异常退出（未给结果）时带上退出码收尾", async () => {
	const { service, latest } = createService();
	const pending = service.login({ providerId: "kimi", method: "oauth" });
	latest().emitLine({ type: "ready" });
	latest().emitClose(1);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "protocol");
	assert.match(result.error, /code 1/);
});

test("dispose 会结算进行中的登录并回收进程", async () => {
	const { service, latest } = createService({ loginTimeout: 5_000 });
	const pending = service.login({ providerId: "kimi", method: "oauth" });
	service.dispose();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.errorKind, "protocol");
	assert.equal(latest().child.killed, true);
});

test("logout: 下发登出指令并回读结果", async () => {
	const { service, latest } = createService();
	const pending = service.logout("kimi");
	latest().emitLine({ type: "result", ok: true, cancelled: false, command: "logout", providerId: "kimi" });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.error, undefined);
	assert.deepEqual(latest().commands(), [{ cmd: "logout", providerId: "kimi" }]);
});

test("非协议输出（非 JSON / 空行 / 未知消息）不会打断流程", async () => {
	const { service, latest } = createService();
	const pending = service.listProviders();
	latest().emitRawLine("this is not json");
	latest().emitRawLine("");
	latest().emitLine({ type: "some-unknown-message" });
	latest().emitLine({ type: "providers", providers: [] });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.deepEqual(plain(result.list.providers), []);
});
