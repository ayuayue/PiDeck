import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { fileSymlinkSkipReason } from "./helpers/symlinkSupport.mjs";

function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-draft-migration-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const handlers = new Map();
	createTsSandbox({
		stubs: {
			electron: { app: { getPath: () => root }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../fs/trash": { trashPath: async () => {} },
		},
	})("src/main/ipc/scratchPadIpc.ts").registerScratchPadIpc({ appLogger: { info() {}, error() {} } });
	return { root, list: () => handlers.get("scratch-pad:list")(null) };
}

test("legacy draft migrates once under concurrent list requests and preserves bytes", async (t) => {
	const { root, list } = setup(t);
	writeFileSync(join(root, "scratch-pad.md"), "legacy notes\r\n第二行\n");
	await Promise.all([list(), list(), list()]);
	const drafts = await list();
	assert.equal(drafts.length, 1);
	assert.equal(readFileSync(drafts[0].path, "utf8"), "legacy notes\r\n第二行\n");
	assert.equal(readdirSync(root).includes("scratch-pad.md"), false);
});

test("existing timestamp draft is preserved on migration collision", async (t) => {
	const { root, list } = setup(t);
	const source = join(root, "scratch-pad.md");
	writeFileSync(source, "old scratch notes");
	const { statSync } = await import("node:fs");
	const ts = statSync(source).mtime;
	const pad = (n) => String(n).padStart(2, "0");
	const name = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}.md`;
	mkdirSync(join(root, "drafts"));
	writeFileSync(join(root, "drafts", name), "existing user draft");
	await list();
	await list();
	const contents = (await list()).map((draft) => readFileSync(draft.path, "utf8")).sort();
	assert.deepEqual([...contents], ["existing user draft", "old scratch notes"]);
});

test("legacy symlink is retained without copying or deleting its target", { skip: fileSymlinkSkipReason() }, async (t) => {
	const { root, list } = setup(t);
	writeFileSync(join(root, "outside.md"), "keep source");
	symlinkSync(join(root, "outside.md"), join(root, "scratch-pad.md"));
	assert.equal((await list()).length, 0);
	assert.equal(readFileSync(join(root, "outside.md"), "utf8"), "keep source");
	assert.equal(readdirSync(root).includes("scratch-pad.md"), true);
});

test("published copy is reused when source deletion fails and migration is retried", async (t) => {
	const { root } = setup(t);
	const source = join(root, "scratch-pad.md");
	writeFileSync(source, "keep all notes");
	let failDelete = true;
	const { migrateLegacyDraft } = createTsSandbox({
		stubs: {
			"node:fs/promises": {
				...fsPromises,
				unlink: async (path) => {
					if (path === source && failDelete) {
						failDelete = false;
						throw Object.assign(new Error("locked"), { code: "EPERM" });
					}
					return fsPromises.unlink(path);
				},
			},
		},
	})("src/main/scratchpad/legacyDraftMigration.ts");
	await assert.rejects(migrateLegacyDraft(root), /locked/);
	assert.equal(readFileSync(source, "utf8"), "keep all notes");
	await migrateLegacyDraft(root);
	const files = readdirSync(join(root, "drafts"));
	assert.equal(files.length, 1);
	assert.equal(readFileSync(join(root, "drafts", files[0]), "utf8"), "keep all notes");
	assert.equal(readdirSync(root).includes("scratch-pad.md"), false);
});

test("source changed during publication is retained and both versions converge on retry", async (t) => {
	const { root } = setup(t);
	const source = join(root, "scratch-pad.md");
	writeFileSync(source, "original notes");
	let changed = false;
	const { migrateLegacyDraft } = createTsSandbox({
		stubs: {
			"node:fs/promises": {
				...fsPromises,
				link: async (...args) => {
					await fsPromises.link(...args);
					if (!changed) {
						changed = true;
						writeFileSync(source, "new notes written concurrently");
					}
				},
			},
		},
	})("src/main/scratchpad/legacyDraftMigration.ts");
	await migrateLegacyDraft(root);
	assert.equal(readFileSync(source, "utf8"), "new notes written concurrently");
	await migrateLegacyDraft(root);
	const contents = readdirSync(join(root, "drafts"))
		.map((file) => readFileSync(join(root, "drafts", file), "utf8"))
		.sort();
	assert.deepEqual(contents, ["new notes written concurrently", "original notes"]);
});

test("a drafts directory link is retained and never receives migrated notes", async (t) => {
	const { root } = setup(t);
	const outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(root, "scratch-pad.md"), "legacy notes");
	symlinkSync(outside, join(root, "drafts"), process.platform === "win32" ? "junction" : "dir");
	const { migrateLegacyDraft } = createTsSandbox()("src/main/scratchpad/legacyDraftMigration.ts");
	await assert.rejects(migrateLegacyDraft(root), /regular drafts directory/);
	assert.equal(readFileSync(join(root, "scratch-pad.md"), "utf8"), "legacy notes");
	assert.deepEqual(readdirSync(outside), []);
});
