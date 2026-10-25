/**
 * /api/state 的条件请求（304）接线：直接驱动路由，验证真实分支而不是只测纯函数。
 *
 * 为什么值得单独测：ETag 只有「命中就不发响应体」才省钱，而这段逻辑在路由里。
 * 用假 port + 假 response 直接调 WebApiRoutes.handle，可在 node 里跑完整分支
 * （无需 Electron / 真实 HTTP / 真实 pi）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebApiRoutes } = loadTsCommonJs("src/main/web/WebApiRoutes.ts");
const { stateEtag } = loadTsCommonJs("src/main/web/WebStateEtag.ts");

const STATE = {
	projects: [{ id: "p1", name: "PiDeck", path: "C:/repo" }],
	sessions: [{ id: "s1", title: "标题", updatedAt: 1000, backend: "pi", status: "idle" }],
	runtimes: [],
	pendingUiRequests: [],
};

/** 假响应：记录 writeHead/end，供断言「有没有真的写体」。 */
function fakeResponse() {
	return {
		statusCode: 0,
		headers: {},
		body: null,
		headersSent: false,
		req: { headers: {} },
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers ?? {};
			this.headersSent = true;
			return this;
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

function makeRoutes(onSendJson) {
	// 只填 /api/state 分支会碰到的 port；其余保持可用但不会被调用
	const port = {
		deps: {},
		sendJson: (response, body, extraHeaders) => {
			response.writeHead(200, { "content-type": "application/json", ...(extraHeaders ?? {}) });
			response.end(JSON.stringify(body));
			onSendJson?.(body, extraHeaders);
		},
		sendError: () => {},
		sendNoContent: () => {},
		readJson: async () => ({}),
		getState: async () => STATE,
		queryNumber: () => undefined,
		runtimeAgentIdForSession: () => undefined,
		runtimeTargetForSession: () => undefined,
		executeRestartWithProgress: async () => {},
		handleStream: () => {},
		writeStreamError: () => {},
	};
	return new WebApiRoutes(port);
}

test("无 If-None-Match：正常返回 200 + 带 ETag 响应头", async () => {
	let sentBody = null;
	let sentHeaders = null;
	const routes = makeRoutes((body, headers) => {
		sentBody = body;
		sentHeaders = headers;
	});
	const response = fakeResponse();
	const request = { headers: {} };
	const handled = await routes.handle(new URL("http://127.0.0.1/api/state"), request, response);
	assert.equal(handled, true);
	assert.equal(response.statusCode, 200);
	assert.deepEqual(sentBody, STATE);
	assert.equal(sentHeaders.etag, stateEtag(STATE), "响应必须带 ETag，否则客户端无从条件请求");
});

test("If-None-Match 命中：304 且不发送响应体", async () => {
	let sendJsonCalls = 0;
	const routes = makeRoutes(() => {
		sendJsonCalls += 1;
	});
	const etag = stateEtag(STATE);
	const response = fakeResponse();
	const request = { headers: { "if-none-match": etag } };
	const handled = await routes.handle(new URL("http://127.0.0.1/api/state"), request, response);
	assert.equal(handled, true);
	assert.equal(response.statusCode, 304, "未变化必须 304");
	assert.equal(response.body, null, "304 不能带响应体");
	assert.equal(response.headers.etag, etag);
	assert.equal(sendJsonCalls, 0, "命中后不得再走 sendJson（否则等于没省流量）");
});

test("If-None-Match 弱标签/多值同样命中", async () => {
	const etag = stateEtag(STATE);
	for (const header of [`W/${etag}`, `"stale", ${etag}`, "*"]) {
		const response = fakeResponse();
		await routes(header, response);
		assert.equal(response.statusCode, 304, `header=${header} 应命中`);
	}
	function routes(header, response) {
		return makeRoutes().handle(new URL("http://127.0.0.1/api/state"), { headers: { "if-none-match": header } }, response);
	}
});

test("If-None-Match 不匹配：回 200 全量", async () => {
	const routes = makeRoutes();
	const response = fakeResponse();
	await routes.handle(new URL("http://127.0.0.1/api/state"), { headers: { "if-none-match": '"deadbeef"' } }, response);
	assert.equal(response.statusCode, 200);
	assert.ok(response.body && response.body.length > 0, "不匹配时要给完整载荷");
});

test("状态变化后同一 If-None-Match 失效（不会误回 304）", async () => {
	const first = stateEtag(STATE);
	const changed = { ...STATE, sessions: [{ id: "s1", title: "改标题", updatedAt: 2000, backend: "pi", status: "running" }] };
	const port = {
		deps: {},
		sendJson: (response, body) => {
			response.writeHead(200, {});
			response.end(JSON.stringify(body));
		},
		sendError: () => {},
		sendNoContent: () => {},
		readJson: async () => ({}),
		getState: async () => changed,
		queryNumber: () => undefined,
		runtimeAgentIdForSession: () => undefined,
		runtimeTargetForSession: () => undefined,
		executeRestartWithProgress: async () => {},
		handleStream: () => {},
		writeStreamError: () => {},
	};
	const routes = new WebApiRoutes(port);
	const response = fakeResponse();
	await routes.handle(new URL("http://127.0.0.1/api/state"), { headers: { "if-none-match": first } }, response);
	assert.equal(response.statusCode, 200, "内容变了就不能 304");
});
