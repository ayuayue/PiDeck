import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteSftpDirectoryReader, REMOTE_SFTP_DIRECTORY_MAX_ENTRIES, REMOTE_SFTP_DIRECTORY_READER_CODES } = loadTsCommonJs("src/main/remote/RemoteSftpDirectoryReader.ts");

const ROOT = "/srv/project";
const BINARY = process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/opt/pideck/remote-sftp";
const BINARY_IDENTITY = "sha256:" + "a".repeat(64);
const INVOCATION = Object.freeze({
	executable: process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh",
	args: Object.freeze(["-T", "-s", "host", "sftp"]),
	env: Object.freeze({}),
});
const plain = (value) => JSON.parse(JSON.stringify(value));

function listValue(overrides = {}) {
	return {
		entries: [{ name: "src", kind: "directory", isSymlink: false }],
		scanned: 1,
		truncated: false,
		...overrides,
	};
}

function setup(options = {}) {
	const calls = { binary: 0, probes: [], invocations: [], assertions: 0, adapters: [] };
	const session = {
		hostId: "11111111-1111-4111-8111-111111111111",
		hostRevision: 7,
		connectionId: "host#manager#1",
		async withSftpInvocation(launch) {
			calls.invocations.push("sftp");
			return launch(INVOCATION, async () => {
				calls.assertions += 1;
				if (session.stale === true) throw new Error("SSH_HOST_NOT_READY");
			});
		},
		stale: false,
	};
	const reader = createRemoteSftpDirectoryReader({
		async binary() {
			calls.binary += 1;
			if (options.binaryThrows) throw new Error("read failed");
			return options.binaryUndefined ? undefined : { path: BINARY, identity: BINARY_IDENTITY };
		},
		cache: {},
		probe: {
			async ensureProbe(input) {
				calls.probes.push(input);
				if (options.probeFailure !== undefined) return { ok: false, code: options.probeFailure };
				return { ok: true, value: { protocolVersion: 1, root: ROOT, extensions: {} } };
			},
		},
		adapter: async (binaryPath, input, dependencies) => {
			calls.adapters.push({ binaryPath, input, dependencies });
			if (options.adapterError !== undefined) throw options.adapterError;
			if (options.staleAfterAdapter === true) session.stale = true;
			return options.adapterResult ?? { ok: true, operation: "list", value: listValue(options.list) };
		},
	});
	return { calls, reader, session };
}

function invoke(harness, overrides = {}) {
	return harness.reader.read({
		session: harness.session,
		canonicalRoot: ROOT,
		relative: "packages/app",
		...overrides,
	});
}

test("one pinned session probes once, lists through SFTP, and preserves truncation metadata", async () => {
	const h = setup({ list: { entries: Array.from({ length: 4096 }, (_, index) => ({ name: `n${index}`, kind: "file", bytes: 1, isSymlink: false })), scanned: 4100, truncated: true } });
	const result = await invoke(h);
	assert.equal(result.ok, true);
	assert.equal(result.value.entries.length, REMOTE_SFTP_DIRECTORY_MAX_ENTRIES);
	assert.equal(result.value.scanned, 4100);
	assert.equal(result.value.truncated, true);
	assert.equal(h.calls.binary, 1);
	assert.equal(h.calls.probes.length, 1);
	assert.equal(h.calls.probes[0].session, h.session, "the reader reuses the caller's pinned project session");
	assert.equal(h.calls.probes[0].canonicalRoot, ROOT);
	assert.equal(h.calls.adapters.length, 1);
	assert.equal(h.calls.adapters[0].binaryPath, BINARY);
	assert.equal(h.calls.adapters[0].input.operation, "list");
	assert.equal(h.calls.adapters[0].input.root, ROOT);
	assert.equal(h.calls.adapters[0].input.relative, "packages/app");
	assert.equal(h.calls.adapters[0].input.maxEntries, REMOTE_SFTP_DIRECTORY_MAX_ENTRIES);
	assert.equal(h.calls.assertions, 2, "the listing is fenced before and after the one-shot job");
});

test("a missing binary or failed probe returns its stable capability code without starting SFTP", async () => {
	for (const [options, code] of [
		[{ binaryUndefined: true }, REMOTE_SFTP_DIRECTORY_READER_CODES.binaryUnavailable],
		[{ binaryThrows: true }, REMOTE_SFTP_DIRECTORY_READER_CODES.binaryUnavailable],
		[{ probeFailure: "REMOTE_SFTP_SUBSYSTEM_UNAVAILABLE" }, "REMOTE_SFTP_SUBSYSTEM_UNAVAILABLE"],
	]) {
		const h = setup(options);
		assert.deepEqual(plain(await invoke(h)), { ok: false, code });
		assert.equal(h.calls.adapters.length, 0);
	}
});

test("adapter permission, missing, cancellation and malformed-operation results stay explicit", async () => {
	for (const [adapterResult, code] of [
		[{ ok: false, code: "SFTP_PERMISSION_DENIED" }, "SFTP_PERMISSION_DENIED"],
		[{ ok: false, code: "SFTP_REMOTE_NOT_FOUND" }, "SFTP_REMOTE_NOT_FOUND"],
		[{ ok: false, code: "SFTP_JOB_CANCELLED" }, "SFTP_JOB_CANCELLED"],
		[{ ok: true, operation: "download", value: { bytes: 1, fsync: false, atomicRename: false } }, "SFTP_RESULT_INVALID"],
	]) {
		const h = setup({ adapterResult });
		assert.deepEqual(plain(await invoke(h)), { ok: false, code });
	}
});

test("a generation change during the list is rejected and never returned as a directory fact", async () => {
	const h = setup({ staleAfterAdapter: true });
	assert.deepEqual(plain(await invoke(h)), { ok: false, code: "SSH_HOST_NOT_READY" });
	assert.equal(h.calls.assertions, 2, "the post-list generation fence still runs");
});

test("aborting before the one-shot job sends no SFTP list request", async () => {
	const h = setup();
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(plain(await invoke(h, { signal: controller.signal })), { ok: false, code: "SFTP_JOB_CANCELLED" });
	assert.equal(h.calls.adapters.length, 0);
});
