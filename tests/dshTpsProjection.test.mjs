import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("@deepseek-ai/dsh-session-projection"));
const { z } = runtimeRequire("zod");
const [{ assistantStreamFirstTokenTime }, { Context }, { SessionProjectionRegistry }] = await Promise.all([
	import(pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href),
	import(pathToFileURL(runtimeRequire.resolve("@deepseek-ai/cordis")).href),
	import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-projection")).href),
]);
const { createDshTpsPlugin } = loadTsCommonJs("src/main/dsh/pideckTpsProjection.ts");
const { deriveDshSessionStats, parseDshTpsProjection } = loadTsCommonJs("src/main/dsh/dshProcessEvents.ts");

function definition() {
	let registered;
	createDshTpsPlugin(z, assistantStreamFirstTokenTime).apply({ sessionProjections: { register: (unit) => (registered = unit) } });
	assert.ok(registered);
	return registered;
}

const unit = definition();
const init = () => unit.init({}, 0);
const event = (type, time, data = {}) => ({ type, time, data });
const start = (time, turn = 0, step = 0) => event("step/start", time, { turn, step });
const textStream = (time, type = "text-chunks", texts = ["hello"], dt = [0]) => [{ type, time0: time, index: 0, dt, texts }];
const attempt = (time, stream, turn = 0, step = 0) => event("assistant/attempt", time, { turn, step, stream });
const finish = (time, outputTokens, turn = 0, step = 0, stream = []) => event("assistant/message", time, { turn, step, stream, usage: outputTokens === undefined ? undefined : { outputTokens } });
const replay = (events, state = init()) => events.reduce((current, entry) => unit.apply(current, entry), state);
const stats = (totals) => deriveDshSessionStats({ turns: 1, steps: 1, llmMs: 999999, toolMs: 20000, ttftMs: 1000, ttftSteps: 1, decodeMs: 0, decodeTokens: 0 }, totals);
const totalsOf = (state) => JSON.parse(JSON.stringify(unit.wire.view(state)));

test("projection schemas validate plain JSON state and reject malformed totals", () => {
	const state = init();
	assert.ok(unit.stateSchema.safeParse(state).success);
	assert.ok(unit.wire.viewSchema.safeParse(unit.wire.view(state)).success);
	assert.equal(unit.stateSchema.safeParse({ ...state, openStep: { turn: -1 } }).success, false);
	assert.equal(unit.wire.viewSchema.safeParse({ ...unit.wire.view(state), endToEndMs: -1 }).success, false);
	assert.equal(unit.wire.viewSchema.safeParse({ ...unit.wire.view(state), streamingTokens: "1" }).success, false);
});

test("streaming and end-to-end totals use only their corresponding valid output samples", () => {
	const state = replay([start(1000), attempt(4000, textStream(2000)), finish(4000, 100), start(5000, 0, 1), attempt(10000, textStream(6000), 0, 1), finish(10000, undefined, 0, 1), start(30000, 0, 2), attempt(31000, textStream(30500), 0, 2), finish(31000, 200, 0, 2)]);
	assert.deepEqual(totalsOf(state), { streamingTokens: 300, streamingMs: 2500, endToEndTokens: 300, endToEndMs: 4000 });
	assert.equal(stats(unit.wire.view(state)).tokensPerSecond, 120);
	assert.equal(stats(unit.wire.view(state)).endToEndTokensPerSecond, 75);
});

test("final message stream supplies first-token timing when attempt events are absent", () => {
	const state = replay([start(1000), finish(4000, 100, 0, 0, textStream(2000))]);
	assert.deepEqual(totalsOf(state), { streamingTokens: 100, streamingMs: 2000, endToEndTokens: 100, endToEndMs: 3000 });
	assert.equal(stats(unit.wire.view(state)).tokensPerSecond, 50);
	assert.equal(stats(unit.wire.view(state)).endToEndTokensPerSecond, 100 / 3);
});

test("a reply without a first-token record contributes only an end-to-end sample", () => {
	const state = replay([start(1000), finish(4000, 90)]);
	assert.deepEqual(totalsOf(state), { streamingTokens: 0, streamingMs: 0, endToEndTokens: 90, endToEndMs: 3000 });
	assert.equal(stats(unit.wire.view(state)).tokensPerSecond, undefined);
	assert.equal(stats(unit.wire.view(state)).endToEndTokensPerSecond, 30);
});

test("empty fragments are ignored and reasoning/tool-call fragments follow the official first-token reader", () => {
	for (const stream of [textStream(1100, "reasoning-chunks", ["", "thought"], [900]), [{ type: "tool-call-chunks", time0: 2000, index: 0, dt: [0], id: "call-1", name: "read", args: [""] }]]) {
		const state = replay([start(1000), attempt(4000, stream), finish(4000, 100)]);
		assert.equal(stats(unit.wire.view(state)).tokensPerSecond, 50);
	}
});

test("zero, negative, non-finite durations and invalid usage never add a sample", () => {
	for (const output of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
		assert.deepEqual(totalsOf(replay([start(1000), attempt(4000, textStream(2000)), finish(4000, output)])), totalsOf(init()));
	}
	for (const end of [1000, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.deepEqual(totalsOf(replay([start(1000), attempt(end, textStream(1000)), finish(end, 100)])), totalsOf(init()));
	}
	const state = replay([start(1000), attempt(2000, textStream(2000)), finish(2000, 100)]);
	assert.equal(stats(unit.wire.view(state)).tokensPerSecond, undefined);
	assert.equal(stats(unit.wire.view(state)).endToEndTokensPerSecond, 100);
});

test("zero output is a valid measurement when its duration is positive", () => {
	const state = replay([start(1000), attempt(4000, textStream(2000)), finish(4000, 0)]);
	assert.equal(stats(unit.wire.view(state)).tokensPerSecond, 0);
	assert.equal(stats(unit.wire.view(state)).endToEndTokensPerSecond, 0);
});

test("retries preserve the step boundary and first token while counting only the settled usage", () => {
	const state = replay([start(1000), attempt(3500, textStream(3000)), event("llm/retry", 4000), attempt(8000, textStream(5000)), finish(8000, 100)]);
	assert.deepEqual(totalsOf(state), { streamingTokens: 100, streamingMs: 5000, endToEndTokens: 100, endToEndMs: 7000 });
});

test("turn/step termination discards pending timing and excludes subsequent tool time", () => {
	for (const termination of ["step/end", "turn/end"]) {
		const state = replay([start(1000), attempt(2000, textStream(1500)), event(termination, 3000, { turn: 0, step: 0 }), finish(4000, 999), start(30000, 1), attempt(32000, textStream(31000), 1), finish(32000, 100, 1)]);
		assert.deepEqual(totalsOf(state), { streamingTokens: 100, streamingMs: 1000, endToEndTokens: 100, endToEndMs: 2000 });
	}
});

test("unrelated events and foreign assistant steps leave state unchanged", () => {
	const state = unit.apply(init(), start(1000));
	assert.equal(unit.apply(state, event("tool/call", 2000)), state);
	assert.equal(unit.apply(state, attempt(2000, textStream(1500), 1, 1)), state);
	assert.equal(unit.apply(state, finish(3000, 100, 1, 1)), state);
});

test("pending first-token updates keep the same wire view and replay resumes from a validated JSON checkpoint", () => {
	const state = unit.apply(init(), start(1000));
	const updated = unit.apply(state, attempt(3000, textStream(2000)));
	assert.equal(unit.wire.view(updated), unit.wire.view(state));
	const checkpoint = unit.stateSchema.parse(JSON.parse(JSON.stringify(updated)));
	const tail = [finish(4000, 100), start(9000, 0, 1), attempt(10000, textStream(9500), 0, 1), finish(10000, 50, 0, 1)];
	assert.deepEqual(totalsOf(replay(tail, checkpoint)), totalsOf(replay([start(1000), attempt(3000, textStream(2000)), ...tail])));
});

test("selected runtime registry validates replay, restores checkpoints and cleans up the plugin", async () => {
	const ctx = new Context();
	const registry = new SessionProjectionRegistry(ctx);
	const fiber = ctx.plugin(createDshTpsPlugin(z, assistantStreamFirstTokenTime));
	await fiber;
	try {
		const entries = [start(1000), attempt(3000, textStream(2000)), finish(4000, 100)].map((entry, seq) => ({ ...entry, seq }));
		const restored = registry.restore({}, entries, 0, {}, 0);
		assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot.values.pideckTps)), { streamingTokens: 100, streamingMs: 2000, endToEndTokens: 100, endToEndMs: 3000 });
		const checkpoint = JSON.parse(JSON.stringify(restored.checkpoint));
		const floor = registry.restoreFloor(checkpoint);
		assert.equal(floor, 2);
		assert.deepEqual(JSON.parse(JSON.stringify(registry.restore(checkpoint, entries.slice(floor), floor, {}, 0).snapshot)), JSON.parse(JSON.stringify(restored.snapshot)));
	} finally {
		await fiber.dispose();
	}
	assert.equal(registry.restore({}, [], 0, {}, 0).snapshot.values.pideckTps, undefined);
});

test("wire parsing supports direct and baseline values and rejects missing or malformed data", () => {
	const value = { streamingTokens: 100, streamingMs: 2000, endToEndTokens: 100, endToEndMs: 3000 };
	assert.deepEqual(JSON.parse(JSON.stringify(parseDshTpsProjection(value))), value);
	assert.deepEqual(JSON.parse(JSON.stringify(parseDshTpsProjection({ pideckTps: value }))), value);
	assert.equal(parseDshTpsProjection({ values: {} }), undefined);
	assert.equal(parseDshTpsProjection({ ...value, streamingMs: -1 }), undefined);
	assert.equal(parseDshTpsProjection({ ...value, endToEndTokens: "100" }), undefined);
});
