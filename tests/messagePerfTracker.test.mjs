import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function fixture() {
	let time = 1000;
	class Clock extends Date {
		static now() {
			return time;
		}
	}
	const { MessagePerfTracker } = loadTsCommonJs("src/main/pi/messagePerfTracker.ts", { globals: { Date: Clock } });
	const tracker = new MessagePerfTracker();
	const events = [];
	const logs = [];
	const at = (value, action) => {
		time = value;
		action?.();
	};
	const settle = (agentId, message) =>
		tracker.settle(
			agentId,
			(channel, payload) => events.push({ channel, payload }),
			message,
			(message2, detail) => logs.push({ message: message2, detail }),
		);
	const deltas = (agentId, count) => {
		for (let index = 0; index < count; index++) tracker.noteDelta(agentId);
	};
	const reply = ({ agentId = "a", start = 1000, delta = 2000, deltas: deltaCount = 120, end = 3000, usage = { output: 100 } } = {}) => {
		at(start, () => tracker.ensureTimer(agentId));
		// 一次回复会收到很多 delta（真增量流式）；delta 数也是「整段送达」判据的分子，见 hasIncrementalDeltaStream。
		if (delta !== null) at(delta, () => deltas(agentId, deltaCount));
		at(end, () => settle(agentId, { usage }));
		return tracker.getLast(agentId);
	};
	return { tracker, at, settle, reply, deltas, events, logs };
}

test("reply pairs both TPS values with the same usage, independently of text-only TTFT", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	f.at(2000, () => f.tracker.ensureTimer("a"));
	f.at(6000, () => f.deltas("a", 1000));
	f.at(9000, () => f.tracker.markFirstText("a"));
	f.at(16000, () => f.settle("a", { usage: { output: 1000 } }));
	const result = f.tracker.getLast("a");
	assert.deepEqual({ ...result }, { totalMs: 15000, ttftMs: 8000, tps: 100, endToEndTps: 1000 / 15, sessionTps: 100, sessionEndToEndTps: 1000 / 15, at: 16000 });
	assert.deepEqual({ ...f.events[0].payload.state }, { totalMs: result.totalMs, ttftMs: result.ttftMs, tps: result.tps, endToEndTps: result.endToEndTps, sessionTps: result.sessionTps, sessionEndToEndTps: result.sessionEndToEndTps, perfAt: result.at });
});

test("a buffered reply contributes only to end-to-end throughput", () => {
	const f = fixture();
	const buffered = f.reply({ start: 1000, delta: 6105, end: 6138, usage: { output: 862 } });
	assert.equal(buffered.tps, undefined);
	assert.equal(buffered.sessionTps, undefined);
	assert.equal(buffered.endToEndTps, 862 / 5.138);
	assert.equal(buffered.sessionEndToEndTps, buffered.endToEndTps);

	// The 200 ms decode window is measurable even in a session with a buffered reply.
	const streamed = f.reply({ start: 7000, delta: 7800, end: 8000, usage: { output: 100 } });
	assert.equal(streamed.tps, 500);
	assert.equal(streamed.sessionTps, 500);
	assert.equal(streamed.sessionEndToEndTps, 962 / 6.138);
});

test("整段送达的回复不产生物理不可能的流式速度，也不拉高会话均速", () => {
	// #602：上游把正文分两批送到（1481 token / 2 个 delta）。窗口 264 ms 量到的是传输/刷新延迟，
	// 按它算会得到 5610 tok/s，而同一回复的端到端速度只有 1481 ÷ 1.264 ≈ 1172。
	const f = fixture();
	const lump = f.reply({ start: 1000, delta: 2000, deltas: 2, end: 2264, usage: { output: 1481 } });
	assert.equal(lump.tps, undefined, "非增量流式窗口不得输出流式速度");
	assert.equal(lump.sessionTps, undefined, "会话平均同样跳过该窗口");
	assert.equal(lump.endToEndTps, 1481 / 1.264);

	// 真增量流式（400 token / 400 delta）仍按流式窗口统计，不能被一刀切掉。
	const streamed = f.reply({ start: 4000, delta: 5000, deltas: 400, end: 6000, usage: { output: 400 } });
	assert.equal(streamed.tps, 400);
	assert.equal(streamed.sessionTps, 400);
});

test("continuation timer starts before provider waiting and excludes preceding tool execution", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	f.reply({ usage: { outputTokens: 100 } });
	f.at(31000, () => f.tracker.ensureTimer("a"));
	// A later message_start must not replace the preceding turn_start timestamp.
	const result = f.reply({ start: 32000, delta: 32000, end: 33000, usage: { completionTokens: 100 } });
	assert.equal(result.totalMs, 2000);
	assert.equal(result.tps, 100);
	assert.equal(result.endToEndTps, 50);
});

test("interrupted timing cleanup preserves settled metrics and removes pending timestamps", () => {
	const f = fixture();
	const settled = f.reply();
	f.tracker.notePromptRequested("a", 4000);
	f.at(5000, () => f.tracker.ensureTimer("a"));
	f.tracker.notePromptRequested("a", 6000);
	f.tracker.discardInFlight("a");
	assert.equal(f.tracker.getLast("a"), settled);
	assert.equal(f.reply({ start: 31000, delta: 32000, end: 33000 }).endToEndTps, 50);
});

test("automatic retry restarts timing at the new attempt; failed attempts and backoff are excluded", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	f.reply({ start: 1000, delta: 2000, end: 3000, usage: {} });
	// agent_end.willRetry → discard; Pi then backs off and emits a fresh turn_start.
	f.tracker.discardInFlight("a");
	const result = f.reply({ start: 8000, delta: 9000, end: 10000, usage: { output: 200 } });
	assert.equal(result.totalMs, 2000);
	assert.equal(result.tps, 200);
	assert.equal(result.endToEndTps, 100);
});

test("missing or invalid usage clears the previous reply rates", () => {
	const f = fixture();
	assert.equal(f.reply().tps, 100);
	for (const output of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
		const result = f.reply({ usage: { output } });
		assert.equal(result.tps, undefined);
		assert.equal(result.endToEndTps, undefined);
	}
});

test("zero output is valid and a missing first delta disables only streaming TPS", () => {
	const f = fixture();
	const withoutDelta = f.reply({ delta: null });
	assert.equal(withoutDelta.tps, undefined);
	assert.equal(withoutDelta.endToEndTps, 50);
	const zero = f.reply({ usage: { output: 0 } });
	assert.equal(zero.tps, 0);
	assert.equal(zero.endToEndTps, 0);
});

test("zero duration and duplicate settlement cannot produce infinite or repeated rates", () => {
	const f = fixture();
	const result = f.reply({ delta: 1000, end: 1000 });
	assert.equal(result.tps, undefined);
	assert.equal(result.endToEndTps, undefined);
	f.settle("a", { usage: { output: 100 } });
	assert.equal(f.events.length, 1);
});

test("phase breakdown attributes agent_start/turn_start/message_start/firstDelta offsets", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	// agent_start 先于计时器创建（turn_start 才起表）：挂 pending，起表时并入
	f.at(1500, () => f.tracker.noteAgentStart("a"));
	f.at(2000, () => f.tracker.ensureTimer("a"));
	f.at(2000, () => f.tracker.noteTurnStart("a"));
	f.at(3000, () => f.tracker.noteMessageStart("a"));
	f.at(6000, () => f.tracker.noteDelta("a"));
	f.at(9000, () => f.settle("a", { usage: { output: 10 } }));
	const entry = f.logs.at(-1);
	assert.equal(entry.message, "Model reply phase breakdown");
	// 起点被 notePromptRequested 固定在 1000：各边界偏移 = 边界时刻 − 起点
	// （展开复制：tracker 经 vm 沙箱加载，detail 的原型域与测试字面量不同）
	assert.deepEqual({ ...entry.detail }, { agentId: "a", agentStartMs: 500, turnStartMs: 1000, messageStartMs: 2000, firstDeltaMs: 5000, ttftMs: 5000, totalMs: 8000 });
});

test("discarded in-flight epoch leaves no stale agent_start for the next one", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	f.at(1500, () => f.tracker.noteAgentStart("a"));
	f.tracker.discardInFlight("a");
	f.at(8000, () => f.tracker.ensureTimer("a"));
	f.at(8200, () => f.tracker.noteDelta("a"));
	f.at(9000, () => f.settle("a", { usage: { output: 10 } }));
	const entry = f.logs.at(-1);
	// 中止轮的 agent_start 不能串进下一轮的归因（相对偏移会变成负数/错值）
	assert.equal(entry.detail.agentStartMs, undefined);
	assert.equal(entry.detail.firstDeltaMs, 200);
});

test("agents have isolated timers and lifecycle cleanup removes cached metrics", () => {
	const f = fixture();
	f.at(1000, () => f.tracker.ensureTimer("a"));
	f.reply({ agentId: "b", start: 2000, delta: 3000, end: 4000 });
	f.settle("a", { usage: { output: 100 } });
	assert.equal(f.tracker.getLast("a").endToEndTps, 100 / 3);
	assert.equal(f.tracker.getLast("b").endToEndTps, 50);
	f.tracker.clearAgent("a");
	assert.equal(f.tracker.getLast("a"), undefined);
	assert.ok(f.tracker.getLast("b"));
});

test("subagents task records merge with interval union for session tps", () => {
	const f = fixture();
	// Main reply 1: 1000 -> 3000 (delta: 2000), tokens: 100
	f.reply({ agentId: "a", start: 1000, delta: 2000, end: 3000, usage: { output: 100 } });
	// Subagent 1 & Subagent 2 run concurrently
	// Subagent 1: 4000 -> 6000, tokens: 100
	// Subagent 2: 5000 -> 7000, tokens: 100
	// E2E active duration: [1000, 3000] (2000ms) + union([4000, 6000], [5000, 7000]) -> [4000, 7000] (3000ms) = 5000ms
	// Total tokens: 300
	// E2E TPS: 300 / 5s = 60 TPS
	f.tracker.recordSubagentTask("a", { id: "sub-1", startedAt: 4000, completedAt: 6000, tokens: 100 });
	f.tracker.recordSubagentTask("a", { id: "sub-2", startedAt: 5000, completedAt: 7000, tokens: 100 });

	const last = f.tracker.getLast("a");
	assert.equal(last.sessionEndToEndTps, 60);
});

test("batch subagent sync dedupes by id, recomputes once and keeps snapshot at in sync with perfAt", () => {
	const f = fixture();
	f.reply({ agentId: "a", start: 1000, delta: 2000, end: 3000, usage: { output: 100 } });
	const batch = [
		{ id: "sub-1", startedAt: 4000, completedAt: 6000, tokens: 100 },
		{ id: "sub-2", startedAt: 5000, completedAt: 7000, tokens: 100 },
	];
	f.at(8000, () => f.tracker.syncSubagentTasks("a", batch, (channel, payload) => f.events.push({ channel, payload })));

	// 整批写入后与逐条记录结果一致：300 tokens / union([1000,3000],[4000,7000]) = 60
	assert.equal(f.tracker.getLast("a").sessionEndToEndTps, 60);
	assert.equal(f.tracker.getSessionSpans("a").length, 3);
	// 快照 at 与推送 perfAt 同源：读接口拿到的结算时刻不能比刚推的事件更旧
	const state = f.events.at(-1).payload.state;
	assert.equal(f.tracker.getLast("a").at, 8000);
	assert.deepEqual({ ...state }, { sessionTps: 100, sessionEndToEndTps: 60, perfAt: 8000 });

	// 重复回放同一批记录（列举子代理会反复读同一批）按 id 覆盖，不追加区间、不改变结果
	f.at(9000, () => f.tracker.syncSubagentTasks("a", batch, (channel, payload) => f.events.push({ channel, payload })));
	assert.equal(f.tracker.getSessionSpans("a").length, 3);
	assert.equal(f.tracker.getLast("a").sessionEndToEndTps, 60);
});

test("latest reply metrics record the provider and model that actually served the reply", () => {
	const f = fixture();
	// 运行时模型来源 = 宿主最近一次完整快照（AgentManager 按 agent 绑定）。
	let runtimeModel = { provider: "anthropic", modelId: "claude-opus-4", modelName: "Claude Opus 4" };
	f.tracker.bindRuntimeModelSource(() => runtimeModel);
	// assistant 消息自带 model（pi）：优先于运行时快照；供应商只来自运行时快照。
	f.at(1000, () => f.tracker.ensureTimer("a"));
	f.at(2000, () => f.tracker.noteDelta("a"));
	f.at(3000, () => f.tracker.settle("a", (channel, payload) => f.events.push({ channel, payload }), { model: "claude-opus-4", usage: { output: 100 } }));
	const facts = f.tracker.getLastReplyModel("a");
	assert.deepEqual({ provider: facts.provider, modelId: facts.modelId, modelName: facts.modelName }, { provider: "anthropic", modelId: "claude-opus-4", modelName: undefined });
	const state = f.events.at(-1).payload.state;
	assert.equal(state.perfProvider, "anthropic");
	assert.equal(state.perfModelId, "claude-opus-4");
	assert.equal(state.perfModelName, undefined);

	// assistant 消息没带 model 时退回运行时快照的 modelId / modelName。
	runtimeModel = { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" };
	f.at(4000, () => f.tracker.ensureTimer("a"));
	f.at(5000, () => f.tracker.noteDelta("a"));
	f.at(6000, () => f.tracker.settle("a", () => {}, { usage: { output: 10 } }));
	assert.equal(f.tracker.getLastReplyModel("a").modelId, "gpt-5");
	assert.equal(f.tracker.getLastReplyModel("a").modelName, "GPT-5");

	// 切模型后的子代理区间同步不能抹掉「最近一次回复」的归属。
	f.at(7000, () => f.tracker.recordSubagentTask("a", { id: "sub-1", startedAt: 6500, completedAt: 7000, tokens: 10 }));
	assert.equal(f.tracker.getLastReplyModel("a").provider, "openai");
	assert.equal(f.tracker.getLastReplyModel("a").modelId, "gpt-5");
	// 子代理区间同步只重算数值，快照结构不变（settle 的 push 形状仍由静态断言锁定）
	assert.deepEqual(Object.keys(f.tracker.getLast("a")).sort(), ["at", "endToEndTps", "sessionEndToEndTps", "sessionTps", "totalMs", "tps", "ttftMs"]);

	// 没有任何模型事实时不写空字段（旧 pi / 未轮询过快照 / 未绑定来源）。
	const g = fixture();
	g.reply();
	assert.equal(g.tracker.getLastReplyModel("a").provider, undefined);
	assert.equal(g.tracker.getLastReplyModel("a").modelId, undefined);
});

test("silent sync refreshes the snapshot without pushing runtime state", () => {
	const f = fixture();
	f.reply({ agentId: "a", start: 1000, delta: 2000, end: 3000, usage: { output: 100 } });
	const eventsBefore = f.events.length;
	f.at(8000, () => f.tracker.syncSubagentTasks("a", [{ id: "sub-1", startedAt: 4000, completedAt: 6000, tokens: 100 }]));
	assert.equal(f.events.length, eventsBefore);
	assert.equal(f.tracker.getLast("a").sessionEndToEndTps, 50);
	assert.equal(f.tracker.getLast("a").at, 8000);

	// 非法区间（缺 completedAt / 负 tokens）不重算也不推事件
	f.tracker.syncSubagentTasks("a", [{ id: "sub-2", startedAt: 4000, tokens: 100 }], (channel, payload) => f.events.push({ channel, payload }));
	f.tracker.syncSubagentTasks("a", [{ id: "sub-3", startedAt: 4000, completedAt: 6000, tokens: -1 }], (channel, payload) => f.events.push({ channel, payload }));
	assert.equal(f.events.length, eventsBefore);
	assert.equal(f.tracker.getSessionSpans("a").length, 2);
});
