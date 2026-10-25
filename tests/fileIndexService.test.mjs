/**
 * FileIndexService（Go file-index sidecar 宿主客户端）的生命周期回归测试。
 *
 * 用假子进程（PassThrough）锁定常驻进程协议语义：ready 握手、请求 id 配对、
 * roots 变化重启（切项目核心链路）、boot/请求超时、协议版本不匹配、迟到响应丢弃、
 * 拒绝坏落点保留旧值、isReady 同步探测与 warmup 防重入、dispose 结算。
 * Go 侧语义（模糊匹配/内容扫描/预算）由 native/file-index 的 *_test.go 覆盖，这里只测宿主。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { FileIndexService, FILE_INDEX_PROTOCOL_VERSION } = loadTsCommonJs("src/main/files/FileIndexService.ts");

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
	const service = new FileIndexService({
		resolveBinaryPath: overrides.resolveBinaryPath ?? (() => "/fake/file-index"),
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
	harness.emitLine({ type: "ready", protocolVersion: FILE_INDEX_PROTOCOL_VERSION, roots: 1, fileCount: 3, dirCount: 2, indexedMs: 4, truncated: false, ...extra });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const NAME_RESULT = {
	hits: [{ name: "useFileSearch.ts", path: "/w/src/hooks/useFileSearch.ts", relativePath: "src/hooks/useFileSearch.ts", type: "file", score: 900 }],
	indexed: 12,
	truncated: false,
};

const CONTENT_RESULT = {
	hits: [{ name: "search.go", path: "/w/native/session-index/search.go", relativePath: "native/session-index/search.go", line: 42, column: 7, snippet: "func Search(query string" }],
	matchedFiles: 1,
	scannedFiles: 8,
	scannedBytes: 4096,
	truncated: false,
};

test("searchNames：boot 握手后按请求 id 配对返回结果（spawn 参数只带 roots）", async () => {
	const { service, harnesses, spawnCalls } = createService();
	const pending = service.searchNames(["/proj/a"], "useFileSearch");
	await tick();
	assert.equal(spawnCalls.length, 1);
	assert.equal(spawnCalls[0].command, "/fake/file-index");
	assert.equal(spawnCalls[0].args.length, 1);
	assert.equal(spawnCalls[0].args[0], "/proj/a");
	bootReady(harnesses[0]);
	await tick();
	const command = harnesses[0].commands()[0];
	assert.equal(command.cmd, "search-name");
	assert.equal(command.query, "useFileSearch");
	assert.equal(command.limit, 200);
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: NAME_RESULT });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value.hits.length, 1);
	assert.equal(result.value.hits[0].relativePath, "src/hooks/useFileSearch.ts");
	assert.equal(result.value.indexed, 12);
});

test("searchContent：透传 query/limit/字节预算并返回片段结果", async () => {
	const { service, harnesses } = createService();
	const pending = service.searchContent(["/proj/a"], "func Search", 30, 2048, 4096);
	await tick();
	bootReady(harnesses[0]);
	await tick();
	const command = harnesses[0].commands()[0];
	assert.equal(command.cmd, "search-content");
	assert.equal(command.query, "func Search");
	assert.equal(command.limit, 30);
	assert.equal(command.maxFileBytes, 2048);
	assert.equal(command.maxScannedBytes, 4096);
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: CONTENT_RESULT });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value.hits[0].line, 42);
	assert.equal(result.value.scannedBytes, 4096);
});

test("searchContent 默认字节预算：单文件 1MiB、总量 64MiB（避免扫盘失控）", async () => {
	const { service, harnesses } = createService();
	const pending = service.searchContent(["/proj/a"], "budget");
	await tick();
	bootReady(harnesses[0]);
	await tick();
	const command = harnesses[0].commands()[0];
	assert.equal(command.maxFileBytes, 1024 * 1024);
	assert.equal(command.maxScannedBytes, 64 * 1024 * 1024);
	harnesses[0].emitLine({ type: "response", id: command.id, ok: true, result: CONTENT_RESULT });
	await pending;
});

test("roots 变化：结算在途请求、杀旧进程并按新 roots 重拉（切项目链路）", async () => {
	const { service, harnesses, spawnCalls } = createService();
	const first = service.searchNames(["/proj/a"], "alpha");
	await tick();
	bootReady(harnesses[0]);
	await tick();
	// 第二条请求使用不同 roots：旧请求被结算为失败，进程重建
	const second = service.searchNames(["/proj/b"], "alpha");
	const firstResult = await first;
	assert.equal(firstResult.ok, false);
	assert.equal(harnesses[0].child.killed, true);
	await tick();
	assert.equal(spawnCalls.length, 2);
	assert.equal(spawnCalls[1].args[0], "/proj/b");
	bootReady(harnesses[1]);
	await tick();
	const command = harnesses[1].commands()[0];
	assert.equal(command.cmd, "search-name");
	harnesses[1].emitLine({ type: "response", id: command.id, ok: true, result: NAME_RESULT });
	const secondResult = await second;
	assert.equal(secondResult.ok, true);
});

test("isReady：同步探测就绪与 roots 签名（未 spawn/booting/roots 不符/退出/dispose 全为 false）", async () => {
	const { service, harnesses } = createService();
	assert.equal(service.isReady(["/proj/a"]), false);
	const pending = service.searchNames(["/proj/a"], "alpha");
	await tick();
	assert.equal(service.isReady(["/proj/a"]), false, "booting 阶段不得视为就绪");
	bootReady(harnesses[0]);
	await tick();
	assert.equal(service.isReady(["/proj/a"]), true);
	assert.equal(service.isReady(["/proj/b"]), false, "roots 与当前进程不一致");
	harnesses[0].emitLine({ type: "response", id: 1, ok: true, result: NAME_RESULT });
	await pending;
	harnesses[0].child.emit("close", 0);
	await tick();
	assert.equal(service.isReady(["/proj/a"]), false);
	service.dispose();
	assert.equal(service.isReady(["/proj/a"]), false);
});

test("warmup：未就绪时后台建索引、booting 中不重复 spawn、已就绪零动作", async () => {
	const { service, harnesses, spawnCalls } = createService();
	service.warmup(["/proj/a"]);
	await tick();
	assert.equal(spawnCalls.length, 1);
	service.warmup(["/proj/a"]);
	await tick();
	assert.equal(spawnCalls.length, 1, "booting 中不得重复起进程");
	bootReady(harnesses[0]);
	await tick();
	// 就绪后的 warmup 立刻发出 refresh，且不新建进程
	service.warmup(["/proj/a"]);
	await tick();
	assert.equal(spawnCalls.length, 1);
	await tick();
	const commands = harnesses[0].commands();
	assert.equal(
		commands.some((command) => command.cmd === "refresh"),
		true,
	);
	service.dispose();
});

test("boot 超时：结算为 boot-failed 并杀进程（不把 IPC 挂到 20s 上限）", async () => {
	const { service, harnesses } = createService({ bootTimeout: 20 });
	const pending = service.searchNames(["/proj/a"], "alpha");
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "boot-failed");
	assert.equal(harnesses[0].child.killed, true);
	assert.equal(service.isReady(["/proj/a"]), false);
});

test("协议版本不匹配：拒绝该进程并杀之（宿主与 Go 侧必须同协议）", async () => {
	const { service, harnesses } = createService();
	const pending = service.searchNames(["/proj/a"], "alpha");
	await tick();
	harnesses[0].emitLine({ type: "ready", protocolVersion: 99 });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(harnesses[0].child.killed, true);
});

test("迟到响应：请求超时后到达的响应被丢弃，不影响后续请求", async () => {
	const { service, harnesses } = createService({ requestTimeout: 20 });
	const timedOut = service.searchNames(["/proj/a"], "alpha");
	await tick();
	bootReady(harnesses[0]);
	await tick();
	const firstId = harnesses[0].commands()[0].id;
	const firstResult = await timedOut;
	assert.equal(firstResult.ok, false);
	assert.equal(firstResult.reason, "timeout");
	// 迟到的响应不得污染状态，也不得抛异常
	harnesses[0].emitLine({ type: "response", id: firstId, ok: true, result: NAME_RESULT });
	await tick();
	const second = service.searchNames(["/proj/a"], "beta");
	await tick();
	const secondId = harnesses[0].commands().at(-1).id;
	harnesses[0].emitLine({ type: "response", id: secondId, ok: true, result: NAME_RESULT });
	const secondResult = await second;
	assert.equal(secondResult.ok, true);
});

test("resolveBinaryPath 返回 null：reason 为 binary-missing（未构建时静默降级扫盘）", async () => {
	const { service, spawnCalls } = createService({ resolveBinaryPath: () => null });
	const result = await service.searchNames(["/proj/a"], "alpha");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "binary-missing");
	assert.equal(spawnCalls.length, 0);
});

test("roots 为空：直接 not-ready，不拉进程", async () => {
	const { service, spawnCalls } = createService();
	const result = await service.searchNames([], "alpha");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "not-ready");
	assert.equal(spawnCalls.length, 0);
});

test("dispose：结算在途请求并杀进程（退出路径不泄漏 sidecar）", async () => {
	const { service, harnesses } = createService();
	const pending = service.searchNames(["/proj/a"], "alpha");
	await tick();
	bootReady(harnesses[0]);
	await tick();
	service.dispose();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(harnesses[0].child.killed, true);
	const afterDispose = await service.searchNames(["/proj/a"], "alpha");
	assert.equal(afterDispose.ok, false);
});
