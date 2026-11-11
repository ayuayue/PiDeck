/**
 * Web 端「智能体目录」GET 的弱网兜底（webApi 的 apiGet）：超时 + 一次重试。
 *
 * 现场：手机经 EasyTier/NAT 连桌面端时，请求经常不是被 4xx/5xx 拒绝，而是「发出去没有回音」
 * ——浏览器复用了一条半死连接或被 6 条并发连接卡住，面板一路转圈到浏览器自己超时才报
 * 「智能体目录读取失败」。守的行为：
 * - 网络错误 / 5xx 各重试一次（第二次仍失败才抛）；
 * - 4xx 是契约错误，原样返回、不重试；
 * - 每次尝试都带 abort signal（超时必须真的能打断挂住的请求）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 加载 webApi 并把 fetch 换成可数的假实现（vm 沙箱不继承全局 fetch）。 */
function loadWebApi(impl) {
	const calls = [];
	const mod = loadTsCommonJs("src/renderer/src/web/webApi.ts", {
		globals: {
			fetch: async (input, init) => {
				calls.push({ input, init });
				return impl(calls.length);
			},
		},
	});
	return { mod, calls };
}

const okAgents = () => ({
	ok: true,
	status: 200,
	json: async () => ({ agents: [{ id: "builtin-pideck-helper" }] }),
	headers: { get: () => null },
});

test("retries once after a network error and returns the second response", async () => {
	const { mod, calls } = loadWebApi((attempt) => {
		if (attempt === 1) throw new TypeError("fetch failed");
		return okAgents();
	});
	const agents = await mod.fetchAgents();
	assert.equal(calls.length, 2, "a dropped request must get exactly one retry");
	assert.deepEqual(agents, [{ id: "builtin-pideck-helper" }]);
});

test("surfaces the failure after the single retry", async () => {
	const { mod, calls } = loadWebApi(() => {
		throw new TypeError("fetch failed");
	});
	await assert.rejects(() => mod.fetchAgents(), /fetch failed/);
	assert.equal(calls.length, 2, "give up after the retry instead of looping");
});

test("retries a 5xx once", async () => {
	const { mod, calls } = loadWebApi((attempt) => (attempt === 1 ? { ok: false, status: 503, json: async () => ({}), headers: { get: () => null } } : okAgents()));
	const agents = await mod.fetchAgents();
	assert.equal(calls.length, 2);
	assert.equal(agents.length, 1);
});

test("does not retry a 4xx", async () => {
	const { mod, calls } = loadWebApi(() => ({ ok: false, status: 401, json: async () => ({}), headers: { get: () => null } }));
	await assert.rejects(() => mod.fetchAgents(), /agents 401/);
	assert.equal(calls.length, 1, "a contract error must not be retried");
});

test("arms an abort timeout on every attempt", async () => {
	const { mod, calls } = loadWebApi(() => okAgents());
	await mod.fetchAgents();
	assert.equal(calls.length, 1);
	assert.equal(mod.WEB_GET_TIMEOUT_MS, 10_000);
	assert.ok(calls[0].init.signal instanceof AbortSignal, "the request must carry an abort signal");
	assert.equal(calls[0].input, "/api/agents");
});
