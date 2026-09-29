import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 跨 VM realm 的对象比较前先归一化：deepStrictEqual 会比较原型。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

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
		const one = join(userData, "one");
		const two = join(userData, "two");
		await Promise.all([store.add(one), store.add(two)]);
		const saved = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(saved.schemaVersion, 2);
		assert.ok(saved.revision >= 3);
		assert.deepEqual(saved.projects.map((item) => item.locator.localPath).sort(), [one, two, join(userData, "chat-workspace")].sort());
	});
});

// ---------------------------------------------------------------------------
// Phase 3 第二段：远端（ssh）项目的持久化、去重与重启恢复
// ---------------------------------------------------------------------------

const HOST_A = "11111111-1111-4111-8111-111111111111";
const HOST_B = "22222222-2222-4222-8222-222222222222";

test("addRemote stores an ssh project without a local path and survives a restart", async () => {
	await withUserData(async (userData, filePath) => {
		const store = createStore(userData);
		await store.load();
		const project = await store.addRemote({ hostId: HOST_A, canonicalRemotePath: "/srv/app" });
		assert.equal(project.path, undefined, "远端项目没有本机 path");
		assert.deepEqual(plain(project.locator), { kind: "ssh", hostId: HOST_A, remotePath: "/srv/app" });
		assert.equal(project.name, "app");

		const saved = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(saved.projects.find((item) => item.id === project.id).path, undefined, "落盘不含 path");
		assert.deepEqual(saved.projects.find((item) => item.id === project.id).locator, { kind: "ssh", hostId: HOST_A, remotePath: "/srv/app" });

		// 重启：重新 load，远端记录原样回来，id 稳定
		const reopened = createStore(userData);
		await reopened.load();
		const restored = reopened.get(project.id);
		assert.ok(restored, "重启后远端项目仍在列表");
		assert.deepEqual(plain(restored.locator), { kind: "ssh", hostId: HOST_A, remotePath: "/srv/app" });
		assert.equal(restored.path, undefined);
	});
});

test("addRemote dedupes on hostId + remotePath and keeps the id stable", async () => {
	await withUserData(async (userData) => {
		const store = createStore(userData);
		await store.load();
		const first = await store.addRemote({ hostId: HOST_A, canonicalRemotePath: "/srv/app" });
		const again = await store.addRemote({ hostId: HOST_A, canonicalRemotePath: "/srv/app" });
		assert.equal(again.id, first.id, "同主机同路径 → 同一项目");

		// 同路径不同主机是两个不同项目（不能只用 path 去重）
		const otherHost = await store.addRemote({ hostId: HOST_B, canonicalRemotePath: "/srv/app" });
		assert.notEqual(otherHost.id, first.id);

		// 同主机不同路径也是两个不同项目
		const otherPath = await store.addRemote({ hostId: HOST_A, canonicalRemotePath: "/srv/other" });
		assert.notEqual(otherPath.id, first.id);

		assert.equal(store.list().filter((project) => project.locator?.kind === "ssh").length, 3);
	});
});

test("addRemote rejects a malformed target before writing anything", async () => {
	await withUserData(async (userData) => {
		const store = createStore(userData);
		await store.load();
		await assert.rejects(store.addRemote({ hostId: "", canonicalRemotePath: "/srv/app" }), /REMOTE_PROJECT_TARGET_INVALID/);
		await assert.rejects(store.addRemote({ hostId: HOST_A, canonicalRemotePath: "" }), /REMOTE_PROJECT_TARGET_INVALID/);
		await assert.rejects(store.addRemote(undefined), /REMOTE_PROJECT_TARGET_INVALID/);
		assert.equal(store.list().filter((project) => project.locator?.kind === "ssh").length, 0);
	});
});

test("a project store whose primary holds an ssh locator but is otherwise corrupt fails closed", async () => {
	await withUserData(async (userData, filePath) => {
		await writeFile(filePath, JSON.stringify({ schemaVersion: 2, revision: 4, projects: [{ id: "p-1", name: "app", lastOpenedAt: 1, locator: { kind: "ssh", hostId: HOST_A, remotePath: "relative" } }] }), "utf8");
		const store = createStore(userData);
		await assert.rejects(store.load(), (error) => error.code === "PROJECT_STORE_NEEDS_REPAIR");
		assert.throws(
			() => store.list(),
			(error) => error.code === "PROJECT_STORE_NEEDS_REPAIR",
		);
	});
});
