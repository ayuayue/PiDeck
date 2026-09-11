import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// vm 沙箱默认没有 fetch 系全局（主进程有，测试需补齐）：
// DshApiClient 用 Headers/Response/ReadableStream/DOMException 组装标准 Response。
const { DshApiClient } = loadTsCommonJs("src/main/dsh/DshApiClient.ts", {
  globals: {
    Headers,
    Response,
    ReadableStream,
    DOMException,
    TextEncoder,
  },
});

/**
 * 内存 transport：模拟 utilityProcess 桥两侧。
 * - mainToHost: main 发出的消息（fetch-request / stream-open / cancel 等）
 * - hostPush: 测试侧主动向 client 推送 host → main 消息
 */
function makeMemoryTransport() {
	const mainToHost = [];
	const listeners = new Set();
	return {
		transport: {
			send(message) {
				mainToHost.push(message);
			},
			onMessage(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose() {
				listeners.clear();
			},
		},
		mainToHost,
		hostPush(message) {
			for (const listener of listeners) listener(message);
		},
	};
}

/** 轮询等待 mainToHost 出现消息（客户端链在 microtask 里推进，不依赖固定延时）。 */
async function waitForOutbound(mainToHost, count = 1, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (mainToHost.length < count && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return mainToHost.length >= count;
}

test("call：client-request 信封 POST /api/<endpoint>，server-response 组装为结果", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });

	const promise = client.call("session/list", {});
	await waitForOutbound(mainToHost, 1);
	assert.equal(mainToHost[0].type, "fetch-request");
	assert.equal(mainToHost[0].method, "POST");
	assert.equal(mainToHost[0].path, "/api/session/list");

	// 信封：body 是 client-request JSON，rpcId 与桥消息 id 相互独立
	const envelope = JSON.parse(mainToHost[0].body);
	assert.equal(envelope.type, "client-request");
	assert.equal(envelope.method, "session/list");
	assert.equal(typeof envelope.rpcId, "string");

	hostPush({
		type: "fetch-response",
		id: mainToHost[0].id,
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "server-response",
			rpcId: envelope.rpcId,
			result: { ok: true, value: { items: [{ sessionId: "s1" }] } },
		}),
	});
	const result = await promise;
	assert.equal(result.ok, true);
	assert.deepEqual(result.value, { items: [{ sessionId: "s1" }] });
	client.dispose();
});

test("call：HTTP 非 200 收敛为 {ok:false, error:'internal'}（不 reject）", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const promise = client.call("session/list", {});
	await waitForOutbound(mainToHost, 1);
	hostPush({ type: "fetch-response", id: mainToHost[0].id, status: 500, body: "boom" });
	const result = await promise;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "internal");
	assert.match(result.error.message, /HTTP 500/);
	client.dispose();
});

test("call：rpcId 不匹配拒绝组装（关联校验）", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const promise = client.call("session/list", {});
	await waitForOutbound(mainToHost, 1);
	const envelope = JSON.parse(mainToHost[0].body);
	hostPush({
		type: "fetch-response",
		id: mainToHost[0].id,
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "server-response",
			rpcId: "other-id",
			result: { ok: true, value: {} },
		}),
	});
	const result = await promise;
	assert.equal(result.ok, false);
	assert.match(result.error.message, /rpcId mismatch/);
	client.dispose();
});

test("openStream：stream-open 发出，item* → end 组装为异步迭代", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });

	const iterator = client.openStream("session/follow", { request: { address: { kind: "session", sessionId: "s1" } } });
	const pending = iterator.next();
	await waitForOutbound(mainToHost, 1);
	assert.equal(mainToHost[0].type, "stream-open");
	assert.equal(mainToHost[0].endpoint, "session/follow");
	const streamId = mainToHost[0].id;

	hostPush({ type: "stream-item", id: streamId, value: { type: "event", event: { type: "turn/start", seq: 1 } } });
	hostPush({ type: "stream-item", id: streamId, value: { type: "event", event: { type: "turn/end", seq: 2 } } });
	hostPush({ type: "stream-end", id: streamId });

	const values = [];
	values.push((await pending).value);
	for await (const value of iterator) values.push(value);
	assert.equal(values.length, 2);
	assert.equal(values[0].event.type, "turn/start");
	assert.equal(values[1].event.type, "turn/end");
	client.dispose();
});

test("openStream：stream-error 以 'code: message' reject", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const iterator = client.openStream("session/follow", {});
	const pending = iterator.next().catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	hostPush({
		type: "stream-error",
		id: mainToHost[0].id,
		code: "gateway/context-not-found",
		message: "session gone",
		details: {},
	});
	const error = await pending;
	assert.match(String(error), /gateway\/context-not-found: session gone/);
	client.dispose();
});

test("外部 abort 转发 stream-cancel 并终止迭代", async () => {
	const { transport, mainToHost } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const controller = new AbortController();
	const iterator = client.openStream("session/follow", {}, controller.signal);
	// 先挂 catch（abort 可能在任何 await 点触发，避免 rejection 竞态）
	const pending = iterator.next().catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	controller.abort();
	// abort 转发：main → host 的 stream-cancel 已发出
	assert.ok(
		mainToHost.some((message) => message.type === "stream-cancel"),
		"abort 必须转发 stream-cancel 到 host",
	);
	// 取消语义：迭代以失败终结（与旧 SSE 流的 AbortError 契约一致）
	const error = await pending;
	assert.match(String(error), /cancelled/);
	client.dispose();
});

test("dispose 拒绝在途 call 并退订", async () => {
	const { transport, mainToHost } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const promise = client.call("session/list", {});
	await waitForOutbound(mainToHost, 1);
	client.dispose();
	const result = await promise;
	assert.equal(result.ok, false);
	assert.match(result.error.message, /transport disposed/);
});

test("dispose 后 abort/新 call 不再向 transport 发消息", async () => {
	const { transport, mainToHost } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const promise = client.call("session/list", {});
	await waitForOutbound(mainToHost, 1);
	client.dispose();
	const before = mainToHost.length;
	// dispose 后在途 call 已被拒绝结算，无 abort 消息可发
	const result = await promise;
	assert.equal(result.ok, false);
	assert.equal(mainToHost.length, before, "dispose 后不得向 transport 发消息");
	// dispose 后新请求直接失败，不产生任何桥消息
	const late = await client.call("session/list", {});
	assert.match(late.error.message, /transport disposed/);
	assert.equal(mainToHost.length, before);
});

test("abortAllPending 中断悬挂流（host 进程退出联动）", async () => {
	const { transport, mainToHost } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	// 流已打开但 host 永远不会发 stream-end（进程崩溃场景）
	const iterator = client.openStream("session/follow", {});
	const pending = iterator.next().catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	// DshHost 的 exit 联动：abortAllPending 应让悬挂流以 error 结束（pump 据此退避重连）
	client.abortAllPending();
	const error = await pending;
	assert.match(String(error), /DSH host process exited/);
	client.dispose();
});

test("abortAllPending 后新流不受影响（仅中断当时在途的流）", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const iterator = client.openStream("session/follow", {});
	const pending = iterator.next().catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	client.abortAllPending();
	await pending;
	// 新流（host 重启完成后）：应正常建立并接收帧
	const iterator2 = client.openStream("session/follow", {});
	const pending2 = iterator2.next();
	await waitForOutbound(mainToHost, 2);
	const streamId2 = mainToHost[1].id;
	hostPush({ type: "stream-item", id: streamId2, value: { type: "event", event: { type: "turn/start", seq: 1 } } });
	assert.deepEqual((await pending2).value, { type: "event", event: { type: "turn/start", seq: 1 } });
	hostPush({ type: "stream-end", id: streamId2 });
	client.dispose();
});

test("rawFetch：任意 dsh.internal 路径（插件管理桥用），不经过 RPC 信封", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });

	const promise = client.rawFetch("http://dsh.internal/pideck-plugin/rpc", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ method: "inventory", params: undefined }),
	});
	await waitForOutbound(mainToHost, 1);
	assert.equal(mainToHost[0].type, "fetch-request");
	assert.equal(mainToHost[0].path, "/pideck-plugin/rpc");
	assert.equal(mainToHost[0].method, "POST");
	const requestBody = JSON.parse(mainToHost[0].body);
	assert.equal(requestBody.method, "inventory");
	// JSON.stringify 会省略 undefined 字段：params 不传时请求体只有 method
	assert.equal("params" in requestBody, false);

	// 桥协议 unary 响应：rawFetch 不做 Connection 信封校验，原样返回 body
	hostPush({
		type: "fetch-response",
		id: mainToHost[0].id,
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ok: true, value: [{ pluginId: "p" }] }),
	});
	const response = await promise;
	assert.equal(response.status, 200);
	assert.deepEqual(JSON.parse(await response.text()), { ok: true, value: [{ pluginId: "p" }] });
	client.dispose();
});

test("respondRemoteEvent：POST /api/$events/result 载带 clientId/eventId/outcome", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const promise = client.respondRemoteEvent("client-1", "event-9", { kind: "result", value: "allowed-once" });
	await waitForOutbound(mainToHost, 1);
	assert.equal(mainToHost[0].path, "/api/$events/result");
	const envelope = JSON.parse(mainToHost[0].body);
	assert.equal(envelope.method, "$events/result");
	// 载荷统一 { args } 包装（gateway remoteRequest 强校验），领域字段在 args 内。
	assert.deepEqual(envelope.payload, {
		args: {
			clientId: "client-1",
			eventId: "event-9",
			outcome: { kind: "result", value: "allowed-once" },
		},
	});
	hostPush({
		type: "fetch-response",
		id: mainToHost[0].id,
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value: null } }),
	});
	const result = await promise;
	assert.equal(result.ok, true);
	client.dispose();
});

test("call：领域载荷统一包装为 { args }（gateway remoteRequest 强校验契约）", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const promise = client.call("settings/describe", { refs: ["a"] });
	await waitForOutbound(mainToHost, 1);
	const envelope = JSON.parse(mainToHost[0].body);
	// 裸领域对象在出口被包成 { args }，handler 侧拿到解包后的 args。
	assert.deepEqual(envelope.payload, { args: { refs: ["a"] } });
	hostPush({
		type: "fetch-response",
		id: mainToHost[0].id,
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value: {} } }),
	});
	const result = await promise;
	assert.equal(result.ok, true);
	client.dispose();
});

test("openStream：stream-open 帧载荷同样包装为 { args }", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const iterator = client.openStream("session/follow", { request: { address: { kind: "session", sessionId: "s1" } } });
	const done = (async () => {
		for await (const item of iterator) void item;
	})();
	await waitForOutbound(mainToHost, 1);
	assert.equal(mainToHost[0].type, "stream-open");
	// vm 沙箱 realm 的对象原型不同，deepEqual 会误报；JSON 序列化比较结构。
	assert.deepEqual(JSON.parse(JSON.stringify(mainToHost[0].payload)), {
		args: { request: { address: { kind: "session", sessionId: "s1" } } },
	});
	hostPush({ type: "stream-end", id: mainToHost[0].id });
	await done;
	client.dispose();
});

test("call：传入已 args 包装的载荷直接抛错（防二次包装静默损坏协议）", async () => {
	const { transport } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	await assert.rejects(
		client.call("settings/describe", { args: {} }),
		/already args-wrapped/,
	);
	client.dispose();
});
