// pi-deck-linked-sessions 扩展（resources/extensions/pi-deck-linked-sessions.ts）与端点线格式的测试。
//
// 扩展是自包含 .ts（只能 import type 共享类型），字段漂移没有编译期兜底，所以这里：
// 1. 真实执行扩展：env 缺失整体不注册；三个工具发出的帧字段；端点失败转成工具错误而不是抛出。
// 2. 契约：扩展发出的字段名必须被宿主的 parseLinkedSessionsRequest 接受（同一份帧过一遍解析器）。
// 3. 端点：只绑回环、token 头不对不放行、调用方身份来自 token。
import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const URL = "http://127.0.0.1:45999/linked/token-abc";
const TOKEN = "token-abc";

const passthrough = (schema) => schema;
const Type = { Object: passthrough, Optional: passthrough, String: () => ({ type: "string" }) };
const StringEnum = (values) => ({ enum: values });

function loadExtension({ env = { PIDECK_LINKED_SESSIONS_URL: URL, PIDECK_LINKED_SESSIONS_TOKEN: TOKEN }, respond } = {}) {
	const tools = new Map();
	const pi = { registerTool: (tool) => tools.set(tool.name, tool), on: () => () => {} };
	const calls = [];
	const sandbox = createTsSandbox({
		stubs: { typebox: { Type }, "@earendil-works/pi-ai": { StringEnum } },
		globals: {
			process: { env, stderr: { write: () => {} } },
			AbortController,
			setTimeout,
			clearTimeout,
			fetch: async (url, options) => {
				calls.push({ url, options, frame: JSON.parse(options.body) });
				if (respond) return respond(JSON.parse(options.body));
				return { json: async () => ({ ok: true, data: { echoed: true } }) };
			},
		},
	});
	const extension = sandbox("resources/extensions/pi-deck-linked-sessions.ts");
	extension.default(pi);
	return { tools, calls };
}

const { parseLinkedSessionsRequest, LinkedSessionServer } = loadTsCommonJs("src/main/linkedSessions/LinkedSessionServer.ts");

test("env 缺失时不注册任何工具（纯终端 pi / 端点未就绪 / 远端会话）", () => {
	assert.equal(loadExtension({ env: {} }).tools.size, 0);
	assert.equal(loadExtension({ env: { PIDECK_LINKED_SESSIONS_URL: URL } }).tools.size, 0);
});

test("注册三件工具，帧带 token 头，字段被宿主解析器原样接受", async () => {
	const { tools, calls } = loadExtension();
	assert.deepEqual([...tools.keys()].sort(), ["list_linked_sessions", "send_to_session", "start_session"]);
	await tools.get("start_session").execute("tc-9", { title: "修 bug", prompt: "修掉 a.ts", initiation: "offer" }, undefined);
	await tools.get("start_session").execute("tc-10", { proposal_id: "prop-1" }, undefined);
	await tools.get("send_to_session").execute("tc-11", { session_id: "child-1", message: "顺便改 README" }, undefined);
	await tools.get("list_linked_sessions").execute("tc-12", {}, undefined);
	for (const call of calls) {
		assert.equal(call.url, URL);
		assert.equal(call.options.headers["x-pideck-linked-token"], TOKEN);
		const parsed = parseLinkedSessionsRequest(call.frame);
		assert.ok(parsed, `宿主拒收了扩展发出的帧：${JSON.stringify(call.frame)}`);
		assert.deepEqual(JSON.parse(JSON.stringify(parsed)), call.frame, "宿主解析后字段不能丢（扩展字段名必须是共享类型声明过的）");
	}
	assert.equal(calls[0].frame.toolCallId, "tc-9", "卡片按工具调用 id 找提议");
	assert.equal(calls[1].frame.proposalId, "prop-1");
	assert.equal(calls[2].frame.sessionId, "child-1");
});

test("端点报错 / 连不上：转成工具错误结果，不抛", async () => {
	const failing = loadExtension({ respond: async () => ({ json: async () => ({ ok: false, error: "session-not-linked" }) }) });
	const denied = await failing.tools.get("send_to_session").execute("tc", { session_id: "x", message: "y" }, undefined);
	assert.equal(denied.isError, true);
	assert.match(denied.content[0].text, /session-not-linked/);
	const down = loadExtension({ respond: async () => Promise.reject(new Error("ECONNREFUSED")) });
	const unreachable = await down.tools.get("list_linked_sessions").execute("tc", {}, undefined);
	assert.equal(unreachable.isError, true);
	assert.match(unreachable.content[0].text, /pideck-unreachable/);
});

test("解析器只放行三种 op；start 必须有 title+prompt 或 proposalId", () => {
	assert.equal(parseLinkedSessionsRequest({ op: "delete", sessionId: "x" }), null);
	assert.equal(parseLinkedSessionsRequest({ op: "start", title: "只有标题" }), null);
	assert.equal(parseLinkedSessionsRequest({ op: "send", sessionId: "x" }), null);
	assert.equal(parseLinkedSessionsRequest({ op: "start", title: "t", prompt: "p", initiation: "whatever" }).initiation, undefined, "未知发起方式丢弃，由服务按 offer 处理");
});

test("端点：只绑 127.0.0.1，token 头不对 403，调用方身份来自 token", async () => {
	const seen = [];
	const server = new LinkedSessionServer(async (agentId, request) => {
		seen.push([agentId, request.op]);
		return { ok: true, data: null };
	});
	assert.equal(await server.start(), true);
	try {
		const env = server.registerAgent("agent-1");
		assert.match(env.PIDECK_LINKED_SESSIONS_URL, /^http:\/\/127\.0\.0\.1:\d+\/linked\//);
		const post = (headers) => fetch(env.PIDECK_LINKED_SESSIONS_URL, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ op: "list" }) });
		assert.equal((await post({})).status, 403);
		assert.equal((await post({ "x-pideck-linked-token": "wrong" })).status, 403);
		const ok = await post({ "x-pideck-linked-token": env.PIDECK_LINKED_SESSIONS_TOKEN });
		assert.equal(ok.status, 200);
		assert.deepEqual(seen, [["agent-1", "list"]]);
		server.unregisterAgent("agent-1");
		assert.equal((await post({ "x-pideck-linked-token": env.PIDECK_LINKED_SESSIONS_TOKEN })).status, 403, "注销后旧 token 失效");
	} finally {
		server.stop();
	}
});
