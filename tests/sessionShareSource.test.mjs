import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createSessionShareSourceLoader } = loadTsCommonJs("src/main/sessions/sessionShareSource.ts");
const { DEFAULT_SESSION_SHARE_OPTIONS } = loadTsCommonJs("src/shared/types/sessionExport.ts");
const message = { id: "tool", agentId: "_share", role: "tool", text: "✓ read", timestamp: 0, meta: { entryId: "entry", toolName: "read" } };
function fixture(backend = "pi", locator) {
	const calls = [];
	const entry = { id: "s1", projectId: "p1", title: "sample", backend, dshSessionId: "dsh1" };
	const load = createSessionShareSourceLoader({
		catalog: { get: (id) => (id === "s1" ? entry : undefined), getLocator: () => locator, getLocalFilePath: () => "/fixture/session.jsonl" },
		projects: { get: () => ({ id: "p1", path: "/fixture/workspace" }) },
		pi: {
			readSessionDisplayTurnPage: async (...args) => {
				calls.push(["pi", ...args]);
				return { messages: [message], nextBefore: null, total: 1 };
			},
			readMessageFullTextFromFile: async (...args) => {
				calls.push(["full", ...args]);
				return { text: "full result" };
			},
		},
		dsh: {
			readSessionExportMessages: async (...args) => {
				calls.push(["dsh", ...args]);
				return { messages: [message], truncated: false };
			},
		},
	});
	return { load, calls, entry };
}

test("source loader uses the read-only export projector and never re-reads tool text after collection", async () => {
	const h = fixture();
	const result = await h.load("s1", DEFAULT_SESSION_SHARE_OPTIONS);
	assert.equal(result.backend, "pi");
	assert.equal(result.cwd, "/fixture/workspace");
	assert.equal(h.calls[0][1], "/fixture/session.jsonl");
	assert.equal(h.calls.length, 1);
	await h.load("s1", { ...DEFAULT_SESSION_SHARE_OPTIONS, excludeToolResults: false });
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1][0], "pi");
});

test("DSH source reads host projections and avoids attachment hydration when images are excluded", async () => {
	const h = fixture("dsh");
	const result = await h.load("s1", DEFAULT_SESSION_SHARE_OPTIONS);
	assert.equal(result.backend, "dsh");
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0][0], "dsh");
	assert.equal(h.calls[0][1], "dsh1");
	assert.equal(h.calls[0][2].includeImages, false);
	await h.load("s1", { ...DEFAULT_SESSION_SHARE_OPTIONS, excludeImages: false });
	assert.equal(h.calls[1][2].includeImages, true);
});

test("local WSL shares use the session's distribution without routing Linux paths into native readers", async () => {
	const h = fixture();
	h.entry.environment = "wsl";
	h.entry.wslDistro = "FixtureDistro";
	await h.load("s1", DEFAULT_SESSION_SHARE_OPTIONS);
	assert.equal(h.calls[0][1], "\\\\wsl.localhost\\FixtureDistro\\fixture\\session.jsonl");
});

test("unsupported backends and SSH routes are refused before any local read, without fallback", async () => {
	for (const backend of ["acp", "imagegen", "videogen"]) {
		const h = fixture(backend);
		await assert.rejects(h.load("s1", DEFAULT_SESSION_SHARE_OPTIONS), /SESSION_SHARE_UNSUPPORTED/);
		assert.deepEqual(h.calls, []);
	}
	const h = fixture("pi", { kind: "ssh", hostId: "host", remotePath: "/remote/session" });
	await assert.rejects(h.load("s1", DEFAULT_SESSION_SHARE_OPTIONS), /SESSION_SHARE_UNSUPPORTED/);
	assert.deepEqual(h.calls, []);
});
