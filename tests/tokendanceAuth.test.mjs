/**
 * TokenDance 授权：loopback callback 模式（自动收 code，免用户复制粘贴）。
 *
 * 需求背景：用户反馈「一键配置后 apikey 还要再手动获取一遍，能不能放到一个操作里完成」。
 * 本文件覆盖把两件事合并成一个操作的主进程侧机制：
 * - start(callback) 把本地回环地址写进授权 URL 的 callback_url；
 * - awaitKey 等 code 自动送达并当场交换成 Key（PKCE verifier 不出主进程）；
 * - 绑定失败自动降级 headless；cancel/超时释放端口。
 * 大部分用例注入假监听器（不占真端口），最后一条用真实 node:http 服务验证端到端。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const auth = loadTsCommonJs("src/main/config/tokendanceAuth.ts");
const { TokendanceAuthStore } = auth;

/** 交换端点替身：记录请求体，返回固定 Key（不触真实网络）；responses 可给序列模拟先失败后成功。 */
function makeFetch({ status = 200, body = { key: "td-key-abc" }, responses } = {}) {
	const calls = [];
	let index = 0;
	const fetchFn = async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		const next = responses ? responses[Math.min(index, responses.length - 1)] : undefined;
		index += 1;
		const currentStatus = next?.status ?? status;
		const currentBody = next?.body ?? body;
		if (currentStatus !== 200) {
			return { ok: false, status: currentStatus, json: async () => ({ error: "forbidden" }) };
		}
		return { ok: true, status: currentStatus, json: async () => currentBody };
	};
	return { fetchFn, calls };
}

/** vm 跨 realm：store 返回的对象 prototype 不同，deepStrictEqual 会误报，按字段断言。 */
function assertOkKey(result, key = "td-key-abc") {
	assert.equal(result.ok, true);
	assert.equal(result.key, key);
}

/**
 * 假回环监听器：语义对齐真实实现（code 可先于 waitForCode 到达、close 唤醒等待者、
 * 超时返回 null），但不占端口。
 */
function makeFakeListener(callbackUrl = "http://127.0.0.1:54321/callback/fake-token") {
	const state = { received: null, waiter: null, closeCount: 0, timeouts: [] };
	return {
		callbackUrl,
		state,
		waitForCode: (timeoutMs) => {
			state.timeouts.push(timeoutMs);
			if (state.received !== null || state.closeCount > 0) {
				return Promise.resolve(state.received);
			}
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					if (state.waiter === finish) state.waiter = null;
					resolve(null);
				}, timeoutMs);
				const finish = (code) => {
					clearTimeout(timer);
					resolve(code);
				};
				state.waiter = finish;
			});
		},
		close: () => {
			state.closeCount += 1;
			const pending = state.waiter;
			state.waiter = null;
			pending?.(state.received);
		},
		deliver: (code) => {
			state.received = code;
			const pending = state.waiter;
			state.waiter = null;
			pending?.(code);
		},
	};
}

/** 注入假监听器工厂的 store；factory 可传 throw 以模拟绑定失败。 */
function makeStore({ listener, factory, fetchOptions } = {}) {
	const exchange = makeFetch(fetchOptions);
	const store = new TokendanceAuthStore({
		fetchFn: exchange.fetchFn,
		createCallbackServer:
			factory ??
			(async () => {
				if (!listener) throw new Error("no listener configured");
				return listener;
			}),
	});
	return { store, exchange };
}

test("start(callback)：callback_url 进入授权 URL，且不带 verifier（只带 S256 challenge）", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({ listener });
	const started = await store.start({ mode: "callback" });

	assert.equal(started.mode, "callback");
	const url = new URL(started.authUrl);
	assert.equal(url.searchParams.get("callback_url"), listener.callbackUrl);
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	// 归因仍走固定 app_url：随机回环端口不得写进 Key 归因
	assert.equal(url.searchParams.get("app_url"), "https://pideck.caoayu.top/");
	assert.ok(!started.authUrl.includes("verifier"), "verifier 不得出现在授权 URL");
});

test("awaitKey：code 自动送达即交换成 Key，一次点击完成授权（无需用户粘贴）", async () => {
	const listener = makeFakeListener();
	const { store, exchange } = makeStore({ listener });
	const started = await store.start({ mode: "callback" });

	const pending = store.awaitKey(started.flowId);
	listener.deliver("one-time-code");
	const result = await pending;

	assertOkKey(result);
	assert.equal(exchange.calls.length, 1);
	assert.equal(exchange.calls[0].body.code, "one-time-code");
	assert.equal(exchange.calls[0].body.code_challenge_method, "S256");
});

test("awaitKey：交换出去的 verifier 与授权 URL 里的 challenge 严格对应（PKCE 绑定）", async () => {
	const listener = makeFakeListener();
	const { store, exchange } = makeStore({ listener });
	const started = await store.start({ mode: "callback" });

	const pending = store.awaitKey(started.flowId);
	listener.deliver("code-1");
	await pending;

	const verifier = exchange.calls[0].body.code_verifier;
	const challenge = new URL(started.authUrl).searchParams.get("code_challenge");
	assert.equal(createHash("sha256").update(verifier, "utf8").digest("base64url"), challenge);
});

test("awaitKey：code 先于调用到达（用户秒授权）也能取到结果", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({ listener });
	const started = await store.start({ mode: "callback" });

	listener.deliver("early-code");
	const result = await store.awaitKey(started.flowId, 50);
	assertOkKey(result);
});

test("awaitKey：默认等待 5 分钟，覆盖用户切去浏览器登录确认的真实耗时", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({ listener });
	const started = await store.start({ mode: "callback" });
	const pending = store.awaitKey(started.flowId);
	listener.deliver("code-x");
	await pending;
	assert.equal(listener.state.timeouts[0], 5 * 60 * 1000);
});

test("awaitKey：超时返回失败并释放回环端口（渲染层据此展开手动兜底）", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({ listener });
	const started = await store.start({ mode: "callback" });

	const result = await store.awaitKey(started.flowId, 10);
	assert.equal(result.ok, false);
	assert.match(result.error, /timed out/);
	assert.ok(listener.state.closeCount >= 1, "超时必须关闭监听器释放端口");
	// 流程已清理：重复等待不再挂 5 分钟
	const again = await store.awaitKey(started.flowId, 10);
	assert.equal(again.ok, false);
	assert.match(again.error, /expired or unknown/);
});

test("cancel：立即释放端口并丢弃流程，弹窗关闭不留悬挂监听器", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({ listener });
	const started = await store.start({ mode: "callback" });

	store.cancel(started.flowId);
	assert.equal(listener.state.closeCount, 1);
	const result = await store.awaitKey(started.flowId, 10);
	assert.equal(result.ok, false);
	assert.match(result.error, /expired or unknown/);
});

test("回环端口绑定失败：自动降级 headless，带 fallbackReason 且不写 callback_url", async () => {
	const { store } = makeStore({
		factory: async () => {
			throw new Error("listen EACCES: permission denied 127.0.0.1");
		},
	});
	const started = await store.start({ mode: "callback" });

	assert.equal(started.mode, "headless");
	assert.match(started.fallbackReason, /EACCES/);
	assert.equal(new URL(started.authUrl).searchParams.get("callback_url"), null);
	// 降级后仍可走粘贴授权码的老路径，不阻断配置
	const headlessAwait = await store.awaitKey(started.flowId, 10);
	assert.equal(headlessAwait.ok, false);
	assert.match(headlessAwait.error, /not in callback mode/);
	const exchanged = await store.complete(started.flowId, "pasted-code");
	assertOkKey(exchanged);
});

test("显式请求 headless：不带 callback_url（保留原有手动路径）", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({ listener });
	const started = await store.start({ mode: "headless" });
	assert.equal(started.mode, "headless");
	assert.equal(new URL(started.authUrl).searchParams.get("callback_url"), null);
	// headless 不该占用监听器
	assert.equal(listener.state.closeCount, 0);
});

test("交换失败（403）：awaitKey 透传错误，流程保留以便用户换 code 重试", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({
		listener,
		fetchOptions: { responses: [{ status: 403 }, { status: 200 }] },
	});
	const started = await store.start({ mode: "callback" });

	const pending = store.awaitKey(started.flowId);
	listener.deliver("bad-code");
	const failed = await pending;
	assert.equal(failed.ok, false);
	assert.match(failed.error, /HTTP 403/);

	// code 未被消费：换正确 code 仍可成功
	const retry = await store.complete(started.flowId, "good-code");
	assertOkKey(retry);
});

test("交换响应缺 key：判失败而不是写入空 Key", async () => {
	const listener = makeFakeListener();
	const { store } = makeStore({ listener, fetchOptions: { body: {} } });
	const started = await store.start({ mode: "callback" });
	const pending = store.awaitKey(started.flowId);
	listener.deliver("code-1");
	const result = await pending;
	assert.equal(result.ok, false);
	assert.match(result.error, /empty key/);
});

test("真实回环服务：浏览器把 code 重定向回本机端口后，awaitKey 端到端拿到 Key", async () => {
	const exchange = makeFetch();
	const store = new TokendanceAuthStore({ fetchFn: exchange.fetchFn });
	const started = await store.start({ mode: "callback" });
	assert.equal(started.mode, "callback");

	const callbackUrl = new URL(started.authUrl).searchParams.get("callback_url");
	assert.match(callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback\/[\w-]+$/);

	const pending = store.awaitKey(started.flowId, 5000);
	// 模拟平台重定向：保留路径与查询参数并追加 code
	const response = await fetch(`${callbackUrl}?code=${encodeURIComponent("real-code")}`);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /授权已完成/);

	assertOkKey(await pending);
	assert.equal(exchange.calls[0].body.code, "real-code");
	store.cancel(started.flowId);
});

test("真实回环服务：错误路径的探测请求不消费流程，端口用完即释放", async () => {
	const exchange = makeFetch();
	const store = new TokendanceAuthStore({ fetchFn: exchange.fetchFn });
	const started = await store.start({ mode: "callback" });
	const callbackUrl = new URL(started.authUrl).searchParams.get("callback_url");
	const expected = new URL(callbackUrl);

	const pending = store.awaitKey(started.flowId, 5000);
	// 同端口但路径不对（本机其它页面误访问）→ 400，且不得提前结束流程
	const probe = await fetch(`http://127.0.0.1:${expected.port}/callback/not-the-token?code=steal`);
	assert.equal(probe.status, 400);
	assert.equal(exchange.calls.length, 0);

	await fetch(`${callbackUrl}?code=real-code`);
	assertOkKey(await pending);
	store.cancel(started.flowId);

	// 交换成功后端口应已释放：再打同一地址连接失败
	await assert.rejects(() => fetch(callbackUrl));
});
