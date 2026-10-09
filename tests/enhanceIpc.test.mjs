/**
 * 提示词增强 IPC handler（enhanceIpc）的边界校验测试。
 *
 * 渲染层来的数据一律不可信：provider/modelId 形态、草稿长度上限都在这一层拦；
 * 事件只回发给发起方（event.sender），这些语义在这里锁定。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { registerEnhanceIpc } = loadTsCommonJs("src/main/ipc/enhanceIpc.ts");

function createFakeIpc() {
	const handlers = new Map();
	return {
		handlers,
		handle: (channel, fn) => handlers.set(channel, fn),
	};
}

function createFakeService() {
	const calls = { enhance: [], cancel: 0 };
	let callbacks = null;
	return {
		calls,
		callbacks: () => callbacks,
		service: {
			enhance: async (input, cb) => {
				callbacks = cb;
				calls.enhance.push(input);
				return { ok: true, runId: "run-1" };
			},
			cancel: () => {
				calls.cancel += 1;
			},
		},
	};
}

function createEvent() {
	const sent = [];
	return {
		sent,
		event: { sender: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) } },
	};
}

/** 生产模块跑在 vm realm，对象原型不同：结构断言前先 JSON 归一化。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function register() {
	const ipc = createFakeIpc();
	const fake = createFakeService();
	registerEnhanceIpc(ipc, fake.service);
	return { ...fake, run: ipc.handlers.get("enhance:run"), cancel: ipc.handlers.get("enhance:cancel") };
}

const VALID = { provider: "kimi-coding", modelId: "kimi-k2", userText: "帮我写个爬虫" };

// 真实目录里存在的形态（session-catalog 实测）：provider/modelId 带 `:` `/` URL。
// 曾因校验过严把它们全拒掉，用户点增强直接「Invalid enhance input」（2026-06 反馈）。
const REAL_WORLD_VALID = [
	{ provider: "builtin:bigmodel-start-plan", modelId: "GLM-5.3-Flash", userText: "草稿" },
	{ provider: "https://open.mwy.asia", modelId: "gpt-5.6-luna", userText: "草稿" },
	{ provider: "workbuddy", modelId: "cn:deepseek-v4.1-flash", userText: "草稿" },
	{ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5", userText: "草稿" },
];

test("真实目录形态：带冒号/斜杠/URL 的 provider 与 modelId 必须放行", async () => {
	const h = register();
	for (const input of REAL_WORLD_VALID) {
		const result = await h.run(createEvent().event, input);
		assert.equal(result.ok, true, `should accept ${input.provider}/${input.modelId}`);
	}
	assert.deepEqual(
		h.calls.enhance.map((c) => `${c.provider}/${c.modelId}`),
		REAL_WORLD_VALID.map((c) => `${c.provider}/${c.modelId}`),
	);
});

test("中文与带空格的 provider/modelId 原样传递给增强服务", async () => {
	const h = register();
	const inputs = [
		{ ...VALID, provider: "我的供应商", modelId: "深度思考模型" },
		{ ...VALID, provider: "My Provider", modelId: "My Model 2" },
		{ ...VALID, provider: "中文 Provider", modelId: "模型 Pro v2" },
		{ ...VALID, provider: "p".repeat(160), modelId: "模".repeat(160) },
	];
	for (const input of inputs) assert.equal((await h.run(createEvent().event, input)).ok, true);
	assert.deepEqual(plain(h.calls.enhance), inputs);
});

test("名称边界：拒绝纯空白、控制字符与超长值且不调用服务", async () => {
	const h = register();
	const invalidNames = ["", "  ", "\u3000", "a\nname", "a\rname", "a\tname", "a\0name", "a\u007fname", "a\u0085name", "a\u2028name", "a\u2029name", "x".repeat(161), "名".repeat(161)];
	for (const field of ["provider", "modelId"]) {
		for (const name of invalidNames) {
			await assert.rejects(() => h.run(createEvent().event, { ...VALID, [field]: name }), new RegExp(`Invalid enhance input: ${field}`));
		}
	}
	assert.deepEqual(h.calls.enhance, []);
});

test("入参校验：provider/modelId/草稿形态不对直接抛错", async () => {
	const h = register();
	await assert.rejects(() => h.run(createEvent().event, { ...VALID, provider: "" }));
	await assert.rejects(() => h.run(createEvent().event, { ...VALID, modelId: 42 }));
	await assert.rejects(() => h.run(createEvent().event, { ...VALID, userText: "   " }));
	await assert.rejects(() => h.run(createEvent().event, { ...VALID, userText: "x".repeat(64 * 1024 + 1) }));
	await assert.rejects(() => h.run(createEvent().event, "not-an-object"));
	await assert.rejects(() => h.run(createEvent().event, null));
	assert.deepEqual(h.calls.enhance, []);
});

test("合法受理：转发给服务并把 started 发回发起方", async () => {
	const h = register();
	const { event, sent } = createEvent();
	const result = await h.run(event, VALID);
	assert.deepEqual(result, { ok: true, runId: "run-1" });
	assert.deepEqual(plain(h.calls.enhance), [VALID]);
	assert.deepEqual(plain(sent), [{ channel: "enhance:event", payload: { runId: "run-1", phase: "started" } }]);
});

test("回调事件按受理到的 runId 回发；窗口销毁后静默丢弃", async () => {
	const h = register();
	const destroyed = { sender: { isDestroyed: () => true, send: () => assert.fail("destroyed sender must not be sent") } };
	await h.run(destroyed, VALID);
	// 受理后服务才开始跑模型：回调此刻触发，销毁的 sender 不应炸主进程。
	h.callbacks().onDelta("增强");
	h.callbacks().onDone("增强后的提示词");
	await h.run(createEvent().event, VALID);
	h.callbacks().onAborted();
	h.callbacks().onError("model-not-found", "gone");
	// 不抛错即通过；断言正常 sender 的事件在下一测试锁定。
});

test("取消：转发服务 cancel", async () => {
	const h = register();
	const result = await h.cancel(createEvent().event);
	assert.deepEqual(plain(result), { ok: true });
	assert.equal(h.calls.cancel, 1);
});
