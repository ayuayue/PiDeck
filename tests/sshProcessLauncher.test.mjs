import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Pinned SSH process launcher tests (task-2, extended in task-7 with the stdin channel and the
 * "unconsumed output" accounting).
 *
 * Every case injects an EventEmitter child through `options.spawn`, so no real ssh, network or child
 * process is ever created. Timers are injected as well: the timeout / SIGKILL escalation / timer
 * cleanup assertions stay deterministic instead of sleeping on real 30 s deadlines.
 */

const MODULE_PATH = "src/main/remote/SshProcessLauncher.ts";
const SSH_PATH = process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh";

const {
	SSH_LAUNCHER_DEFAULT_TIMEOUT_MS,
	SSH_LAUNCHER_MAX_TIMEOUT_MS,
	SSH_LAUNCHER_DEFAULT_MAX_OUTPUT_BYTES,
	SSH_LAUNCHER_DEFAULT_MAX_LINE_BYTES,
	SSH_LAUNCHER_MAX_OUTPUT_BYTES,
	SSH_LAUNCHER_MAX_LINE_BYTES,
	SSH_LAUNCHER_STDIN_UNAVAILABLE,
	SSH_LAUNCHER_STDIN_LINE_INVALID,
	SSH_LAUNCHER_STDIN_LINE_TOO_LARGE,
	SSH_LAUNCHER_STDIN_WRITE_FAILED,
} = loadTsCommonJs(MODULE_PATH);

/**
 * Cross-vm objects have a different Object.prototype, so `deepEqual` compares a JSON round-trip (which
 * also proves the terminal report stays serializable for diagnostics).
 */
const exitShape = (exit) => JSON.parse(JSON.stringify(exit));

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeChild(options = {}) {
	const child = new EventEmitter();
	child.pid = "pid" in options ? options.pid : 4242;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	// An explicit stdin only: a launcher that spawned with "ignore" must reject every write instead of
	// falling back to a stream the injected child never had.
	child.stdin = "stdin" in options ? options.stdin : undefined;
	// kill() records the signal so escalation (TERM -> KILL) is observable without a real process.
	child.kills = [];
	child.kill = (signal) => {
		child.kills.push(signal === undefined ? null : signal);
		return options.killResult === undefined ? true : options.killResult;
	};
	return child;
}

/** Minimal writable stdin: only the surface the launcher may touch, plus a log of what it received. */
function fakeStdin(options = {}) {
	const stdin = new EventEmitter();
	stdin.writes = [];
	stdin.ended = false;
	stdin.write = (chunk) => {
		stdin.writes.push(chunk);
		// Node reports backpressure by returning false; the frame is still accepted and buffered.
		return options.writeResult === undefined ? true : options.writeResult;
	};
	stdin.end = () => {
		stdin.ended = true;
	};
	return stdin;
}

/** Minimal deterministic scheduler: the module only ever calls setTimeout(handler, delay). */
function createTimerSpy() {
	let nextId = 1;
	const pending = new Map();
	const delays = () => [...pending.values()].map((timer) => timer.delay);
	return {
		setTimeout(handler, delay) {
			const id = nextId;
			nextId += 1;
			pending.set(id, { handler, delay });
			return id;
		},
		clearTimeout(id) {
			pending.delete(id);
		},
		delays,
		count() {
			return pending.size;
		},
		fireDelay(delay) {
			const entry = [...pending.entries()].find(([, timer]) => timer.delay === delay);
			assert.ok(entry, `expected a pending timer with delay ${delay}, saw ${JSON.stringify(delays())}`);
			pending.delete(entry[0]);
			entry[1].handler();
		},
	};
}

function setup({ child = fakeChild(), spawnError, killTimeoutMs } = {}) {
	const timers = createTimerSpy();
	const calls = [];
	const module = loadTsCommonJs(MODULE_PATH, { globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
	const launcher = module.createSshProcessLauncher({
		spawn: (executable, args, spawnOptions) => {
			calls.push({ executable, args, spawnOptions });
			if (spawnError !== undefined) throw spawnError;
			return child;
		},
		...(killTimeoutMs === undefined ? {} : { killTimeoutMs }),
	});
	return { launcher, calls, child, timers };
}

function invocation(overrides = {}) {
	return { executable: SSH_PATH, destination: "work", args: ["-T", "work", "true"], env: { PATH: "/usr/bin" }, openSshVersion: "OpenSSH_9.5p1", ...overrides };
}

function request(overrides = {}) {
	return { hostId: "host-a", generation: 7, invocation: invocation(), ...overrides };
}

function startLauncher(context, overrides = {}) {
	return context.launcher.start(request(overrides));
}

/** start() only resolves once the child confirms `spawn`; the fake reports it explicitly. */
async function launch(context, overrides = {}) {
	const started = startLauncher(context, overrides);
	context.child.emit("spawn");
	return started;
}

function collectExits(handle) {
	const exits = [];
	handle.onExit((exit) => exits.push(exit));
	return exits;
}

test("starts the pinned executable as an argv array through a shell-free spawn", async () => {
	const context = setup();
	const env = { PATH: "/usr/bin", SystemRoot: "C:\\Windows" };
	const args = ["-T", "-o", "BatchMode=yes", "work", "true; rm -rf / #"];
	const handle = await launch(context, { invocation: invocation({ args, env }) });

	assert.equal(handle.pid, 4242);
	assert.equal(context.calls.length, 1);
	const [call] = context.calls;
	assert.equal(call.executable, SSH_PATH);
	// The very same argv array reaches spawn: a shell-quoted command string would show up here, and the
	// metacharacter payload must stay one literal element.
	assert.equal(call.args, args);
	assert.equal(call.spawnOptions.env, env);
	assert.equal(call.spawnOptions.shell, false);
	assert.equal(call.spawnOptions.windowsHide, true);
	assert.deepEqual(Array.from(call.spawnOptions.stdio), ["ignore", "pipe", "pipe"]);
	assert.deepEqual(Object.keys(call.spawnOptions).sort(), ["env", "shell", "stdio", "windowsHide"]);
});

test("a zero exit is reported as exited with the child pid", async () => {
	const context = setup();
	const handle = await launch(context);
	const exits = collectExits(handle);
	context.child.emit("exit", 0, null);
	assert.deepEqual(exits.map(exitShape), [{ kind: "exited", code: 0, signal: null }]);
});

test("a non-zero exit is reported as failed and keeps code and signal", async () => {
	const failed = setup();
	const failedExits = collectExits(await launch(failed));
	failed.child.emit("exit", 255, null);
	assert.deepEqual(failedExits.map(exitShape), [{ kind: "failed", code: 255, signal: null }]);

	const signalled = setup();
	const signalledExits = collectExits(await launch(signalled));
	signalled.child.emit("exit", null, "SIGKILL");
	assert.deepEqual(signalledExits.map(exitShape), [{ kind: "failed", code: null, signal: "SIGKILL" }]);
});

test("pid stays safely undefined when the child reports none", async () => {
	const context = setup({ child: fakeChild({ pid: undefined }) });
	const handle = await launch(context);
	assert.equal(handle.pid, undefined);
});

test("stop is idempotent, escalates to SIGKILL and resolves only after the child exits", async () => {
	const context = setup({ killTimeoutMs: 2000 });
	const handle = await launch(context);
	const exits = collectExits(handle);

	const first = handle.stop("abort");
	const second = handle.stop("shutdown");
	assert.equal(first, second);
	let stopResolved = false;
	first.then(() => {
		stopResolved = true;
	});
	assert.deepEqual(context.child.kills, [null]);
	assert.deepEqual(
		context.timers.delays().sort((left, right) => left - right),
		[2000, SSH_LAUNCHER_DEFAULT_TIMEOUT_MS],
	);

	context.timers.fireDelay(2000);
	assert.deepEqual(context.child.kills, [null, "SIGKILL"]);
	await tick();
	assert.equal(stopResolved, false);

	context.child.emit("exit", null, "SIGKILL");
	await first;
	assert.equal(stopResolved, true);
	assert.deepEqual(exits.map(exitShape), [{ kind: "stopped", code: null, signal: "SIGKILL" }]);
	assert.equal(context.timers.count(), 0);
	assert.equal(context.child.listenerCount("exit"), 0);
});

test("a clean exit after stop is still reported as stopped", async () => {
	const context = setup();
	const handle = await launch(context);
	const exits = collectExits(handle);
	const stopped = handle.stop("shutdown");
	context.child.emit("exit", 0, null);
	await stopped;
	assert.deepEqual(exits.map(exitShape), [{ kind: "stopped", code: 0, signal: null }]);
});

test("stop resolves immediately when the child cannot be signalled at all", async () => {
	const context = setup({ child: fakeChild({ killResult: false }) });
	const handle = await launch(context);
	const exits = collectExits(handle);
	await handle.stop("abort");
	assert.deepEqual(context.child.kills, [null]);
	assert.deepEqual(exits.map(exitShape), [{ kind: "stopped", code: null, signal: null }]);
	assert.equal(context.timers.count(), 0);
});

test("stop does not suspend shutdown when the kill is never confirmed", async () => {
	const context = setup({ killTimeoutMs: 50 });
	const handle = await launch(context);
	const exits = collectExits(handle);
	const stopped = handle.stop("shutdown");

	context.timers.fireDelay(50);
	await tick();
	assert.deepEqual(context.child.kills, [null, "SIGKILL"]);

	context.timers.fireDelay(50);
	await stopped;
	assert.deepEqual(exits.map(exitShape), [{ kind: "stopped", code: null, signal: null }]);
	assert.equal(context.timers.count(), 0);
});

test("stop after the process already ended resolves without signalling", async () => {
	const context = setup();
	const handle = await launch(context);
	context.child.emit("exit", 0, null);
	await handle.stop("shutdown");
	assert.deepEqual(context.child.kills, []);
});

test("a request deadline force-kills the child and reports timeout", async () => {
	const context = setup();
	const handle = await launch(context, { timeoutMs: 5000 });
	const exits = collectExits(handle);
	assert.deepEqual(context.timers.delays(), [5000]);

	context.timers.fireDelay(5000);
	assert.deepEqual(context.child.kills, ["SIGKILL"]);
	assert.deepEqual(exits.map(exitShape), [{ kind: "timeout", code: null, signal: null }]);
	assert.equal(context.timers.count(), 0);
	assert.equal(context.child.listenerCount("exit"), 0);
	assert.equal(context.child.stdout.listenerCount("data"), 0);
});

test("the request deadline defaults and is clamped to the documented maximum", async () => {
	const cases = [
		[{}, SSH_LAUNCHER_DEFAULT_TIMEOUT_MS],
		[{ timeoutMs: 500 }, 500],
		[{ timeoutMs: 10 * 60 * 1000 }, SSH_LAUNCHER_MAX_TIMEOUT_MS],
		[{ timeoutMs: 0 }, SSH_LAUNCHER_DEFAULT_TIMEOUT_MS],
		[{ timeoutMs: Number.NaN }, SSH_LAUNCHER_DEFAULT_TIMEOUT_MS],
	];
	for (const [overrides, expected] of cases) {
		const context = setup();
		await launch(context, overrides);
		assert.deepEqual(context.timers.delays(), [expected], JSON.stringify(overrides));
		// Release the deadline again so the cases cannot leak timers into each other.
		context.child.emit("exit", 0, null);
		assert.equal(context.timers.count(), 0);
	}
});

test("output beyond the per-stream byte budget kills the child and keeps no content", async () => {
	const context = setup();
	const handle = await launch(context);
	const exits = collectExits(handle);

	context.child.stdout.emit("data", Buffer.from("A".repeat(SSH_LAUNCHER_DEFAULT_MAX_OUTPUT_BYTES)));
	assert.deepEqual(context.child.kills, []);
	context.child.stderr.emit("data", Buffer.from("B".repeat(SSH_LAUNCHER_DEFAULT_MAX_OUTPUT_BYTES)));
	assert.deepEqual(context.child.kills, []);

	context.child.stdout.emit("data", Buffer.from("CCCCCCCC"));
	assert.deepEqual(context.child.kills, ["SIGKILL"]);
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_OUTPUT_TOO_LARGE" }]);
	assert.equal(JSON.stringify(exits).includes("CCCCCCCC"), false);
	assert.equal(context.timers.count(), 0);
	assert.equal(context.child.stdout.listenerCount("data"), 0);
});

test("maxOutputBytes overrides the per-stream budget", async () => {
	const context = setup();
	const handle = await launch(context, { maxOutputBytes: 4 });
	const exits = collectExits(handle);

	context.child.stderr.emit("data", "abcd");
	assert.deepEqual(context.child.kills, []);
	context.child.stderr.emit("data", "e");
	assert.deepEqual(context.child.kills, ["SIGKILL"]);
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_OUTPUT_TOO_LARGE" }]);

	// A non-positive override is not a budget: it falls back to the documented default.
	const fallback = setup();
	await launch(fallback, { maxOutputBytes: 0 });
	fallback.child.stdout.emit("data", Buffer.from("A".repeat(SSH_LAUNCHER_DEFAULT_MAX_OUTPUT_BYTES)));
	assert.deepEqual(fallback.child.kills, []);
});

test("spawn failures reject start with a stable code and leak nothing", async () => {
	const secretPath = "C:\\Users\\dev\\.ssh\\id_ed25519";

	const missing = setup();
	const missingStart = startLauncher(missing);
	missing.child.emit("error", { code: "ENOENT", path: secretPath, spawnargs: ["-T", "work"] });
	await assert.rejects(missingStart, (error) => {
		assert.equal(error.message, "SSH_CLIENT_UNAVAILABLE");
		assert.equal(error.message.includes(secretPath), false);
		return true;
	});
	assert.equal(missing.timers.count(), 0);

	const denied = setup({ spawnError: Object.assign(new Error("spawn failed"), { code: "EACCES" }) });
	await assert.rejects(startLauncher(denied), (error) => error.message === "SSH_CLIENT_UNAVAILABLE");

	const broken = setup({ spawnError: new Error(`cannot run ${secretPath}`) });
	await assert.rejects(startLauncher(broken), (error) => {
		assert.equal(error.message, "SSH_LAUNCHER_SPAWN_FAILED");
		assert.equal(error.message.includes(secretPath), false);
		return true;
	});
	assert.equal(broken.timers.count(), 0);
});

test("a late error after startup fails the handle with a stable code", async () => {
	const context = setup();
	const handle = await launch(context);
	const exits = collectExits(handle);
	context.child.emit("error", { code: "ENOENT", path: "C:\\secret\\ssh.exe", spawnargs: ["-T"] });
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_CLIENT_UNAVAILABLE" }]);
	assert.equal(context.timers.count(), 0);
});

test("a malformed pinned invocation fails closed before spawn", async () => {
	const context = setup();
	const cases = [
		[{ hostId: "host-a", generation: 7 }, "missing invocation"],
		[request({ invocation: undefined }), "undefined invocation"],
		[request({ invocation: {} }), "empty invocation"],
		[request({ invocation: invocation({ executable: "" }) }), "empty executable"],
		[request({ invocation: invocation({ executable: "C:\\ssh.exe\u0000" }) }), "NUL in executable"],
		[request({ invocation: invocation({ executable: `${SSH_PATH}\n` }) }), "control character in executable"],
		[request({ invocation: invocation({ args: "true" }) }), "args not an array"],
		[request({ invocation: invocation({ args: ["-T", 7] }) }), "non-string argument"],
		[request({ invocation: invocation({ args: ["-T", "wo\u0000rk"] }) }), "NUL in argument"],
		[request({ invocation: invocation({ env: null }) }), "env not an object"],
		[request({ invocation: invocation({ env: ["PATH"] }) }), "array env"],
		[request({ invocation: invocation({ env: { PATH: 7 } }) }), "non-string env value"],
		[request({ invocation: invocation({ env: { "PA=TH": "/usr/bin" } }) }), "env name containing ="],
	];
	for (const [badRequest, label] of cases) {
		await assert.rejects(context.launcher.start(badRequest), (error) => error.message === "SSH_LAUNCHER_REQUEST_INVALID", label);
	}
	assert.equal(context.calls.length, 0);
	assert.equal(context.timers.count(), 0);
});

test("listeners are released and timers stopped once the process ends", async () => {
	const context = setup();
	const handle = await launch(context);
	const seen = [];
	const offFirst = handle.onExit((exit) => seen.push(exit));
	const offSecond = handle.onExit((exit) => seen.push(exit));
	offSecond();

	context.child.emit("exit", 0, null);
	assert.equal(seen.length, 1);
	offFirst();
	context.child.emit("exit", 0, null);
	assert.equal(seen.length, 1);

	assert.equal(context.child.listenerCount("spawn"), 0);
	assert.equal(context.child.listenerCount("error"), 0);
	assert.equal(context.child.listenerCount("exit"), 0);
	assert.equal(context.child.stdout.listenerCount("data"), 0);
	assert.equal(context.child.stderr.listenerCount("data"), 0);
	assert.equal(context.timers.count(), 0);
});

test("a listener that subscribes after the exit still receives the terminal state once", async () => {
	const context = setup();
	const handle = await launch(context);
	context.child.emit("exit", 3, null);

	const seen = [];
	handle.onExit((exit) => seen.push(exit));
	await tick();
	assert.deepEqual(seen.map(exitShape), [{ kind: "failed", code: 3, signal: null }]);

	const cancelled = [];
	const cancel = handle.onExit((exit) => cancelled.push(exit));
	cancel();
	await tick();
	assert.deepEqual(cancelled, []);
});

test("start resolves for a silent child and for an exit that precedes spawn", async () => {
	const silent = setup();
	const silentStart = startLauncher(silent);
	await tick();
	assert.equal(silent.calls.length, 1);
	assert.equal(silent.timers.count(), 1);
	silent.timers.fireDelay(silent.timers.delays()[0]);
	const silentHandle = await silentStart;
	assert.equal(silentHandle.pid, 4242);
	// The deadline only starts once the process is confirmed.
	assert.deepEqual(silent.timers.delays(), [SSH_LAUNCHER_DEFAULT_TIMEOUT_MS]);
	silent.child.emit("exit", 0, null);
	assert.equal(silent.timers.count(), 0);

	const early = setup();
	const earlyStart = startLauncher(early);
	early.child.emit("exit", 0, null);
	const earlyHandle = await earlyStart;
	const earlyExits = collectExits(earlyHandle);
	await tick();
	assert.deepEqual(earlyExits.map(exitShape), [{ kind: "exited", code: 0, signal: null }]);
	assert.equal(early.timers.count(), 0);
});

test("the production default spawner is node:child_process spawn", async () => {
	const child = fakeChild();
	const calls = [];
	const module = loadTsCommonJs(MODULE_PATH, {
		stubs: {
			"node:child_process": {
				spawn: (executable, args, spawnOptions) => {
					calls.push({ executable, args, spawnOptions });
					return child;
				},
			},
		},
	});
	const started = module.createSshProcessLauncher().start(request());
	child.emit("spawn");
	const handle = await started;

	assert.equal(calls.length, 1);
	assert.equal(handle.pid, 4242);
	assert.equal(calls[0].spawnOptions.shell, false);
	assert.equal(calls[0].spawnOptions.windowsHide, true);
	child.emit("exit", 0, null);
});

function collectLines(handle, stream) {
	const lines = [];
	const unsubscribe = stream === "stdout" ? handle.onStdoutLine((line) => lines.push(line)) : handle.onStderrLine((line) => lines.push(line));
	return { lines, unsubscribe };
}

test("streams stdout as decoded lines and keeps stderr separate", async () => {
	const context = setup();
	const handle = await launch(context);
	const stdout = collectLines(handle, "stdout");
	const stderr = collectLines(handle, "stderr");
	context.child.stdout.emit("data", Buffer.from('{"v":1,"op":"ready"}\n{"v":1,"op":"next"}\n', "utf8"));
	context.child.stderr.emit("data", Buffer.from("diagnostic line\n", "utf8"));
	await tick();
	assert.deepEqual(stdout.lines, ['{"v":1,"op":"ready"}', '{"v":1,"op":"next"}']);
	assert.deepEqual(stderr.lines, ["diagnostic line"]);
	context.child.emit("exit", 0, null);
});

test("reassembles a line split across chunks and across a multi-byte character", async () => {
	const context = setup();
	const handle = await launch(context);
	const stdout = collectLines(handle, "stdout");
	// The frame is split inside the 3-byte UTF-8 sequence of 你, which a per-chunk toString() would mangle.
	const frame = Buffer.from('{"v":1,"text":"你好"}\n', "utf8");
	const splitAt = frame.indexOf(Buffer.from("你", "utf8")) + 1;
	context.child.stdout.emit("data", frame.subarray(0, splitAt));
	context.child.stdout.emit("data", frame.subarray(splitAt, splitAt + 2));
	context.child.stdout.emit("data", frame.subarray(splitAt + 2));
	await tick();
	assert.deepEqual(stdout.lines, ['{"v":1,"text":"你好"}']);
	context.child.emit("exit", 0, null);
});

test("strips CRLF and drops blank lines", async () => {
	const context = setup();
	const handle = await launch(context);
	const stdout = collectLines(handle, "stdout");
	context.child.stdout.emit("data", Buffer.from('{"a":1}\r\n\r\n{"b":2}\n', "utf8"));
	await tick();
	assert.deepEqual(stdout.lines, ['{"a":1}', '{"b":2}']);
	context.child.emit("exit", 0, null);
});

test("flushes the trailing partial line when the process ends mid-frame", async () => {
	const context = setup();
	const handle = await launch(context);
	const stdout = collectLines(handle, "stdout");
	context.child.stdout.emit("data", Buffer.from('{"v":1,"op":"rea', "utf8"));
	context.child.emit("exit", 1, null);
	await tick();
	assert.deepEqual(stdout.lines, ['{"v":1,"op":"rea']);
});

test("kills the process when a single line exceeds the per-line bound", async () => {
	const context = setup();
	const handle = await launch(context, { maxLineBytes: 32 });
	const exits = collectExits(handle);
	context.child.stdout.emit("data", Buffer.from("x".repeat(64), "utf8"));
	await tick();
	assert.deepEqual(context.child.kills, ["SIGKILL"]);
	// A bounded-output kill is reported immediately, so code/signal are still null at that point.
	await tick();
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_LINE_TOO_LARGE" }]);
});

test("replays lines that arrived before the first subscriber and honours unsubscribe", async () => {
	const context = setup();
	const handle = await launch(context);
	context.child.stdout.emit("data", Buffer.from('{"early":true}\n', "utf8"));
	const first = collectLines(handle, "stdout");
	await tick();
	assert.deepEqual(first.lines, ['{"early":true}'], "a frame answered before we subscribed is not lost");
	first.unsubscribe();
	context.child.stdout.emit("data", Buffer.from('{"late":true}\n', "utf8"));
	await tick();
	assert.deepEqual(first.lines, ['{"early":true}'], "an unsubscribed listener receives nothing more");
	// With nobody listening the line is held for the next subscriber instead of being dropped.
	const second = collectLines(handle, "stdout");
	await tick();
	assert.deepEqual(second.lines, ['{"late":true}']);
	context.child.emit("exit", 0, null);
});

/** write() must throw exactly the stable code: no frame text, command line, path or env value may leak. */
function assertWriteThrows(handle, line, code) {
	assert.throws(
		() => handle.write(line),
		(error) => {
			assert.equal(error.message, code);
			return true;
		},
	);
}

test("stdin is piped only when the request asks for it", async () => {
	const closed = setup();
	const closedHandle = await launch(closed);
	assert.deepEqual(Array.from(closed.calls[0].spawnOptions.stdio), ["ignore", "pipe", "pipe"]);
	assertWriteThrows(closedHandle, '{"v":1}', SSH_LAUNCHER_STDIN_UNAVAILABLE);
	closed.child.emit("exit", 0, null);

	const started = setup({ child: fakeChild({ stdin: fakeStdin() }) });
	await launch(started, { stdin: true });
	assert.deepEqual(Array.from(started.calls[0].spawnOptions.stdio), ["pipe", "pipe", "pipe"]);
	started.child.emit("exit", 0, null);
});

test("write appends exactly one newline to the child's stdin", async () => {
	const stdin = fakeStdin();
	const context = setup({ child: fakeChild({ stdin }) });
	const handle = await launch(context, { stdin: true });

	handle.write('{"v":1,"op":"answer","id":7}');
	handle.write('{"v":1,"op":"answer","id":8}');
	assert.deepEqual(stdin.writes, ['{"v":1,"op":"answer","id":7}\n', '{"v":1,"op":"answer","id":8}\n']);
	context.child.emit("exit", 0, null);
});

test("a stdin write that only reports backpressure is still accepted", async () => {
	const stdin = fakeStdin({ writeResult: false });
	const context = setup({ child: fakeChild({ stdin }) });
	const handle = await launch(context, { stdin: true });

	handle.write("{}");
	assert.deepEqual(stdin.writes, ["{}\n"]);
	context.child.emit("exit", 0, null);
});

test("write rejects NUL and line breaks so one frame can never become two", async () => {
	const stdin = fakeStdin();
	const context = setup({ child: fakeChild({ stdin }) });
	const handle = await launch(context, { stdin: true });

	assertWriteThrows(handle, '{"v":1}\u0000', SSH_LAUNCHER_STDIN_LINE_INVALID);
	assertWriteThrows(handle, '{"v":1}\n{"v":2}', SSH_LAUNCHER_STDIN_LINE_INVALID);
	assertWriteThrows(handle, '{"v":1}\r\n', SSH_LAUNCHER_STDIN_LINE_INVALID);
	assert.deepEqual(stdin.writes, []);
	context.child.emit("exit", 0, null);
});

test("write rejects an empty or blank frame instead of emitting a bare newline", async () => {
	const stdin = fakeStdin();
	const context = setup({ child: fakeChild({ stdin }) });
	const handle = await launch(context, { stdin: true });

	assertWriteThrows(handle, "", SSH_LAUNCHER_STDIN_LINE_INVALID);
	assertWriteThrows(handle, "   ", SSH_LAUNCHER_STDIN_LINE_INVALID);
	assert.deepEqual(stdin.writes, []);
	context.child.emit("exit", 0, null);
});

test("a read-side stream error is absorbed and reported instead of crashing the process", async () => {
	const context = setup();
	const handle = await launch(context);
	const exits = collectExits(handle);

	// Without a listener an unhandled 'error' on a stream kills the whole main process.
	context.child.stdout.emit("error", Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
	await tick();
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_STREAM_FAILED" }]);
	assert.equal(context.child.kills.length, 0, "no kill is needed once the stream itself failed");
});

test("the holding area can always carry one maximum-size frame", async () => {
	const context = setup();
	const handle = await launch(context, { maxLineBytes: 16, maxOutputBytes: 64 });
	const line = "x".repeat(16);

	context.child.stdout.emit("data", Buffer.from(`${line}\n`, "utf8"));
	await tick();
	assert.deepEqual(context.child.kills, [], "a legal maximal frame is held, not treated as an overflow");
	const collected = collectLines(handle, "stdout");
	await tick();
	assert.deepEqual(collected.lines, [line], "and the first subscriber still receives it");
	context.child.emit("exit", 0, null);
});

test("write rejects a frame beyond the per-line bound instead of truncating it", async () => {
	const stdin = fakeStdin();
	const context = setup({ child: fakeChild({ stdin }) });
	const handle = await launch(context, { stdin: true, maxLineBytes: 16 });

	// The bound is a byte count, not a character count: 你 is three bytes of UTF-8.
	handle.write("x".repeat(16));
	handle.write("你".repeat(5));
	assertWriteThrows(handle, "x".repeat(17), SSH_LAUNCHER_STDIN_LINE_TOO_LARGE);
	assertWriteThrows(handle, "你".repeat(6), SSH_LAUNCHER_STDIN_LINE_TOO_LARGE);
	assert.deepEqual(stdin.writes, [`${"x".repeat(16)}\n`, `${"你".repeat(5)}\n`]);
	context.child.emit("exit", 0, null);
});

test("write is rejected once the process has settled", async () => {
	const stdin = fakeStdin();
	const context = setup({ child: fakeChild({ stdin }) });
	const handle = await launch(context, { stdin: true });

	context.child.emit("exit", 0, null);
	assertWriteThrows(handle, "{}", SSH_LAUNCHER_STDIN_UNAVAILABLE);
	assert.deepEqual(stdin.writes, []);
	assert.equal(stdin.ended, true, "a settled process closes its stdin instead of keeping the pipe open");
});

test("a failing stdin write is mapped to a stable code and leaks nothing", async () => {
	const frame = '{"v":1,"token":"hunter2"}';
	const stdin = fakeStdin();
	stdin.write = () => {
		throw Object.assign(new Error(`EPIPE: broken pipe, write ${frame}`), { code: "EPIPE" });
	};
	const context = setup({ child: fakeChild({ stdin }) });
	const handle = await launch(context, { stdin: true });

	assert.throws(
		() => handle.write(frame),
		(error) => {
			assert.equal(error.message, SSH_LAUNCHER_STDIN_WRITE_FAILED);
			assert.equal(error.message.includes(frame), false);
			assert.equal(error.message.includes("EPIPE"), false);
			return true;
		},
	);
	context.child.emit("exit", 0, null);
});

test("a stdin stream that is gone or never existed is reported as unavailable", async () => {
	const destroyed = fakeStdin();
	destroyed.destroyed = true;
	const destroyedContext = setup({ child: fakeChild({ stdin: destroyed }) });
	assertWriteThrows(await launch(destroyedContext, { stdin: true }), "{}", SSH_LAUNCHER_STDIN_UNAVAILABLE);

	const ended = fakeStdin();
	ended.writableEnded = true;
	const endedContext = setup({ child: fakeChild({ stdin: ended }) });
	assertWriteThrows(await launch(endedContext, { stdin: true }), "{}", SSH_LAUNCHER_STDIN_UNAVAILABLE);

	// A requested stdin the injected child never provided must be unavailable rather than silently dropped.
	const missing = setup();
	assertWriteThrows(await launch(missing, { stdin: true }), "{}", SSH_LAUNCHER_STDIN_UNAVAILABLE);
});

test("output handed to a subscriber stops counting against the unconsumed budget", async () => {
	const context = setup();
	// 64 frames are 2112 bytes, far beyond the 64-byte budget: only the *unconsumed* remainder may count.
	const handle = await launch(context, { maxOutputBytes: 64, maxLineBytes: 1024 });
	const exits = collectExits(handle);
	const stdout = collectLines(handle, "stdout");
	const frame = Buffer.from(`${"x".repeat(32)}\n`, "utf8");

	for (let index = 0; index < 64; index += 1) context.child.stdout.emit("data", frame);
	assert.equal(stdout.lines.length, 64);
	assert.deepEqual(context.child.kills, []);
	assert.deepEqual(exits, []);
	context.child.emit("exit", 0, null);
});

test("the same frames with nobody consuming them still trip the budget", async () => {
	const context = setup();
	const handle = await launch(context, { maxOutputBytes: 64, maxLineBytes: 1024 });
	const exits = collectExits(handle);
	const frame = Buffer.from(`${"x".repeat(32)}\n`, "utf8");

	context.child.stdout.emit("data", frame);
	assert.deepEqual(context.child.kills, [], "one held frame is still within the budget");
	context.child.stdout.emit("data", frame);
	assert.deepEqual(context.child.kills, ["SIGKILL"], "the second frame exceeds it because nothing consumed the first");
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_OUTPUT_TOO_LARGE" }]);
});

test("blank lines are released as consumed instead of charging the budget", async () => {
	const context = setup();
	const handle = await launch(context, { maxOutputBytes: 8, maxLineBytes: 64 });
	const exits = collectExits(handle);

	// 32 blank frames are 64 bytes in total, eight times the budget, yet every one of them leaves the gauge.
	for (let index = 0; index < 32; index += 1) context.child.stdout.emit("data", Buffer.from("\r\n", "utf8"));
	assert.deepEqual(context.child.kills, []);
	assert.deepEqual(exits, []);
	context.child.emit("exit", 0, null);
});

test("lines replayed from the holding area are released from the budget", async () => {
	const context = setup();
	// One twelve-byte frame (thirteen with its newline) fits the budget while nobody is subscribed yet.
	const handle = await launch(context, { maxOutputBytes: 16, maxLineBytes: 256 });
	const exits = collectExits(handle);
	context.child.stdout.emit("data", Buffer.from("0123456789ab\n", "utf8"));
	assert.deepEqual(context.child.kills, []);

	const stdout = collectLines(handle, "stdout");
	await tick();
	assert.deepEqual(stdout.lines, ["0123456789ab"], "the frame is replayed to the first subscriber");

	// The replayed frame was handed over, so the gauge is empty again and the next frame still fits.
	context.child.stdout.emit("data", Buffer.from("cdefghijklmn\n", "utf8"));
	assert.deepEqual(context.child.kills, []);
	assert.deepEqual(stdout.lines, ["0123456789ab", "cdefghijklmn"]);
	assert.deepEqual(exits, []);
	context.child.emit("exit", 0, null);
});

test("the holding area is bounded by line count", async () => {
	const context = setup();
	const handle = await launch(context, { maxOutputBytes: 1_000_000, maxLineBytes: 4096 });
	const exits = collectExits(handle);
	const frame = Buffer.from(`${"y".repeat(10)}\n`, "utf8");

	// 64 frames fit the holding area and stay counted; the 65th has nowhere left to go.
	for (let index = 0; index < 65; index += 1) context.child.stdout.emit("data", frame);
	assert.deepEqual(context.child.kills, ["SIGKILL"]);
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_OUTPUT_TOO_LARGE" }]);
});

test("the holding area is bounded by bytes as well", async () => {
	const context = setup();
	// The budget is far above these two frames, so only the byte bound of the holding area can kill here.
	const handle = await launch(context, { maxOutputBytes: 1_000_000, maxLineBytes: 64 });
	const exits = collectExits(handle);
	const frame = Buffer.from(`${"z".repeat(32)}\n`, "utf8");

	context.child.stdout.emit("data", frame);
	assert.deepEqual(context.child.kills, [], "one 33-byte frame fits the bounded area");
	context.child.stdout.emit("data", frame);
	assert.deepEqual(context.child.kills, ["SIGKILL"], "two frames exceed the bounded area and are never truncated");
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_OUTPUT_TOO_LARGE" }]);
});

test("the unconsumed budget can always hold one maximum-size frame", () => {
	// A frame the per-line bound accepts must not be rejected by the total budget first.
	assert.ok(SSH_LAUNCHER_MAX_OUTPUT_BYTES >= SSH_LAUNCHER_MAX_LINE_BYTES);
	assert.ok(SSH_LAUNCHER_DEFAULT_MAX_OUTPUT_BYTES <= SSH_LAUNCHER_MAX_OUTPUT_BYTES);
	assert.ok(SSH_LAUNCHER_DEFAULT_MAX_LINE_BYTES <= SSH_LAUNCHER_MAX_LINE_BYTES);
});
