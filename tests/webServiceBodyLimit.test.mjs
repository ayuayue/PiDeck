import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

async function withServer(run) {
	const { WebServiceManager } = loadTsCommonJs(
		"src/main/web/WebServiceManager.ts",
		{ globals: { fetch: globalThis.fetch } },
	);
	const calls = [];
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		createProject: async (path) => {
			calls.push(path);
			return { id: "project-2", name: "New Project", path, lastOpenedAt: 2 };
		},
	});
	await manager.start("127.0.0.1", 0);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ baseUrl, calls });
	} finally {
		await manager.stop();
	}
}

test("oversized JSON body gets 413 without reaching route logic", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const oversized = JSON.stringify({
			path: `C:/${"a".repeat(MAX_JSON_BODY_BYTES + 1024)}`,
		});
		const response = await fetch(`${baseUrl}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: oversized,
		});
		assert.equal(response.status, 413);
		assert.deepEqual(calls, [], "createProject must not run for oversized bodies");
		const payload = await response.json();
		assert.equal(payload.code, "webError.bodyTooLarge");
	});
});

test("bodies within the limit still reach route logic", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const response = await fetch(`${baseUrl}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: "C:/small" }),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(calls, ["C:/small"]);
	});
});
