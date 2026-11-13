import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 重放分批投递 + 投递窗口（docs/acp-replay-batching-plan.md Phase 2/3）：
// 一次全量 1076 条 / 4251KB 会在渲染进程形成长任务；现在先按「条数预算 + 轮边界」截窗口，
// 再把窗口按 100 条一块、每块隔一帧投递。渲染层零改动（复用 upsertFrom/totalLength）。
const emitted = [];
const { AcpUpdatePipeline } = loadTsCommonJs("src/main/acp/AcpUpdatePipeline.ts", {
	stubs: {
		"../../shared/ipc": { agentEventTags: { agentsMessage: "agents:message" } },
		"./AcpEventProjector": { projectAcpSessionUpdate: (projection) => projection },
		"../perf/messageFlushMeter": {
			emitAgentMessageMeasured: (_backend, _agentId, payload, emit) => emit(payload),
		},
	},
});
const { resolveAcpWindowStart } = loadTsCommonJs("src/main/acp/acpReplayWindow.ts");

/** 造 turns 轮、每轮 messagesPerTurn 条（首条 user，其余 assistant）。 */
function makeMessages(turns, messagesPerTurn) {
	const messages = [];
	for (let turn = 0; turn < turns; turn += 1) {
		for (let index = 0; index < messagesPerTurn; index += 1) {
			messages.push({ id: `m${turn}-${index}`, role: index === 0 ? "user" : "assistant", text: "x" });
		}
	}
	return messages;
}

function makeRuntime(messages) {
	return {
		status: "idle",
		tab: { id: "agent-1", deckSessionId: "deck-1" },
		acpSessionId: "acp-session-1",
		projection: { messages },
		windowStart: 0,
		updateChain: Promise.resolve(),
	};
}

function makePipeline(runtime) {
	const snapshots = new Map();
	const pipeline = new AcpUpdatePipeline(
		{
			ownsRuntime: (rt) => rt === runtime,
			isTracked: () => true,
			emit: (_channel, payload) => emitted.push(payload),
			emitRuntimeState: () => undefined,
		},
		{ set: (key, value) => snapshots.set(key, value) },
	);
	return { pipeline, snapshots };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

test("replay is windowed first, then delivered in ordered chunks", async () => {
	emitted.length = 0;
	// 3 轮 × 400 条：单轮就超过条数预算，窗口 = 最后一轮（400 条）→ 超过分块阈值
	const messages = makeMessages(3, 400);
	const expectedWindowStart = resolveAcpWindowStart(messages);
	assert.ok(expectedWindowStart > 0, "1200 条必须被窗口截断");
	assert.ok(messages.length - expectedWindowStart > 300, "窗口要大于分块阈值才走分块");
	const runtime = makeRuntime(messages);
	const { pipeline, snapshots } = makePipeline(runtime);
	pipeline.flushMessagesChunked(runtime);
	await settle();

	assert.equal(runtime.windowStart, expectedWindowStart);
	const windowed = messages.slice(expectedWindowStart);
	assert.equal(emitted[0].upsertFrom, undefined); // 首块全量，建立 runtime 缓存
	assert.equal(emitted[0].windowStart, expectedWindowStart);
	assert.equal(emitted[0].totalLength, expectedWindowStart + Math.min(100, windowed.length));
	// 重放标记：Web 事件流据此把整份窗口当历史吸收，不能照增量上屏（否则 ACP 文本重复渲染）
	for (const payload of emitted) assert.equal(payload.replay, true);
	// 块拼起来 == 窗口段，且顺序不变、无重复
	const delivered = emitted.flatMap((payload) => payload.messages.map((message) => message.id));
	assert.equal(delivered.join("|"), windowed.map((message) => message.id).join("|"));
	// 末块收敛到真实总条数
	assert.equal(emitted.at(-1).totalLength, messages.length);
	// 后续块都是增量，且 upsertFrom 用 runtime 绝对下标
	for (const payload of emitted.slice(1)) assert.equal(typeof payload.upsertFrom, "number");
	// 快照始终写全量：窗口只是投递口径
	assert.equal(snapshots.get("acp-session-1").length, messages.length);
});

test("short histories stay a single un-windowed flush", async () => {
	emitted.length = 0;
	const messages = makeMessages(5, 20); // 100 条 / 5 轮：窗口吃满整段
	assert.equal(resolveAcpWindowStart(messages), 0);
	const runtime = makeRuntime(messages);
	const { pipeline } = makePipeline(runtime);
	pipeline.flushMessagesChunked(runtime);
	await settle();
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].messages.length, 100);
	assert.equal(emitted[0].windowStart, undefined);
	assert.equal(emitted[0].upsertFrom, undefined);
	assert.equal(emitted[0].replay, true, "整段重放（一次全量）同样要标重放");
});

test("projection rewritten mid-chunk stops chunking and re-flushes the latest window", async () => {
	emitted.length = 0;
	const messages = makeMessages(3, 400);
	const runtime = makeRuntime(messages);
	const { pipeline } = makePipeline(runtime);
	pipeline.flushMessagesChunked(runtime);
	// 首块是同步发出的；5ms 时窗口内还剩后续块没发
	await new Promise((resolve) => setTimeout(resolve, 5));
	const nextMessages = [...messages, { id: "m-new", role: "assistant", text: "y" }];
	runtime.projection = { messages: nextMessages };
	await settle();
	const last = emitted.at(-1);
	const expectedWindowStart = resolveAcpWindowStart(nextMessages);
	assert.equal(last.upsertFrom, undefined); // 校准走全量
	assert.equal(last.totalLength, nextMessages.length);
	assert.equal(last.messages.length, nextMessages.length - expectedWindowStart);
	// 投影被改写后的校准可能含新一轮内容：不能标重放（否则新回合正文被当历史吞掉）
	assert.equal(last.replay, undefined);
});

test("a closed runtime stops the remaining chunks", async () => {
	emitted.length = 0;
	const runtime = makeRuntime(makeMessages(3, 400));
	const { pipeline } = makePipeline(runtime);
	pipeline.flushMessagesChunked(runtime);
	await new Promise((resolve) => setTimeout(resolve, 20));
	runtime.status = "closed";
	const sentBeforeClose = emitted.length;
	await settle();
	assert.equal(emitted.length, sentBeforeClose);
	assert.ok(sentBeforeClose < 4);
});
