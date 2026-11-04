import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveRemoteSftpBinaryPath, runRemoteSftpJob } = loadTsCommonJs("src/main/remote/RemoteSftpAdapter.ts");

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function invocation() {
	return {
		executable: process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh",
		destination: "work-server",
		args: ["-T", "-s", "--", "work-server", "sftp"],
		env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
		openSshVersion: "OpenSSH_9.9",
	};
}

function fakeChild(onRequest) {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.killed = false;
	child.exitCode = null;
	let request = "";
	child.stdin.on("data", (chunk) => {
		request += chunk.toString();
	});
	child.stdin.on("finish", () => onRequest(child, request));
	child.kill = () => {
		child.killed = true;
		child.exitCode = 1;
		queueMicrotask(() => child.emit("close", 1, null));
		return true;
	};
	return child;
}

test("resolves the native executor in dev and packaged layouts", () => {
	assert.equal(resolveRemoteSftpBinaryPath({ packaged: false, appPath: "F:\\PiDeck", resourcesPath: "ignored", platform: "win32" }), "F:\\PiDeck\\resources\\remote-sftp\\bin\\remote-sftp.exe");
	assert.equal(resolveRemoteSftpBinaryPath({ packaged: false, appPath: "F:\\PiDeck\\out\\main", resourcesPath: "ignored", platform: "win32" }), "F:\\PiDeck\\resources\\remote-sftp\\bin\\remote-sftp.exe");
	assert.equal(resolveRemoteSftpBinaryPath({ packaged: true, appPath: "ignored", resourcesPath: "/opt/PiDeck/resources", platform: "linux" }), "/opt/PiDeck/resources/remote-sftp/remote-sftp");
});

test("runs one SFTP list job and validates the final frame", async () => {
	let spawned;
	let request;
	const result = await runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{ operation: "list", invocation: invocation(), root: "/srv/project", relative: "src", maxEntries: 2 },
		{
			spawnFn(_binary, _args, _options) {
				spawned = fakeChild((child, body) => {
					request = JSON.parse(body);
					child.stdout.write(
						`${JSON.stringify({
							type: "result",
							ok: true,
							result: {
								entries: [
									{ name: "a.txt", kind: "file", bytes: 1, mtimeMs: 2, isSymlink: false },
									{ name: "nested", kind: "directory", isSymlink: false },
								],
								scanned: 3,
								truncated: true,
							},
						})}\n`,
					);
					child.exitCode = 0;
					child.emit("close", 0, null);
				});
				return spawned;
			},
		},
	);
	assert.equal(request.version, 1);
	assert.equal(request.operation, "list");
	assert.equal(request.root, "/srv/project");
	assert.equal(request.relative, "src");
	assert.deepEqual(request.ssh.args, invocation().args);
	assert.deepEqual(plain(result), {
		ok: true,
		operation: "list",
		value: {
			entries: [
				{ name: "a.txt", kind: "file", bytes: 1, mtimeMs: 2, isSymlink: false },
				{ name: "nested", kind: "directory", isSymlink: false },
			],
			scanned: 3,
			truncated: true,
		},
	});
});

test("forwards progress only for the requested transfer operation", async () => {
	const progress = [];
	const result = await runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{
			operation: "download",
			invocation: invocation(),
			root: "/srv/project",
			relative: "asset.bin",
			localPath: process.platform === "win32" ? "C:\\tmp\\asset.bin" : "/tmp/asset.bin",
		},
		{
			spawnFn() {
				return fakeChild((child) => {
					child.stdout.write(`${JSON.stringify({ type: "progress", operation: "upload", transferred: 1, total: 2 })}\n`);
					child.stdout.write(`${JSON.stringify({ type: "progress", operation: "download", transferred: 1, total: 2 })}\n`);
					child.stdout.write(`${JSON.stringify({ type: "result", ok: true, result: { bytes: 2, mtimeMs: 3, fsync: false, atomicRename: false } })}\n`);
					child.exitCode = 0;
					child.emit("close", 0, null);
				});
			},
			onProgress(value) {
				progress.push(plain(value));
			},
		},
	);
	assert.deepEqual(progress, [{ operation: "download", transferred: 1, total: 2 }]);
	assert.deepEqual(plain(result), { ok: true, operation: "download", value: { bytes: 2, mtimeMs: 3, fsync: false, atomicRename: false } });
});

test("runs a stage-only job and accepts only its bounded digest receipt", async () => {
	const digest = "a".repeat(64);
	const localPath = process.platform === "win32" ? "C:\\tmp\\source.bin" : "/tmp/source.bin";
	let request;
	let progress;
	const result = await runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{ operation: "stage", invocation: invocation(), root: "/home/user/.pideck/remote-host", relative: "upload-spool/" + "b".repeat(32) + ".part", localPath },
		{
			spawnFn() {
				return fakeChild((child, body) => {
					request = JSON.parse(body);
					child.stdout.write(`${JSON.stringify({ type: "progress", operation: "stage", transferred: 1, total: 2 })}\n`);
					child.stdout.write(`${JSON.stringify({ type: "result", ok: true, result: { bytes: 2, sha256: digest, fsync: true } })}\n`);
					child.exitCode = 0;
					child.emit("close", 0, null);
				});
			},
			onProgress(value) {
				progress = plain(value);
			},
		},
	);
	assert.equal(request.operation, "stage");
	assert.equal(request.root, "/home/user/.pideck/remote-host");
	assert.equal(request.localPath, localPath);
	assert.deepEqual(plain(progress), { operation: "stage", transferred: 1, total: 2 });
	assert.deepEqual(plain(result), { ok: true, operation: "stage", value: { bytes: 2, sha256: digest, fsync: true } });
});

test("rejects invalid paths and overwrite before starting the executor", async () => {
	let spawned = false;
	const spawnFn = () => {
		spawned = true;
		throw new Error("must not spawn");
	};
	const binary = process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp";
	for (const input of [
		{ operation: "list", invocation: invocation(), root: "/srv/../escape" },
		{ operation: "download", invocation: invocation(), root: "/srv/project", relative: "a", localPath: "relative" },
		{ operation: "upload", invocation: invocation(), root: "/srv/project", relative: "a", localPath: process.platform === "win32" ? "C:\\tmp\\a" : "/tmp/a", overwrite: true },
		{ operation: "stage", invocation: invocation(), root: "/home/user/.pideck/remote-host", relative: "target/a.bin", localPath: process.platform === "win32" ? "C:\\tmp\\a" : "/tmp/a" },
	]) {
		assert.deepEqual(plain(await runRemoteSftpJob(binary, input, { spawnFn })), { ok: false, code: "SFTP_REQUEST_INVALID" });
	}
	assert.equal(spawned, false);
});

test("rejects a malformed sidecar result without leaking raw output", async () => {
	const result = await runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{ operation: "probe", invocation: invocation(), root: "/srv/project" },
		{
			spawnFn() {
				return fakeChild((child) => {
					child.stdout.write(`${JSON.stringify({ type: "result", ok: true, result: { protocolVersion: 1, root: "/srv/project", extensions: { x: 1 } } })}\n`);
					child.exitCode = 0;
					child.emit("close", 0, null);
				});
			},
		},
	);
	assert.deepEqual(plain(result), { ok: false, code: "SFTP_RESULT_INVALID" });
});

test("aborting cancels and kills the one-shot executor", async () => {
	const controller = new AbortController();
	let child;
	const pending = runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{ operation: "probe", invocation: invocation(), root: "/srv/project" },
		{
			signal: controller.signal,
			spawnFn() {
				child = fakeChild(() => {});
				return child;
			},
		},
	);
	controller.abort();
	assert.deepEqual(plain(await pending), { ok: false, code: "SFTP_JOB_CANCELLED" });
	assert.equal(child.killed, true);
});

test("cancellation settles only after the executor process closes", async () => {
	const controller = new AbortController();
	let child;
	let settled = false;
	const pending = runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{ operation: "probe", invocation: invocation(), root: "/srv/project" },
		{
			signal: controller.signal,
			spawnFn() {
				child = fakeChild(() => {});
				child.kill = () => {
					child.killed = true;
					return true;
				};
				return child;
			},
		},
	);
	void pending.then(() => {
		settled = true;
	});
	controller.abort();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false, "cancel must not publish success before the process tree is reaped");
	child.exitCode = 1;
	child.emit("close", 1, null);
	assert.deepEqual(plain(await pending), { ok: false, code: "SFTP_JOB_CANCELLED" });
});

test("a stdin pipe failure settles the job instead of escaping as an unhandled error", async () => {
	const result = await runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{ operation: "probe", invocation: invocation(), root: "/srv/project" },
		{
			spawnFn() {
				const child = fakeChild(() => {});
				queueMicrotask(() => child.stdin.emit("error", new Error("broken pipe")));
				return child;
			},
		},
	);
	assert.deepEqual(plain(result), { ok: false, code: "SFTP_REQUEST_WRITE_FAILED" });
});

test("a successful frame followed by a non-zero exit is not reported as success", async () => {
	const result = await runRemoteSftpJob(
		process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/tmp/remote-sftp",
		{ operation: "probe", invocation: invocation(), root: "/srv/project" },
		{
			spawnFn() {
				return fakeChild((child) => {
					child.stdout.write(`${JSON.stringify({ type: "result", ok: true, result: { protocolVersion: 1, root: "/srv/project", extensions: {} } })}\n`);
					child.exitCode = 1;
					child.emit("close", 1, null);
				});
			},
		},
	);
	assert.deepEqual(plain(result), { ok: false, code: "SFTP_JOB_FAILED" });
});
