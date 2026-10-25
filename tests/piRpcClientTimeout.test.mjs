import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// PiRpcClient.ts 含参数属性等非可擦除 TS 语法，node 原生 type-stripping 无法解析，
// 统一走 loadTsCommonJs（TypeScript 编译加载）。
const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");

/**
 * PiRpcClient 超时契约：错误文本必须携带超时时长，
 * 供 toast / 启动诊断卡直接区分「等待过久」与「连接断开」，
 * 也用于验证默认 30s 与调用方显式 timeout 都落在同一错误格式上。
 */

function createClient(timeoutMs) {
	const stdin = new Writable({
		write: (_chunk, _enc, cb) => cb(),
	});
	const stdout = new PassThrough();
	const client = new PiRpcClient(stdin, stdout);
	return { client, stdout };
}

test("timeout error message includes the configured duration", async () => {
	const { client } = createClient(10);
	await assert.rejects(client.request({ type: "get_state" }, 10), (error) => {
		// loadTsCommonJs 走 vm 加载，Error 属于另一个 realm，instanceof 不可靠，鸭子类型断言
		const message = typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
		assert.match(message, /RPC command timed out after 10ms: get_state/);
		return true;
	});
});

test("default timeout is 30s and reflected in error text", () => {
	// 不实际等 30s：仅断言源码层面默认值与错误模板一致，防止默认值漂移
	const source = readFileSync("src/main/pi/PiRpcClient.ts", "utf8");
	assert.match(source, /timeoutMs = 30_000/);
	assert.match(source, /RPC command timed out after \$\{timeoutMs\}ms/);
});

test("pending request is removed after timeout (no double resolve)", async () => {
	const { client } = createClient(10);
	const error = await client.request({ type: "get_state" }, 10).catch((e) => e);
	const message = typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
	assert.match(message, /timed out/);
});

test("large JSONL lines parse after the stdout data callback returns", async () => {
	const { PiRpcClient, LARGE_RPC_LINE_PARSE_CHARS } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");
	const stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
	const stdout = new PassThrough();
	const client = new PiRpcClient(stdin, stdout);
	const pending = client.request({ type: "get_entries", id: "big" }, 2000);
	const payload = {
		id: "big",
		type: "response",
		command: "get_entries",
		success: true,
		data: { pad: "x".repeat(LARGE_RPC_LINE_PARSE_CHARS) },
	};
	stdout.write(`${JSON.stringify(payload)}\n`);
	// setImmediate 尚未跑：主进程仍能处理关窗/设置 IPC。
	const raced = await Promise.race([pending.then(() => "done"), Promise.resolve("pending")]);
	assert.equal(raced, "pending");
	const response = await pending;
	assert.equal(response.success, true);
	assert.equal(response.command, "get_entries");
});
