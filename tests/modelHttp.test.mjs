import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 统一模型 HTTP 层（src/main/modelHttp/request.ts + bounded.ts）测试。
 *
 * 这一层把主进程里「拿模型 API 的 JSON」重复了 4 份的传输细节收口：
 * 按需分流 net.fetch / net.request（Cookie 头是 fetch forbidden header）、
 * 归并超时与外部取消、响应体字节上界、错误归一成 timeout / network。
 * 用例锁定这些语义，避免以后各调用点又把分支写回去。
 */

/** 构造一个假 fetch Response：body 由 chunks 依次吐出，done 后关闭。 */
function fakeFetchResponse({ status = 200, statusText = "OK", chunks = [], headers = {}, onCancel } = {}) {
	let index = 0;
	return {
		status,
		statusText,
		headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
		body: {
			getReader: () => ({
				read: async () => {
					if (index >= chunks.length) return { done: true, value: undefined };
					const value = chunks[index++];
					return { done: false, value: typeof value === "string" ? Buffer.from(value) : value };
				},
				cancel: async () => {
					onCancel?.();
				},
			}),
		},
	};
}

/** 构造一个模拟 Electron ClientRequest。 */
function fakeClientRequest({ opts, statusCode, body = "", headers = {}, onAbort } = {}) {
	const request = new EventEmitter();
	request.opts = opts;
	request.written = "";
	request.write = (chunk) => {
		request.written += chunk;
	};
	request.end = () => {
		const response = new EventEmitter();
		response.statusCode = statusCode;
		response.headers = headers;
		request.emit("response", response);
		queueMicrotask(() => {
			if (body) response.emit("data", Buffer.from(body));
			response.emit("end");
		});
	};
	request.abort = () => {
		onAbort?.();
		const error = new Error("net::ERR_ABORTED");
		error.code = "ERR_ABORTED";
		request.emit("error", error);
	};
	return request;
}

/** 组装带 stub electron 的请求层。 */
function loadRequest({ fetchImpl, requestImpl, proxySession } = {}) {
	const calls = { fetch: [], setProxy: [] };
	const electron = {
		net: {
			fetch: async (url, init) => {
				calls.fetch.push({ url, init });
				if (!fetchImpl) throw new Error("不应走 net.fetch");
				return fetchImpl(url, init, calls);
			},
			request: (opts) => {
				calls.request = opts;
				if (!requestImpl) throw new Error("不应走 net.request");
				return requestImpl(opts, calls);
			},
		},
		session: {
			fromPartition: (partition) => {
				calls.partition = partition;
				return {
					setProxy: async (config) => {
						calls.setProxy.push(config);
						if (proxySession) await proxySession({ config, calls });
					},
					fetch: async (url, init) => {
						calls.sessionFetch = { url, init };
						if (!fetchImpl) throw new Error("不应走 session.fetch");
						return fetchImpl(url, init, calls);
					},
				};
			},
		},
	};
	const api = loadTsCommonJs("src/main/modelHttp/request.ts", { stubs: { electron } });
	return { api, calls };
}

test("hasCookieHeader 大小写不敏感，只认 Cookie", () => {
	const { api } = loadRequest();
	assert.equal(api.hasCookieHeader({ Cookie: "a=1" }), true);
	assert.equal(api.hasCookieHeader({ cookie: "a=1" }), true);
	assert.equal(api.hasCookieHeader({ Authorization: "Bearer x" }), false);
	assert.equal(api.hasCookieHeader(undefined), false);
});

test("无 Cookie 走 net.fetch：redirect 拒绝、正文按流读出", async () => {
	const { api, calls } = loadRequest({
		fetchImpl: async () => fakeFetchResponse({ chunks: ['{"data":', "[1]}"], headers: { "content-type": "application/json" } }),
	});
	const result = await api.modelHttpRequest("https://api.example.com/v1/models", {
		headers: { Authorization: "Bearer k" },
		timeoutMs: 1000,
		maxBytes: 1024,
	});
	assert.equal(calls.request, undefined);
	assert.equal(calls.fetch[0].init.redirect, "error");
	assert.equal(result.status, 200);
	assert.equal(result.raw, '{"data":[1]}');
	assert.equal(result.truncated, false);
	assert.equal(result.header("Content-Type"), "application/json");
	assert.equal(result.header("x-missing"), null);
});

test("带 Cookie 走 net.request（fetch forbidden header），Cookie 与 body 原样送出", async () => {
	const { api, calls } = loadRequest({
		requestImpl: (opts) => fakeClientRequest({ opts, statusCode: 200, body: '{"balance":1.5}' }),
	});
	const result = await api.modelHttpRequest("https://x.example/api", {
		method: "POST",
		headers: { Cookie: "session=abc" },
		body: '{"q":1}',
		timeoutMs: 1000,
		maxBytes: 1024,
	});
	assert.equal(calls.fetch.length, 0);
	assert.equal(calls.request.headers.Cookie, "session=abc");
	assert.equal(calls.request.method, "POST");
	assert.equal(result.status, 200);
	assert.equal(result.raw, '{"balance":1.5}');
});

test("net.request 的响应头数组取值取首个元素", async () => {
	const { api } = loadRequest({
		requestImpl: (opts) => fakeClientRequest({ opts, statusCode: 200, body: "{}", headers: { "Content-Type": ["application/json", "charset=utf-8"] } }),
	});
	const result = await api.modelHttpRequest("https://x.example/api", { headers: { Cookie: "a=1" }, timeoutMs: 1000, maxBytes: 64 });
	assert.equal(result.header("content-type"), "application/json");
});

test("超时归为 timeout，且 abort 同步抛出的 ERR_ABORTED 不抢先归为 network", async () => {
	const { api, calls } = loadRequest({
		// 不响应：超时后 abort → error（ERR_ABORTED）会同步抛出，必须仍归 timeout
		requestImpl: (opts, buckets) => {
			const request = new EventEmitter();
			request.opts = opts;
			request.write = () => {};
			request.end = () => {};
			request.abort = () => {
				buckets.aborted = true;
				const error = new Error("net::ERR_ABORTED");
				error.code = "ERR_ABORTED";
				request.emit("error", error);
			};
			return request;
		},
	});
	const result = await api.modelHttpRequest("https://x.example/api", { headers: { Cookie: "a=1" }, timeoutMs: 5, maxBytes: 64 });
	assert.equal(result.error, "timeout");
	assert.equal(calls.aborted, true);
});

test("外部 signal 取消同样归为 timeout", async () => {
	const { api } = loadRequest({
		fetchImpl: (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				});
			}),
	});
	const controller = new AbortController();
	const promise = api.modelHttpRequest("https://x.example/v1/models", { timeoutMs: 60_000, maxBytes: 64, signal: controller.signal });
	controller.abort();
	const result = await promise;
	assert.equal(result.error, "timeout");
});

test("net.fetch 普通异常归为 network 并保留原始文本供分类", async () => {
	const { api } = loadRequest({
		fetchImpl: async () => {
			throw new Error("net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH");
		},
	});
	const result = await api.modelHttpRequest("https://x.example/v1/models", { timeoutMs: 1000, maxBytes: 64 });
	assert.equal(result.error, "network");
	assert.match(result.detail, /ERR_SSL_VERSION_OR_CIPHER_MISMATCH/);
});

test("net.request 的响应流错误归为 network", async () => {
	const { api } = loadRequest({
		requestImpl: (opts) => {
			const request = fakeClientRequest({ opts, statusCode: 200, body: "" });
			request.end = () => {
				const response = new EventEmitter();
				response.statusCode = 200;
				response.headers = {};
				request.emit("response", response);
				queueMicrotask(() => response.emit("error", new Error("ECONNRESET")));
			};
			return request;
		},
	});
	const result = await api.modelHttpRequest("https://x.example/api", { headers: { Cookie: "a=1" }, timeoutMs: 1000, maxBytes: 64 });
	assert.equal(result.error, "network");
});

test("net.fetch 正文超上界：截断保留前缀并 cancel 读取", async () => {
	let cancelled = false;
	const { api } = loadRequest({
		fetchImpl: async () => fakeFetchResponse({ chunks: ["0123456789"], onCancel: () => (cancelled = true) }),
	});
	const result = await api.modelHttpRequest("https://x.example/v1/models", { timeoutMs: 1000, maxBytes: 4 });
	assert.equal(result.raw, "0123");
	assert.equal(result.truncated, true);
	assert.equal(cancelled, true);
});

test("net.request 正文超上界：同样截断", async () => {
	const { api } = loadRequest({
		requestImpl: (opts) => fakeClientRequest({ opts, statusCode: 200, body: "0123456789" }),
	});
	const result = await api.modelHttpRequest("https://x.example/api", { headers: { Cookie: "a=1" }, timeoutMs: 1000, maxBytes: 4 });
	assert.equal(result.raw, "0123");
	assert.equal(result.truncated, true);
});

test("proxyTarget.on：走独立 session 的 fixed_servers 代理", async () => {
	const { api, calls } = loadRequest({ fetchImpl: async () => fakeFetchResponse({ chunks: ["{}"] }) });
	await api.modelHttpRequest("https://x.example/v1/models", {
		timeoutMs: 1000,
		maxBytes: 64,
		proxyTarget: { mode: "on", url: "http://127.0.0.1:7890", bypass: "<local>" },
	});
	assert.equal(calls.partition, "pideck-config-proxy");
	// 逐字段比：vm 沙箱里创建的对象原型与宿不同，deepStrictEqual 会判不等
	assert.equal(calls.setProxy[0].mode, "fixed_servers");
	assert.equal(calls.setProxy[0].proxyRules, "http://127.0.0.1:7890");
	assert.equal(calls.setProxy[0].proxyBypassRules, "<local>");
	assert.equal(calls.sessionFetch.url, "https://x.example/v1/models");
	assert.equal(calls.fetch.length, 0);
});

test("proxyTarget.off：走独立 session 的 direct", async () => {
	const { api, calls } = loadRequest({ fetchImpl: async () => fakeFetchResponse({ chunks: ["{}"] }) });
	await api.modelHttpRequest("https://x.example/v1/models", { timeoutMs: 1000, maxBytes: 64, proxyTarget: { mode: "off" } });
	assert.equal(calls.setProxy[0].mode, "direct");
	assert.equal(calls.sessionFetch.url, "https://x.example/v1/models");
});

test("proxyTarget.follow：不碰 session，直接 net.fetch（跟随全局代理）", async () => {
	const { api, calls } = loadRequest({ fetchImpl: async () => fakeFetchResponse({ chunks: ["{}"] }) });
	await api.modelHttpRequest("https://x.example/v1/models", { timeoutMs: 1000, maxBytes: 64, proxyTarget: { mode: "follow" } });
	assert.equal(calls.setProxy.length, 0);
	assert.equal(calls.sessionFetch, undefined);
	assert.equal(calls.fetch.length, 1);
});

test("非 2xx 原样返回状态，由调用方判定（本层不做错误分类）", async () => {
	const { api } = loadRequest({ fetchImpl: async () => fakeFetchResponse({ status: 302, statusText: "Found", chunks: [""] }) });
	const result = await api.modelHttpRequest("https://x.example/v1/models", { timeoutMs: 1000, maxBytes: 64 });
	assert.equal(result.status, 302);
	assert.equal(result.raw, "");
});

test("readBoundedBytesOrNull：reject 语义按 content-length 提前拒绝", async () => {
	const { api: bounded } = { api: loadTsCommonJs("src/main/modelHttp/bounded.ts") };
	const response = {
		headers: { get: (name) => (name === "content-length" ? "999" : null) },
		body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) },
	};
	assert.equal(await bounded.readBoundedBytesOrNull(response, 10), null);
	assert.equal(await bounded.readBoundedTextOrNull(response, 10), null);
	// truncate 语义不看 content-length：仍要读满前缀供解析
	assert.equal(await bounded.readBoundedText(response, 10), "");
});

// ── 契约：主进程请求模型 API 不摸全局 fetch ─────────────────────────────
//
// 全局 fetch 是 Node 的 undici，不读系统代理、不跟随桌面代理开关、不用 Chromium
// 根证书库，境外 API 会挂到超时（docs/maintenance-domains.md 同款教训）。这几处
// 曾经各写一份全局 fetch，改用 modelHttpFetch 后加断言防回归：默认实现必须是
// 统一层的 fetch，注入点（deps.fetchImpl / deps.fetch）保持不变以便测试替身。

test("生图 / 生视频 / 语音转写 / 更新日志的缺省传输是 modelHttpFetch，不留全局 fetch 兜底", () => {
	for (const [file, marker] of [
		["src/main/imagegen/ImageGenService.ts", "await modelHttpFetch("],
		["src/main/videogen/VideoJobRunner.ts", "this.deps.fetchImpl ?? modelHttpFetch"],
		["src/main/voice/VoiceTranscriptionService.ts", "this.deps.fetch ?? modelHttpFetch"],
		["src/main/voice/VolcengineSpeechClient.ts", "deps.fetchImpl ?? modelHttpFetch"],
		["src/main/pi/PiChangelogService.ts", "this.deps.fetchImpl ?? modelHttpFetch"],
	]) {
		const source = readFileSync(file, "utf8");
		assert.ok(source.includes('from "../modelHttp/request"'), `${file} 应导入统一传输层`);
		assert.ok(source.includes(marker), `${file} 的缺省实现应是 modelHttpFetch`);
		assert.equal(/\?\?\s*fetch\b|= fetch;|await fetch\(/.test(source), false, `${file} 不应再直接调全局 fetch`);
	}
});

test("扩展目录页拉取把 fetchImpl 做成必填，删掉全局 fetch 兜底", () => {
	const source = readFileSync("src/main/extensions/piPackageCatalog.ts", "utf8");
	assert.ok(source.includes("fetchImpl: CatalogFetcher;"), "fetchImpl 应是必填参数（编译期强制调用方注入）");
	assert.equal(/fetchImpl\s*=\s*args\.fetchImpl\s*\?\?\s*fetch/.test(source), false, "不应保留 args.fetchImpl ?? fetch 兜底");
	assert.equal(/\?\?\s*fetch\b/.test(source), false, "文件内不应再出现全局 fetch 兜底");
});

test("本地进程与本地静态资源仍直连（不该走代理）", () => {
	// whisper-server 是 127.0.0.1 上的本地子进程；WebStaticAssets 扟的是本机 vite
	// dev server。Chromium 栈会把这类请求带进代理判定，本机代理异常时反而挂掉。
	// 留断言防止有人「顺手统一」。注：同文件里的 WhisperRuntimeManager 只管文件落位/
	// 解压，它唯一的外网请求（GitHub Release 摘要）在境外，所以它走统一层。
	for (const file of ["src/main/voice/WhisperServerPool.ts", "src/main/web/WebStaticAssets.ts"]) {
		const source = readFileSync(file, "utf8");
		assert.equal(source.includes('from "../modelHttp/request"'), false, `${file} 应继续直连，不经代理栈`);
	}
});
