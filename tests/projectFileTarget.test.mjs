import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { INVALID_PROJECT_FILE_TARGET, parseProjectFileTarget, resolveLocalProjectFileTarget } = loadTsCommonJs("src/main/files/projectFileTarget.ts");

test("project file targets accept only canonical project-relative paths", () => {
	const target = parseProjectFileTarget({ projectId: "project-1", relativePath: "src/main.ts" });
	assert.equal(target.projectId, "project-1");
	assert.equal(target.relativePath, "src/main.ts");
	assert.equal(parseProjectFileTarget({ projectId: "project-1", relativePath: "" }).relativePath, "");
});

test("project file targets reject traversal, absolute paths, and non-contract fields", () => {
	const invalidTargets = [
		{ projectId: "project-1", relativePath: "../secret" },
		{ projectId: "project-1", relativePath: "src/../secret" },
		{ projectId: "project-1", relativePath: "/etc/passwd" },
		{ projectId: "project-1", relativePath: "C:/secret.txt" },
		{ projectId: " project-1", relativePath: "file.txt" },
		{ projectId: "project-1", relativePath: "file.txt", path: "C:/secret.txt" },
		{ projectId: "project-1", relativePath: "src//main.ts" },
	];
	if (process.platform === "win32") invalidTargets.push({ projectId: "project-1", relativePath: "src\\main.ts" });
	for (const target of invalidTargets) {
		assert.throws(() => parseProjectFileTarget(target), new RegExp(INVALID_PROJECT_FILE_TARGET));
	}
	assert.throws(() => parseProjectFileTarget(null), new RegExp(INVALID_PROJECT_FILE_TARGET));
});

test("local project target resolution preserves roots and rejects escapes", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-project-target-"));
	const root = join(fixture, "project");
	try {
		assert.equal(resolveLocalProjectFileTarget(root, ""), root);
		assert.equal(resolveLocalProjectFileTarget(root, "src/main.ts"), join(root, "src", "main.ts"));
		assert.throws(() => resolveLocalProjectFileTarget(root, "../secret.txt"), new RegExp(INVALID_PROJECT_FILE_TARGET));
		assert.throws(() => resolveLocalProjectFileTarget("relative/project", "src/main.ts"), new RegExp(INVALID_PROJECT_FILE_TARGET));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
