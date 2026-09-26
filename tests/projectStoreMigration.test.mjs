import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function createStore(userData) {
	const { ProjectStore } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: { electron: { app: { getPath: () => userData }, dialog: {} } },
	});
	return new ProjectStore();
}

function project(id, name, path) {
	return { id, name, path, lastOpenedAt: 1, environment: "windows" };
}

async function withUserData(run) {
	const userData = await mkdtemp(join(tmpdir(), "pideck-project-migration-"));
	try {
		await run(userData, join(userData, "projects.json"));
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
}

test("ProjectStore upgrades a v1 array and keeps local legacy output for current callers", async () => {
	await withUserData(async (userData, filePath) => {
		await writeFile(filePath, JSON.stringify([project("legacy-1", "legacy", "C:\\work\\legacy")]), "utf8");
		const store = createStore(userData);
		await store.load();
		assert.equal(store.get("legacy-1")?.path, "C:\\work\\legacy");
		assert.equal(store.get("legacy-1")?.environment, "windows");
		const saved = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(saved.schemaVersion, 2);
		assert.equal(saved.projects.find((item) => item.id === "legacy-1").locator.localPath, "C:\\work\\legacy");
	});
});

test("ProjectStore recovery selects the highest revision and preserves its backup", async () => {
	await withUserData(async (userData, filePath) => {
		const { encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");
		const chatPath = join(userData, "chat-workspace");
		const projects = [{ id: "builtin-chat", name: "Chat", path: chatPath, lastOpenedAt: 1, pinned: true, sortOrder: -1, kind: "chat" }, project("p1", "saved", "C:\\work\\saved")];
		await writeFile(filePath, JSON.stringify(encodeProjectStoreSnapshot(projects, 2)), "utf8");
		await writeFile(`${filePath}.bak`, JSON.stringify(encodeProjectStoreSnapshot([projects[0], project("p1", "recovered", "C:\\work\\recovered")], 3)), "utf8");

		const store = createStore(userData);
		await store.load();
		assert.equal(store.get("p1")?.name, "recovered");
		assert.equal(JSON.parse(await readFile(filePath, "utf8")).revision, 4);
		assert.equal(JSON.parse(await readFile(`${filePath}.bak`, "utf8")).revision, 3);
	});
});

test("ProjectStore refuses writes when both snapshots are invalid", async () => {
	await withUserData(async (userData, filePath) => {
		await writeFile(filePath, "{truncated-primary", "utf8");
		await writeFile(`${filePath}.bak`, "{truncated-backup", "utf8");
		const store = createStore(userData);
		await assert.rejects(store.load(), (error) => error.code === "PROJECT_STORE_NEEDS_REPAIR");
		await assert.rejects(store.add("C:\\work\\new"), /PROJECT_STORE_NEEDS_REPAIR/);
		assert.equal(await readFile(filePath, "utf8"), "{truncated-primary");
		assert.equal(await readFile(`${filePath}.bak`, "utf8"), "{truncated-backup");
		assert.throws(
			() => store.list(),
			(error) => error.code === "PROJECT_STORE_NEEDS_REPAIR",
		);
	});
});

test("concurrent ProjectStore additions are written with increasing revisions", async () => {
	await withUserData(async (userData, filePath) => {
		const store = createStore(userData);
		await store.load();
		await Promise.all([store.add("C:\\work\\one"), store.add("C:\\work\\two")]);
		const saved = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(saved.schemaVersion, 2);
		assert.ok(saved.revision >= 3);
		assert.deepEqual(saved.projects.map((item) => item.locator.localPath).sort(), ["C:\\work\\one", "C:\\work\\two", join(userData, "chat-workspace")].sort());
	});
});
