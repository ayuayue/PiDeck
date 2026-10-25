/**
 * GoSidecarClient（四个 Go sidecar 共用的 NDJSON stdio 传输层）回归测试。
 *
 * 各服务的业务测试（sessionIndexService/fileIndexService/sessionStoreService/
 * xueIndexService）覆盖复用键、命令形状与 ready 字段；这里只锁定共享层自己的
 * 边界：非法行、stdout 溢出、stdin 管道错误、运行期协议版本漂移、dispose 结算。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { GoSidecarClient } = loadTsCommonJs("src/main/sidecar/GoSidecarClient.ts");

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

const MESSAGES = {
	binaryMissing: "missing",
	spawnFailed: "spawn failed",
	bootFailed: "boot failed",
	processError: "process error",
	processExited: (code) => `exited ${code ?? "null"}`,
	requestTimeout: "request timeout",
	requestFailed: (error) => error ?? "request failed",
	childUnavailable: "unavailable",
	writeFailed: "write failed",
	pipeClosed: "pipe closed",
	protocolMismatch: "protocol mismatch",
	responseOverflow: "overflow",
	disposed: "disposed",
	keyChanged: "key changed",
};

function createClient(overrides = {}) {
	const harnesses = [];
	const client = new GoSidecarClient({
		name: "test-sidecar",
		resolveBinaryPath: () => "/fake/test-sidecar",
		spawnFn: () => {
			const harness = createHarness();
			harnesses.push(harness);
			return harness.child;
		},
		logger: SILENT_LOGGER,
		timeouts: { boot: overrides.bootTimeout ?? 5_000, request: overrides.requestTimeout ?? 5_000 },
		protocolVersion: 1,
		maxLineChars: overrides.maxLineChars ?? 4 * 1024 * 1024,
		messages: MESSAGES,
	});
	return { client, harnesses, latest: () => harnesses.at(-1) };
}

async function bootAndSend(client, latest) {
	const ready = client.ensureReady("key", ["arg"]);
	await new Promise((resolve) => setImmediate(resolve));
	latest().emitLine({ type: "ready", protocolVersion: 1 });
	await ready;
	const pending = client.request({ cmd: "do", value: 7 });
	await new Promise((resolve) => setImmediate(resolve));
	return { pending, command: latest().commands()[0] };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
test("行泵分段正确性：跨 chunk 的多字节字符、跨多块的行、块边界上的 LF（2027-02 Buffer 化回归）", async () => {
	const { client, latest } = createClient();
	const ready = client.ensureReady("key", []);
	await tick();
	latest().emitLine({ type: "ready", protocolVersion: 1 });
	await ready;
	const pending = client.request({ cmd: "do", value: 1 });
	await tick();
	const command = latest().commands()[0];

	// 构造一行响应：JSON 里带中日韩 + emoji（多字节），故意按 7 字节一块切开，
	// 保证多字节序列与 LF 都可能落在任意块边界上；旧字符串实现在这种切法下
	// 靠 StringDecoder 保全字节，Buffer 版必须同样保全（按字节找 LF 不破坏 UTF-8）。
	const payload = { type: "response", id: command.id, ok: true, result: { text: "中文日本語한국어🚀emoji、混合 tail" } };
	const frame = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
	for (let offset = 0; offset < frame.length; offset += 7) {
		latest().child.stdout.write(frame.subarray(offset, Math.min(offset + 7, frame.length)));
	}
	// vm realm 对象原型不同：JSON 比较内容（仓库测试惯例）
	assert.equal(JSON.stringify((await pending).value), JSON.stringify({ text: "中文日本語한국어🚀emoji、混合 tail" }));

	// 连续多行粘在一个 chunk、末行无 LF（半行留待下一 chunk）：
	// 第二条完整行先结算，半行等到补齐后才结算——分段泵不得丢行或串行。
	const pending2 = client.request({ cmd: "do", value: 2 });
	await tick();
	const command2 = latest().commands().at(-1);
	const line2 = JSON.stringify({ type: "response", id: command2.id, ok: true, result: 2 });
	const line3 = JSON.stringify({ type: "response", id: 999, ok: true, result: 3 });
	latest().child.stdout.write(Buffer.from(`${line2}\n${line3}`, "utf8"));
	const settled2 = await pending2;
	assert.equal(settled2.value, 2);
	// id 999 无 pending：只验证泵继续工作（补 LF 后再发一条正常请求能结算）
	const pending4 = client.request({ cmd: "do", value: 4 });
	await tick();
	const command4 = latest().commands().at(-1);
	latest().child.stdout.write(Buffer.from(`\n${JSON.stringify({ type: "response", id: command4.id, ok: true, result: 4 })}\n`, "utf8"));
	assert.equal((await pending4).value, 4);
});

test("请求 id 配对：正常响应回传 result，非法行忽略后仍能结算", async () => {
	const { client, latest } = createClient();
	const { pending, command } = await bootAndSend(client, latest);
	latest().child.stdout.write("not-json\n");
	latest().emitLine({ type: "response", id: command.id, ok: true, result: { value: 42 } });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value.value, 42);
	client.dispose();
});

test("运行期协议版本漂移：结算在途请求为 protocol 并回收进程", async () => {
	const { client, latest } = createClient();
	const { pending } = await bootAndSend(client, latest);
	latest().emitLine({ type: "ready", protocolVersion: 99 });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	client.dispose();
});

test("stdout 行缓冲溢出：判定协议异常、杀进程并结算 pending", async () => {
	const { client, latest } = createClient({ maxLineChars: 128 });
	const { pending } = await bootAndSend(client, latest);
	latest().child.stdout.write("x".repeat(256));
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	client.dispose();
});

test("stdin 管道错误：结算 pending 为 protocol 并回收进程", async () => {
	const { client, latest } = createClient();
	const { pending } = await bootAndSend(client, latest);
	latest().child.stdin.emit("error", new Error("EPIPE"));
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	client.dispose();
});

test("stdin 写入抛错：单请求结算为 protocol，不悬挂也不崩主进程", async () => {
	const { client, latest } = createClient();
	const ready = client.ensureReady("key", ["arg"]);
	await tick();
	latest().emitLine({ type: "ready", protocolVersion: 1 });
	await ready;
	latest().child.stdin.write = () => {
		throw new Error("EPIPE");
	};
	const result = await client.request({ cmd: "fail" });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	client.dispose();
});

test("dispose：结算在途请求、杀进程；之后的 ensureReady 直接 boot-failed", async () => {
	const { client, latest } = createClient();
	const { pending } = await bootAndSend(client, latest);
	client.dispose();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	const after = await client.ensureReady("key", ["arg"]);
	assert.equal(after.ok, false);
	assert.equal(after.reason, "boot-failed");
});
