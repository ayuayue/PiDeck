import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * F2b：写侧背压（docs/archive/remote/remote-functional-optimization-plan.md §3 F2）。
 *
 * 这些用例证明三件事，全部离线可判定：`write=false` 之后不再无界写入；`drain` 恢复时整帧顺序不变；
 * 进程结束/停止时等待者被释放而不是悬挂。真机内存曲线不在这里测量（见 F0/F5 记录要求）。
 */
const MODULE_PATH = "src/main/remote/SshProcessLauncher.ts";
const { createSshProcessLauncher, SSH_LAUNCHER_MAX_PENDING_STDIN_BYTES, SSH_LAUNCHER_STDIN_BACKLOG, SSH_LAUNCHER_STDIN_UNAVAILABLE, SSH_LAUNCHER_STDIN_WRITE_FAILED } = loadTsCommonJs(MODULE_PATH);

const SSH_PATH = process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh";
const INVOCATION = { executable: SSH_PATH, args: ["-o", "BatchMode=yes", "host", "true"], env: { PATH: "/usr/bin" } };

/** Minimal child whose stdin models a peer that stops reading after `cap` unsent bytes. */
function slowChild({ cap = 128 } = {}) {
	const child = new EventEmitter();
	child.pid = 777;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	const stdin = new EventEmitter();
	stdin.writes = [];
	stdin.pending = 0;
	stdin.writableLength = 0;
	stdin.destroyed = false;
	stdin.writableEnded = false;
	stdin.ended = false;
	stdin.write = (chunk) => {
		stdin.writes.push(String(chunk));
		stdin.pending += Buffer.byteLength(String(chunk), "utf8");
		stdin.writableLength = stdin.pending;
		return stdin.pending < cap;
	};
	stdin.drain = () => {
		stdin.pending = 0;
		stdin.writableLength = 0;
		stdin.emit("drain");
	};
	stdin.end = () => {
		stdin.ended = true;
	};
	child.stdin = stdin;
	child.kills = [];
	child.kill = (signal) => {
		child.kills.push(signal === undefined ? null : signal);
		return true;
	};
	return { child, stdin };
}

async function launch({ cap } = {}) {
	const { child, stdin } = slowChild({ cap });
	const launcher = createSshProcessLauncher({ spawn: () => child, killTimeoutMs: 20 });
	const handle = await launcher.start({ hostId: "b145de8c-6330-45be-8752-f20e8e270150", generation: 1, invocation: INVOCATION, lifetime: "session", stdin: true });
	return { child, stdin, handle };
}

const lines = (stdin) => stdin.writes.map((line) => line.slice(0, -1));
const isPromise = (value) => typeof value === "object" && value !== null && typeof value.then === "function";

test("backpressure stops the flush and drain resumes it in whole-frame order", async () => {
	const { stdin, handle } = await launch({ cap: 100 });
	assert.equal(handle.write("A".repeat(60)), undefined);
	// 61 bytes accepted and buffered, but the stream is now over its mark: the frame still went out.
	const second = handle.write("B".repeat(60));
	assert.equal(second, undefined, "an accepted frame is written even when it reports backpressure");
	assert.deepEqual(
		lines(stdin).map((line) => line[0]),
		["A", "B"],
	);
	// Everything after the first `false` waits for drain instead of piling into the Writable.
	const third = handle.write("C");
	assert.ok(isPromise(third), "a frame queued behind backpressure hands the caller an awaitable");
	assert.equal(stdin.writes.length, 2, "no further frame may be written before drain");
	stdin.drain();
	await third;
	assert.deepEqual(
		lines(stdin).map((line) => line[0]),
		["A", "B", "C"],
	);
});
test("a synchronous writer past the unsent-byte budget fails closed instead of buffering without limit", async () => {
	const { stdin, handle } = await launch({ cap: 1024 });
	const big = "x".repeat(3 * 1024 * 1024);
	handle.write(big);
	assert.equal(stdin.pending > 0, true);
	assert.throws(
		() => handle.write(big),
		(error) => {
			assert.equal(error.message, SSH_LAUNCHER_STDIN_BACKLOG);
			return true;
		},
	);
	// The refused frame never reached the stream.
	assert.equal(stdin.writes.length, 1);
});

test("an awaited write waits for capacity instead of failing at the budget", async () => {
	const { stdin, handle } = await launch({ cap: 1024 });
	handle.write("x".repeat(3 * 1024 * 1024));
	let settled = false;
	const pending = handle.writeAwait("y".repeat(2 * 1024 * 1024)).then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false, "the awaited frame must wait for the peer to drain");
	assert.equal(stdin.writes.length, 1);
	assert.ok(SSH_LAUNCHER_MAX_PENDING_STDIN_BYTES > 2 * 1024 * 1024, "the budget must admit one awaited frame");
	stdin.drain();
	await pending;
	assert.equal(settled, true);
	assert.equal(stdin.writes.length, 2);
});

test("stopping the process releases queued frames and capacity waiters instead of hanging them", async () => {
	const { child, stdin, handle } = await launch({ cap: 1024 });
	handle.write("x".repeat(3 * 1024 * 1024));
	const queued = handle.write("queued");
	const waiting = handle.writeAwait("y".repeat(2 * 1024 * 1024));
	const stopping = handle.stop("abort");
	// The real child reports close after its pipes drain; settle here so cleanup runs deterministically.
	child.emit("exit", null, "SIGTERM");
	child.emit("close", null, "SIGTERM");
	await stopping;
	await assert.rejects(queued, (error) => error.message === SSH_LAUNCHER_STDIN_WRITE_FAILED);
	await assert.rejects(waiting, (error) => error.message === SSH_LAUNCHER_STDIN_WRITE_FAILED);
	// Nothing was written after the teardown began, and stdin is closed exactly once.
	assert.equal(stdin.writes.length, 1);
	assert.equal(stdin.ended, true);
	assert.throws(() => handle.write("late"), new RegExp(SSH_LAUNCHER_STDIN_UNAVAILABLE));
});
