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
	const reply = ({ agentId = "a", start = 1000, delta = 2000, end = 3000, usage = { output: 100 } } = {}) => {
		at(start, () => tracker.ensureTimer(agentId));
		if (delta !== null) at(delta, () => tracker.markFirstDelta(agentId));
		at(end, () => settle(agentId, { usage }));
		return tracker.getLast(agentId);
	};
	return { tracker, at, settle, reply, events, logs };
}

test("reply pairs both TPS values with the same usage, independently of text-only TTFT", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	f.at(2000, () => f.tracker.ensureTimer("a"));
	f.at(6000, () => f.tracker.markFirstDelta("a"));
	f.at(9000, () => f.tracker.markFirstText("a"));
	f.at(16000, () => f.settle("a", { usage: { output: 1000 } }));
	const result = f.tracker.getLast("a");
	assert.deepEqual({ ...result }, { totalMs: 15000, ttftMs: 8000, tps: 100, endToEndTps: 1000 / 15, sessionTps: 100, sessionEndToEndTps: 1000 / 15, at: 16000 });
	assert.deepEqual({ ...f.events[0].payload.state }, { totalMs: result.totalMs, ttftMs: result.ttftMs, tps: result.tps, endToEndTps: result.endToEndTps, sessionTps: result.sessionTps, sessionEndToEndTps: result.sessionEndToEndTps, perfAt: result.at });
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
	f.at(6000, () => f.tracker.markFirstDelta("a"));
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
	f.at(8200, () => f.tracker.markFirstDelta("a"));
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
