import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * DshRemoteClient 的 wire 载荷回归（0.1.5 typert Gateway 边界校验）。
 *
 * 背景：host 侧 gateway 对每个 RPC 载荷做两道强校验——args 键集必须与描述符 wires
 * 精确一致、每个值按 zod strict parse。迁移期载荷少一层 `request` 包装、少一个必填
 * 字段（如 session/prompt 的 requestId）都是**运行时才暴露**的 gateway/input-invalid，
 * 一个错误要打包重启一轮才能发现。这里用内存 transport 捕获真实发出的载荷做断言，
 * 静态全量核对见 `npm run check:dsh-wire`。
 */
const globals = { Headers, Response, ReadableStream, DOMException, TextEncoder };
const { DshApiClient } = loadTsCommonJs("src/main/dsh/DshApiClient.ts", { globals });
const { DshRemoteClient } = loadTsCommonJs("src/main/dsh/dshRemoteClient.ts", { globals });

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

async function waitForOutbound(mainToHost, count = 1, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (mainToHost.length < count && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return mainToHost.length >= count;
}

/** 发一次调用并返回 wire 载荷（`{ args }` 包装解包后的 args）。 */
async function captureArgs(call) {
	const { transport, mainToHost } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const remote = new DshRemoteClient(client);
	const pending = call(remote);
	await waitForOutbound(mainToHost, 1);
	const envelope = JSON.parse(mainToHost[0].body);
	const payload = { endpoint: envelope.method, args: envelope.payload.args };
	// 让在途 Promise 有结局（host 不回包即可视为传输悬挂，unref 后由 dispose 收尾）。
	void pending.catch(() => undefined);
	client.dispose();
	return payload;
}

test("session/prompt：request.requestId 必填且为 UUID（host 幂等键，缺失即被 gateway 拒绝）", async () => {
	const { endpoint, args } = await captureArgs((remote) => remote.sessionsPrompt({ sessionId: "s1", mode: "queue", content: [{ type: "text", text: "hi" }] }));
	assert.equal(endpoint, "session/prompt");
	assert.equal(typeof args.request.requestId, "string");
	assert.match(args.request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "requestId 必须是 UUID");
	assert.equal(args.request.sessionId, "s1");
	assert.equal(args.request.mode, "queue");
	assert.deepEqual(args.request.content, [{ type: "text", text: "hi" }]);
});

test("session/prompt：每次调用生成新的 requestId（幂等键不能复用）", async () => {
	const first = await captureArgs((remote) => remote.sessionsPrompt({ sessionId: "s1", mode: "queue", content: [{ type: "text", text: "a" }] }));
	const second = await captureArgs((remote) => remote.sessionsPrompt({ sessionId: "s1", mode: "queue", content: [{ type: "text", text: "b" }] }));
	assert.notEqual(first.args.request.requestId, second.args.request.requestId);
});

test("session/page：载荷包在 request 内（描述符 wire），且地址/区间字段齐全", async () => {
	const { endpoint, args } = await captureArgs((remote) => remote.sessionsHistory({ sessionId: "s1", throughSeq: 42, maxMessages: 10 }));
	assert.equal(endpoint, "session/page");
	assert.deepEqual(args.request.address, { kind: "session", sessionId: "s1" });
	assert.equal(args.request.maxMessages, 10);
	// 0.1.5 契约：throughSeq 是必填的「包含式日志切点」（≤ 会话 cursor，来自冷读
	// observation）；适配层必须原样透传调用方给的合法 cursor，禁止再送 MAX_SAFE_INTEGER。
	assert.equal(args.request.throughSeq, 42);
	assert.equal(args.address, undefined, "不得把 request 字段平铺到 args 顶层");
});

test("subagentsHistory：同 session/page，地址为 subagent 形态", async () => {
	const { args } = await captureArgs((remote) => remote.subagentsHistory({ parentSessionId: "p1", childSessionId: "c1", throughSeq: 7 }));
	assert.equal(args.request.address.kind, "subagent");
	assert.equal(args.request.address.parentSessionId, "p1");
	assert.equal(args.request.address.childSessionId, "c1");
	assert.equal(args.request.address.mode, "one-shot");
	assert.equal(args.request.throughSeq, 7);
});

test("session/list：wire 名为 _request（非可选），空对象表示不带游标", async () => {
	const { endpoint, args } = await captureArgs((remote) => remote.sessionsList());
	assert.equal(endpoint, "session/list");
	assert.deepEqual(args, { _request: {} });
});

// ── 实时助手流（0.1.5 思考过程/流式正文的唯一来路） ──
// session/follow 的助手增量是 opt-in 的：不传 assistantStream 就只剩终态
// assistant/message，表现为「看不到思考过程、正文整段才出现」。

test("sessionsFollow：opt-in assistantStream，并把实时帧翻成 assistant/live-chunk 事件", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const remote = new DshRemoteClient(client);
	const controller = new AbortController();
	const seen = [];
	const consume = (async () => {
		for await (const frame of remote.sessionsFollow({ sessionId: "s1" }, controller.signal)) seen.push(frame);
	})();
	await waitForOutbound(mainToHost, 1);
	const open = mainToHost[0];
	assert.equal(open.type, "stream-open");
	assert.equal(open.payload.args.request.address.sessionId, "s1");
	assert.equal(open.payload.args.request.assistantStream, true, "必须 opt-in，否则没有实时增量");

	hostPush({
		type: "stream-item",
		id: open.id,
		value: {
			type: "assistant-stream",
			ordinal: 1,
			frame: { type: "chunk", attemptId: "a1", time: 1700000000123, chunk: { type: "reasoning-delta", text: "想" } },
		},
	});
	hostPush({
		type: "stream-item",
		id: open.id,
		value: {
			type: "assistant-stream",
			ordinal: 2,
			frame: { type: "chunk", attemptId: "a1", chunk: { type: "text-delta", text: "答" } },
		},
	});
	// start/end 帧不产生事件（终态由会话日志的 assistant/message 收口）。
	hostPush({ type: "stream-item", id: open.id, value: { type: "assistant-stream", ordinal: 3, frame: { type: "end", attemptId: "a1" } } });

	const deadline = Date.now() + 5000;
	while (seen.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	hostPush({ type: "stream-end", id: open.id });
	await consume;

	assert.equal(seen.length, 2);
	assert.equal(seen[0].payload.type, "session/event");
	assert.equal(seen[0].payload.sessionId, "s1");
	assert.equal(seen[0].payload.event.type, "assistant/live-chunk");
	assert.equal(seen[0].payload.event.data.liveId, "dsh:live:a1");
	assert.equal(seen[0].payload.event.data.chunk.type, "reasoning-delta");
	assert.equal(seen[0].payload.event.data.chunk.text, "想");
	assert.equal(seen[0].payload.event.time, 1700000000123);
	assert.equal(seen[1].payload.event.data.chunk.text, "答");
	client.dispose();
});

// ── 投影控制流（session/control） ──
// 0.1.5 把「投影变更广播」从 events.mux 挪到这条 Host 级流：不订阅 ⇒ sessionStats /
// tokenUsage / contextPressure / contextBreakdown 永远停在 attach 那一刻的初值，
// 输入框底下只剩 deriveSessionStatsFallback 的「N 轮 · M 步」。

test("sessionControl：baseline 拆成每会话投影基线帧，projection 复用 session/projection 形状", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const remote = new DshRemoteClient(client);
	const controller = new AbortController();
	const seen = [];
	const consume = (async () => {
		for await (const frame of remote.sessionControl(controller.signal)) seen.push(frame);
	})();
	await waitForOutbound(mainToHost, 1);
	const open = mainToHost[0];
	assert.equal(open.type, "stream-open");
	assert.equal(open.endpoint, "session/control");

	// 首帧 baseline：全会话投影快照，必须按 sessionId 拆开（下游 dispatchMuxFrame 按
	// sessionId 找 runtime，整块下发会找不到 owner 而静默丢弃）。
	hostPush({
		type: "stream-item",
		id: open.id,
		value: {
			type: "baseline",
			value: {
				queues: { s1: [] },
				jobs: { s1: [] },
				projections: {
					s1: { asOfSeq: 7, values: { sessionStats: { turns: 1, steps: 35 } } },
					s2: { asOfSeq: 3, values: { todos: null } },
				},
			},
		},
	});
	// 实时帧：host 的 sessionProjections.onChanged 原样广播（含 seq）。
	hostPush({
		type: "stream-item",
		id: open.id,
		value: { type: "projection", sessionId: "s1", key: "sessionStats", value: { turns: 2, steps: 40 }, seq: 9 },
	});
	// queue/jobs 帧本项目暂不消费（渲染层队列/后台任务未接入），不应产出下游帧。
	hostPush({ type: "stream-item", id: open.id, value: { type: "queue", sessionId: "s1", value: [] } });

	const deadline = Date.now() + 5000;
	while (seen.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	hostPush({ type: "stream-end", id: open.id });
	await consume;

	assert.equal(seen.length, 3, "baseline 两条 + projection 一条，queue 帧不产出");
	assert.equal(seen[0].payload.type, "session/projection-baseline");
	assert.equal(seen[0].payload.sessionId, "s1");
	assert.deepEqual(seen[0].payload.block, { asOfSeq: 7, values: { sessionStats: { turns: 1, steps: 35 } } });
	assert.equal(seen[1].payload.sessionId, "s2");
	assert.equal(seen[1].payload.block.asOfSeq, 3);
	assert.equal(seen[2].payload.type, "session/projection");
	assert.equal(seen[2].payload.sessionId, "s1");
	assert.equal(seen[2].payload.key, "sessionStats");
	assert.deepEqual(seen[2].payload.value, { turns: 2, steps: 40 });
	assert.equal(seen[2].payload.seq, 9, "seq 必须透传，投影帧按 higher-seq-wins 收敛");
	client.dispose();
});

test("sessionControl：baseline 缺失 projections 时安全跳过，不产出任何帧", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport });
	const remote = new DshRemoteClient(client);
	const controller = new AbortController();
	const seen = [];
	const consume = (async () => {
		for await (const frame of remote.sessionControl(controller.signal)) seen.push(frame);
	})();
	await waitForOutbound(mainToHost, 1);
	const open = mainToHost[0];
	hostPush({ type: "stream-item", id: open.id, value: { type: "baseline", value: { queues: {}, jobs: {} } } });
	// 畸形帧：sessionId 非字符串 / value 非对象，都不应把垃圾推给下游。
	hostPush({ type: "stream-item", id: open.id, value: { type: "projection", sessionId: 5, key: "sessionStats", value: 1 } });
	await new Promise((resolve) => setTimeout(resolve, 60));
	hostPush({ type: "stream-end", id: open.id });
	await consume;
	assert.deepEqual(seen, []);
	client.dispose();
});
