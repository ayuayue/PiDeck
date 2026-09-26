import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

function createFilesIpc(root) {
	const listHandlers = new Map();
	const listCalls = [];
	const mutationCalls = [];
	const openedPaths = [];
	const electron = {
		app: {},
		dialog: {},
		ipcMain: { handle: (channel, handler) => listHandlers.set(channel, handler) },
		shell: {
			openPath: async (path) => {
				openedPaths.push(path);
				return "";
			},
			showItemInFolder: () => undefined,
		},
	};
	const { registerFilesIpc } = loadTsCommonJs("src/main/ipc/filesIpc.ts", { stubs: { electron } });
	registerFilesIpc({
		fileSystemService: {
			listTree: async (projectRoot, maxDepth, directory) => {
				listCalls.push({ projectRoot, maxDepth, directory });
				return [
					{
						name: "src",
						path: join(projectRoot, "src"),
						relativePath: "src",
						type: "directory",
						children: [{ name: "main.ts", path: join(projectRoot, "src", "main.ts"), relativePath: "src/main.ts", type: "file" }],
					},
				];
			},
			searchNames: async () => [{ name: "main.ts", path: join(root, "src", "main.ts"), relativePath: "src/main.ts", type: "file" }],
			create: async (parentDir, name, type) => {
				mutationCalls.push({ operation: "create", parentDir, name, type });
				return join(parentDir, name);
			},
			delete: async (path, recursive) => mutationCalls.push({ operation: "delete", path, recursive }),
			rename: async (path, newName) => {
				mutationCalls.push({ operation: "rename", path, newName });
				return join(path, "..", newName);
			},
		},
		projectStore: { get: (id) => (id === "project-1" ? { id, path: root } : undefined) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: async () => undefined, error: async () => undefined },
		getMainWindow: () => null,
		openExternalUrl: async () => undefined,
	});
	return {
		listHandler: listHandlers.get(ipcChannels.filesList),
		searchHandler: listHandlers.get(ipcChannels.filesSearch),
		readContentHandler: listHandlers.get(ipcChannels.filesReadContent),
		writeContentHandler: listHandlers.get(ipcChannels.filesWriteContent),
		pathsExistHandler: listHandlers.get(ipcChannels.filesPathsExist),
		statHandler: listHandlers.get(ipcChannels.filesStat),
		openHandler: listHandlers.get(ipcChannels.filesOpen),
		createHandler: listHandlers.get(ipcChannels.filesCreate),
		deleteHandler: listHandlers.get(ipcChannels.filesDelete),
		renameHandler: listHandlers.get(ipcChannels.filesRename),
		copyHandler: listHandlers.get(ipcChannels.filesCopy),
		moveHandler: listHandlers.get(ipcChannels.filesMove),
		openedPaths,
		listCalls,
		mutationCalls,
	};
}

test("project file backend router selects local and rejects remote locators", () => {
	const { ProjectFileBackendRouter } = loadTsCommonJs("src/main/files/ProjectFileBackend.ts");
	const localBackend = { marker: "local" };
	const router = new ProjectFileBackendRouter(localBackend, (projectId) => {
		if (projectId === "local") return { kind: "local", environment: "native", localPath: "C:/project" };
		if (projectId === "remote") return { kind: "ssh", hostId: "host-1", remotePath: "/srv/project" };
		return undefined;
	});
	assert.equal(router.forProject("local"), localBackend);
	assert.throws(() => router.forProject("remote"), /UNSUPPORTED_PROJECT_LOCATION/);
	assert.throws(() => router.forProject("missing"), /PROJECT_NOT_FOUND/);
});

test("files:list resolves a ProjectFileTarget locally and returns nested targets", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-target-"));
	const root = join(fixture, "project");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "main.ts"), "export {};\n");
	try {
		const { listHandler, listCalls } = createFilesIpc(root);
		const nodes = await listHandler({}, { projectId: "project-1", relativePath: "src" }, { maxDepth: 0 });
		assert.equal(listCalls[0].projectRoot, root);
		assert.equal(listCalls[0].directory, await realpath(join(root, "src")));
		assert.equal(nodes[0].target.projectId, "project-1");
		assert.equal(nodes[0].target.relativePath, "src");
		assert.equal(nodes[0].children[0].target.projectId, "project-1");
		assert.equal(nodes[0].children[0].target.relativePath, "src/main.ts");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:list rejects invalid depth and unknown options at the IPC boundary", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-list-options-"));
	try {
		const { listHandler, listCalls } = createFilesIpc(join(fixture, "project"));
		await assert.rejects(listHandler({}, { projectId: "project-1", relativePath: "" }, { maxDepth: 13 }), /INVALID_FILE_LIST_OPTIONS/);
		await assert.rejects(listHandler({}, { projectId: "project-1", relativePath: "" }, { maxDepth: 1.5 }), /INVALID_FILE_LIST_OPTIONS/);
		await assert.rejects(listHandler({}, { projectId: "project-1", relativePath: "" }, { unexpected: true }), /INVALID_FILE_LIST_OPTIONS/);
		assert.equal(listCalls.length, 0);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:list maps a missing target project root to a stable error", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-target-missing-"));
	try {
		const { listHandler } = createFilesIpc(join(fixture, "missing-project"));
		await assert.rejects(listHandler({}, { projectId: "project-1", relativePath: "" }), /PROJECT_DIRECTORY_MISSING/);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:list rejects target traversal before local filesystem access", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-target-escape-"));
	try {
		const { listHandler, listCalls } = createFilesIpc(join(fixture, "project"));
		await assert.rejects(listHandler({}, { projectId: "project-1", relativePath: "../outside" }), /INVALID_PROJECT_FILE_TARGET/);
		assert.equal(listCalls.length, 0);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:read, write, stat, open, and pathsExist resolve a project target locally", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-target-access-"));
	const root = join(fixture, "project");
	const filePath = join(root, "src", "main.ts");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(filePath, "before");
	try {
		const api = createFilesIpc(root);
		const target = { projectId: "project-1", relativePath: "src/main.ts" };
		assert.equal(await api.readContentHandler({}, target, 1024), "before");
		await api.writeContentHandler({}, target, "after");
		assert.equal(readFileSync(filePath, "utf8"), "after");
		const existence = await api.pathsExistHandler({}, [target]);
		assert.equal(existence[0], true);
		const stat = await api.statHandler({}, target);
		assert.equal(stat.exists, true);
		assert.equal(stat.isDirectory, false);
		const missing = await api.statHandler({}, { projectId: "project-1", relativePath: "src/missing.ts" });
		assert.equal(missing.exists, false);
		assert.equal(missing.isDirectory, false);
		await api.openHandler({}, target);
		assert.equal(api.openedPaths[0], await realpath(filePath));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("file mutation handlers resolve project targets beneath the registered root", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-target-mutate-"));
	const root = join(fixture, "project");
	const srcDir = join(root, "src");
	const filePath = join(srcDir, "main.ts");
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(filePath, "source");
	try {
		const api = createFilesIpc(root);
		const directoryTarget = { projectId: "project-1", relativePath: "src" };
		const fileTarget = { projectId: "project-1", relativePath: "src/main.ts" };
		const created = await api.createHandler({}, directoryTarget, "new.ts", "file");
		await api.deleteHandler({}, fileTarget, true);
		const renamed = await api.renameHandler({}, fileTarget, "renamed.ts");
		assert.equal(created.projectId, "project-1");
		assert.equal(created.relativePath, "src/new.ts");
		assert.equal("path" in created, false);
		assert.equal(renamed.projectId, "project-1");
		assert.equal(renamed.relativePath, "src/renamed.ts");
		assert.equal(api.mutationCalls[0].operation, "create");
		assert.equal(api.mutationCalls[0].parentDir, await realpath(srcDir));
		assert.equal(api.mutationCalls[1].operation, "delete");
		assert.equal(api.mutationCalls[1].path, await realpath(filePath));
		assert.equal(api.mutationCalls[1].recursive, true);
		assert.equal(api.mutationCalls[2].operation, "rename");
		assert.equal(api.mutationCalls[2].path, await realpath(filePath));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:copy and move resolve target sources and destination", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-target-copy-move-"));
	const root = join(fixture, "project");
	const srcDir = join(root, "src");
	const dstDir = join(root, "dst");
	mkdirSync(srcDir, { recursive: true });
	mkdirSync(dstDir, { recursive: true });
	writeFileSync(join(srcDir, "copy.txt"), "copy me");
	writeFileSync(join(srcDir, "move.txt"), "move me");
	try {
		const api = createFilesIpc(root);
		const copied = await api.copyHandler({}, [{ projectId: "project-1", relativePath: "src/copy.txt" }], { projectId: "project-1", relativePath: "dst" });
		assert.equal(copied[0].projectId, "project-1");
		assert.equal(copied[0].relativePath, "dst/copy.txt");
		assert.equal(readFileSync(join(dstDir, "copy.txt"), "utf8"), "copy me");
		const moved = await api.moveHandler({}, [{ projectId: "project-1", relativePath: "src/move.txt" }], { projectId: "project-1", relativePath: "dst" });
		assert.equal(moved[0].projectId, "project-1");
		assert.equal(moved[0].relativePath, "dst/move.txt");
		assert.equal(readFileSync(join(dstDir, "move.txt"), "utf8"), "move me");
		assert.equal(existsSync(join(srcDir, "move.txt")), false);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:copy and move keep local clipboard paths compatible with target directories", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-local-clipboard-"));
	const root = join(fixture, "project");
	const srcDir = join(root, "src");
	const dstDir = join(root, "dst");
	mkdirSync(srcDir, { recursive: true });
	mkdirSync(dstDir, { recursive: true });
	const copyPath = join(srcDir, "copy.txt");
	const movePath = join(srcDir, "move.txt");
	writeFileSync(copyPath, "copy me");
	writeFileSync(movePath, "move me");
	try {
		const api = createFilesIpc(root);
		const destination = { projectId: "project-1", relativePath: "dst" };
		const copied = await api.copyHandler({}, [copyPath], destination);
		assert.equal(copied[0], join(await realpath(dstDir), "copy.txt"));
		const moved = await api.moveHandler({}, [movePath], destination);
		assert.equal(moved[0], join(await realpath(dstDir), "move.txt"));
		assert.equal(existsSync(movePath), false);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:search attaches project-relative targets", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-search-target-"));
	const root = join(fixture, "project");
	mkdirSync(root);
	try {
		const { searchHandler } = createFilesIpc(root);
		const results = await searchHandler({}, "project-1", "main");
		assert.equal(results[0].target.projectId, "project-1");
		assert.equal(results[0].target.relativePath, "src/main.ts");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:list preserves the existing local absolute-directory adapter", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-target-legacy-"));
	const root = join(fixture, "project");
	const directory = join(root, "src");
	mkdirSync(directory, { recursive: true });
	try {
		const { listHandler, listCalls } = createFilesIpc(root);
		const nodes = await listHandler({}, "project-1", { maxDepth: 0, directory });
		assert.equal(listCalls[0].directory, await realpath(directory));
		assert.equal(nodes[0].target.projectId, "project-1");
		assert.equal(nodes[0].target.relativePath, "src");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
