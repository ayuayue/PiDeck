/**
 * SessionIndexService（Go session-index sidecar 宿主客户端）的生命周期回归测试。
 *
 * 用假子进程（PassThrough）锁定常驻进程协议语义：ready 握手、请求 id 配对、
 * roots 变化重启（settings sessionDir 变更核心链路）、boot/请求超时、协议版本
 * 不匹配、迟到响应丢弃、进程退出重拉、dispose 结算。这些是「侧栏搜索卡死/
 * 结果错乱/进程泄漏」类问题的直接防线；Go 侧语义由 native/session-index 的
 * *_test.go 覆盖，这里只测宿主。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionIndexService, SESSION_INDEX_PROTOCOL_VERSION } = loadTsCommonJs("src/main/sessions/SessionIndexService.ts");

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
	const service = new SessionIndexService({
		corpusDir: overrides.corpusDir ?? "/fake/corpus",
		resolveBinaryPath: overrides.resolveBinaryPath ?? (() => "/fake/session-index"),
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

function bootReady(harness, extra = {}) {
	harness.emitLine({ type: "ready", protocolVersion: SESSION_INDEX_PROTOCOL_VERSION, sessionCount: 3, entryCount: 42, corpusBytes: 1024, indexMs: 5, fullRebuild: false, ...extra });
}

const SEARCH_RESULT = {
	sessions: [{ filePath: "/home/.pi/agent/sessions/x/abc.jsonl", updatedAtMs: 1700000000000, matches: [{ messageId: "m1", role: "user", timestampMs: 1700000000000, snippet: "hello 修复" }] }],
	totalHitSessions: 1,
	truncated: false,
};

test("searchInSession：cmd=search-session 只带 path/query/limit（单文件检索）", async () => {
	const { service, harnesses } = createService();
	const pending = service.searchInSession(["/roots/a"], "C:/sessions/a.jsonl", "缓存");
	await new Promise((resolve) => setImmediate(resolve));
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	const command = harnesses[0].commands()[0];
	assert.equal(command.cmd, "search-session");
	assert.equal(command.path, "C:/sessions/a.jsonl");
	assert.equal(command.query, "缓存");
	// 默认上限 100：会话内查找是「上一条/下一条」导航，需要一次拿到足够多的命中
	assert.equal(command.limit, 100);
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: SEARCH_RESULT });
	const result = await pending;
	assert.ok(result.ok);
	service.dispose();
});

test("searchInSession：缺少会话路径时直接 not-ready，不拉进程", async () => {
	const { service, spawnCalls } = createService();
	const result = await service.searchInSession(["/roots/a"], "", "缓存");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "not-ready");
	assert.equal(spawnCalls.length, 0);
	service.dispose();
});

test("search：boot 握手后请求 id 配对返回结果（spawn 参数带 corpusDir+roots）", async () => {
	const { service, harnesses, spawnCalls } = createService();
	const pending = service.search(["/roots/a", "/roots/b"], "修复");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawnCalls.length, 1);
	assert.equal(spawnCalls[0].command, "/fake/session-index");
	// vm 沙箱数组与主 realm 原型不同，deepEqual 会假败：逐元素断言
	assert.equal(spawnCalls[0].args.length, 3);
	assert.equal(spawnCalls[0].args[0], "/fake/corpus");
	assert.equal(spawnCalls[0].args[1], "/roots/a");
	assert.equal(spawnCalls[0].args[2], "/roots/b");
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	const command = harnesses[0].commands()[0];
	assert.equal(command.cmd, "search");
	assert.equal(command.query, "修复");
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: SEARCH_RESULT });
	const result = await pending;
	assert.ok(result.ok);
	assert.equal(result.value.totalHitSessions, 1);
	assert.equal(result.value.sessions[0].matches[0].messageId, "m1");
	service.dispose();
});

test("refresh：请求帧 cmd=refresh 且返回统计值", async () => {
	const { service, harnesses } = createService();
	const pending = service.refresh(["/roots/a"]);
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	const command = harnesses[0].commands()[0];
	assert.equal(command.cmd, "refresh");
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: { changedFiles: 2, removedFiles: 1, sessionCount: 10, entryCount: 50, corpusBytes: 4096 } });
	const result = await pending;
	assert.ok(result.ok);
	assert.equal(result.value.changedFiles, 2);
	assert.equal(result.value.sessionCount, 10);
	service.dispose();
});

test("协议版本不匹配：kill 子进程并 boot-failed", async () => {
	const { service, harnesses, spawnCalls } = createService();
	const pending = service.search(["/roots/a"], "x");
	await new Promise((resolve) => setImmediate(resolve));
	harnesses[0].emitLine({ type: "ready", protocolVersion: 99, sessionCount: 0, entryCount: 0, corpusBytes: 0 });
	const result = await pending;
	assert.ok(!result.ok);
	assert.equal(result.reason, "boot-failed");
	assert.equal(harnesses[0].child.killed, true);
	assert.equal(spawnCalls.length, 1);
	service.dispose();
});

test("请求超时：结算 timeout；迟到响应被丢弃；进程复用不重 spawn", async () => {
	const { service, harnesses, spawnCalls } = createService({ requestTimeout: 40 });
	const first = service.search(["/roots/a"], "slow");
	bootReady(harnesses[0]);
	const firstResult = await first;
	assert.ok(!firstResult.ok);
	assert.equal(firstResult.reason, "timeout");
	// 迟到响应（id 已结算）不得炸未处理 rejection，也不得污染下一个请求
	harnesses[0].emitLine({ type: "response", id: 1, ok: true, result: { stale: true } });
	const second = service.search(["/roots/a"], "again");
	await new Promise((resolve) => setImmediate(resolve));
	const command = harnesses[0].commands().at(-1);
	assert.equal(command.cmd, "search");
	assert.equal(command.query, "again");
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: SEARCH_RESULT });
	const secondResult = await second;
	assert.ok(secondResult.ok);
	assert.equal(spawnCalls.length, 1);
	service.dispose();
});

test("roots 变化：杀旧进程按新 roots 重拉，在途请求按 protocol 结算", async () => {
	const { service, harnesses, spawnCalls } = createService();
	const first = service.search(["/roots/a"], "x");
	await new Promise((resolve) => setImmediate(resolve));
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	harnesses[0].emitLine({ type: "response", id: harnesses[0].commands()[0].id, ok: true, result: SEARCH_RESULT });
	await first;
	// 在途请求挂在旧进程上
	const inFlight = service.search(["/roots/a"], "y");
	await new Promise((resolve) => setImmediate(resolve));
	const swap = service.search(["/roots/b"], "z");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawnCalls.length, 2);
	assert.equal(spawnCalls[1].args.length, 2);
	assert.equal(spawnCalls[1].args[0], "/fake/corpus");
	assert.equal(spawnCalls[1].args[1], "/roots/b");
	assert.equal(harnesses[0].child.killed, true);
	const settled = await inFlight;
	assert.ok(!settled.ok);
	assert.equal(settled.reason, "protocol");
	bootReady(harnesses[1]);
	await new Promise((resolve) => setImmediate(resolve));
	harnesses[1].emitLine({ type: "response", id: harnesses[1].commands()[0].id, ok: true, result: SEARCH_RESULT });
	const swapResult = await swap;
	assert.ok(swapResult.ok);
	service.dispose();
});

test("binary 缺失：不 spawn，直接 binary-missing", async () => {
	const { service, spawnCalls } = createService({ resolveBinaryPath: () => null });
	const result = await service.search(["/roots/a"], "x");
	assert.ok(!result.ok);
	assert.equal(result.reason, "binary-missing");
	assert.equal(spawnCalls.length, 0);
	service.dispose();
});

test("roots 为空：not-ready 且不 spawn", async () => {
	const { service, spawnCalls } = createService();
	const result = await service.search([], "x");
	assert.ok(!result.ok);
	assert.equal(result.reason, "not-ready");
	assert.equal(spawnCalls.length, 0);
	service.dispose();
});

test("进程退出（close）：结算 pending，下次调用重拉新进程", async () => {
	const { service, harnesses, spawnCalls } = createService();
	const first = service.search(["/roots/a"], "x");
	await new Promise((resolve) => setImmediate(resolve));
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	harnesses[0].emitLine({ type: "response", id: harnesses[0].commands()[0].id, ok: true, result: SEARCH_RESULT });
	await first;
	const inFlight = service.search(["/roots/a"], "y");
	await new Promise((resolve) => setImmediate(resolve));
	harnesses[0].child.emit("close", 1);
	const settled = await inFlight;
	assert.ok(!settled.ok);
	assert.equal(settled.reason, "boot-failed");
	const after = service.search(["/roots/a"], "z");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawnCalls.length, 2);
	bootReady(harnesses[1]);
	await new Promise((resolve) => setImmediate(resolve));
	harnesses[1].emitLine({ type: "response", id: harnesses[1].commands()[0].id, ok: true, result: SEARCH_RESULT });
	const afterResult = await after;
	assert.ok(afterResult.ok);
	service.dispose();
});

test("isReady：同步就绪探测——未 spawn/booting/roots 不一致/死亡/dispose 一律 false", async () => {
	const { service, harnesses } = createService();
	// 连接口冷启动：还没拉进程
	assert.equal(service.isReady(["/roots/a"]), false);
	const pending = service.search(["/roots/a"], "x");
	await new Promise((resolve) => setImmediate(resolve));
	// 已 spawn 但未握手（booting）：未就绪——交互路径据此降级，不会等 boot 超时
	assert.equal(service.isReady(["/roots/a"]), false);
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(service.isReady(["/roots/a"]), true);
	// roots 口径不一致：需要重启才能服务，不算就绪
	assert.equal(service.isReady(["/roots/b"]), false);
	harnesses[0].emitLine({ type: "response", id: harnesses[0].commands()[0].id, ok: true, result: SEARCH_RESULT });
	assert.ok((await pending).ok);
	// 进程退出：立刻回落未就绪，下一次调用重拉
	harnesses[0].child.emit("close", 0);
	assert.equal(service.isReady(["/roots/a"]), false);
	service.dispose();
	assert.equal(service.isReady(["/roots/a"]), false);
});

test("isReady：boot 超时后回落未就绪（不把后续交互挂在死进程上）", async () => {
	const { service, harnesses } = createService({ bootTimeout: 30 });
	const pending = service.search(["/roots/a"], "x");
	const result = await pending;
	assert.ok(!result.ok);
	assert.equal(result.reason, "boot-failed");
	assert.equal(harnesses[0].child.killed, true);
	assert.equal(service.isReady(["/roots/a"]), false);
	service.dispose();
});

test("warmup：无进程时后台建索引（spawn + 就绪后 refresh 帧），boot 中/已就绪不重复触发", async () => {
	const { service, harnesses, spawnCalls } = createService();
	service.warmup(["/roots/a"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawnCalls.length, 1);
	// boot 中再 warmup：已有 booting 的同 roots 进程，不重复 spawn
	service.warmup(["/roots/a"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawnCalls.length, 1);
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	const command = harnesses[0].commands().at(-1);
	assert.equal(command.cmd, "refresh");
	// 已就绪：warmup 什么都不做（刷新交给调用方的就绪路径）
	service.warmup(["/roots/a"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawnCalls.length, 1);
	assert.equal(harnesses[0].commands().length, 1);
	// roots 不同（settings sessionDir 变更）：warmup 负责把新口径的进程拉起来
	service.warmup(["/roots/b"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(spawnCalls.length, 2);
	assert.equal(spawnCalls[1].args[1], "/roots/b");
	service.dispose();
});

test("dispose：结算在途请求并杀进程", async () => {
	const { service, harnesses } = createService();
	const inFlight = service.search(["/roots/a"], "x");
	bootReady(harnesses[0]);
	await new Promise((resolve) => setImmediate(resolve));
	service.dispose();
	const settled = await inFlight;
	assert.ok(!settled.ok);
	assert.equal(settled.reason, "protocol");
	assert.equal(harnesses[0].child.killed, true);
	// dispose 后再调用直接失败，不再拉进程
	const after = await service.search(["/roots/a"], "x");
	assert.ok(!after.ok);
});
