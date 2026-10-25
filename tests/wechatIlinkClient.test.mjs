/**
 * IlinkClient(微信 iLink 协议传输层)单测：注入 fetch 桩，不联网、不依赖真实微信。
 * 覆盖：应用级/业务级请求头分流（凭据只在业务请求上）、ret≠0 → business 错误、
 * errcode -14 → session-expired、超时分类、QR 状态端点用自己的长超时（回归：
 * 探针第一版就是被默认 15s 超时打死的）、非 JSON 响应、游标续接、发送体组装、
 * 日志脱敏。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { IlinkClient, IlinkError, redactSecrets } = loadTsCommonJs("src/main/wechat/IlinkClient.ts");
const protocol = loadTsCommonJs("src/main/wechat/ilinkProtocol.ts");

const SESSION = { botToken: "78d85fe69881@im.bot:secret-value", baseUrl: "https://ilinkai.weixin.qq.com", ilinkBotId: "78d85fe69881@im.bot", ilinkUserId: "o9cq80x1@im.wechat", cursor: "" };

const jsonResponse = (payload, status = 200) => ({ status, text: async () => JSON.stringify(payload) });
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

/** 请求桩：按队列吐响应，记录每次调用的 url/headers/body 供断言。 */
function recorder(responses) {
	const calls = [];
	const fetchImpl = (url, init) => {
		calls.push({ url, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body), hasSignal: Boolean(init.signal) });
		const next = responses.shift();
		if (typeof next === "function") return next(url, init);
		if (next === undefined) throw new Error(`unexpected request to ${url}`);
		return Promise.resolve(next);
	};
	return { calls, fetchImpl };
}

/** 挂到被 abort 为止的桩：验证超时分类而不真的等 15s。 */
function hangingUntilAbort(url, init) {
	return new Promise((_, reject) => {
		init.signal.addEventListener("abort", () => reject(abortError()));
	});
}

const newClient = (fetchImpl, overrides = {}) => new IlinkClient({ channelVersion: "1.0.2", botAgent: "PiDeck/0.9.0", fetchImpl, timeouts: { api: 50, qrStatus: 50, poll: 50 }, ...overrides });

test("app-level calls carry no credentials while business calls carry the bearer token", async () => {
	const { calls, fetchImpl } = recorder([jsonResponse({ ret: 0, qrcode: "abc", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" }), jsonResponse({ ret: 0, msgs: [], get_updates_buf: "c1" })]);
	const client = newClient(fetchImpl);

	await client.createQrcode();
	const qrHeaders = calls[0].headers;
	assert.equal(qrHeaders.Authorization, undefined, "扫码阶段尚无 token，绝不能带鉴权头");
	assert.equal(qrHeaders.AuthorizationType, undefined);
	assert.equal(qrHeaders["X-WECHAT-UIN"], undefined);
	assert.match(calls[0].url, /get_bot_qrcode\?bot_type=3$/);

	await client.getUpdates(SESSION);
	const updatesHeaders = calls[1].headers;
	assert.equal(updatesHeaders.AuthorizationType, "ilink_bot_token");
	assert.equal(updatesHeaders.Authorization, `Bearer ${SESSION.botToken}`);
	// X-WECHAT-UIN 每次都要新随机值（固定值会被服务端判重放）
	assert.ok(updatesHeaders["X-WECHAT-UIN"], "业务请求要带 X-WECHAT-UIN");
	assert.equal(calls[1].hasSignal, true, "每个请求都要挂 AbortSignal 才能超时");
});

test("X-WECHAT-UIN is a fresh base64 value per request", async () => {
	const { calls, fetchImpl } = recorder([jsonResponse({ ret: 0, msgs: [], get_updates_buf: "c" }), jsonResponse({ ret: 0, msgs: [], get_updates_buf: "c" })]);
	const client = newClient(fetchImpl);
	await client.getUpdates(SESSION);
	await client.getUpdates(SESSION);
	const first = calls[0].headers["X-WECHAT-UIN"];
	const second = calls[1].headers["X-WECHAT-UIN"];
	assert.notEqual(first, second);
	assert.equal(Buffer.from(first, "base64").toString("utf-8"), String(Number(Buffer.from(first, "base64").toString("utf-8"))), "UIN 载荷应是十进制字符串");
});

test("QR status keeps its own long timeout and survives a wait longer than the api default", async () => {
	// 回归：QR 状态端点是长轮询。若它误用 api 超时（这里 50ms），这次 120ms 的响应会被 abort。
	const slow = (url, init) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => resolve(jsonResponse({ ret: 0, status: "confirmed", bot_token: "t" })), 120);
			init.signal.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(abortError());
			});
		});
	const slowClient = newClient(slow, { timeouts: { api: 50, qrStatus: 400, poll: 50 } });
	const result = await slowClient.queryQrcodeStatus("abc");
	assert.equal(result.status, "confirmed");
	// 对照：同样 120ms 的响应走业务端点（50ms 超时）必须被判成 timeout
	const businessSlow = newClient(slow, { timeouts: { api: 50, qrStatus: 400, poll: 50 } });
	await assert.rejects(businessSlow.getUpdates(SESSION), (error) => {
		assert.equal(error.kind, "timeout");
		return true;
	});
});

test("timeouts are classified as timeout and abort the request", async () => {
	const client = newClient(hangingUntilAbort, { timeouts: { api: 30, qrStatus: 30, poll: 30 } });
	await assert.rejects(client.getUpdates(SESSION), (error) => {
		assert.equal(error.kind, "timeout");
		assert.equal(error.endpoint, "getupdates");
		return true;
	});
});

test("network failures are distinguished from timeouts", async () => {
	const failing = () =>
		Promise.reject(
			Object.assign(new Error("fetch failed"), {
				name: "TypeError",
			}),
		);
	const client = newClient(failing);
	await assert.rejects(client.getUpdates(SESSION), (error) => {
		assert.equal(error.kind, "network");
		return true;
	});
});

test("ret!=0 becomes a business error while errcode -14 becomes session-expired", async () => {
	const { fetchImpl } = recorder([jsonResponse({ ret: -1, errmsg: "bad request" }), jsonResponse({ ret: -14, errcode: -14, errmsg: "session expired" })]);
	const client = newClient(fetchImpl);
	await assert.rejects(client.getUpdates(SESSION), (error) => {
		assert.equal(error.kind, "business");
		assert.equal(error.ret, -1);
		assert.match(error.message, /bad request/);
		return true;
	});
	await assert.rejects(client.getUpdates(SESSION), (error) => {
		assert.equal(error.kind, "session-expired");
		return true;
	});
});

test("HTTP-level and malformed responses never surface as bare exceptions", async () => {
	const { fetchImpl } = recorder([
		{ status: 403, text: async () => '{"error":"forbidden"}' },
		{ status: 200, text: async () => "<html>not json</html>" },
	]);
	const client = newClient(fetchImpl);
	await assert.rejects(client.createQrcode(), (error) => {
		assert.equal(error.kind, "http");
		assert.equal(error.httpStatus, 403);
		return true;
	});
	await assert.rejects(client.createQrcode(), (error) => {
		assert.equal(error.kind, "malformed");
		return true;
	});
});

test("getupdates sends the cursor back and returns the server cursor", async () => {
	const { calls, fetchImpl } = recorder([jsonResponse({ ret: 0, msgs: [], get_updates_buf: "next-cursor" })]);
	const client = newClient(fetchImpl);
	const result = await client.getUpdates(SESSION, "prev");
	assert.equal(calls[0].body.get_updates_buf, "prev");
	assert.equal(result.cursor, "next-cursor");
	assert.deepEqual(JSON.parse(JSON.stringify(result.msgs)), []);

	// 服务端不回游标时保留传入值，避免下一次变成「从头拉」
	const noCursor = recorder([jsonResponse({ ret: 0, msgs: [] })]);
	const client2 = newClient(noCursor.fetchImpl);
	assert.equal((await client2.getUpdates(SESSION, "keep")).cursor, "keep");
	// 首次无游标时回传空串而不是省略字段
	const first = recorder([jsonResponse({ ret: 0, msgs: [] })]);
	await newClient(first.fetchImpl).getUpdates(SESSION);
	assert.equal(first.calls[0].body.get_updates_buf, "");
});

test("sendText assembles the bot message envelope and always carries base_info", async () => {
	const { calls, fetchImpl } = recorder([jsonResponse({ ret: 0, message_id: 7516024233693981064 })]);
	const client = newClient(fetchImpl);
	const result = await client.sendText(SESSION, { toUserId: "user@im.wechat", contextToken: "ctx-token", text: "你好", clientId: "pideck-abc", runId: "run-1" });
	assert.equal(result.message_id, 7516024233693981064);
	const body = calls[0].body;
	assert.equal(body.msg.from_user_id, "");
	assert.equal(body.msg.to_user_id, "user@im.wechat");
	// client_id/run_id：官方插件每条出站消息都带，实测缺失会被服务端静默丢弃。
	assert.equal(body.msg.client_id, "pideck-abc");
	assert.equal(body.msg.run_id, "run-1");
	assert.equal(body.msg.message_type, protocol.MESSAGE_TYPE_BOT);
	assert.equal(body.msg.message_state, protocol.MESSAGE_STATE_DELIVERED);
	assert.equal(body.msg.context_token, "ctx-token");
	assert.equal(body.msg.item_list[0].type, protocol.ITEM_TYPE_TEXT);
	assert.equal(body.msg.item_list[0].text_item.text, "你好");
	assert.equal(body.base_info.channel_version, "1.0.2");
	assert.equal(body.base_info.bot_agent, "PiDeck/0.9.0");
});

test("sendText omits client_id/run_id when the caller has none", async () => {
	const { calls, fetchImpl } = recorder([jsonResponse({ ret: 0, message_id: 1 })]);
	await newClient(fetchImpl).sendText(SESSION, { toUserId: "u", contextToken: "ctx", text: "hi" });
	assert.equal("client_id" in calls[0].body.msg, false, "没传就不该凭空造一个假 ID");
	assert.equal("run_id" in calls[0].body.msg, false);
});

test("a session-expired code is not reported as a plain business failure anywhere", async () => {
	const { fetchImpl } = recorder([jsonResponse({ ret: 0, errcode: -14, typing_ticket: "x" })]);
	const client = newClient(fetchImpl);
	await assert.rejects(client.getConfig(SESSION, "u", "ctx"), (error) => {
		assert.equal(error.kind, "session-expired", "errcode 单独出现也要判会话过期");
		return true;
	});
});

test("long-poll sequences survive repeated timeouts without emitting extra requests", async () => {
	let attempts = 0;
	const flaky = (url, init) => {
		attempts += 1;
		if (attempts <= 2) {
			return new Promise((_, reject) => {
				init.signal.addEventListener("abort", () => reject(abortError()));
			});
		}
		return Promise.resolve(jsonResponse({ ret: 0, msgs: [{ message_id: 1, from_user_id: "u", to_user_id: "b", message_type: 1, context_token: "c", item_list: [{ type: 1, text_item: { text: "Hi" } }] }], get_updates_buf: "c2" }));
	};
	const client = newClient(flaky, { timeouts: { api: 20, qrStatus: 20, poll: 20 } });
	// 调用方负责重试；这里确认单次调用只发一次请求且超时后可继续（游标不被破坏）
	await assert.rejects(client.getUpdates(SESSION, "c1"));
	await assert.rejects(client.getUpdates(SESSION, "c1"));
	const ok = await client.getUpdates(SESSION, "c1");
	assert.equal(attempts, 3);
	assert.equal(ok.cursor, "c2");
	assert.equal(ok.msgs.length, 1);
});

test("base url follows scaned_but_redirect and ignores empty redirects", () => {
	const client = newClient(() => Promise.resolve(jsonResponse({ ret: 0 })));
	assert.equal(client.getBaseUrl(), protocol.ILINK_DEFAULT_BASE_URL);
	client.setBaseUrl("ilinkai.weixin.qq.com");
	assert.equal(client.getBaseUrl(), "https://ilinkai.weixin.qq.com");
	client.setBaseUrl("other.example.com");
	assert.equal(client.getBaseUrl(), "https://other.example.com");
	client.setBaseUrl(undefined);
	client.setBaseUrl("");
	assert.equal(client.getBaseUrl(), "https://other.example.com", "空重定向不能把 base 清掉");
});

test("redactSecrets masks tokens so they cannot reach the log", () => {
	const payload = JSON.stringify({ bot_token: "78d85fe69881@im.bot:06000072642df0", context_token: "AARzJWAFAAAB", typing_ticket: "AARTBK8F" });
	const redacted = redactSecrets(payload);
	assert.equal(redacted.includes("06000072642df0"), false);
	assert.equal(redacted.includes("AARzJWAFAAAB"), false);
	assert.equal(redacted.includes("AARTBK8F"), false);
	assert.match(redacted, /<redacted>/);
	assert.equal(redactSecrets("Authorization: Bearer abc.def-ghi").includes("abc.def-ghi"), false);
});

test("logging never receives the raw token", async () => {
	const seen = [];
	const { fetchImpl } = recorder([jsonResponse({ ret: 0, status: "confirmed", bot_token: "top-secret-token", ilink_bot_id: "b", ilink_user_id: "u" })]);
	const client = newClient(fetchImpl, {
		logger: (level, message, detail) => {
			seen.push(`${level} ${message} ${detail === undefined ? "" : JSON.stringify(detail)}`);
		},
	});
	await client.queryQrcodeStatus("abc");
	const joined = seen.join("\n");
	assert.equal(joined.includes("top-secret-token"), false, "token 不能落进日志出口");
});

test("IlinkError carries endpoint and kind for caller-side routing", async () => {
	const { fetchImpl } = recorder([]);
	const client = newClient(fetchImpl);
	const error = await client.queryQrcodeStatus("abc").catch((caught) => caught);
	assert.ok(error instanceof IlinkError);
	assert.equal(error.endpoint, "get_qrcode_status");
	assert.equal(error.kind, "network");
	// 沙箱 realm 的 Error 子类仍应是宿主 Error 的实例（否则测试侧分类断言会失配）
	assert.ok(error instanceof Error);
});

test("extractMessageText joins split text items and flags unsupported ones", () => {
	const textItems = [
		{ type: 1, text_item: { text: "第一段" } },
		{ type: 1, text_item: { text: "第二段" } },
	];
	assert.equal(protocol.extractMessageText(textItems), "第一段第二段");
	assert.equal(protocol.hasUnsupportedItem(textItems), false);
	const withImage = [...textItems, { type: 2, image_item: {} }];
	assert.equal(protocol.hasUnsupportedItem(withImage), true);
	assert.equal(protocol.extractMessageText(undefined), "");
	assert.equal(protocol.hasUnsupportedItem(undefined), false);
	assert.equal(protocol.extractMessageText([{ type: 2 }]), "");
});
