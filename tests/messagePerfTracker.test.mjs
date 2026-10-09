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
	const at = (value, action) => {
		time = value;
		action?.();
	};
	const settle = (agentId, message) => tracker.settle(agentId, (channel, payload) => events.push({ channel, payload }), message);
	const reply = ({ agentId = "a", start = 1000, delta = 2000, end = 3000, usage = { output: 100 } } = {}) => {
		at(start, () => tracker.ensureTimer(agentId));
		if (delta !== null) at(delta, () => tracker.markFirstDelta(agentId));
		at(end, () => settle(agentId, { usage }));
		return tracker.getLast(agentId);
	};
	return { tracker, at, settle, reply, events };
}

test("reply pairs both TPS values with the same usage, independently of text-only TTFT", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	f.at(2000, () => f.tracker.ensureTimer("a"));
	f.at(6000, () => f.tracker.markFirstDelta("a"));
	f.at(9000, () => f.tracker.markFirstText("a"));
	f.at(16000, () => f.settle("a", { usage: { output: 1000 } }));
	const result = f.tracker.getLast("a");
	assert.deepEqual({ ...result }, { totalMs: 15000, ttftMs: 8000, tps: 100, endToEndTps: 1000 / 15, at: 16000 });
	assert.deepEqual({ ...f.events[0].payload.state }, { totalMs: result.totalMs, ttftMs: result.ttftMs, tps: result.tps, endToEndTps: result.endToEndTps, perfAt: result.at });
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

test("automatic retries retain the original request start and reset streaming timing", () => {
	const f = fixture();
	f.tracker.notePromptRequested("a", 1000);
	for (const attempt of [
		{ start: 1000, delta: 2000, end: 3000 },
		{ start: 6000, delta: null, end: 7000 },
	]) {
		f.reply({ ...attempt, usage: { output: 0 } });
		f.tracker.prepareRetry("a");
	}
	f.at(8000, () => f.tracker.ensureTimer("a"));
	f.at(9000, () => {
		f.tracker.markFirstDelta("a");
		f.tracker.markFirstText("a");
	});
	f.at(10000, () => f.settle("a", { usage: { output: 200 } }));
	const result = f.tracker.getLast("a");
	assert.equal(result.totalMs, 9000);
	assert.equal(result.ttftMs, 8000);
	assert.equal(result.tps, 200);
	assert.equal(result.endToEndTps, 200 / 9);
});

test("cancelled retry timing cannot leak into the next request", () => {
	const f = fixture();
	f.reply({ delta: null, usage: {} });
	f.tracker.prepareRetry("a");
	f.tracker.discardInFlight("a");
	assert.equal(f.reply({ start: 31000, delta: 32000, end: 33000 }).endToEndTps, 50);
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

test("older or undated runtime snapshots preserve the whole newer performance sample", () => {
	const { mergeAgentRuntimeState } = loadTsCommonJs("src/renderer/src/utils/agentRuntimeState.ts");
	const current = { perfAt: 200, totalMs: 15000, ttftMs: 5000, endToEndTps: 1000 / 15, tps: 100, toolStateSequence: 3, isExecutingTool: true };
	for (const perfAt of [100, undefined]) {
		const merged = mergeAgentRuntimeState(current, { perfAt, totalMs: undefined, ttftMs: 0, endToEndTps: 999, tps: 999, toolStateSequence: 2, isExecutingTool: false, sessionStats: { tokens: 42 }, isStreaming: false });
		for (const key of Object.keys(current)) assert.equal(merged[key], current[key], key);
		assert.equal(merged.sessionStats.tokens, 42);
		assert.equal(merged.isStreaming, false);
	}
});
