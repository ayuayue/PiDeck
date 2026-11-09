import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const entry = require.resolve("app-builder-lib/out/util/electronGet.js");
const runtime = require("builder-util-runtime");

/** Exercise upstream's replacement for the retired local extraction patch, without retry delays. */
function loadMove(filesystem) {
	return loadTsCommonJs(entry, {
		stubs: {
			"fs/promises": filesystem,
			"builder-util": { log: { warn() {}, filePath: (value) => value } },
			"builder-util-runtime": { ...runtime, retry: (task, options) => runtime.retry(task, { ...options, interval: 0, backoff: 0 }) },
		},
	}).moveDirAtomic;
}

test("upstream extraction move retries transient failures and stops after success", async () => {
	let calls = 0;
	const failures = ["EPERM", "EBUSY", "ENOENT"];
	const move = loadMove({
		rename: async () => {
			const code = failures[calls++];
			if (code) throw Object.assign(new Error(code), { code });
		},
	});
	await move("source", "destination");
	assert.equal(calls, 4);
});

test("upstream extraction move fails immediately on non-transient errors", async () => {
	let calls = 0;
	const error = Object.assign(new Error("disk failure"), { code: "EIO" });
	const move = loadMove({
		rename: async () => {
			calls++;
			throw error;
		},
	});
	await assert.rejects(move("source", "destination"), error);
	assert.equal(calls, 1);
});

test("upstream extraction move bounds retries and falls back to copy before deleting the source", async () => {
	let attempts = 0;
	const operations = [];
	const move = loadMove({
		rename: async () => {
			attempts++;
			throw Object.assign(new Error("busy"), { code: "EPERM" });
		},
		cp: async (source, destination, options) => {
			assert.equal(options.recursive, true);
			operations.push(["copy", source, destination]);
		},
		rm: async (source, options) => {
			assert.equal(options.recursive, true);
			assert.equal(options.force, true);
			operations.push(["remove", source]);
		},
	});
	await move("source", "destination");
	assert.equal(attempts, 5);
	assert.deepEqual(operations, [
		["copy", "source", "destination"],
		["remove", "source"],
	]);
});

test("copy fallback failure is reported and preserves its source", async () => {
	const move = loadMove({
		rename: async () => {
			throw Object.assign(new Error("busy"), { code: "EBUSY" });
		},
		cp: async () => {
			throw new Error("copy failed");
		},
		rm: async () => {
			assert.fail("must preserve the source when copy fails");
		},
	});
	await assert.rejects(move("source", "destination"), /copy failed.*last rename error: busy/);
});

test("upstream extraction move preserves a real temporary archive directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-archive-move-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "archive.tmp"),
		destination = join(root, "archive");
	await mkdir(source);
	await writeFile(join(source, "binary.txt"), "archive payload");
	await require(entry).moveDirAtomic(source, destination);
	assert.equal(await readFile(join(destination, "binary.txt"), "utf8"), "archive payload");
	await assert.rejects(readFile(join(source, "binary.txt")), { code: "ENOENT" });
});
