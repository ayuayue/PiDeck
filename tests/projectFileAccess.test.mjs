import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	FILE_OUTSIDE_PROJECT_ERROR,
	assertProjectFilePathInsideRoot,
	assertProjectFileReadPath,
} = loadTsCommonJs("src/main/files/projectFileAccess.ts");

test("project file access accepts a real file inside the project", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-project-file-access-"));
	const root = join(fixture, "project");
	const file = join(root, "src", "index.ts");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(file, "export {};\n");
	try {
		assert.doesNotThrow(() => assertProjectFilePathInsideRoot(root, file));
		assert.equal(await assertProjectFileReadPath(root, file), await realpath(file));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("project file access rejects lexical traversal and prefix collisions", () => {
	const root = join(tmpdir(), "pideck-project");
	assert.throws(
		() => assertProjectFilePathInsideRoot(root, join(root, "..", "secret.txt")),
		new RegExp(FILE_OUTSIDE_PROJECT_ERROR),
	);
	assert.throws(
		() => assertProjectFilePathInsideRoot(root, join(`${root}-other`, "secret.txt")),
		new RegExp(FILE_OUTSIDE_PROJECT_ERROR),
	);
});

test("project file access rejects a symlink that resolves outside the project", async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-project-file-symlink-"));
	const root = join(fixture, "project");
	const outsideDir = join(fixture, "outside");
	const outsideFile = join(outsideDir, "secret.txt");
	const link = join(root, "linked");
	const linkedFile = join(link, "secret.txt");
	mkdirSync(root, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });
	writeFileSync(outsideFile, "secret\n");
	try {
		try {
			// Windows junction 不要求 Developer Mode；其它平台按目录 symlink 创建。
			symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit symlink creation");
				return;
			}
			throw error;
		}
		await assert.rejects(
			() => assertProjectFileReadPath(root, linkedFile),
			new RegExp(FILE_OUTSIDE_PROJECT_ERROR),
		);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
