import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { downloadThroughRemoteTransfer, uploadThroughRemoteTransfer } = loadTsCommonJs("src/renderer/src/services/remoteProjectTransferClient.ts");
const JOB_ID = "job-0000000000001";
const projectId = "p1";
const target = { projectId, relativePath: "src" };
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function api(start, event) {
	let listener;
	return {
		remoteTransfers: {
			onEvent(callback) {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			async start(input) {
				if (event !== undefined) listener?.(event);
				return start(input);
			},
		},
	};
}

test("terminal events that beat the start reply are buffered and matched", async () => {
	const calls = [];
	const client = api(
		async (input) => {
			calls.push(input);
			return { ok: true, value: { jobId: JOB_ID, operation: "upload", total: 4 } };
		},
		{ kind: "settled", jobId: JOB_ID, operation: "upload", outcome: "succeeded", result: { uploaded: [{ name: "a.bin", bytes: 4 }], failed: [] } },
	);
	assert.deepEqual(plain(await uploadThroughRemoteTransfer(client, projectId, target, { kind: "picker" })), { ok: true, value: { uploaded: [{ name: "a.bin", bytes: 4 }], failed: [] } });
	assert.deepEqual(plain(calls[0]), { operation: "upload", projectId, targetRelativePath: "src", source: { kind: "picker" } });
});

test("unknown terminal outcome survives and is never downgraded to rejected", async () => {
	const client = api(async () => ({ ok: true, value: { jobId: JOB_ID, operation: "upload", total: 4 } }), { kind: "settled", jobId: JOB_ID, operation: "upload", outcome: "unknown", code: "REMOTE_UPLOAD_COMMIT_UNCONFIRMED" });
	const result = await uploadThroughRemoteTransfer(client, projectId, target, { kind: "paths", paths: ["/tmp/a"] });
	assert.deepEqual(plain(result), { ok: false, code: "REMOTE_UPLOAD_COMMIT_UNCONFIRMED", outcome: "unknown" });
});

test("a start failure retains its original outcome and malformed success is rejected", async () => {
	const failed = api(async () => ({ ok: false, code: "REMOTE_CUSTOM_UNKNOWN", outcome: "unknown" }));
	assert.deepEqual(plain(await downloadThroughRemoteTransfer(failed, projectId, { projectId, relativePath: "src/a.bin" })), { ok: false, code: "REMOTE_CUSTOM_UNKNOWN", outcome: "unknown" });

	const malformed = api(async () => ({ ok: true, value: { jobId: JOB_ID, operation: "download", total: 4 } }), { kind: "settled", jobId: JOB_ID, operation: "download", outcome: "succeeded", result: { path: "", bytes: 4 } });
	assert.deepEqual(plain(await downloadThroughRemoteTransfer(malformed, projectId, { projectId, relativePath: "src/a.bin" })), { ok: false, code: "REMOTE_TRANSFER_RESULT_INVALID", outcome: "rejected" });
});

test("a terminal event for the same job id but a different operation is ignored", async () => {
	let listener;
	const client = {
		remoteTransfers: {
			onEvent(callback) {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			async start() {
				setImmediate(() => {
					listener?.({ kind: "settled", jobId: JOB_ID, operation: "download", outcome: "failed", code: "WRONG_OPERATION" });
					listener?.({
						kind: "settled",
						jobId: JOB_ID,
						operation: "upload",
						outcome: "succeeded",
						result: { uploaded: [{ name: "a.bin", bytes: 4 }], failed: [] },
					});
				});
				return { ok: true, value: { jobId: JOB_ID, operation: "upload", total: 4 } };
			},
		},
	};

	const result = await uploadThroughRemoteTransfer(client, projectId, target, { kind: "picker" });
	assert.deepEqual(plain(result), { ok: true, value: { uploaded: [{ name: "a.bin", bytes: 4 }], failed: [] } });
});

test("progress callbacks only receive the started job and operation", async () => {
	let listener;
	const progress = [];
	const client = {
		remoteTransfers: {
			onEvent(callback) {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			async start() {
				setImmediate(() => {
					listener?.({ kind: "progress", jobId: "job-0000000000002", operation: "upload", transferred: 1, total: 10 });
					listener?.({ kind: "progress", jobId: JOB_ID, operation: "download", transferred: 2, total: 10 });
					listener?.({ kind: "progress", jobId: JOB_ID, operation: "upload", transferred: 4, total: 10 });
					listener?.({ kind: "progress", jobId: JOB_ID, operation: "upload", transferred: 6, total: 10 });
					listener?.({ kind: "progress", jobId: JOB_ID, operation: "upload", transferred: 11, total: 10 });
					listener?.({ kind: "settled", jobId: JOB_ID, operation: "upload", outcome: "succeeded", result: { uploaded: [{ name: "a.bin", bytes: 6 }], failed: [] } });
				});
				return { ok: true, value: { jobId: JOB_ID, operation: "upload", total: 10 } };
			},
		},
	};
	const result = await uploadThroughRemoteTransfer(client, projectId, target, { kind: "picker" }, { onProgress: (event) => progress.push({ ...event }) });
	assert.deepEqual(progress, [
		{ operation: "upload", transferred: 4, total: 10 },
		{ operation: "upload", transferred: 6, total: 10 },
	]);
	assert.deepEqual(Object.keys(progress[0]).sort(), ["operation", "total", "transferred"], "progress observers see only the presentation projection, never job identity");
	assert.equal(result.ok, true);
});

test("abort cancels only the current opaque job once and waits for its terminal frame", async () => {
	let listener;
	let startCalls = 0;
	const cancelCalls = [];
	const client = {
		remoteTransfers: {
			onEvent(callback) {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			async start() {
				startCalls += 1;
				return { ok: true, value: { jobId: JOB_ID, operation: "upload", total: 10 } };
			},
			async cancel(projectIdValue, jobIdValue) {
				cancelCalls.push([projectIdValue, jobIdValue]);
				return { accepted: true };
			},
		},
	};
	const controller = new AbortController();
	const pending = uploadThroughRemoteTransfer(client, projectId, target, { kind: "picker" }, { signal: controller.signal });
	await flush();
	controller.abort();
	controller.abort();
	await flush();
	assert.deepEqual(cancelCalls, [[projectId, JOB_ID]], "同一任务只能发送一次 cancel");
	assert.equal(startCalls, 1, "取消不得触发自动重放");
	listener?.({ kind: "settled", jobId: JOB_ID, operation: "upload", outcome: "cancelled", code: "REMOTE_TRANSFER_CANCELLED" });
	assert.deepEqual(plain(await pending), { ok: false, code: "REMOTE_TRANSFER_CANCELLED", outcome: "rejected" });
	assert.equal(listener, undefined, "settle 后必须退订事件监听");
});

test("abort followed by an unconfirmed terminal remains unknown and is never replayed", async () => {
	let listener;
	let startCalls = 0;
	const client = {
		remoteTransfers: {
			onEvent(callback) {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			async start() {
				startCalls += 1;
				return { ok: true, value: { jobId: JOB_ID, operation: "upload", total: 10 } };
			},
			async cancel() {
				return { accepted: true };
			},
		},
	};
	const controller = new AbortController();
	const pending = uploadThroughRemoteTransfer(client, projectId, target, { kind: "picker" }, { signal: controller.signal });
	await flush();
	controller.abort();
	await flush();
	listener?.({ kind: "settled", jobId: JOB_ID, operation: "upload", outcome: "unknown", code: "REMOTE_UPLOAD_COMMIT_UNCONFIRMED" });
	assert.deepEqual(plain(await pending), { ok: false, code: "REMOTE_UPLOAD_COMMIT_UNCONFIRMED", outcome: "unknown" });
	assert.equal(startCalls, 1);
});

test("an already-aborted transfer never starts or subscribes", async () => {
	let startCalls = 0;
	let subscribeCalls = 0;
	const client = {
		remoteTransfers: {
			onEvent() {
				subscribeCalls += 1;
				return () => {};
			},
			async start() {
				startCalls += 1;
				throw new Error("must not start");
			},
		},
	};
	const controller = new AbortController();
	controller.abort();
	const result = await downloadThroughRemoteTransfer(client, projectId, { projectId, relativePath: "src/a.bin" }, { signal: controller.signal });
	assert.deepEqual(plain(result), { ok: true, value: { canceled: true } });
	assert.equal(startCalls, 0);
	assert.equal(subscribeCalls, 0);
});

test("a start receipt with the wrong operation is rejected and its job is cancelled", async () => {
	let cancelCalls = 0;
	const client = {
		remoteTransfers: {
			onEvent() {
				return () => {};
			},
			async start() {
				return { ok: true, value: { jobId: JOB_ID, operation: "download", total: 4 } };
			},
			async cancel(projectIdValue, jobIdValue) {
				assert.equal(projectIdValue, projectId);
				assert.equal(jobIdValue, JOB_ID);
				cancelCalls += 1;
				return { accepted: true };
			},
		},
	};
	const result = await uploadThroughRemoteTransfer(client, projectId, target, { kind: "picker" });
	assert.deepEqual(plain(result), { ok: false, code: "REMOTE_TRANSFER_RESULT_INVALID", outcome: "rejected" });
	assert.equal(cancelCalls, 1);
});
