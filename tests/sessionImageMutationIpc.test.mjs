import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { registerSessionImageMutationIpc } = loadTsCommonJs("src/main/ipc/sessionImageMutationIpc.ts");
const selection = { index: 1, expectedImageCount: 2, expectedHash: "a".repeat(64) };

/** 通过真实 IPC handler 验证不可信入参，不调用 Electron 或真实 pi。 */
function harness(result = { ok: true, value: undefined }) {
	const handlers = new Map();
	const calls = [];
	const failures = [];
	registerSessionImageMutationIpc(
		{ handle: (channel, fn) => handlers.set(channel, fn) },
		{
			removeCatalogMessageImage: async (...args) => {
				calls.push(args);
				return result;
			},
		},
		(...args) => failures.push(args),
	);
	return { calls, failures, invoke: (...args) => handlers.get("sessions:catalog-remove-message-image")({}, ...args) };
}

test("image removal IPC forwards stable identities and bounded snapshot without a file path", async () => {
	const h = harness();
	assert.equal((await h.invoke("session-a", "message-a", selection, "entry-a")).ok, true);
	assert.deepEqual(h.calls, [["session-a", "message-a", selection, "entry-a"]]);
});

test("image removal IPC rejects malformed identities and selections before the coordinator", async () => {
	const h = harness();
	for (const id of [null, "", "  ", "a\n", "x".repeat(513)]) {
		await assert.rejects(h.invoke(id, "message-a", selection), /Invalid catalog/);
		await assert.rejects(h.invoke("session-a", id, selection), /Invalid catalog/);
		await assert.rejects(h.invoke("session-a", "message-a", selection, id), /Invalid catalog/);
	}
	for (const target of [null, [], {}, { ...selection, index: -1 }, { ...selection, index: 0.5 }, { ...selection, index: 2 }, { ...selection, expectedImageCount: 1.5 }, { ...selection, expectedHash: "not-a-hash" }]) {
		await assert.rejects(h.invoke("session-a", "message-a", target), /Invalid catalog/);
	}
	assert.deepEqual(h.calls, []);
});

test("image removal IPC returns and reports structured failures without hiding them", async () => {
	const error = { code: "SESSION_RUNTIME_BUSY", debugDetails: "Stop first" };
	const h = harness({ ok: false, error });
	assert.equal((await h.invoke("session-a", "message-a", selection)).error, error);
	assert.deepEqual(JSON.parse(JSON.stringify(h.failures)), [[error, { sessionId: "session-a", messageId: "message-a" }]]);
});
