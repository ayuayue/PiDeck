import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const bridge = loadTsCommonJs("src/main/dsh/dshHostBridge.ts");

test("marshalFetchRequest 拆 URL 并带 method/headers/body", () => {
	const message = bridge.marshalFetchRequest("id-1", new URL("http://dsh.internal/api/session.prompt?x=1"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(message.type, "fetch-request");
	assert.equal(message.id, "id-1");
	assert.equal(message.method, "POST");
	assert.equal(message.path, "/api/session.prompt?x=1");
	assert.equal(message.body, "{}");
	assert.equal(message.headers["content-type"], "application/json");
});

test("marshalFetchRequest GET 无 body 时不带可选字段", () => {
	const message = bridge.marshalFetchRequest("id-2", new URL("http://dsh.internal/api/events.mux"));
	assert.equal(message.method, "GET");
	assert.equal(message.body, undefined);
	assert.equal(message.headers, undefined);
});

test("parseDshFetchMessage 往返合法消息", () => {
	const request = bridge.parseDshFetchMessage({
		type: "fetch-request",
		id: "r1",
		method: "POST",
		path: "/api/session.list",
		body: "{}",
	});
	assert.equal(request?.type, "fetch-request");
	assert.equal(request?.body, "{}");

	const response = bridge.parseDshFetchMessage({
		type: "fetch-response",
		id: "r1",
		status: 200,
		body: '{"ok":true}',
	});
	assert.equal(response?.type, "fetch-response");
	assert.equal(response?.status, 200);

	const start = bridge.parseDshFetchMessage({ type: "fetch-stream-start", id: "r2", status: 200 });
	assert.equal(start?.type, "fetch-stream-start");

	const chunk = bridge.parseDshFetchMessage({ type: "fetch-chunk", id: "r2", data: "data: x\n\n" });
	assert.equal(chunk?.type, "fetch-chunk");
	assert.equal(chunk?.data, "data: x\n\n");

	const end = bridge.parseDshFetchMessage({ type: "fetch-end", id: "r2" });
	assert.equal(end?.type, "fetch-end");

	const abort = bridge.parseDshFetchMessage({ type: "fetch-abort", id: "r1" });
	assert.equal(abort?.type, "fetch-abort");

	const error = bridge.parseDshFetchMessage({ type: "fetch-error", id: "r1", message: "boom" });
	assert.equal(error?.type, "fetch-error");
});

test("parseDshFetchMessage 拒绝畸形消息", () => {
	assert.equal(bridge.parseDshFetchMessage(undefined), undefined);
	assert.equal(bridge.parseDshFetchMessage({ type: "fetch-request" }), undefined, "缺 id");
	assert.equal(bridge.parseDshFetchMessage({ type: "fetch-request", id: "x" }), undefined, "缺 method/path");
	assert.equal(bridge.parseDshFetchMessage({ type: "fetch-response", id: "x" }), undefined, "缺 status");
	assert.equal(bridge.parseDshFetchMessage({ type: "fetch-chunk", id: "x" }), undefined, "缺 data");
	assert.equal(bridge.parseDshFetchMessage({ type: "unknown", id: "x" }), undefined);
	assert.equal(bridge.parseDshFetchMessage({ type: "fetch-request", id: "x", method: 1, path: "/" }), undefined, "method 非字符串");
});
