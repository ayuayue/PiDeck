import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 与 piRpcClientTimeout.test.mjs 同一加载理由：参数属性等 TS 语法需编译加载。
const { PiRpcClient, MAX_RPC_LINE_BYTES } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");

function createClient() {
	const stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
	const stdout = new PassThrough();
	const client = new PiRpcClient(stdin, stdout);
	return { client, stdout };
}

test("无换行的失控输出触发 protocol-error 并清空行缓冲", async () => {
	const { client, stdout } = createClient();
	const errors = [];
	client.on("protocol-error", (line) => errors.push(String(line)));
	stdout.write("x".repeat(MAX_RPC_LINE_BYTES + 1024));
	await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
	assert.equal(errors.length, 1);
	assert.match(errors[0], /rpc line buffer overflow: dropped \d+ bytes without newline/);
});

test("超限清空后，后续正常 JSONL 行仍能解析派发", async () => {
	const { client, stdout } = createClient();
	const errors = [];
	client.on("protocol-error", (line) => errors.push(String(line)));
	stdout.write("x".repeat(MAX_RPC_LINE_BYTES + 1024));
	await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
	stdout.end('{"id":"cap-recovery","type":"response","result":{"ok":true}}\n');
	await new Promise((resolve) => setTimeout(resolve, 30));
	// 恢复路径只应保留最初那一次协议错误，且恢复行不得再被污染缓冲拖垮
	assert.equal(errors.length, 1);
});
