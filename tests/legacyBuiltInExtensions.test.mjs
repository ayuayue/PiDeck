import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("legacy extension cleanup preserves modified files and backs up verified bundled copies", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-legacy-extension-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const oldDir = join(root, ".pi", "agent", "extensions");
	const bundledDir = join(root, "bundled");
	mkdirSync(oldDir, { recursive: true });
	mkdirSync(bundledDir);
	for (const name of ["same.ts", "modified.ts"]) writeFileSync(join(bundledDir, name), "bundled extension");
	writeFileSync(join(oldDir, "same.ts"), "bundled extension");
	writeFileSync(join(oldDir, "modified.ts"), "user changes");
	writeFileSync(join(oldDir, "retired.ts"), "unknown historical code");
	const { migrateLegacyExtensionCopies } = loadTsCommonJs("src/main/extensions/legacyBuiltInExtensions.ts");
	const result = await migrateLegacyExtensionCopies(root, bundledDir, ["same.ts", "modified.ts", "retired.ts"]);
	assert.equal(result.moved, 1);
	assert.equal(result.preserved, 2);
	assert.equal(existsSync(join(oldDir, "same.ts")), false);
	assert.equal(readFileSync(join(oldDir, "modified.ts"), "utf8"), "user changes");
	assert.equal(readFileSync(join(oldDir, "retired.ts"), "utf8"), "unknown historical code");
	const backups = readdirSync(join(root, ".pi", "agent", "pideck-legacy-extension-backups"));
	assert.equal(backups.length, 1);
	assert.equal(readFileSync(join(root, ".pi", "agent", "pideck-legacy-extension-backups", backups[0]), "utf8"), "bundled extension");
	await migrateLegacyExtensionCopies(root, bundledDir, ["same.ts"]);
	assert.equal(readdirSync(join(root, ".pi", "agent", "pideck-legacy-extension-backups")).length, 1);
});

test("an extensions directory link cannot authorize removing another directory's files", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-legacy-extension-link-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, ".pi", "agent");
	const outside = join(root, "outside");
	const bundled = join(root, "bundled");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(outside);
	mkdirSync(bundled);
	writeFileSync(join(outside, "same.ts"), "bundled");
	writeFileSync(join(bundled, "same.ts"), "bundled");
	symlinkSync(outside, join(agentDir, "extensions"), process.platform === "win32" ? "junction" : "dir");
	const { migrateLegacyExtensionCopies } = loadTsCommonJs("src/main/extensions/legacyBuiltInExtensions.ts");
	assert.equal((await migrateLegacyExtensionCopies(root, bundled, ["same.ts"])).moved, 0);
	assert.equal(readFileSync(join(outside, "same.ts"), "utf8"), "bundled");
});
