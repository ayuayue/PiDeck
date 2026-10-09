/**
 * AcpConnection(JSON-RPC over NDJSON stdio)单测:内存流回环,不依赖真实 CLI。
 * 覆盖:请求/响应 id 配对、error → AcpRpcError、通知不占 id、行分帧(半行/多行/
 * 分块 UTF-8)、agent→client 请求分发与 defer、超时与关闭语义、大行护栏。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AcpConnection, ACP_DEFER_RESPONSE } = loadTsCommonJs("src/main/acp/AcpConnection.ts");

/** 回环:stdout 是伪造的 agent 输出流;writeLine 模拟 agent 发帧。afterEach 销毁流,
 * 否则 PassThrough 的 data 监听会挂住 node --test 进程不退出。 */
function harness(t) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const written = [];
	stdin.on("data", (chunk) => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (line.trim()) written.push(JSON.parse(line));
		}
	});
	const conn = new AcpConnection(stdin, stdout);
	t.after(() => {
		conn.close();
		stdin.destroy();
		stdout.destroy();
	});
	const sendFromAgent = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
	return { conn, written, sendFromAgent, stdout };
}

test("request/response pairs by id and rejects with AcpRpcError on error response", async (t) => {
	const { conn, sendFromAgent } = harness(t);
	const promise = conn.request("initialize", { protocolVersion: 1 });
	// 响应乱序/别的 id 不影响配对
	sendFromAgent({ jsonrpc: "2.0", id: 999, result: { wrong: true } });
	sendFromAgent({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "gemini" } } });
	const result = await promise;
	assert.equal(result.agentInfo.name, "gemini");

	const failing = conn.request("session/prompt", { sessionId: "s" });
	// 业务错误码透传（authRequired 是 ACP 规范码；message 原样携带）
	sendFromAgent({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "auth required" } });
	await assert.rejects(failing, (error) => {
		assert.equal(error.code, -32000);
		assert.match(error.message, /auth required/);
		return true;
	});
});

test("notifications carry no id and close() rejects pending requests", async (t) => {
	const { conn, written, sendFromAgent } = harness(t);
	conn.notify("session/update", { sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } } });
	await sleep(10);
	assert.equal(written[0].method, "session/update");
	assert.equal("id" in written[0], false);

	const pending = conn.request("session/prompt");
	conn.close(new Error("agent exited"));
	await assert.rejects(pending, /agent exited/);
	// 关闭后的请求直接拒绝
	await assert.rejects(conn.request("session/new"), /agent exited/);
	// stdout end 触发关闭
	const second = harness(t);
	const wait = assert.rejects(second.conn.request("session/new"), /closed|ended/i);
	second.stdout.end();
	await wait;
});

test("line framing survives split lines, multiple frames per chunk, and split UTF-8", async (t) => {
	const { conn, sendFromAgent, stdout } = harness(t);
	const seen = [];
	conn.on("notification", (n) => seen.push(n.params.update.sessionUpdate));
	const frameA = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } });
	const frameB = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call" } } });
	// 半行 + 多帧同 chunk（sendFromAgent 收对象，内部序列化——传字符串会双重转义成非法帧）
	sendFromAgent({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "plan" } } });
	await sleep(5);
	stdout.write(frameA.slice(0, 10));
	await sleep(5);
	stdout.write(`${frameA.slice(10)}\n${frameB}\n`);
	await sleep(10);
	assert.deepEqual(seen, ["plan", "agent_message_chunk", "tool_call"]);
	// 分块 UTF-8(中文跨 chunk 切断)
	const textFrame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", text: "你好" } } }), "utf8");
	const cut = textFrame.indexOf(Buffer.from("你"));
	stdout.write(textFrame.subarray(0, cut));
	await sleep(5);
	stdout.write(textFrame.subarray(cut));
	stdout.write("\n");
	await sleep(10);
	assert.equal(seen.length, 4);
});

test("agent→client requests dispatch to handlers; defer answers later via respond", async (t) => {
	const { conn, sendFromAgent, written } = harness(t);
	let resolvePermission;
	const answers = [];
	conn.handleRequest("permission/request", (params, rpcId) => {
		// VM 沙箱 realm 数组用序列化断言（deepStrictEqual 比原型失配）
		answers.push(JSON.stringify(params.options.map((o) => o.optionId)));
		resolvePermission = (optionId) => conn.respond(rpcId, { outcome: { outcome: "selected", optionId } });
		return ACP_DEFER_RESPONSE;
	});
	sendFromAgent({ jsonrpc: "2.0", id: 41, method: "permission/request", params: { sessionId: "s", options: [{ optionId: "allow" }, { optionId: "reject" }] } });
	await sleep(10);
	assert.deepEqual(answers[0], JSON.stringify(["allow", "reject"]));
	resolvePermission("allow");
	await sleep(10);
	const response = written.find((frame) => frame.id === 41);
	assert.equal(response.result.outcome.optionId, "allow");
	// 未注册方法的 agent 请求收到 JSON-RPC method-not-found(-32601) 错误帧
	sendFromAgent({ jsonrpc: "2.0", id: 42, method: "future/method", params: {} });
	await sleep(10);
	const errFrame = written.find((frame) => frame.id === 42);
	assert.equal(errFrame.error.code, -32601);
});

test("request timeout rejects after timeoutMs", async (t) => {
	const { conn } = harness(t);
	await assert.rejects(conn.request("session/prompt", undefined, 30), /timed out after 30ms/);
});
