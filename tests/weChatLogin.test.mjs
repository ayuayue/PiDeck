import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 微信扫码登录状态机测试（WeChatLogin）。
 *
 * 重点在两类只有真机才会暴露的偏差（探针实测得来，见 ilinkProtocol 注释）：
 * 1. get_qrcode_status 是长轮询：超时表示「还没变化」，绝不能当成失败——
 *    探针第一版就是被一次性超时打死的。
 * 2. redirect 会换 base 域名，后续请求必须跟着走，否则轮询永远停在旧 host。
 */

const load = createTsSandbox({});
const { WeChatLogin } = load("src/main/wechat/WeChatLogin.ts");

/** 假传输层：状态按队列消费，队列空了就一直返回 wait。 */
function makeTransport({ qr = { qrcode: "Q1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x?qrcode=abc" }, statuses = [] } = {}) {
	const queries = [];
	const baseUrls = [];
	return {
		queries,
		baseUrls,
		createQrcode: async () => qr,
		queryQrcodeStatus: async (qrcode, verifyCode) => {
			queries.push({ qrcode, verifyCode });
			const next = statuses.length > 0 ? statuses.shift() : { status: "wait" };
			if (next instanceof Error) throw next;
			return next;
		},
		// 对齐真实 IlinkClient：空值不得清掉已生效的 base（否则重定向会被后续空字段抹掉）。
		setBaseUrl: (url) => {
			if (url) baseUrls.push(url);
		},
	};
}

/** 让当前的微任务队列排空（配合可控 sleep 使用）。 */
function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 可控时钟 + 可放行 sleep。
 *
 * 轮询循环在 sleep 里等下一轮。测试必须能在「两轮之间」插进去（提交验证码），
 * 用真定时器只能靠运气——所以把放行权交给测试。
 */
function makeStepper(stepMs = 1000) {
	let clock = 0;
	const waiters = [];
	return {
		sleep: () => new Promise((resolve) => waiters.push(resolve)),
		now: () => clock,
		pending: () => waiters.length,
		/** 放行一次 sleep（推进一个间隔），返回是否真有人等着。 */
		step() {
			const next = waiters.shift();
			if (!next) return false;
			clock += stepMs;
			next();
			return true;
		},
	};
}

/** 可控时钟：每次 sleep 推进一个间隔，让 deadline 一定会到达，循环不会挂死。 */
function makeClock(stepMs = 1000) {
	let clock = 0;
	return {
		now: () => clock,
		sleep: async () => {
			clock += stepMs;
		},
	};
}

function makeLogin(transport, overrides = {}) {
	const states = [];
	const clock = makeClock();
	const login = new WeChatLogin({
		transport,
		onState: (state) => states.push(state),
		pollIntervalMs: 1000,
		deadlineMs: 5000,
		sleep: clock.sleep,
		now: clock.now,
		...overrides,
	});
	return { login, states };
}

/** 同上，但轮询节奏由测试逐轮放行。 */
function makeSteppedLogin(transport, overrides = {}) {
	const states = [];
	const stepper = makeStepper();
	const login = new WeChatLogin({
		transport,
		onState: (state) => states.push(state),
		pollIntervalMs: 1000,
		deadlineMs: 5000,
		sleep: stepper.sleep,
		now: stepper.now,
		...overrides,
	});
	return { login, states, stepper };
}

/** 从状态序列里取出某阶段的状态。 */
function findByPhase(states, phase) {
	return states.find((state) => state.phase === phase);
}

test("prepare exposes the scannable content rather than the opaque query code", async () => {
	const transport = makeTransport();
	const { login, states } = makeLogin(transport);

	const prepared = await login.prepare();

	assert.equal(prepared.phase, "waiting");
	// 人扫的是 qrcode_img_content（liteapp URL）；qrcode 只是查询用的不透明码。
	assert.equal(prepared.qrcodeContent, "https://liteapp.weixin.qq.com/q/x?qrcode=abc");
	assert.equal(states.length, 1, "prepare must report exactly one state change");
	assert.equal(login.isRunning(), true);
});

test("a qrcode response without a query code fails before polling starts", async () => {
	const transport = makeTransport({ qr: { qrcode: "", qrcode_img_content: "https://x" } });
	const { login } = makeLogin(transport);

	const prepared = await login.prepare();

	assert.equal(prepared.phase, "error");
	assert.equal(login.isRunning(), false);
	const outcome = await login.run();
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error, "login not prepared");
});

test("confirmation returns the server-issued credentials and follows the redirect host", async () => {
	const transport = makeTransport({
		statuses: [{ status: "scaned" }, { status: "confirmed", bot_token: "TOKEN", ilink_bot_id: "bot@im.bot", ilink_user_id: "wxid_1", baseurl: "https://ilinkai.example.com" }],
	});
	const { login } = makeLogin(transport);

	await login.prepare();
	const outcome = await login.run();

	assert.equal(outcome.ok, true);
	assert.deepEqual(JSON.parse(JSON.stringify(outcome.credentials)), {
		botToken: "TOKEN",
		ilinkBotId: "bot@im.bot",
		ilinkUserId: "wxid_1",
		baseUrl: "https://ilinkai.example.com",
	});
	// 登录可能被调度到别的 IDC，base 必须跟着换，否则后续收信打到旧 host。
	assert.deepEqual(transport.baseUrls, ["https://ilinkai.example.com"]);
	assert.equal(login.getState().phase, "confirmed");
	assert.equal(login.isRunning(), false);
});

test("scaned_but_redirect switches the base and keeps waiting", async () => {
	const transport = makeTransport({
		statuses: [
			{ status: "scaned_but_redirect", redirect_host: "https://other.idc" },
			{ status: "confirmed", bot_token: "T", ilink_bot_id: "b", baseurl: "" },
		],
	});
	const { login } = makeLogin(transport);

	await login.prepare();
	const outcome = await login.run();

	assert.equal(outcome.ok, true);
	// 只记录真正生效的换域；空 baseurl 不该清掉重定向结果（对齐真实客户端语义）。
	assert.deepEqual(transport.baseUrls, ["https://other.idc"]);
	assert.equal(transport.queries.length, 2, "redirect must not end the wait");
});

test("need_verifycode surfaces the phase and the submitted code reaches the next poll", async () => {
	const transport = makeTransport({
		statuses: [{ status: "need_verifycode" }, { status: "confirmed", bot_token: "T", ilink_bot_id: "b" }],
	});
	const { login, states, stepper } = makeSteppedLogin(transport);

	await login.prepare();
	const pending = login.run();

	// 第一轮：服务端要求验证码。
	stepper.step();
	await tick();
	assert.ok(findByPhase(states, "need-verify-code"), "phase must be reported so the UI can ask for the code");
	assert.equal(transport.queries.length, 1);

	// 用户在两轮之间提交，验证码必须带到下一轮（而不是复用已发出的那一轮）。
	assert.equal(login.submitVerifyCode("123456"), true);
	stepper.step();

	const outcome = await pending;
	assert.equal(outcome.ok, true);
	assert.equal(transport.queries.length, 2);
	assert.equal(transport.queries[1].verifyCode, "123456", "the code must be sent on the following poll");
});

test("submitting a code with no login in flight is rejected", async () => {
	const transport = makeTransport();
	const { login } = makeLogin(transport);
	assert.equal(login.submitVerifyCode("123456"), false);
});

test("expiry ends the wait with the expired phase", async () => {
	const transport = makeTransport({ statuses: [{ status: "expired" }] });
	const { login, states } = makeLogin(transport);

	await login.prepare();
	const outcome = await login.run();

	assert.equal(outcome.ok, false);
	assert.equal(outcome.error, "expired");
	assert.equal(login.getState().phase, "expired");
	assert.ok(findByPhase(states, "expired"));
});

test("a long-poll timeout means no change, not a failure", async () => {
	const abort = new Error("This operation was aborted");
	abort.name = "AbortError";
	const transport = makeTransport({ statuses: [abort, abort, { status: "confirmed", bot_token: "T", ilink_bot_id: "b" }] });
	const { login, states } = makeLogin(transport);

	await login.prepare();
	const outcome = await login.run();

	assert.equal(outcome.ok, true, "timeouts must not terminate the wait");
	assert.equal(transport.queries.length, 3);
	assert.equal(findByPhase(states, "error"), undefined);
});

test("the deadline bounds a wait that never changes", async () => {
	const transport = makeTransport();
	const { login } = makeLogin(transport);

	await login.prepare();
	const outcome = await login.run();

	assert.equal(outcome.ok, false);
	assert.equal(outcome.error, "expired");
	// deadline 5000ms / 每次推进 1000ms：不能无限轮询。
	assert.equal(transport.queries.length, 5);
});

test("cancel stops the wait without reporting a terminal error", async () => {
	const transport = makeTransport();
	const { login, states } = makeLogin(transport);

	await login.prepare();
	const pending = login.run();
	login.cancel();
	const outcome = await pending;

	assert.equal(outcome.ok, false);
	assert.equal(outcome.error, "cancelled");
	assert.equal(login.isRunning(), false);
	// 取消是用户行为，不该在界面上留一个「登录失败」。
	assert.equal(findByPhase(states, "error"), undefined);
	assert.equal(findByPhase(states, "expired"), undefined);
});

test("confirmation without credentials is rejected instead of persisting a half account", async () => {
	const transport = makeTransport({ statuses: [{ status: "confirmed", bot_token: "", ilink_bot_id: "" }] });
	const { login } = makeLogin(transport);

	await login.prepare();
	const outcome = await login.run();

	assert.equal(outcome.ok, false);
	assert.equal(outcome.error, "confirmed without credentials");
	assert.equal(login.getState().phase, "error");
});

test("unknown status values are ignored rather than fatal", async () => {
	const transport = makeTransport({ statuses: [{ status: "some_future_state" }, { status: "confirmed", bot_token: "T", ilink_bot_id: "b" }] });
	const { login } = makeLogin(transport);

	await login.prepare();
	const outcome = await login.run();

	assert.equal(outcome.ok, true);
	assert.equal(transport.queries.length, 2);
});

test("repeated identical phases are reported once to avoid UI churn", async () => {
	const transport = makeTransport({ statuses: [{ status: "scaned" }, { status: "scaned" }, { status: "confirmed", bot_token: "T", ilink_bot_id: "b" }] });
	const { login, states } = makeLogin(transport);

	await login.prepare();
	await login.run();

	const scannedReports = states.filter((state) => state.phase === "scanned");
	assert.equal(scannedReports.length, 1);
});

test("start() is prepare plus run for callers that do not render the QR first", async () => {
	const transport = makeTransport({ statuses: [{ status: "confirmed", bot_token: "T", ilink_bot_id: "b" }] });
	const { login } = makeLogin(transport);

	const outcome = await login.start();

	assert.equal(outcome.ok, true);
	assert.equal(transport.queries.length, 1);
});
