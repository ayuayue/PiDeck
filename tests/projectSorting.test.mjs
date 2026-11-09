import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeProjectSortMode } = loadTsCommonJs("src/shared/projectSort.ts");
const { sortSidebarProjects } = loadTsCommonJs("src/renderer/src/projectSortModes.ts");
const { decodeProjectStoreSnapshot, encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");
const hostId = "11111111-1111-4111-8111-111111111111";
const project = (id, fields = {}) => ({ id, name: id, path: `C:/${id}`, lastOpenedAt: 1, ...fields });
const ids = (projects) => [...projects.map((entry) => entry.id)];

test("project sorting defaults to manual and accepts only the supported modes", () => {
	for (const value of [undefined, null, "unknown", {}, "manual"]) assert.equal(normalizeProjectSortMode(value), "manual");
	for (const value of ["updatedAt", "createdAt", "title"]) assert.equal(normalizeProjectSortMode(value), value);
});

test("manual order and pinned order survive automatic sorting and switching back", () => {
	const projects = [project("chat", { kind: "chat" }), project("pin-z", { pinned: true }), project("pin-a", { pinned: true }), project("z"), project("a")];
	assert.deepEqual(ids(sortSidebarProjects(projects, {}, "title")), ["chat", "pin-z", "pin-a", "a", "z"]);
	assert.deepEqual(ids(sortSidebarProjects(projects, {}, "manual")), ids(projects));
	assert.deepEqual(ids(projects), ["chat", "pin-z", "pin-a", "z", "a"]);
});

test("recent activity includes sessions, live turn anchors, worktrees, and empty projects", () => {
	const projects = [project("a"), project("b"), project("c"), project("empty", { lastOpenedAt: 40 }), project("child", { worktreeParentId: "b" })];
	const sessions = { a: [{ id: "sa", updatedAt: 10 }], child: [{ id: "sb", updatedAt: 30 }], c: [{ id: "sc", updatedAt: 20 }] };
	assert.deepEqual(ids(sortSidebarProjects(projects, sessions, "updatedAt", { sa: 50 })), ["a", "empty", "b", "c"]);
	assert.deepEqual(ids(sortSidebarProjects(projects, sessions, "updatedAt", { sa: 5 })), ["empty", "b", "c", "a"]);
});

test("collapsed project activity uses disk cache until a current catalog is available", () => {
	const projects = [project("a"), project("b"), project("child", { worktreeParentId: "b" })];
	assert.deepEqual(ids(sortSidebarProjects(projects, {}, "updatedAt", {}, { a: 10, child: 30 })), ["b", "a"]);
	assert.deepEqual(ids(sortSidebarProjects(projects, { child: [] }, "updatedAt", {}, { a: 10, child: 30 })), ["a", "b"]);
});

test("creation order uses recorded dates and leaves legacy projects stable at the end", () => {
	const projects = [project("legacy-z", { lastOpenedAt: 999 }), project("old", { createdAt: 10 }), project("legacy-a"), project("new", { createdAt: 20 })];
	assert.deepEqual(ids(sortSidebarProjects(projects, {}, "createdAt")), ["new", "old", "legacy-z", "legacy-a"]);
});

test("title order uses numeric, case-insensitive comparison and stable ties", () => {
	const projects = [project("a10", { name: "Alpha 10" }), project("a2", { name: "alpha 2" }), project("same", { name: "ALPHA 2" }), project("b", { name: "Beta" })];
	assert.deepEqual(ids(sortSidebarProjects(projects, {}, "title")), ["a2", "same", "a10", "b"]);
});

test("project creation metadata round-trips for local and SSH projects and rejects invalid dates", () => {
	const projects = [project("local", { createdAt: 123 }), { id: "remote", name: "remote", lastOpenedAt: 5, createdAt: 456, locator: { kind: "ssh", hostId, remotePath: "/repo" } }];
	const decoded = decodeProjectStoreSnapshot(encodeProjectStoreSnapshot(projects, 1));
	assert.deepEqual([...decoded.projects.map((entry) => entry.createdAt)], [123, 456]);
	assert.equal(decodeProjectStoreSnapshot([project("legacy")]).projects[0].createdAt, undefined);
	for (const createdAt of ["123", null, NaN, Infinity]) assert.throws(() => decodeProjectStoreSnapshot([project("bad", { createdAt })]), /PROJECT_STORE_INVALID_PROJECT/);
});

test("new projects keep their creation date when reopened and after store reload", async () => {
	const userData = await mkdtemp(join(tmpdir(), "pideck-project-sort-"));
	let now = 100;
	class Clock extends Date {
		static now() {
			return now;
		}
	}
	const loadStore = () => loadTsCommonJs("src/main/projects/ProjectStore.ts", { stubs: { electron: { app: { getPath: () => userData }, dialog: {} } }, globals: { Date: Clock } });
	try {
		const localPath = join(userData, "repo");
		await mkdir(localPath);
		const { ProjectStore } = loadStore();
		const store = new ProjectStore();
		await store.load();
		const local = await store.addWithLocation(localPath);
		const remote = await store.addRemote({ hostId, canonicalRemotePath: "/repo" });
		assert.equal(local.createdAt, 100);
		assert.equal(remote.createdAt, 100);
		now = 200;
		assert.equal((await store.addWithLocation(localPath)).createdAt, 100);
		assert.equal((await store.addRemote({ hostId, canonicalRemotePath: "/repo" })).createdAt, 100);
		const reloaded = new ProjectStore();
		await reloaded.load();
		for (const entry of reloaded.list().filter((entry) => entry.id === local.id || entry.id === remote.id)) {
			assert.equal(entry.createdAt, 100);
			assert.equal(entry.lastOpenedAt, 200);
		}
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
});
