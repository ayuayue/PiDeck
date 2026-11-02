import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOST = "11111111-1111-4111-8111-111111111111";
const ROOT = "/srv/project";
const JOB_ID = /^[A-Za-z0-9_-]{16,128}$/;
const plain = (value) => JSON.parse(JSON.stringify(value));

function sender(id = 1) {
	const value = new EventEmitter();
	value.id = id;
	value.destroyed = false;
	value.events = [];
	value.isDestroyed = () => value.destroyed;
	value.send = (channel, event) => value.events.push({ channel, event });
	return value;
}

function setup(options = {}) {
	const handlers = new Map();
	const uploads = [];
	const audit = { afterWrite: [], afterUnknown: [], probes: [] };
	const { registerRemoteProjectTransferJobIpc } = loadTsCommonJs("src/main/ipc/remoteProjectTransferJobIpc.ts", {
		stubs: {
			electron: {
				ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
				BrowserWindow: { fromWebContents: () => null },
				dialog: {
					showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
					showSaveDialog: async () => ({ canceled: true }),
				},
			},
		},
	});
	const session = {
		async request(method, params) {
			assert.equal(method, "fs.stat");
			assert.equal(params.path, "src/a.bin");
			return { kind: "file", bytes: 5, mtimeMs: 1 };
		},
		async withSftpInvocation(launch) {
			return launch({ executable: "/usr/bin/ssh", args: ["-s", HOST, "sftp"], env: {} }, async () => undefined);
		},
	};
	const service = {
		projectTransferIdentity: () => ({ connectionId: "c1", hostRevision: 1, state: "ready" }),
		projectHelperCapabilities: () => ["fs.stat", "fs.uploadPrepare", "fs.uploadCommit", "fs.uploadAbort"],
		async withProjectSession(_hostId, _root, task) {
			return { ok: true, value: await task(session) };
		},
	};
	const handle = registerRemoteProjectTransferJobIpc({
		enabled: true,
		service: async () => service,
		locator: () => ({ kind: "ssh", hostId: HOST, remotePath: ROOT }),
		binary: async () => (options.binaryUnavailable ? undefined : { path: process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/opt/pideck/remote-sftp", identity: "sha256:" + "a".repeat(64) }),
		dialogs: {
			openFiles: async () => options.picked,
			saveFile: async () => options.savedTo,
		},
		probe: {
			async ensureProbe(input) {
				audit.probes.push(input);
				return { ok: true, value: { protocolVersion: 1, root: ROOT, extensions: {} } };
			},
		},
		adapter: async (_binary, input, dependencies) => {
			if (options.downloadError !== undefined) throw options.downloadError;
			dependencies.onProgress?.({ operation: "download", transferred: 3, total: 5 });
			return options.downloadResult ?? { ok: true, operation: "download", value: { bytes: 5, fsync: true, atomicRename: true } };
		},
		uploadOne: async (input) => {
			uploads.push(input);
			if (typeof options.uploadOne === "function") return options.uploadOne(input, uploads.length);
			input.onProgress?.(input.localPath.endsWith(".bin") ? 2 : 1, 2);
			return { name: input.localPath.split(/[\\/]/).at(-1), bytes: 2, sha256: "b".repeat(64), relativePath: (input.directory ? input.directory + "/" : "") + input.localPath.split(/[\\/]/).at(-1), revision: {} };
		},
		afterWrite: (projectId, paths) => audit.afterWrite.push({ projectId, paths: [...paths] }),
		afterUnknown: (projectId) => audit.afterUnknown.push(projectId),
	});
	const invoke = (channel, from, ...args) => handlers.get(channel)({ sender: from }, ...args);
	return { audit, handle, invoke, sender, uploads };
}

async function settled(from) {
	for (let index = 0; index < 100; index += 1) {
		const event = from.events.find((entry) => entry.event.kind === "settled");
		if (event !== undefined) return event.event;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error("transfer did not settle");
}

test("upload job returns an opaque id and streams only to its sender", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-transfer-ipc-"));
	try {
		const file = join(directory, "a.bin");
		await writeFile(file, "abc");
		const f = setup();
		const from = f.sender(1);
		const receipt = await f.invoke("remote:project-transfer-start", from, { operation: "upload", projectId: "p1", targetRelativePath: "src", source: { kind: "paths", paths: [file] } });
		assert.equal(receipt.ok, true);
		assert.match(receipt.value.jobId, JOB_ID);
		assert.equal(receipt.value.total, 3);
		const terminal = await settled(from);
		assert.equal(terminal.outcome, "succeeded");
		assert.deepEqual(plain(terminal.result), { uploaded: [{ name: "a.bin", bytes: 2 }], failed: [] });
		assert.ok(from.events.every((entry) => entry.channel === "remote:project-transfer-event"));
		assert.equal(f.audit.probes.length, 0, "the fake worker bypasses the real helper phase");
		assert.deepEqual(f.audit.afterWrite, [{ projectId: "p1", paths: ["src/a.bin"] }]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an unknown commit stops the batch, marks facts unknown and never starts the next file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-transfer-ipc-"));
	try {
		const first = join(directory, "a.bin");
		const second = join(directory, "b.bin");
		await writeFile(first, "a");
		await writeFile(second, "b");
		const f = setup({
			uploadOne: async () => {
				const error = new Error("REMOTE_UPLOAD_COMMIT_UNCONFIRMED");
				error.outcome = "unknown";
				throw error;
			},
		});
		const from = f.sender(1);
		await f.invoke("remote:project-transfer-start", from, { operation: "upload", projectId: "p1", targetRelativePath: "", source: { kind: "paths", paths: [first, second] } });
		const terminal = await settled(from);
		assert.equal(terminal.outcome, "unknown");
		assert.equal(terminal.code, "REMOTE_UPLOAD_COMMIT_UNCONFIRMED");
		assert.equal(f.uploads.length, 1);
		assert.deepEqual(f.audit.afterUnknown, ["p1"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancel is scoped to the original sender and aborts the live worker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-transfer-ipc-"));
	try {
		const file = join(directory, "a.bin");
		await writeFile(file, "a");
		let started;
		const opened = new Promise((resolve) => {
			started = resolve;
		});
		const f = setup({
			uploadOne: (input) =>
				new Promise((_resolve, reject) => {
					started();
					input.signal.addEventListener("abort", () => reject(new Error("REQUEST_CANCELLED")), { once: true });
				}),
		});
		const from = f.sender(7);
		const receipt = await f.invoke("remote:project-transfer-start", from, { operation: "upload", projectId: "p1", targetRelativePath: "", source: { kind: "paths", paths: [file] } });
		await opened;
		assert.deepEqual(plain(await f.invoke("remote:project-transfer-cancel", f.sender(8), "p1", receipt.value.jobId)), { ok: true, value: { accepted: false } });
		assert.deepEqual(plain(await f.invoke("remote:project-transfer-cancel", from, "p1", receipt.value.jobId)), { ok: true, value: { accepted: true } });
		const terminal = await settled(from);
		assert.equal(terminal.outcome, "cancelled");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("download uses one stat seam, then the SFTP job, and reports its settlement", async () => {
	const f = setup({ savedTo: process.platform === "win32" ? "C:\\downloads\\a.bin" : "/tmp/a.bin" });
	const from = f.sender(1);
	const receipt = await f.invoke("remote:project-transfer-start", from, { operation: "download", projectId: "p1", targetRelativePath: "src/a.bin" });
	assert.equal(receipt.ok, true);
	const terminal = await settled(from);
	assert.equal(terminal.outcome, "succeeded");
	assert.deepEqual(plain(terminal.result), { path: process.platform === "win32" ? "C:\\downloads\\a.bin" : "/tmp/a.bin", bytes: 5 });
	assert.ok(from.events.some((entry) => entry.event.kind === "progress" && entry.event.transferred === 3));
});

test("a download failure after the SFTP job starts is unknown, not a false rejection", async () => {
	const f = setup({
		savedTo: process.platform === "win32" ? "C:\\downloads\\a.bin" : "/tmp/a.bin",
		downloadError: new Error("SFTP_JOB_TIMEOUT"),
	});
	const from = f.sender(1);
	await f.invoke("remote:project-transfer-start", from, { operation: "download", projectId: "p1", targetRelativePath: "src/a.bin" });
	const terminal = await settled(from);
	assert.equal(terminal.outcome, "unknown");
	assert.equal(terminal.code, "REMOTE_DOWNLOAD_RESULT_UNCONFIRMED");
});

test("invalid input and a missing executor fail before creating a job", async () => {
	for (const [input, code] of [
		[{ operation: "download", projectId: "p1", targetRelativePath: "../secret" }, "REMOTE_TRANSFER_INPUT_INVALID"],
		[{ operation: "upload", projectId: "p1", targetRelativePath: "src", source: { kind: "paths", paths: ["relative.txt"] } }, "REMOTE_TRANSFER_INPUT_INVALID"],
	]) {
		const f = setup();
		const result = await f.invoke("remote:project-transfer-start", f.sender(), input);
		assert.equal(result.ok, false);
		assert.equal(result.code, code);
	}
	const noBinary = setup({ binaryUnavailable: true });
	const result = await noBinary.invoke("remote:project-transfer-start", noBinary.sender(), { operation: "download", projectId: "p1", targetRelativePath: "src/a.bin" });
	assert.equal(result.code, "REMOTE_SFTP_BINARY_UNAVAILABLE");
});
