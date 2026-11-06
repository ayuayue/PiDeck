import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F3 frozen terminal runner: real PTY (script(1)), real ticket files, and the fixed handshake frames. A runner
 * that echoes the init frame, skips the termios restore or hands the shell the wrong cwd is caught here; the
 * ticket file's mode, atomic single use and the expiry/bundle/cwd re-checks are asserted from the filesystem.
 */

const { REMOTE_TERMINAL_RUNNER_ENTRY_FILE_NAME, REMOTE_TERMINAL_RUNNER_ENTRY_SHA256, REMOTE_TERMINAL_RUNNER_ENTRY_VERSION, REMOTE_TERMINAL_RUNNER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteTerminalRunnerEntry.ts");
const { REMOTE_TERMINAL_READY_MARKER, REMOTE_TERMINAL_START_MARKER, REMOTE_TERMINAL_ERROR_MARKER, REMOTE_TERMINAL_FRAME_US, REMOTE_TERMINAL_FRAME_TERMINATOR, buildRemoteTerminalInitFrame, decodeRemoteTerminalStartFrame } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const LINUX = process.platform === "linux";
const runnerTest = (name, fn, timeoutMs = 30_000) => test(name, { skip: LINUX ? false : "POSIX PTY / script(1): the frozen runner refuses win32", timeout: timeoutMs }, fn);
const BUNDLE_SHA = "a".repeat(64);
const TICKET_REF = "b".repeat(32);
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the frozen runner body is one printable ASCII line with its own pin and build", () => {
	assert.equal(REMOTE_TERMINAL_RUNNER_ENTRY_FILE_NAME, "terminal-runner.mjs");
	assert.equal(REMOTE_TERMINAL_RUNNER_ENTRY_VERSION, "1.0.1");
	assert.equal(createHash("sha256").update(REMOTE_TERMINAL_RUNNER_INLINE_SOURCE, "utf8").digest("hex"), REMOTE_TERMINAL_RUNNER_ENTRY_SHA256);
	assert.ok(!/[\r\n]/.test(REMOTE_TERMINAL_RUNNER_INLINE_SOURCE));
	assert.ok(!/[^\x00-\x7f]/.test(REMOTE_TERMINAL_RUNNER_INLINE_SOURCE));
	assert.ok(!/[\u0000-\u001f\u007f]/.test(REMOTE_TERMINAL_RUNNER_INLINE_SOURCE));
	assert.ok(!/\b(?:eval|Function)\s*\(/.test(REMOTE_TERMINAL_RUNNER_INLINE_SOURCE));
	assert.ok(!REMOTE_TERMINAL_RUNNER_INLINE_SOURCE.includes("require("));
	assert.ok(!REMOTE_TERMINAL_RUNNER_INLINE_SOURCE.includes("console."));
	assert.ok(REMOTE_TERMINAL_RUNNER_INLINE_SOURCE.length > 1024 && REMOTE_TERMINAL_RUNNER_INLINE_SOURCE.length < 96 * 1024);
	for (const literal of [
		"PIDECK_TERMINAL/1 READY",
		"PIDECK_TERMINAL/1 START ",
		"PIDECK_TERMINAL/1 ERROR ",
		"terminal-tickets",
		"TERMINAL_TICKET_ALREADY_CONSUMED",
		"TERMINAL_TICKET_EXPIRED",
		"TERMINAL_CWD_CHANGED",
		"TERMINAL_BUNDLE_MISMATCH",
		"TERMINAL_TERMIOS_FAILED",
		"TERMINAL_INPUT_INVALID",
		"TERMINAL_INPUT_TIMEOUT",
		"TERMINAL_SHELL_UNAVAILABLE",
		"TERMINAL_INTERNAL",
		".claim-",
	]) {
		assert.ok(REMOTE_TERMINAL_RUNNER_INLINE_SOURCE.includes(literal), "the frozen body must carry: " + literal);
	}
});

/** One deploy-root-shaped tree: <base>/bundles/<sha>/terminal-runner.mjs and <base>/terminal-tickets/. */
function fixture(t) {
	const base = mkdtempSync(join(tmpdir(), "pideck-terminal-runner-"));
	const home = join(base, "home");
	const deployRoot = join(home, ".pideck", "remote-host");
	const bundle = join(deployRoot, "bundles", BUNDLE_SHA);
	const tickets = join(deployRoot, "terminal-tickets");
	mkdirSync(bundle, { recursive: true });
	mkdirSync(tickets, { mode: 0o700 });
	chmodSync(tickets, 0o700);
	const runnerPath = join(bundle, REMOTE_TERMINAL_RUNNER_ENTRY_FILE_NAME);
	writeFileSync(runnerPath, REMOTE_TERMINAL_RUNNER_INLINE_SOURCE, "utf8");
	const ticket = (overrides = {}) => {
		const value = { v: 1, kind: "project", projectId: "project-a", hostId: HOST_ID, routeDigest: "c".repeat(64), cwd: base, bundleSha256: BUNDLE_SHA, ticketRef: TICKET_REF, expiresAt: Date.now() + 60_000, ...overrides };
		const ref = value.ticketRef;
		const file = join(tickets, ref);
		writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
		chmodSync(file, 0o600);
		return { ref, file, value };
	};
	t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	return { base, home, deployRoot, bundle, tickets, runnerPath, ticket };
}

function shellQuote(value) {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Start the runner under a real PTY (script 1); the trailing stty -a runs on the same TTY after it exits. */
function startRunner(t, f, { trailingStty = true } = {}) {
	const command = shellQuote(process.execPath) + " " + shellQuote(f.runnerPath) + (trailingStty ? "; stty -a" : "");
	const child = spawn("script", ["-q", "-e", "-f", "-c", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: f.home, SHELL: "/bin/bash" } });
	const session = { child, stdout: "", stderr: "", exit: null };
	child.stdout.on("data", (chunk) => (session.stdout += chunk.toString("utf8")));
	child.stderr.on("data", (chunk) => (session.stderr += chunk.toString("utf8")));
	session.done = new Promise((resolve) =>
		child.on("exit", (code, signal) => {
			session.exit = { code, signal };
			resolve(session.exit);
		}),
	);
	t.after(() => {
		try {
			child.kill("SIGKILL");
		} catch {}
	});
	return session;
}
let sessionForDiagnostics = null;
async function waitFor(predicate, label, timeoutMs = 15_000) {
	const started = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error("timed out: " + label + " | stdout=" + JSON.stringify((sessionForDiagnostics && sessionForDiagnostics.stdout) || ""));
		await delay(10);
	}
}
/** Read one plain-marker frame token up to its CRLF; US and CR are tolerated (Linux ONLCR sends CR CR LF). */
function frameToken(stdout, marker, from = 0) {
	const at = stdout.indexOf(marker, from);
	if (at < 0) return null;
	const end = stdout.indexOf("\n", at + marker.length);
	if (end < 0) return null;
	let token = stdout.slice(at + marker.length, end);
	for (;;) {
		const last = token.charAt(token.length - 1);
		if (last === REMOTE_TERMINAL_FRAME_US || last === "\r") token = token.slice(0, -1);
		else break;
	}
	return { token, end };
}
function errorCodeOf(stdout) {
	const frame = frameToken(stdout, REMOTE_TERMINAL_ERROR_MARKER);
	return frame === null ? null : frame.token;
}
function shellOf(stdout) {
	const frame = frameToken(stdout, REMOTE_TERMINAL_START_MARKER);
	return frame === null ? null : (decodeRemoteTerminalStartFrame(frame.token)?.shell ?? null);
}

runnerTest("a valid ticket yields READY -> START(shell) -> a login shell with the ticket cwd, and consumes the ticket", async (t) => {
	const f = fixture(t);
	const ticket = f.ticket();
	const session = startRunner(t, f);
	sessionForDiagnostics = session;
	await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
	assert.ok(!session.stdout.includes(Buffer.from(TICKET_REF, "utf8").toString("base64url").slice(0, 10)), "the runner must not echo ticket material");
	session.child.stdin.write(buildRemoteTerminalInitFrame(ticket.ref));
	await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_START_MARKER), "START");
	assert.match(session.stdout, /PIDECK_TERMINAL\/1 READY\u001f\r+\n/, "READY is CRLF-terminated even though ConPTY may strip the C0 wrapper");
	assert.match(session.stdout, /PIDECK_TERMINAL\/1 START [A-Za-z0-9_-]+\u001f\r+\n/, "START is a CRLF-terminated marker frame");
	assert.equal(shellOf(session.stdout), "/bin/bash", "the runner uses the account login shell it validated");
	assert.equal(existsSync(ticket.file), false, "the ticket is consumed exactly once");
	assert.deepEqual((await import("node:fs")).readdirSync(f.tickets), [], "no claim or temp file is left behind");
	session.child.stdin.write("printf 'RUNNER_OK\\n'; pwd; echo SHELL=$BASH_VERSION >/dev/null; exit\n");
	await waitFor(() => session.stdout.includes("RUNNER_OK"), "shell output");
	await waitFor(() => session.stdout.includes(f.base), "the login shell starts in the ticket cwd");
	const exit = await session.done;
	assert.equal(exit.code, 0, "the runner exits with the shell's own code");
});

runnerTest("the same ticket replayed reports ALREADY_CONSUMED and restores the terminal", async (t) => {
	const f = fixture(t);
	const ticket = f.ticket();
	const first = startRunner(t, f, { trailingStty: false });
	await waitFor(() => first.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
	first.child.stdin.write(buildRemoteTerminalInitFrame(ticket.ref));
	await waitFor(() => first.stdout.includes(REMOTE_TERMINAL_START_MARKER), "START");
	first.child.kill("SIGKILL");
	await first.done;
	const replay = startRunner(t, f);
	await waitFor(() => replay.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY replay");
	replay.child.stdin.write(buildRemoteTerminalInitFrame(ticket.ref));
	await replay.done;
	assert.equal(errorCodeOf(replay.stdout), "TERMINAL_TICKET_ALREADY_CONSUMED");
	// `stty -a` prints the bare `echo` token only when the flag is on; `-echonl` and `-echoprt` are other flags, so a
	// substring match on " -echo" would always hit. The `speed` token proves the trailing probe really ran on this TTY.
	const ttyFlags = replay.stdout.split(/\s+/);
	assert.ok(ttyFlags.includes("speed"), "the trailing stty probe must run on the same TTY");
	assert.ok(ttyFlags.includes("echo"), "termios must be restored before the ERROR frame");
});

runnerTest("an expired ticket reports EXPIRED and leaves no claim behind", async (t) => {
	const f = fixture(t);
	const ticket = f.ticket({ expiresAt: Date.now() - 1 });
	const session = startRunner(t, f);
	await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
	session.child.stdin.write(buildRemoteTerminalInitFrame(ticket.ref));
	await session.done;
	assert.equal(errorCodeOf(session.stdout), "TERMINAL_TICKET_EXPIRED");
	assert.equal(existsSync(ticket.file), false, "an expired ticket is consumed (and answered as expired)");
	assert.deepEqual((await import("node:fs")).readdirSync(f.tickets), []);
});

runnerTest("a ticket minted for another bundle is refused with BUNDLE_MISMATCH", async (t) => {
	const f = fixture(t);
	const ticket = f.ticket({ bundleSha256: "d".repeat(64) });
	const session = startRunner(t, f);
	await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
	session.child.stdin.write(buildRemoteTerminalInitFrame(ticket.ref));
	await session.done;
	assert.equal(errorCodeOf(session.stdout), "TERMINAL_BUNDLE_MISMATCH");
});

runnerTest("a ticket whose canonical cwd is gone is refused with CWD_CHANGED", async (t) => {
	const f = fixture(t);
	const ticket = f.ticket({ cwd: join(f.base, "missing") });
	const session = startRunner(t, f);
	await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
	session.child.stdin.write(buildRemoteTerminalInitFrame(ticket.ref));
	await session.done;
	assert.equal(errorCodeOf(session.stdout), "TERMINAL_CWD_CHANGED");
});

runnerTest("path traversal, plain text and oversized init frames are protocol errors before any ticket work", async (t) => {
	const cases = [
		["../../etc/passwd\n", "TERMINAL_INPUT_INVALID"],
		[buildRemoteTerminalInitFrame(TICKET_REF).trimEnd().slice(0, -1) + "!\n", "TERMINAL_INPUT_INVALID"],
		["a".repeat(1100) + "\n", "TERMINAL_INPUT_INVALID"],
	];
	for (const [line, code] of cases) {
		const f = fixture(t);
		const session = startRunner(t, f);
		await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
		session.child.stdin.write(line);
		await session.done;
		assert.equal(errorCodeOf(session.stdout), code, JSON.stringify(line.slice(0, 24)));
		assert.deepEqual((await import("node:fs")).readdirSync(f.tickets), [], "no ticket was consumed");
	}
});

runnerTest("a missing init frame times out with the restore applied", async (t) => {
	const f = fixture(t);
	const session = startRunner(t, f);
	await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
	await session.done;
	assert.equal(errorCodeOf(session.stdout), "TERMINAL_INPUT_TIMEOUT");
	assert.ok(/(^|\s)echo(\s|$)/.test(session.stdout), "termios restored before the timeout ERROR");
});

runnerTest("a ticket directory that is not 0700 owner-only is refused without consuming anything", async (t) => {
	const f = fixture(t);
	chmodSync(f.tickets, 0o755);
	const ticket = f.ticket();
	const session = startRunner(t, f);
	await waitFor(() => session.stdout.includes(REMOTE_TERMINAL_READY_MARKER), "READY");
	session.child.stdin.write(buildRemoteTerminalInitFrame(ticket.ref));
	await session.done;
	assert.equal(errorCodeOf(session.stdout), "TERMINAL_TICKET_INVALID");
	assert.equal(existsSync(ticket.file), true, "an untrusted directory is never touched");
});
