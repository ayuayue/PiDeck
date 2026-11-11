import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { exportCatalogSessionHtmlWithPorts } = loadTsCommonJs("src/main/sessions/catalogSessionHtmlExport.ts");

test("Pi complete export remains the official RPC artifact, with relative paths resolved against the project", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "share-full-520-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const official = join(dir, "official.html");
	await writeFile(official, "official HTML payload is not rewritten");
	const calls = [];
	const result = await exportCatalogSessionHtmlWithPorts(
		{
			catalog: { get: () => ({ projectId: "p", title: "session", backend: "pi" }), getLocalFilePath: () => "session.jsonl" },
			projects: { get: () => ({ path: dir }) },
			pi: {
				exportSessionHtml: async (...args) => {
					calls.push(args);
					return { path: "official.html" };
				},
				readSessionLoadWindow: async () => {
					throw new Error("must not replace an existing official artifact");
				},
			},
			dsh: {},
			exportDir: () => dir,
			copy: (key) => key,
		},
		"stable-session",
	);
	assert.equal(result.path, official);
	assert.deepEqual(calls, [["p", "session.jsonl"]]);
});

test("DSH complete export routes to the host exporter and preserves the partial-history flag", async () => {
	const result = await exportCatalogSessionHtmlWithPorts(
		{
			catalog: {
				get: () => ({ projectId: "p", title: "dsh", backend: "dsh", dshSessionId: "dsh-source" }),
				getLocalFilePath: () => {
					throw new Error("no local JSONL for DSH");
				},
			},
			projects: { get: () => ({ path: "/workspace" }) },
			pi: {},
			dsh: {
				exportSessionHtml: async (id, title, cwd) => {
					assert.equal(id, "dsh-source");
					assert.equal(title, "dsh");
					assert.equal(cwd, "/workspace");
					return { path: "dsh.html", truncated: true };
				},
			},
			exportDir: () => "/exports",
			copy: (key) => key,
		},
		"stable-session",
	);
	assert.equal(result.path, "dsh.html");
	assert.equal(result.truncated, true);
});
