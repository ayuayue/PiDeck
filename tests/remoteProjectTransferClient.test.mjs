import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { downloadThroughRemoteTransfer, uploadThroughRemoteTransfer } = loadTsCommonJs("src/renderer/src/services/remoteProjectTransferClient.ts");
const JOB_ID = "job-0000000000001";
const projectId = "p1";
const target = { projectId, relativePath: "src" };
const plain = (value) => JSON.parse(JSON.stringify(value));

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
