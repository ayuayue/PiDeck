import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildBundleManifest, observeBundleFiles } = loadTsCommonJs("src/main/remote/RemoteBootstrapUpload.ts");
const { deployPreparedBundle, deployFrozenHelperBundle, frozenHelperBundleManifest } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_HELPER_ENTRY_SHA256, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const CONNECTION = { executable: "/usr/bin/scp", destination: "pideck-verified-host", args: ["-o", "BatchMode=yes"], env: { PATH: "/usr/bin" }, openSshVersion: "OpenSSH_9.5p1" };
const NONCE = "abc12345678901234567";

async function prepared(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-deploy-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "entry.mjs"), "original bytes\n");
	const manifest = buildBundleManifest(await observeBundleFiles(directory, ["entry.mjs"]));
	return {
		directory,
		manifest,
		ready: { op: "ready", protocolVersion: 1, bundleSha256: manifest.bundleSha256, nonce: NONCE, deployRoot: "/home/test/.pideck/remote-host", staging: `.staging-${NONCE}` },
	};
}

function bootstrap(manifest) {
	const listeners = new Set();
	const writes = [];
	return {
		writes,
		write(line) {
			const frame = JSON.parse(line);
			writes.push(frame);
			if (frame.op === "finalize-commit")
				queueMicrotask(() => {
					for (const listener of listeners) listener(JSON.stringify({ v: 1, op: "finalized", active: `./bundles/${manifest.bundleSha256}`, files: manifest.files.length }));
				});
		},
		onStdoutLine(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function exitingUpload(code) {
	return {
		pid: 123,
		onExit(listener) {
			queueMicrotask(() => listener({ kind: "exited", code, signal: null }));
			return () => {};
		},
		onStdoutLine() {
			return () => {};
		},
		onStderrLine() {
			return () => {};
		},
		write() {
			assert.fail("scp must not receive stdin");
		},
		async stop() {},
	};
}

test("frozen helper bundle identity is available before the bootstrap ready frame", () => {
	const manifest = frozenHelperBundleManifest();
	assert.equal(manifest.files.length, 1);
	assert.equal(manifest.files[0].name, REMOTE_HELPER_ENTRY_FILE_NAME);
	assert.equal(manifest.files[0].sha256, REMOTE_HELPER_ENTRY_SHA256);
	assert.equal(manifest.files[0].bytes, Buffer.byteLength(REMOTE_HELPER_INLINE_SOURCE, "utf8"));
});

test("frozen helper deployment transfers the audited entry bytes and clears its temporary files", async () => {
	const manifest = frozenHelperBundleManifest();
	const session = bootstrap(manifest);
	let snapshotDirectory;
	const launcher = {
		async start(request) {
			snapshotDirectory = request.invocation.cwd;
			assert.equal(await readFile(join(snapshotDirectory, REMOTE_HELPER_ENTRY_FILE_NAME), "utf8"), REMOTE_HELPER_INLINE_SOURCE);
			return exitingUpload(0);
		},
	};
	const result = await deployFrozenHelperBundle({
		connection: CONNECTION,
		ready: { op: "ready", protocolVersion: 1, bundleSha256: manifest.bundleSha256, nonce: NONCE, deployRoot: "/home/test/.pideck/remote-host", staging: `.staging-${NONCE}` },
		launcher,
		session,
		hostId: "b145de8c-6330-45be-8752-f20e8e270150",
		generation: 1,
	});
	assert.equal(result.bundleSha256, manifest.bundleSha256);
	assert.equal(session.writes.at(-1).op, "finalize-commit");
	await assert.rejects(lstat(snapshotDirectory), { code: "ENOENT" });
});

test("pinned scp reads the snapshot and finalize follows only successful exit", async (t) => {
	const { directory, manifest, ready } = await prepared(t);
	const session = bootstrap(manifest);
	let snapshotDirectory;
	const launcher = {
		async start(request) {
			assert.equal(request.invocation.executable, CONNECTION.executable);
			assert.equal(request.invocation.env, CONNECTION.env);
			assert.equal(request.stdin, undefined);
			snapshotDirectory = request.invocation.cwd;
			assert.notEqual(snapshotDirectory, directory);
			await writeFile(join(directory, "entry.mjs"), "changed bytes\n");
			assert.equal(await readFile(join(snapshotDirectory, "entry.mjs"), "utf8"), "original bytes\n");
			assert.deepEqual(session.writes, [], "finalize must wait for the scp exit");
			return exitingUpload(0);
		},
	};
	const result = await deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher, session, hostId: "b145de8c-6330-45be-8752-f20e8e270150", generation: 1 });
	assert.equal(result.bundleSha256, manifest.bundleSha256);
	assert.equal(session.writes.at(-1).op, "finalize-commit");
	await assert.rejects(lstat(snapshotDirectory), { code: "ENOENT" });
});

test("a failed scp aborts staging without sending finalize and releases the snapshot", async (t) => {
	const { directory, manifest, ready } = await prepared(t);
	const session = bootstrap(manifest);
	let snapshotDirectory;
	const launcher = {
		async start(request) {
			snapshotDirectory = request.invocation.cwd;
			return exitingUpload(1);
		},
	};
	await assert.rejects(deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher, session, hostId: "b145de8c-6330-45be-8752-f20e8e270150", generation: 1 }), /BOOTSTRAP_UPLOAD_FAILED/);
	assert.deepEqual(
		session.writes.map((frame) => frame.op),
		["abort"],
	);
	await assert.rejects(lstat(snapshotDirectory), { code: "ENOENT" });
});
