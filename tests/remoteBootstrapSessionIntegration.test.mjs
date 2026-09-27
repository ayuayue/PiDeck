import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runPreparedBootstrap } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { frozenHelperBundleManifest } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { REMOTE_BOOTSTRAP_INLINE_SOURCE, REMOTE_BOOTSTRAP_INLINE_ENTRY } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
const { REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const HOST_ID = "a252b70c-ea1d-4612-90b6-af78d299894f";
const NONCE = "noncevalue0123456789";
const ALIAS = `pideck-${HOST_ID}`;
const CONNECTION = { executable: "/usr/bin/ssh", args: ["-o", `HostKeyAlias=${ALIAS}`], env: {}, destination: "10.81.2.15", openSshVersion: "OpenSSH_9.5p1" };

/** Wrap the real entry stdout in the same line/subscription shape as SshProcessLauncher. */
function entryHandle(child, onReady) {
	const lines = new Set();
	const exits = new Set();
	const backlog = [];
	let buffered = "";
	let result;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		while (buffered.includes("\n")) {
			const end = buffered.indexOf("\n");
			const line = buffered.slice(0, end);
			buffered = buffered.slice(end + 1);
			if (JSON.parse(line).op === "ready") onReady(JSON.parse(line));
			if (lines.size === 0) backlog.push(line);
			else for (const listener of [...lines]) listener(line);
		}
	});
	child.on("close", (code, signal) => {
		result = { kind: "exited", code, signal };
		for (const listener of [...exits]) listener(result);
	});
	return {
		onStdoutLine(listener) {
			lines.add(listener);
			for (const line of backlog.splice(0)) listener(line);
			return () => lines.delete(listener);
		},
		onExit(listener) {
			exits.add(listener);
			if (result) queueMicrotask(() => listener(result));
			return () => exits.delete(listener);
		},
		onStderrLine() {
			return () => {};
		},
		write(line) {
			child.stdin.write(`${line}\n`);
		},
		async stop() {
			child.stdin.end();
		},
	};
}

test("real frozen entry reaches finalized after snapshot upload through the production coordinator", { timeout: 20_000 }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pideck-bootstrap-e2e-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const manifest = frozenHelperBundleManifest();
	let ready;
	let child;
	const launcher = {
		async start(request) {
			if (request.invocation.executable === "/usr/bin/ssh") {
				child = spawn(process.execPath, ["-e", REMOTE_BOOTSTRAP_INLINE_SOURCE, "--", REMOTE_BOOTSTRAP_INLINE_ENTRY, "1", manifest.bundleSha256, NONCE], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
				return entryHandle(child, (frame) => {
					ready = frame;
				});
			}
			assert.ok(ready, "scp can only start after ready");
			const snapshot = request.invocation.cwd;
			assert.equal(await readFile(join(snapshot, REMOTE_HELPER_ENTRY_FILE_NAME), "utf8"), REMOTE_HELPER_INLINE_SOURCE);
			await copyFile(join(snapshot, REMOTE_HELPER_ENTRY_FILE_NAME), join(ready.deployRoot, ready.staging, REMOTE_HELPER_ENTRY_FILE_NAME));
			return {
				onExit(listener) {
					queueMicrotask(() => listener({ kind: "exited", code: 0, signal: null }));
					return () => {};
				},
				async stop() {},
			};
		},
	};
	t.after(() => {
		if (child && child.exitCode === null) child.kill();
	});
	const result = await runPreparedBootstrap({ hostId: HOST_ID, generation: 1, nonce: NONCE, expectedBundleSha256: manifest.bundleSha256, sshConnection: CONNECTION, scpConnection: { ...CONNECTION, executable: "/usr/bin/scp" }, launcher });
	assert.equal(result.bundleSha256, manifest.bundleSha256);
	assert.equal(result.deployRoot, ready.deployRoot);
	assert.equal(await readFile(join(result.deployRoot, "bundles", manifest.bundleSha256, REMOTE_HELPER_ENTRY_FILE_NAME), "utf8"), REMOTE_HELPER_INLINE_SOURCE);
	assert.ok((await lstat(join(result.deployRoot, "bundles", manifest.bundleSha256))).isDirectory());
});
