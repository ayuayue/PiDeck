import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_PROJECT_UPLOAD_JOB_CODES, inspectLocalUploadFile, uploadOneRemoteProjectFile } = loadTsCommonJs("src/main/remote/RemoteProjectUploadJob.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const ROOT = "/srv/project";
const DEPLOY_ROOT = "/home/remote/.pideck/remote-host";
const LOCAL = process.platform === "win32" ? "C:\\drop\\report.bin" : "/tmp/drop/report.bin";
const BINARY = process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/opt/pideck/remote-sftp";
const SHA = "a".repeat(64);
const TOKEN = "b".repeat(32);
const INVOCATION = Object.freeze({ executable: process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh", args: Object.freeze(["-s", "host", "sftp"]), env: Object.freeze({}) });
const LOCAL_SNAPSHOT = Object.freeze({
	bytes: 5,
	sha256: SHA,
	identity: Object.freeze({ dev: 1n, ino: 2n, size: 5n, mtimeNs: 3n, ctimeNs: 4n, mode: 33188n, uid: 1000n, gid: 1000n }),
});
const REVISION = Object.freeze({ mode: 384, size: 5, dev: "1", ino: "7", uid: "1000", gid: "1000", mtimeNs: "30", ctimeNs: "40" });
const plain = (value) => JSON.parse(JSON.stringify(value));

function stageSuccess(uploadId, patch = {}) {
	return { ok: true, operation: "stage", value: { bytes: 5, sha256: SHA, fsync: true, ...patch } };
}

function commitSuccess(patch = {}) {
	return { committed: true, path: "docs/report.bin", size: 5, sha256: SHA, revision: REVISION, fsync: true, stageCleaned: true, ...patch };
}

function createHarness(options = {}) {
	const calls = { abort: [], assertions: 0, commit: 0, prepare: 0, probe: 0, progress: [], requests: [], stage: [], withProject: 0 };
	const session = {
		hostId: HOST,
		deployRoot: DEPLOY_ROOT,
		async request(method, params) {
			calls.requests.push({ method, params });
			if (method === "fs.uploadPrepare") {
				calls.prepare += 1;
				if (options.prepareError !== undefined) throw options.prepareError;
				return { token: TOKEN, stageRef: params.uploadId, expiresAt: Date.now() + 120_000, ...options.preparePatch };
			}
			if (method === "fs.uploadCommit") {
				calls.commit += 1;
				if (typeof options.commit === "function") return options.commit(params);
				if (options.commitError !== undefined) throw options.commitError;
				return options.commitResult ?? commitSuccess();
			}
			if (method === "fs.uploadAbort") {
				calls.abort.push(params);
				return { cleaned: true };
			}
			throw new Error("unexpected method");
		},
		async withSftpInvocation(launch) {
			return launch(INVOCATION, async () => {
				calls.assertions += 1;
			});
		},
	};
	const adapter = async (_binaryPath, input, dependencies) => {
		calls.stage.push(input);
		const uploadId = input.relative.slice("upload-spool/".length, -".part".length);
		dependencies.onProgress?.({ operation: "stage", transferred: 3, total: 5 });
		if (options.adapterError !== undefined) throw options.adapterError;
		if (typeof options.adapter === "function") return options.adapter(input, uploadId);
		return options.stageResult ?? stageSuccess(uploadId);
	};
	const service = {
		async withProjectSession(hostId, root, task, requestOptions) {
			calls.withProject += 1;
			assert.equal(hostId, HOST);
			assert.equal(root, ROOT);
			assert.equal(requestOptions.requireReady, true);
			return { ok: true, value: await task(session) };
		},
		projectHelperCapabilities() {
			return options.capabilities ?? ["fs.uploadPrepare", "fs.uploadCommit", "fs.uploadAbort"];
		},
	};
	const sftp = {
		binaryIdentity: "sha256:" + "c".repeat(64),
		cache: {},
		probe: {
			async ensureProbe(probeInput) {
				calls.probe += 1;
				assert.equal(probeInput.session, session);
				assert.equal(probeInput.canonicalRoot, ROOT);
				assert.equal(probeInput.binaryPath, BINARY);
				return options.probeResult ?? { ok: true, value: { protocolVersion: 1, root: ROOT, extensions: {} } };
			},
		},
	};
	return { adapter, calls, service, sftp };
}

function input(harness, overrides = {}) {
	return {
		service: harness.service,
		hostId: HOST,
		canonicalRoot: ROOT,
		binaryPath: BINARY,
		sftp: harness.sftp,
		directory: "docs",
		localPath: LOCAL,
		onProgress: (transferred, total) => harness.calls.progress.push({ transferred, total }),
		...overrides,
	};
}

async function run(harness, overrides = {}) {
	return uploadOneRemoteProjectFile(input(harness, overrides), {
		adapter: harness.adapter,
		inspectLocal: async () => LOCAL_SNAPSHOT,
	});
}

test("prepare, stage and commit form one create-only upload with fixed spool scope", async () => {
	const harness = createHarness();
	const receipt = await run(harness);
	assert.deepEqual(plain(receipt), {
		name: "report.bin",
		bytes: 5,
		sha256: SHA,
		relativePath: "docs/report.bin",
		revision: plain(REVISION),
	});
	assert.deepEqual(
		harness.calls.requests.map((entry) => entry.method),
		["fs.uploadPrepare", "fs.uploadCommit"],
	);
	assert.deepEqual(harness.calls.progress, [{ transferred: 3, total: 5 }]);
	assert.equal(harness.calls.probe, 1);
	assert.equal(harness.calls.stage.length, 1);
	assert.equal(harness.calls.stage[0].operation, "stage");
	assert.equal(harness.calls.stage[0].root, DEPLOY_ROOT);
	assert.match(harness.calls.stage[0].relative, /^upload-spool\/[0-9a-f]{32}\.part$/);
	assert.equal(harness.calls.stage[0].localPath, LOCAL);
	assert.equal(harness.calls.assertions, 2);
	assert.equal(harness.calls.abort.length, 0);
});

test("prepare refusals stop before SFTP and are not replayed", async () => {
	const harness = createHarness({ prepareError: new Error("FILE_UPLOAD_TARGET_EXISTS") });
	await assert.rejects(run(harness), /FILE_UPLOAD_TARGET_EXISTS/);
	assert.equal(harness.calls.prepare, 1);
	assert.equal(harness.calls.stage.length, 0);
	assert.equal(harness.calls.commit, 0);
	assert.equal(harness.calls.abort.length, 0);
});

test("SFTP capability failure stops before prepare and never opens the executor", async () => {
	const harness = createHarness({ probeResult: { ok: false, code: "REMOTE_SFTP_SUBSYSTEM_UNAVAILABLE" } });
	await assert.rejects(run(harness), /REMOTE_SFTP_SUBSYSTEM_UNAVAILABLE/);
	assert.equal(harness.calls.probe, 1);
	assert.equal(harness.calls.prepare, 0);
	assert.equal(harness.calls.stage.length, 0);
	assert.equal(harness.calls.commit, 0);
});

test("stage failure invokes the narrow uploadAbort and never commits", async () => {
	const harness = createHarness({ stageResult: { ok: false, code: "SFTP_SUBSYSTEM_UNAVAILABLE" } });
	await assert.rejects(run(harness), /SFTP_SUBSYSTEM_UNAVAILABLE/);
	assert.equal(harness.calls.commit, 0);
	assert.equal(harness.calls.abort.length, 1);
	assert.match(harness.calls.abort[0].uploadId, /^[0-9a-f]{32}$/);
	assert.equal(harness.calls.abort[0].token, TOKEN);
});

test("stage hash mismatch cleans the spool through the one-use token", async () => {
	const harness = createHarness({ stageResult: { ok: true, operation: "stage", value: { bytes: 5, sha256: "f".repeat(64), fsync: true } } });
	await assert.rejects(run(harness), new RegExp(REMOTE_PROJECT_UPLOAD_JOB_CODES.stageInvalid));
	assert.equal(harness.calls.commit, 0);
	assert.equal(harness.calls.abort.length, 1);
});

test("a definite commit refusal stays rejected and is not relabelled unknown", async () => {
	const harness = createHarness({ commitError: new Error("FILE_UPLOAD_TARGET_EXISTS") });
	await assert.rejects(run(harness), (error) => {
		assert.equal(error.code, "FILE_UPLOAD_TARGET_EXISTS");
		assert.equal(error.outcome, "rejected");
		return true;
	});
	assert.equal(harness.calls.commit, 1);
	assert.equal(harness.calls.abort.length, 0, "the helper consumed the token and cleaned its own temporary file");
});

test("commit timeout or malformed confirmation is unknown and never retried", async () => {
	for (const options of [{ commitError: new Error("REQUEST_TIMEOUT") }, { commitResult: { committed: true } }]) {
		const harness = createHarness(options);
		await assert.rejects(run(harness), (error) => {
			assert.equal(error.code, REMOTE_PROJECT_UPLOAD_JOB_CODES.commitUnconfirmed);
			assert.equal(error.outcome, "unknown");
			return true;
		});
		assert.equal(harness.calls.commit, 1, "an unknown commit must not be replayed");
	}
});

test("cancellation while commit is in flight settles unknown even if a success frame arrives late", async () => {
	let release;
	const opened = new Promise((resolve) => {
		release = resolve;
	});
	const harness = createHarness({
		commit: () =>
			new Promise((resolve) => {
				opened.then(() => resolve(commitSuccess()));
			}),
	});
	const controller = new AbortController();
	const pending = run(harness, { signal: controller.signal });
	while (harness.calls.commit === 0) await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	release();
	await assert.rejects(pending, (error) => {
		assert.equal(error.code, REMOTE_PROJECT_UPLOAD_JOB_CODES.commitUnconfirmed);
		assert.equal(error.outcome, "unknown");
		return true;
	});
});

test("local inspection accepts an empty regular file and rejects a relative path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-upload-job-"));
	try {
		const path = join(directory, "empty.bin");
		await writeFile(path, Buffer.alloc(0));
		const snapshot = await inspectLocalUploadFile(path);
		assert.equal(snapshot.bytes, 0);
		assert.equal(snapshot.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		await assert.rejects(inspectLocalUploadFile("relative.bin"), new RegExp(REMOTE_PROJECT_UPLOAD_JOB_CODES.localPathInvalid));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
