import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadProjectStore, writeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStorePersistence.ts");
const { encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");

function project(name) {
	return { id: `project-${name}`, name, path: `C:\\work\\${name}`, lastOpenedAt: 1, environment: "windows" };
}

async function withDirectory(run) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-project-store-"));
	try {
		await run(directory, join(directory, "projects.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("missing ProjectStore files create a clean first-run snapshot", async () => {
	await withDirectory(async (_directory, filePath) => {
		assert.deepEqual(JSON.parse(JSON.stringify(await loadProjectStore(filePath))), {
			projects: [],
			revision: 0,
			needsRewrite: false,
			skipNextBackup: false,
		});
	});
});

test("legacy v1 arrays are readable and explicitly require a v2 rewrite", async () => {
	await withDirectory(async (_directory, filePath) => {
		await writeFile(filePath, JSON.stringify([project("legacy")]), "utf8");
		const loaded = await loadProjectStore(filePath);
		assert.equal(loaded.revision, 0);
		assert.equal(loaded.needsRewrite, true);
		assert.equal(loaded.projects[0].environment, "windows");
	});
});

test("the highest valid revision wins and its backup is preserved during repair", async () => {
	await withDirectory(async (_directory, filePath) => {
		await writeFile(filePath, JSON.stringify(encodeProjectStoreSnapshot([project("primary")], 2)), "utf8");
		await writeFile(`${filePath}.bak`, JSON.stringify(encodeProjectStoreSnapshot([project("backup")], 3)), "utf8");
		const loaded = await loadProjectStore(filePath);
		assert.equal(loaded.revision, 3);
		assert.equal(loaded.projects[0].name, "backup");
		assert.equal(loaded.needsRewrite, true);
		assert.equal(loaded.skipNextBackup, true);

		await writeProjectStoreSnapshot(filePath, loaded.projects, loaded.revision + 1, { skipBackup: loaded.skipNextBackup });
		assert.equal(JSON.parse(await readFile(filePath, "utf8")).revision, 4);
		assert.equal(JSON.parse(await readFile(`${filePath}.bak`, "utf8")).revision, 3);
	});
});

test("a corrupt primary recovers from backup, but two invalid copies fail closed", async () => {
	await withDirectory(async (_directory, filePath) => {
		await writeFile(filePath, "{truncated", "utf8");
		await writeFile(`${filePath}.bak`, JSON.stringify(encodeProjectStoreSnapshot([project("recovered")], 5)), "utf8");
		const recovered = await loadProjectStore(filePath);
		assert.equal(recovered.projects[0].name, "recovered");
		assert.equal(recovered.skipNextBackup, true);
	});

	await withDirectory(async (_directory, filePath) => {
		await writeFile(filePath, "{truncated", "utf8");
		await writeFile(`${filePath}.bak`, "[] invalid", "utf8");
		await assert.rejects(loadProjectStore(filePath), (error) => error.code === "PROJECT_STORE_NEEDS_REPAIR");
	});
});

test("ProjectStore writer rotates revisions and persists locator-only v2 entries", async () => {
	await withDirectory(async (_directory, filePath) => {
		await writeProjectStoreSnapshot(filePath, [project("one")], 1);
		await writeProjectStoreSnapshot(filePath, [project("two")], 2);
		const primary = JSON.parse(await readFile(filePath, "utf8"));
		const backup = JSON.parse(await readFile(`${filePath}.bak`, "utf8"));
		assert.equal(primary.schemaVersion, 2);
		assert.equal(primary.revision, 2);
		assert.equal(primary.projects[0].locator.localPath, "C:\\work\\two");
		assert.equal(Object.hasOwn(primary.projects[0], "path"), false);
		assert.equal(Object.hasOwn(primary.projects[0], "environment"), false);
		assert.equal(backup.revision, 1);
	});
});
