/**
 * SessionStoreService（Go session-store sidecar 宿主客户端）的生命周期回归测试。
 *
 * 用假子进程（PassThrough）锁定常驻进程协议语义：ready 握手 + 快照信息、
 * 请求 id 配对、roots 逐请求（换根不重启进程）、isReady 同步三态、warmup 防重入、
 * boot/请求超时、协议版本不匹配、迟到响应丢弃、dispose 结算。
 * Go 侧语义（行边界提交/增量扫描/快照复用）由 native/session-store 的 *_test.go 覆盖，
 * 这里只测宿主侧状态机。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionStoreService, SESSION_STORE_PROTOCOL_VERSION } = loadTsCommonJs("src/main/sessions/SessionStoreService.ts");

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
	const service = new SessionStoreService({
		statePath: overrides.statePath ?? "/fake/session-store/state.bin",
		tablesDir: overrides.tablesDir,
		resolveBinaryPath: overrides.resolveBinaryPath ?? (() => "/fake/session-store"),
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
	harness.emitLine({ type: "ready", protocolVersion: SESSION_STORE_PROTOCOL_VERSION, snapshotFiles: 0, bootMs: 1, ...extra });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FILE_STATE = { path: "/root/a/one.jsonl", size: 120, mtimeMs: 1_700_000_000_000, entryCount: 3, hasCompaction: false, endsWithNewline: true };

function listResult(overrides = {}) {
	return { files: [FILE_STATE], reused: 0, incremental: 0, full: 1, pruned: 0, indexMs: 7, ...overrides };
}

async function startedService(overrides = {}) {
	const harness = createService(overrides);
	const pending = harness.service.listFiles(overrides.roots ?? ["/root/a"]);
	await tick();
	bootReady(harness.latest());
	await tick();
	return { ...harness, pending };
}

test("配置 tablesDir 时第二个 spawn 参数是条目表目录（Wave 2b 落盘）", async () => {
	const { spawnCalls } = await startedService({ tablesDir: "/fake/session-store/tables" });
	assert.equal(spawnCalls.length, 1);
	assert.equal(spawnCalls[0].args.length, 2);
	assert.equal(spawnCalls[0].args[0], "/fake/session-store/state.bin");
	assert.equal(spawnCalls[0].args[1], "/fake/session-store/tables");
});

test("listFiles：未配 tablesDir 时 spawn 参数只有 statePath，握手后按请求 id 配对返回文件状态", async () => {
	const { service, spawnCalls, harnesses, pending } = await startedService();
	assert.equal(spawnCalls.length, 1);
	assert.equal(spawnCalls[0].command, "/fake/session-store");
	assert.equal(spawnCalls[0].args.length, 1);
	assert.equal(spawnCalls[0].args[0], "/fake/session-store/state.bin");

	const command = harnesses[0].commands()[0];
	assert.equal(command.cmd, "list-files");
	assert.equal(command.roots.length, 1);
	assert.equal(command.roots[0], "/root/a");
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: listResult({ reused: 1, full: 0 }) });

	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value.reused, 1);
	assert.equal(result.value.full, 0);
	assert.equal(result.value.indexMs, 7);
	const file = result.value.files[0];
	assert.equal(file.path, FILE_STATE.path);
	assert.equal(file.size, 120);
	assert.equal(file.mtimeMs, 1_700_000_000_000);
	assert.equal(file.entryCount, 3);
	assert.equal(file.hasCompaction, false);
	assert.equal(file.endsWithNewline, true);
	assert.equal(service.isReady(), true);
});

test("roots 是逐请求参数：换根不重启进程，请求体带新 roots", async () => {
	const { service, harnesses, spawnCalls } = await startedService();
	const first = harnesses[0].commands()[0];
	harnesses[0].emitLine({ type: "response", id: first.id, ok: true, result: listResult() });
	await tick();

	const second = service.listFiles(["/root/b", "/root/c"]);
	await tick();
	assert.equal(spawnCalls.length, 1, "换 roots 不应重启进程");
	const commands = harnesses[0].commands();
	assert.equal(commands.length, 2);
	assert.equal(commands[1].roots.length, 2);
	assert.equal(commands[1].roots[1], "/root/c");
	harnesses[0].emitLine({ type: "response", id: commands[1].id, ok: true, result: listResult() });
	const result = await second;
	assert.equal(result.ok, true);
});

test("isReady 同步三态：未 spawn / booting / ready / 进程退出后", async () => {
	const { service, harnesses, spawnCalls } = createService();
	assert.equal(service.isReady(), false);
	const pending = service.listFiles(["/root/a"]);
	await tick();
	assert.equal(service.isReady(), false, "booting 期间未就绪");
	bootReady(harnesses[0]);
	await tick();
	assert.equal(service.isReady(), true);
	harnesses[0].child.emit("close", 1);
	assert.equal(service.isReady(), false, "进程退出后未就绪");
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "boot-failed");
	assert.equal(spawnCalls.length, 1);
});

test("warmup：只拉进程不发请求，booting/ready 期间不重复 spawn", async () => {
	const { service, harnesses, spawnCalls } = createService();
	service.warmup();
	service.warmup();
	await tick();
	assert.equal(spawnCalls.length, 1, "booting 期间重复 warmup 不应重复 spawn");
	assert.equal(harnesses[0].writes.length, 0, "warmup 不应发出请求");

	bootReady(harnesses[0]);
	await tick();
	service.warmup();
	await tick();
	assert.equal(spawnCalls.length, 1, "ready 之后 warmup 应零动作");
	assert.equal(harnesses[0].writes.length, 0);
});

test("boot 超时：请求以 boot-failed 结算并回收进程", async () => {
	const { service, harnesses } = createService({ bootTimeout: 15 });
	const result = await service.listFiles(["/root/a"]);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "boot-failed");
	assert.equal(harnesses[0].child.killed, true);
	assert.equal(service.isReady(), false);
});

test("协议版本不匹配（首次握手）：杀进程，请求以 boot-failed 结算", async () => {
	const { service, harnesses } = createService();
	const pending = service.listFiles(["/root/a"]);
	await tick();
	harnesses[0].emitLine({ type: "ready", protocolVersion: 99, snapshotFiles: 0, bootMs: 1 });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "boot-failed");
	assert.equal(harnesses[0].child.killed, true);
	assert.equal(service.isReady(), false);
});

test("协议版本不匹配（运行期）：结算在途请求为 protocol 并回收进程", async () => {
	const { service, harnesses, pending } = await startedService();
	const command = harnesses[0].commands()[0];
	harnesses[0].emitLine({ type: "ready", protocolVersion: 99, snapshotFiles: 0, bootMs: 1 });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(harnesses[0].child.killed, true);
	assert.equal(harnesses[0].commands().length, 1, "握手后发出的请求不应被当成新请求重发");
	assert.equal(command.cmd, "list-files");
});

test("迟到响应：未配对 id 直接丢弃，随后正常响应仍能结算", async () => {
	const { harnesses, pending } = await startedService();
	const command = harnesses[0].commands()[0];
	harnesses[0].emitLine({ type: "response", id: command.id + 500, ok: true, result: listResult({ reused: 99 }) });
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: listResult({ reused: 4 }) });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value.reused, 4, "迟到的未配对响应不得污染结果");
});

test("二进制缺失：不 spawn，直接 binary-missing（fail-open 留给调用方）", async () => {
	const { service, spawnCalls } = createService({ resolveBinaryPath: () => null });
	const result = await service.listFiles(["/root/a"]);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "binary-missing");
	assert.equal(spawnCalls.length, 0);
});

test("空 roots：not-ready 且不拉进程", async () => {
	const { service, spawnCalls } = createService();
	const result = await service.listFiles([]);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "not-ready");
	assert.equal(spawnCalls.length, 0);
});

test("请求超时：以 timeout 结算（进程保留，下次请求仍可用）", async () => {
	const { service, harnesses } = createService({ requestTimeout: 15 });
	const pending = service.listFiles(["/root/a"]);
	await tick();
	bootReady(harnesses[0]);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "timeout");
	assert.equal(harnesses[0].child.killed, false);
	assert.equal(service.isReady(), true);
});

test("进程崩溃：在途请求以 boot-failed 结算", async () => {
	const { service, harnesses } = createService();
	const pending = service.listFiles(["/root/a"]);
	await tick();
	bootReady(harnesses[0]);
	await tick();
	harnesses[0].child.emit("close", 137);
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "boot-failed");
});

test("dispose：结算在途请求、杀进程、isReady 归 false", async () => {
	const { service, harnesses } = createService();
	const pending = service.listFiles(["/root/a"]);
	await tick();
	bootReady(harnesses[0]);
	await tick();
	service.dispose();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(harnesses[0].child.killed, true);
	assert.equal(service.isReady(), false);
});

test("ready 帧带快照信息，dispose/退出后清空诊断信息", async () => {
	const { service, harnesses } = createService();
	const pending = service.listFiles(["/root/a"]);
	await tick();
	bootReady(harnesses[0], { snapshotFiles: 889, bootMs: 2 });
	await tick();
	const info = service.snapshotInfo();
	assert.equal(info.snapshotFiles, 889);
	assert.equal(info.bootMs, 2);
	harnesses[0].child.emit("close", 0);
	assert.equal(service.snapshotInfo(), null);
	const result = await pending;
	assert.equal(result.ok, false);
});

test("get-index：带上路径请求并回传未校验的条目表", async () => {
	const { service, harnesses } = createService();
	const pending = service.getIndex("C:\root\a\one.jsonl");
	await tick();
	bootReady(harnesses[0]);
	await tick();
	const commands = harnesses[0].commands();
	assert.equal(commands.length, 1);
	assert.equal(commands[0].cmd, "get-index");
	assert.equal(commands[0].path, "C:\root\a\one.jsonl");
	assert.deepEqual(commands[0].roots, []);
	const table = { path: "C:\root\a\one.jsonl", size: 120, mtimeMs: 1, endsWithNewline: true, entries: [{ id: "a" }], oversizedLines: 0 };
	harnesses[0].emitLine({ type: "response", id: commands[0].id, ok: true, result: table });
	const result = await pending;
	assert.equal(result.ok, true);
	// 服务只保证「取到 JSON」：字段级校验在消费者的 validator 里（tests/sessionStoreIndexParity.test.mjs）
	// 跨 vm realm 的对象不能用 deepStrictEqual（原型不同），逐字段比对。
	assert.equal(result.value.entries.length, 1);
	assert.equal(result.value.entries[0].id, "a");
	assert.equal(result.value.endsWithNewline, true);
});

test("get-index：空路径不拉进程直接 not-ready", async () => {
	const { service, spawnCalls } = createService();
	const result = await service.getIndex("");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "not-ready");
	assert.equal(spawnCalls.length, 0);
});

test("get-index：sidecar 报错时以 request-failed 结算（不抛异常）", async () => {
	const { service, harnesses } = createService();
	const pending = service.getIndex("/root/a/one.jsonl");
	await tick();
	bootReady(harnesses[0]);
	await tick();
	const commands = harnesses[0].commands();
	harnesses[0].emitLine({ type: "response", id: commands[0].id, ok: false, error: "boom" });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "request-failed");
});
