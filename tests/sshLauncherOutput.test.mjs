import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Bounded output accumulator tests.
 *
 * The module is pure stream bookkeeping: it decodes, splits, meters and holds lines and tells its owner
 * when a bound was broken. Every case therefore asserts what a subscriber actually receives and which
 * overflow (if any) the owner was handed - never how often a private helper ran, and never a byte count
 * of the internal gauge.
 */

const { createSshLauncherOutput } = loadTsCommonJs("src/main/remote/SshLauncherOutput.ts");

const frame = (text) => Buffer.from(`${text}\n`, "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createOutput(options = {}) {
	const overflows = [];
	const output = createSshLauncherOutput({
		maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
		maxLineBytes: options.maxLineBytes ?? 8 * 1024 * 1024,
		onOverflow: (cause) => overflows.push(cause),
	});
	return { output, overflows };
}

function collect(output, stream = "stdout") {
	const lines = [];
	const unsubscribe = output.subscribe(stream, (line) => lines.push(line));
	return { lines, unsubscribe };
}

test("hands complete lines to a subscriber and keeps the two streams apart", () => {
	const { output } = createOutput();
	const stdout = collect(output, "stdout");
	const stderr = collect(output, "stderr");

	output.feed("stdout", frame('{"op":"ready"}'));
	output.feed("stdout", frame('{"op":"next"}'));
	output.feed("stderr", frame("Permission denied"));

	assert.deepEqual(stdout.lines, ['{"op":"ready"}', '{"op":"next"}']);
	assert.deepEqual(stderr.lines, ["Permission denied"]);
});

test("reassembles a line split across chunks and across a multi-byte character", () => {
	const { output } = createOutput();
	const stdout = collect(output);
	// The frame is split inside the 3-byte UTF-8 sequence of 你, which a per-chunk toString() would mangle.
	const bytes = Buffer.from('{"text":"你好"}\n', "utf8");
	const splitAt = bytes.indexOf(Buffer.from("你", "utf8")) + 1;
	output.feed("stdout", bytes.subarray(0, splitAt));
	output.feed("stdout", bytes.subarray(splitAt, splitAt + 2));
	output.feed("stdout", bytes.subarray(splitAt + 2));

	assert.deepEqual(stdout.lines, ['{"text":"你好"}']);
});

test("strips CRLF and drops blank lines instead of charging them to the budget", () => {
	// A budget far below the 64 blank frames below: only lines that were dropped as blank can keep this green.
	const { output, overflows } = createOutput({ maxOutputBytes: 8, maxLineBytes: 64 });
	const stdout = collect(output);

	output.feed("stdout", Buffer.from('{"a":1}\r\n\r\n{"b":2}\n', "utf8"));
	for (let index = 0; index < 64; index += 1) output.feed("stdout", Buffer.from("\r\n", "utf8"));

	assert.deepEqual(stdout.lines, ['{"a":1}', '{"b":2}']);
	assert.deepEqual(overflows, []);
});

test("holds lines that arrived before the first subscriber and replays them once", async () => {
	const { output } = createOutput();
	output.feed("stdout", frame('{"early":true}'));

	const first = collect(output);
	assert.deepEqual(first.lines, [], "the replay is asynchronous so subscribing stays re-entrancy free");
	await tick();
	assert.deepEqual(first.lines, ['{"early":true}'], "a frame answered before we subscribed is not lost");

	// A second subscriber joins after the hand-off, so it only sees lines from now on.
	const second = collect(output);
	output.feed("stdout", frame('{"late":true}'));
	await tick();
	assert.deepEqual(first.lines, ['{"early":true}', '{"late":true}']);
	assert.deepEqual(second.lines, ['{"late":true}'], "only the first subscriber receives the holding area");
});

test("delivers a partial final line on flush and then ignores the stream", () => {
	const { output, overflows } = createOutput();
	const stdout = collect(output);

	output.feed("stdout", Buffer.from('{"op":"rea', "utf8"));
	output.flush();
	assert.deepEqual(stdout.lines, ['{"op":"rea'], "a process that dies mid-frame still reports what it wrote");

	// The owner settled the process, so late bytes may neither reach a subscriber nor report an overflow.
	output.feed("stdout", Buffer.from(`${"x".repeat(2048)}\n`, "utf8"));
	assert.deepEqual(stdout.lines, ['{"op":"rea']);
	assert.deepEqual(overflows, []);
});

test("delivers a flushed partial line to the first subscriber that attaches afterwards", async () => {
	const { output } = createOutput();
	output.feed("stdout", Buffer.from("tail-without-newline", "utf8"));
	output.flush();

	const stdout = collect(output);
	await tick();
	assert.deepEqual(stdout.lines, ["tail-without-newline"]);
});

test("reports a line beyond the per-line bound once and never truncates it", () => {
	const { output, overflows } = createOutput({ maxLineBytes: 32 });
	const stdout = collect(output);

	output.feed("stdout", Buffer.from("x".repeat(64), "utf8"));
	assert.deepEqual(overflows, ["line-too-large"]);
	// The bound kills the process; the buffered text is still handed over as one unmodified line.
	output.flush();
	assert.deepEqual(stdout.lines, ["x".repeat(64)]);
});

test("counts only unconsumed bytes against the per-stream budget", () => {
	// 64 frames are 2112 bytes, far beyond the 64-byte budget: only the *unconsumed* remainder may count.
	const { output, overflows } = createOutput({ maxOutputBytes: 64, maxLineBytes: 1024 });
	const stdout = collect(output);

	for (let index = 0; index < 64; index += 1) output.feed("stdout", frame("x".repeat(32)));
	assert.equal(stdout.lines.length, 64);
	assert.deepEqual(overflows, []);
});

test("reports the unconsumed budget overflow once and stops delivering", () => {
	const { output, overflows } = createOutput({ maxOutputBytes: 64, maxLineBytes: 1024 });
	const stdout = collect(output);
	// This subscriber detaches immediately, so every frame below is held instead of consumed.
	stdout.unsubscribe();

	output.feed("stdout", frame("x".repeat(32)));
	assert.deepEqual(overflows, [], "one held frame is still within the budget");
	output.feed("stdout", frame("x".repeat(32)));
	output.feed("stdout", frame("x".repeat(32)));
	assert.deepEqual(overflows, ["output-too-large"], "the overflow is a terminal verdict, not a per-chunk report");
});

test("the same frames with a consumer attached never trip the budget", () => {
	const { output, overflows } = createOutput({ maxOutputBytes: 64, maxLineBytes: 1024 });
	const stdout = collect(output);

	for (let index = 0; index < 64; index += 1) output.feed("stdout", frame("x".repeat(32)));
	assert.equal(stdout.lines.length, 64);
	assert.deepEqual(overflows, []);
});

test("bounds the holding area by line count", () => {
	const { output, overflows } = createOutput({ maxOutputBytes: 1_000_000, maxLineBytes: 4096 });
	const held = frame("y".repeat(10));

	for (let index = 0; index < 65; index += 1) output.feed("stdout", held);
	assert.deepEqual(overflows, ["output-too-large"], "the 65th held line has nowhere left to go");
});

test("bounds the holding area by bytes as well", () => {
	// The stream budget is far above these two frames, so only the holding area's own byte bound can report.
	const { output, overflows } = createOutput({ maxOutputBytes: 1_000_000, maxLineBytes: 64 });
	const held = frame("z".repeat(32));

	output.feed("stdout", held);
	assert.deepEqual(overflows, [], "one 33-byte frame fits the bounded area");
	output.feed("stdout", held);
	assert.deepEqual(overflows, ["output-too-large"]);
});

test("the holding area can always carry one maximum-size frame", async () => {
	const { output, overflows } = createOutput({ maxOutputBytes: 64, maxLineBytes: 16 });
	const line = "x".repeat(16);

	output.feed("stdout", Buffer.from(`${line}\n`, "utf8"));
	assert.deepEqual(overflows, [], "a legal maximal frame is held, not treated as an overflow");

	const stdout = collect(output);
	await tick();
	assert.deepEqual(stdout.lines, [line], "and the first subscriber still receives it");
});

test("counts subscribers per stream and forgets an unsubscribed listener", async () => {
	const { output } = createOutput();
	const first = collect(output, "stdout");
	const second = collect(output, "stderr");
	assert.equal(output.subscriberCount("stdout"), 1);
	assert.equal(output.subscriberCount("stderr"), 1);

	// A line fed while nobody listens is held for the next subscriber instead of being dropped.
	first.unsubscribe();
	assert.equal(output.subscriberCount("stdout"), 0);
	output.feed("stdout", frame('{"held":true}'));

	const third = collect(output, "stdout");
	assert.equal(output.subscriberCount("stdout"), 1);
	assert.deepEqual(third.lines, [], "the replay stays asynchronous");
	await tick();
	assert.deepEqual(third.lines, ['{"held":true}'], "the line held while nobody listened is replayed first");

	output.feed("stdout", frame('{"fresh":true}'));
	assert.deepEqual(third.lines, ['{"held":true}', '{"fresh":true}']);
	assert.deepEqual(second.lines, [], "the other stream never sees stdout lines");
	assert.deepEqual(first.lines, [], "an unsubscribed listener receives nothing more");
	third.unsubscribe();
	assert.equal(output.subscriberCount("stdout"), 0);
});
