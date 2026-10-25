import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** Controlled Electron requests and clock: no network or real timeout waits. */
function createFixture() {
	const requests = [];
	const timers = new Map();
	const logs = [];
	let timerId = 0;
	const load = createTsSandbox({
		stubs: {
			"node:timers": {
				setTimeout: (callback, ms) => {
					const id = ++timerId;
					timers.set(id, { callback, ms });
					return id;
				},
				clearTimeout: (id) => timers.delete(id),
			},
			electron: {
				net: {
					request: (options) => {
						const request = new EventEmitter();
						request.options = options;
						request.setHeader = () => {};
						request.end = () => {};
						request.abortCount = 0;
						request.abort = () => {
							request.abortCount++;
							request.emit("error", new Error("request aborted"));
						};
						requests.push(request);
						return request;
					},
				},
			},
		},
	});
	const io = load("src/main/dsh/runtime/dshRuntimeIo.ts");
	return {
		...io,
		requests,
		timers,
		logs,
		log: (...args) => logs.push(args),
		fireTimeout: () => {
			const entry = timers.entries().next().value;
			assert.ok(entry, "an in-flight request must have a deadline");
			timers.delete(entry[0]);
			entry[1].callback();
		},
	};
}

function response(body = "", statusCode = 200, headers = {}) {
	const stream = Readable.from([Buffer.from(body)]);
	stream.statusCode = statusCode;
	stream.headers = headers;
	return stream;
}

test("runtime index timeout returns null and aborts a silent request", async () => {
	const fixture = createFixture();
	const pending = fixture.fetchDshRuntimeIndex("https://example.invalid/index.json", fixture.log);
	fixture.fireTimeout();
	assert.equal(await pending, null);
	assert.equal(fixture.requests[0].abortCount, 1);
	assert.equal(fixture.timers.size, 0);
	assert.match(JSON.stringify(fixture.logs), /timeout/);
});

test("runner-node index remote abort resolves instead of leaving installation pending", async () => {
	const fixture = createFixture();
	const pending = fixture.fetchDshRunnerNodeIndex("https://example.invalid/index.json", fixture.log);
	const stream = new PassThrough();
	stream.statusCode = 200;
	fixture.requests[0].emit("response", stream);
	stream.emit("aborted");
	assert.equal(await pending, null);
	assert.equal(fixture.timers.size, 0);
});

test("successful index parsing removes its deadline and ignores late transport errors", async () => {
	const fixture = createFixture();
	const pending = fixture.fetchDshRuntimeIndex("https://example.invalid/index.json", fixture.log);
	fixture.requests[0].emit("response", response('{"schemaVersion":1,"releases":[]}'));
	assert.equal((await pending).schemaVersion, 1);
	assert.equal(fixture.timers.size, 0);
	fixture.requests[0].emit("error", new Error("late socket error"));
	assert.equal(fixture.logs.length, 0);
});

test("runtime index response is bounded before accumulating an oversized JSON body", async () => {
	const fixture = createFixture();
	const pending = fixture.fetchDshRuntimeIndex("https://example.invalid/index.json", fixture.log);
	fixture.requests[0].emit("response", response("x".repeat(2 * 1024 * 1024 + 1)));
	assert.equal(await pending, null);
	assert.equal(fixture.requests[0].abortCount, 1);
	assert.equal(fixture.timers.size, 0);
});

test("a silent download has an idle deadline and releases the cancellation listener on failure", async () => {
	const fixture = createFixture();
	const root = mkdtempSync(join(tmpdir(), "pideck-download-timeout-"));
	try {
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		const rejected = assert.rejects(pending, /download timed out/i);
		fixture.fireTimeout();
		await rejected;
		assert.equal(fixture.requests[0].abortCount, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(fixture.timers.size, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("download cancellation stops the active file pipeline and clears its resources", async () => {
	const fixture = createFixture();
	const root = mkdtempSync(join(tmpdir(), "pideck-download-cancel-"));
	const stream = new PassThrough();
	try {
		stream.statusCode = 200;
		stream.headers = {};
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		const rejected = assert.rejects(pending, /download aborted/i);
		fixture.requests[0].emit("response", stream);
		stream.write("partial archive");
		controller.abort();
		await rejected;
		assert.equal(stream.destroyed, true);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(fixture.timers.size, 0);
	} finally {
		stream.destroy();
		rmSync(root, { recursive: true, force: true });
	}
});

test("completed download clears its deadline and cannot be aborted by a later cancellation", async () => {
	const fixture = createFixture();
	const root = mkdtempSync(join(tmpdir(), "pideck-download-finish-"));
	try {
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		const initialTimer = fixture.timers.keys().next().value;
		fixture.requests[0].emit("response", response("complete archive"));
		await pending;
		assert.ok(!fixture.timers.has(initialTimer));
		assert.equal(fixture.timers.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.equal(fixture.requests[0].abortCount, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("incoming download data refreshes the idle deadline; a later stall closes the file before rejecting", async () => {
	const fixture = createFixture();
	const root = mkdtempSync(join(tmpdir(), "pideck-download-stall-"));
	const stream = new PassThrough();
	try {
		stream.statusCode = 200;
		stream.headers = {};
		const controller = new AbortController();
		const progress = [];
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), (received) => progress.push(received), controller.signal);
		const rejected = assert.rejects(pending, /download timed out/i);
		fixture.requests[0].emit("response", stream);
		const beforeData = fixture.timers.keys().next().value;
		stream.write("partial archive");
		assert.deepEqual(progress, [15]);
		assert.ok(!fixture.timers.has(beforeData), "data, not just response headers, must reset the deadline");
		assert.equal(fixture.timers.size, 1);
		fixture.fireTimeout();
		await rejected;
		assert.equal(stream.destroyed, true);
		assert.equal(fixture.requests[0].abortCount, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(fixture.timers.size, 0);
	} finally {
		stream.destroy();
		rmSync(root, { recursive: true, force: true });
	}
});

test("manual redirect closes the first request and transfers cancellation/deadline ownership to the next hop", async () => {
	const fixture = createFixture();
	const root = mkdtempSync(join(tmpdir(), "pideck-download-redirect-"));
	try {
		const controller = new AbortController();
		const pending = fixture.createNetDownloader()("https://example.invalid/archive.tgz", join(root, "archive.part"), undefined, controller.signal);
		assert.equal(fixture.requests[0].options.redirect, "manual");
		fixture.requests[0].emit("redirect", 302, "GET", "https://cdn.example.invalid/archive.tgz");
		assert.equal(fixture.requests[0].abortCount, 1);
		assert.equal(fixture.timers.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		await Promise.resolve();
		assert.equal(fixture.requests.length, 2);
		assert.equal(fixture.requests[1].options.url, "https://cdn.example.invalid/archive.tgz");
		assert.equal(fixture.timers.size, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 1);
		fixture.requests[0].emit("error", new Error("late redirect socket error"));
		fixture.requests[1].emit("response", response("complete archive"));
		await pending;
		assert.equal(fixture.timers.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
