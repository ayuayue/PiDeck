/**
 * XueIndexService（Go xue-index sidecar 宿主客户端）的生命周期回归测试。
 *
 * 用假子进程（PassThrough）锁定常驻进程协议语义：ready 握手、请求 id 配对、
 * db 换库重启（远程库更新核心链路）、boot/请求超时、协议版本不匹配、迟到
 * 响应丢弃、dispose 结算。这些是「商店检索卡死/结果错乱/进程泄漏」类问题的
 * 直接防线；Go 侧语义由 native/xue-index/store_test.go 覆盖，这里只测宿主。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { XueIndexService, XUE_INDEX_PROTOCOL_VERSION } = loadTsCommonJs("src/main/prompts/XueIndexService.ts");

/** 假子进程：stdin 记录指令，stdout 供测试按行注入协议记录。 */
function createHarness() {
	const stdout = new PassThrough();
	const child = new EventEmitter();
	const writes = [];
	child.stdout = stdout;
	child.stderr = new PassThrough();
	child.stdin = new EventEmitter();
	child.stdin.destroyed = false;
	child.stdin.write = (chunk) => {
		writes.push(String(chunk));
		return true;
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
	};
}

const SILENT_LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function createService(overrides = {}) {
	const harnesses = [];
	const spawnCalls = [];
	const service = new XueIndexService({
		resolveBinaryPath: overrides.resolveBinaryPath ?? (() => "/fake/xue-index"),
		spawnFn: (command, args, options) => {
			spawnCalls.push({ command, args, options });
			const harness = createHarness();
			harnesses.push(harness);
			return harness.child;
		},
		logger: SILENT_LOGGER,
		timeouts: { boot: overrides.bootTimeout ?? 5_000, request: overrides.requestTimeout ?? 5_000 },
	});
	return { service, harnesses, spawnCalls, latest: () => harnesses.at(-1) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 完成 spawn→ready 握手，返回 { pending }（pending 是未决的 list promise，避免 await 解包连带等待）。 */
async function bootAndList(service, latest, dbPath = "/cache/xueprompts-aaa.db", params = { search: "修复" }) {
	const pending = service.list(dbPath, params);
	await tick();
	latest().emitLine({ type: "ready", protocolVersion: XUE_INDEX_PROTOCOL_VERSION, count: 4012, loadMs: 12 });
	await tick();
	return { pending };
}

test("list：spawn 传 dbPath、指令带 id/params、响应按 id 配对返回", async () => {
	const { service, latest, spawnCalls } = createService();
	const { pending } = await bootAndList(service, latest);
	const command = latest().commands()[0];
	assert.equal(command.cmd, "list");
	assert.equal(command.params.search, "修复");
	assert.equal(typeof command.id, "number");
	assert.equal(spawnCalls[0].args[0], "/cache/xueprompts-aaa.db");

	latest().emitLine({ type: "response", id: command.id, ok: true, result: { categories: [], prompts: [], total: 1, page: 1, pageSize: 20 } });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value.total, 1);
	service.dispose();
});

test("进程复用：同 dbPath 的第二次调用不再 spawn；db 换文件触发重启并结算在途请求", async () => {
	const { service, latest, harnesses } = createService();
	// 第一次：正常完成，建立常驻进程
	const first = (await bootAndList(service, latest, "/cache/xueprompts-aaa.db")).pending;
	latest().emitLine({ type: "response", id: latest().commands()[0].id, ok: true, result: { categories: [], prompts: [] } });
	assert.equal((await first).ok, true);
	assert.equal(harnesses.length, 1);

	// 第二次同库：复用，不新增进程
	const second = service.list("/cache/xueprompts-aaa.db", {});
	await tick();
	assert.equal(harnesses.length, 1);
	latest().emitLine({ type: "response", id: latest().commands().at(-1).id, ok: true, result: { categories: [], prompts: [] } });
	assert.equal((await second).ok, true);

	// 第三次换库（远程更新场景）：在途请求被结算（protocol 降级），旧进程被杀，新进程 spawn
	const inFlight = service.list("/cache/xueprompts-aaa.db", {});
	await tick();
	const swapped = service.list("/cache/xueprompts-bbb.db", {});
	const degraded = await inFlight;
	assert.equal(degraded.ok, false);
	assert.equal(degraded.reason, "protocol");
	assert.equal(harnesses[0].child.killed, true);
	await tick();
	latest().emitLine({ type: "ready", protocolVersion: XUE_INDEX_PROTOCOL_VERSION, count: 4012 });
	await tick();
	latest().emitLine({ type: "response", id: latest().commands().at(-1).id, ok: true, result: { categories: [], prompts: [] } });
	assert.equal((await swapped).ok, true);
	assert.equal(harnesses.length, 2);
	service.dispose();
});

test("binary 缺失：resolveBinaryPath 返回 null 时直接 binary-missing，不 spawn", async () => {
	const { service, spawnCalls } = createService({ resolveBinaryPath: () => null });
	const result = await service.list("/cache/a.db", {});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "binary-missing");
	assert.equal(spawnCalls.length, 0);
});

test("boot 超时：未在时限内握手 → boot-failed 且进程被杀", async () => {
	const { service, latest } = createService({ bootTimeout: 25 });
	const pending = service.list("/cache/a.db", {});
	await tick();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "boot-failed");
	assert.equal(latest().child.killed, true);
	service.dispose();
});

test("协议版本不匹配：ready 帧版本高 → 拒用杀进程，boot 以 boot-failed 终结", async () => {
	const { service, latest } = createService();
	const pending = service.list("/cache/a.db", {});
	await tick();
	latest().emitLine({ type: "ready", protocolVersion: XUE_INDEX_PROTOCOL_VERSION + 1, count: 10 });
	const result = await pending;
	// boot 阶段版本不匹配时 list 请求尚未入队，经 childReady(dead) 以 boot-failed 结算；
	// 调用方只关心 ok:false → 回退 sql.js，两种 reason 的下游行为一致
	assert.equal(result.ok, false);
	assert.equal(result.reason, "boot-failed");
	assert.equal(latest().child.killed, true);
	service.dispose();
});

test("请求超时后迟到响应被丢弃（不污染后续调用）", async () => {
	const { service, latest } = createService({ requestTimeout: 25 });
	const { pending } = await bootAndList(service, latest);
	const timedOut = await pending;
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.reason, "timeout");
	// 迟到响应：pending 已清，静默丢弃
	latest().emitLine({ type: "response", id: 1, ok: true, result: { categories: [], prompts: [] } });
	await tick();
	// 进程仍可复用（超时只结算单请求，不杀进程）
	const again = service.list("/cache/xueprompts-aaa.db", {});
	await tick();
	const cmd = latest().commands().at(-1);
	assert.equal(cmd.cmd, "list");
	latest().emitLine({ type: "response", id: cmd.id, ok: true, result: { categories: [], prompts: [] } });
	assert.equal((await again).ok, true);
	service.dispose();
});

test("get：result null 表示未命中（区别于通道失败）", async () => {
	const { service, latest } = createService();
	const pending = service.get("/cache/a.db", "not-exist");
	await tick();
	latest().emitLine({ type: "ready", protocolVersion: XUE_INDEX_PROTOCOL_VERSION });
	await tick();
	latest().emitLine({ type: "response", id: latest().commands()[0].id, ok: true, result: null });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value, null);
	service.dispose();
});

test("dispose：结算在途请求并杀进程", async () => {
	const { service, latest } = createService();
	const { pending } = await bootAndList(service, latest);
	service.dispose();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
});
