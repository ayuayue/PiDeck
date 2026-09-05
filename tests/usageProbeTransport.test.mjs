import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * usageProbeTransport 测试：验证「带 Cookie 头走 net.request、否则走 net.fetch」
 * 的分流与两种传输的错误/截断行为。根因：Electron net.fetch 会静默丢弃手动设置的
 * Cookie 头（forbidden header），必须用 net.request 的 setHeader 发 Cookie 探针。
 */

/** 构造一个模拟 Electron net.request 返回的 ClientRequest（事件流 API）。 */
function fakeClientRequest(opts, behavior) {
	const request = new EventEmitter();
	request.opts = opts;
	request.write = (chunk) => {
		request.writtenBody = (request.writtenBody ?? "") + chunk;
	};
	request.end = () => {
		// 同步触发 response 事件，模拟服务端立即返回。
		request.emit("response", fakeIncomingMessage(behavior));
	};
	request.abort = () => {
		// abort 后触发 error（ERR_ABORTED），与 Electron ClientRequest 行为一致。
		const err = new Error("net::ERR_ABORTED");
		err.code = "ERR_ABORTED";
		request.emit("error", err);
	};
	return request;
}

/** 构造一个模拟 IncomingMessage（statusCode + data/end/error 事件）。 */
function fakeIncomingMessage({ statusCode, body, error }) {
	const response = new EventEmitter();
	response.statusCode = statusCode;
	response.headers = {};
	// 下一拍再发数据，让调用方有时间挂上监听器。
	queueMicrotask(() => {
		if (error) {
			response.emit("error", error);
			return;
		}
		if (body) response.emit("data", Buffer.from(body));
		response.emit("end");
	});
	return response;
}

/** 模拟 Electron net.fetch（返回 fetch Response 形状）。 */
function fakeNetFetchResponse(status, body) {
	const chunks = [Buffer.from(body)];
	const stream = new ReadableStream({
		pull(controller) {
			if (chunks.length === 0) {
				controller.close();
				return;
			}
			controller.enqueue(chunks.shift());
		},
	});
	return {
		ok: status >= 200 && status < 300,
		status,
		body: stream,
	};
}

/** 组装带 stub electron 的传输模块。 */
function loadTransport(fakeNet) {
	return loadTsCommonJs("src/main/config/usageProbeTransport.ts", {
		stubs: { electron: { net: fakeNet } },
	});
}

test("hasCookieHeader 大小写不敏感命中 Cookie", () => {
	const transport = loadTransport({});
	assert.equal(transport.hasCookieHeader({ Cookie: "a=1" }), true);
	assert.equal(transport.hasCookieHeader({ cookie: "a=1" }), true);
	assert.equal(transport.hasCookieHeader({ COOKIE: "a=1" }), true);
	assert.equal(transport.hasCookieHeader({ Authorization: "Bearer x" }), false);
	assert.equal(transport.hasCookieHeader(undefined), false);
});

test("带 Cookie 头走 net.request 且 Cookie 原样保留", async () => {
	let captured;
	const fakeNet = {
		request: (opts) => {
			captured = opts;
			return fakeClientRequest(opts, { statusCode: 200, body: '{"code":0,"data":{"balance":"12.3"}}' });
		},
		fetch: async () => {
			throw new Error("不应走 net.fetch");
		},
	};
	const transport = loadTransport(fakeNet);
	const result = await transport.usageProbeRequest("https://tokenrhythm.studio/api/wallet/summary", {
		method: "GET",
		headers: { Cookie: "tr_session=abc; tr_csrf=xyz", "User-Agent": "OpenAI/JS 6.26.0" },
		timeoutMs: 5000,
		maxBytes: 64 * 1024,
	});
	assert.equal(captured.url, "https://tokenrhythm.studio/api/wallet/summary");
	assert.equal(captured.headers.Cookie, "tr_session=abc; tr_csrf=xyz");
	assert.equal(captured.headers["User-Agent"], "OpenAI/JS 6.26.0");
	assert.equal(result.status, 200);
	assert.equal(result.raw, '{"code":0,"data":{"balance":"12.3"}}');
});

test("无 Cookie 头走 net.fetch（redirect 拒绝保持原行为）", async () => {
	let fetchUrl;
	let fetchInit;
	const fakeNet = {
		request: () => {
			throw new Error("不应走 net.request");
		},
		fetch: async (url, init) => {
			fetchUrl = url;
			fetchInit = init;
			return fakeNetFetchResponse(200, '{"balance":1}');
		},
	};
	const transport = loadTransport(fakeNet);
	const result = await transport.usageProbeRequest("https://api.deepseek.com/user/balance", {
		method: "GET",
		headers: { Authorization: "Bearer key" },
		timeoutMs: 5000,
		maxBytes: 64 * 1024,
	});
	assert.equal(fetchUrl, "https://api.deepseek.com/user/balance");
	assert.equal(fetchInit.redirect, "error");
	assert.equal(result.status, 200);
	assert.equal(result.raw, '{"balance":1}');
});

test("net.request 路径超时归为 timeout", async () => {
	const fakeNet = {
		request: (opts) => {
			// 不触发 response：超时后 abort → error 事件。
			const request = new EventEmitter();
			request.opts = opts;
			request.write = () => {};
			request.end = () => {};
			request.abort = () => {
				const err = new Error("net::ERR_ABORTED");
				err.code = "ERR_ABORTED";
				request.emit("error", err);
			};
			return request;
		},
		fetch: async () => {
			throw new Error("不应走 net.fetch");
		},
	};
	const transport = loadTransport(fakeNet);
	const result = await transport.usageProbeRequest("https://x.example/api", {
		headers: { Cookie: "a=1" },
		timeoutMs: 5,
		maxBytes: 1024,
	});
	assert.equal(result.error, "timeout");
});

test("net.request 路径网络错误归为 network", async () => {
	const fakeNet = {
		request: () =>
			fakeClientRequest({}, { statusCode: 0, error: new Error("ERR_CONNECTION_REFUSED") }),
		fetch: async () => {
			throw new Error("不应走 net.fetch");
		},
	};
	const transport = loadTransport(fakeNet);
	const result = await transport.usageProbeRequest("https://x.example/api", {
		headers: { Cookie: "a=1" },
		timeoutMs: 5000,
		maxBytes: 1024,
	});
	assert.equal(result.error, "network");
});

test("net.request 路径响应体超限截断到 maxBytes", async () => {
	const fakeNet = {
		request: () =>
			fakeClientRequest({}, { statusCode: 200, body: "0123456789" }),
		fetch: async () => {
			throw new Error("不应走 net.fetch");
		},
	};
	const transport = loadTransport(fakeNet);
	const result = await transport.usageProbeRequest("https://x.example/api", {
		headers: { Cookie: "a=1" },
		timeoutMs: 5000,
		maxBytes: 4,
	});
	assert.equal(result.status, 200);
	assert.equal(result.raw, "0123");
});

test("net.request 路径 3xx 原样返回状态（fail-closed 不跟随重定向）", async () => {
	const fakeNet = {
		request: () =>
			fakeClientRequest({}, { statusCode: 302, body: "" }),
		fetch: async () => {
			throw new Error("不应走 net.fetch");
		},
	};
	const transport = loadTransport(fakeNet);
	const result = await transport.usageProbeRequest("https://x.example/api", {
		headers: { Cookie: "a=1" },
		timeoutMs: 5000,
		maxBytes: 1024,
	});
	assert.equal(result.status, 302);
	assert.equal(result.raw, "");
});

test("net.request 路径支持 POST body", async () => {
	let writtenBody;
	const fakeNet = {
		request: (opts) => {
			const request = fakeClientRequest(opts, { statusCode: 200, body: "{}" });
			request.write = (chunk) => {
				writtenBody = (writtenBody ?? "") + chunk;
			};
			return request;
		},
		fetch: async () => {
			throw new Error("不应走 net.fetch");
		},
	};
	const transport = loadTransport(fakeNet);
	await transport.usageProbeRequest("https://x.example/api", {
		method: "POST",
		headers: { Cookie: "a=1" },
		body: '{"q":1}',
		timeoutMs: 5000,
		maxBytes: 1024,
	});
	assert.equal(writtenBody, '{"q":1}');
});
