import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOST = "11111111-1111-4111-8111-111111111111";
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Exercise the public IPC boundary with the same host catalog used by the model picker. */
function harness(catalog) {
	let handler;
	const { registerRemotePiModelIpc } = loadTsCommonJs("src/main/ipc/remotePiModelIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle: (_channel, value) => {
						handler = value;
					},
				},
			},
		},
	});
	registerRemotePiModelIpc({ enabled: true, catalog });
	return (host = HOST, force = false) => handler({}, host, force);
}

test("configuration model catalog works without projects or running sessions and masks private fields", async () => {
	const calls = [];
	const invoke = harness({
		load: async (input) => {
			calls.push(input);
			return { ok: true, models: [{ provider: "remote", id: "model", name: "Remote model", apiKey: "private-value", baseUrl: "private-url", contextWindow: 9000 }], cached: false };
		},
	});
	const result = plain(await invoke(HOST, true));
	assert.equal(result.ok, true);
	assert.deepEqual(result.models, [{ provider: "remote", id: "model", name: "Remote model", contextWindow: 9000 }]);
	assert.deepEqual(plain(calls), [{ hostId: HOST, force: true }]);
	assert.equal(JSON.stringify(result).includes("private"), false);
});

test("invalid host ids and refresh flags perform no catalog work", async () => {
	let calls = 0;
	const invoke = harness({
		load: async () => {
			calls++;
			throw new Error("must not run");
		},
	});
	assert.equal((await invoke("../other")).code, "REMOTE_MODEL_PROBE_TARGET_INVALID");
	assert.equal((await invoke(HOST, "true")).code, "REMOTE_MODEL_PROBE_TARGET_INVALID");
	assert.equal(calls, 0);
});

test("empty host catalogs and transport failures are distinct closed results without local fallback", async () => {
	assert.equal((await harness({ load: async () => ({ ok: false, code: "REMOTE_MODEL_CATALOG_EMPTY" }) })()).code, "REMOTE_MODEL_PROBE_EMPTY");
	assert.equal(
		(
			await harness({
				load: async () => {
					throw new Error("private connection text");
				},
			})()
		).code,
		"REMOTE_MODEL_PROBE_FAILED",
	);
});
