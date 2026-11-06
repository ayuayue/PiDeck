import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

function projectFixture(root, overrides = {}) {
	return { id: "project-1", name: "Project", path: root, lastOpenedAt: 0, ...overrides };
}

function createFilesIpc(root, projectOverride, remoteFiles) {
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
		projectStore: { get: (id) => (id === "project-1" ? (projectOverride ?? projectFixture(root)) : undefined) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		appLogger: { info: async () => undefined, error: async () => undefined },
		getMainWindow: () => null,
		openExternalUrl: async () => undefined,
		remoteFiles,
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

test("an unsupported project locator cannot reach local target read, list, or write", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-remote-target-"));
	try {
		const root = join(fixture, "local-project");
		mkdirSync(root);
		writeFileSync(join(root, "canary.txt"), "local content");
		const project = projectFixture(root, { locator: { kind: "ssh", hostId: "host-1", remotePath: "/srv/project" } });
		const api = createFilesIpc(root, project);
		const target = { projectId: project.id, relativePath: "canary.txt" };
		await assert.rejects(api.listHandler({}, target), /UNSUPPORTED_PROJECT_LOCATION/);
		await assert.rejects(api.readContentHandler({}, target), /UNSUPPORTED_PROJECT_LOCATION/);
		await assert.rejects(api.pathsExistHandler({}, [target]), /UNSUPPORTED_PROJECT_LOCATION/);
		await assert.rejects(api.writeContentHandler({}, target, "overwritten"), /UNSUPPORTED_PROJECT_LOCATION/);
		assert.equal(readFileSync(join(root, "canary.txt"), "utf8"), "local content");
		assert.deepEqual(api.listCalls, []);
		assert.deepEqual(api.mutationCalls, []);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("an unsupported project locator cannot authorize a scoped local absolute path", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-remote-scope-"));
	try {
		const root = join(fixture, "local-project");
		mkdirSync(root);
		const filePath = join(root, "canary.txt");
		writeFileSync(filePath, "local content");
		const project = projectFixture(root, { locator: { kind: "ssh", hostId: "host-1", remotePath: "/srv/project" } });
		const api = createFilesIpc(root, project);
		const scope = { projectId: project.id };
		await assert.rejects(api.readContentHandler({}, filePath, undefined, scope), /UNSUPPORTED_PROJECT_LOCATION/);
		await assert.rejects(api.statHandler({}, filePath, scope), /UNSUPPORTED_PROJECT_LOCATION/);
		await assert.rejects(api.openHandler({}, filePath, scope), /UNSUPPORTED_PROJECT_LOCATION/);
		await assert.rejects(api.pathsExistHandler({}, [filePath], scope), /UNSUPPORTED_PROJECT_LOCATION/);
		assert.deepEqual(api.openedPaths, []);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("legacy WSL projects remain on the local file backend", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-wsl-legacy-"));
	try {
		const root = join(fixture, "project");
		mkdirSync(root);
		const project = projectFixture(root, { environment: "wsl" });
		const api = createFilesIpc(root, project);
		await api.listHandler({}, { projectId: project.id, relativePath: "" });
		assert.equal(api.listCalls[0].projectRoot, root);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

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
		assert.equal(stat.availability, "present");
		assert.equal(stat.exists, true);
		assert.equal(stat.isDirectory, false);
		const missing = await api.statHandler({}, { projectId: "project-1", relativePath: "src/missing.ts" });
		assert.equal(missing.availability, "missing");
		assert.equal(missing.exists, false);
		assert.equal(missing.isDirectory, false);
		assert.equal(missing.code, "ENOENT");
		await api.openHandler({}, target);
		assert.equal(api.openedPaths[0], await realpath(filePath));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("files:stat remote results distinguish present, missing, and unavailable", async () => {
	const project = projectFixture("/unused", { locator: { kind: "ssh", hostId: "host-1", remotePath: "/srv/project" } });
	let answer = { ok: true, value: [{ exists: true, isDirectory: true }] };
	const api = createFilesIpc("/unused", project, {
		async pathsExist() {
			return answer;
		},
	});
	const target = { projectId: project.id, relativePath: "src" };
	const present = await api.statHandler({}, target);
	assert.equal(present.availability, "present");
	assert.equal(present.exists, true);
	assert.equal(present.isDirectory, true);

	answer = { ok: true, value: [{ exists: false, isDirectory: false }] };
	const missing = await api.statHandler({}, target);
	assert.equal(missing.availability, "missing");
	assert.equal(missing.exists, false);
	assert.equal(missing.isDirectory, false);
	assert.equal(missing.code, "PATH_NOT_FOUND");

	answer = { ok: false, code: "SFTP_PERMISSION_DENIED", outcome: "rejected" };
	const unavailable = await api.statHandler({}, target);
	assert.equal(unavailable.availability, "unavailable");
	assert.equal(unavailable.exists, false);
	assert.equal(unavailable.isDirectory, false);
	assert.equal(unavailable.code, "SFTP_PERMISSION_DENIED");

	const noRemote = createFilesIpc("/unused", project);
	const absent = await noRemote.statHandler({}, target);
	assert.equal(absent.availability, "unavailable");
	assert.equal(absent.code, "REMOTE_FILES_UNAVAILABLE");
});

test("文件读写双入口：拒绝非文本且原字节不变，普通打开不改文件", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-files-text-guard-"));
	const filePath = join(root, "App.vue");
	try {
		const api = createFilesIpc(root);
		const target = { projectId: "project-1", relativePath: "App.vue" };
		const scope = { projectId: "project-1" };
		for (const input of [target, filePath]) {
			const access = typeof input === "string" ? scope : undefined;
			const original = Buffer.alloc(128, 0xaa);
			writeFileSync(filePath, original);
			await assert.rejects(api.readContentHandler({}, input, 1024, access), /FILE_NOT_TEXT:128/);
			await assert.rejects(api.writeContentHandler({}, input, "replacement", access), /FILE_WRITE_BLOCKED_ENCRYPTED:128/);
			assert.deepEqual(readFileSync(filePath), original);
			const source = "<template>ok</template>\r\n";
			writeFileSync(filePath, source);
			assert.equal(await api.readContentHandler({}, input, 1024, access), source);
			assert.equal(readFileSync(filePath, "utf8"), source);
			await api.writeContentHandler({}, input, "edited\r\n", access);
			assert.equal(readFileSync(filePath, "utf8"), "edited\r\n");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
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

test("远端项目的正文读/写走远端文本端口，而不是「不支持」", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-remote-text-"));
	const root = join(fixture, "remote-project");
	mkdirSync(root);
	const calls = [];
	const remoteFiles = {
		openText: async (senderId, projectId, path) => {
			calls.push({ kind: "open", senderId, projectId, path });
			return { content: "remote body", version: "0123456789abcdef0123456789abcdef" };
		},
		saveText: async (senderId, projectId, path, content, version) => {
			calls.push({ kind: "save", senderId, projectId, path, content, version });
		},
	};
	const remote = projectFixture(root, { locator: { kind: "ssh", hostId: "host-1", remotePath: "/home/u/project" } });
	const { readContentHandler, writeContentHandler } = createFilesIpc(root, remote, remoteFiles);
	const target = { projectId: "project-1", relativePath: "src/main.ts" };
	try {
		assert.equal(await readContentHandler({ sender: { id: 7 } }, target), "remote body");
		// 不带版本：先读一次拿到远端令牌，再按该令牌写——绝不无版本硬写。
		await writeContentHandler({ sender: { id: 7 } }, target, "next");
		assert.deepEqual(
			calls.map((call) => call.kind),
			["open", "open", "save"],
		);
		assert.equal(calls[2].version, "0123456789abcdef0123456789abcdef");
		// 带版本：直接写，不再多读一次。
		calls.length = 0;
		await writeContentHandler({ sender: { id: 7 } }, target, "again", undefined, "fedcba9876543210fedcba9876543210");
		assert.deepEqual(calls.map((call) => call.kind), ["save"]);
		assert.equal(calls[0].version, "fedcba9876543210fedcba9876543210");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("写入带修订指纹：盘上已被改过就拒绝，绝不静默覆盖外部修改", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-files-revision-"));
	const root = join(fixture, "local-project");
	mkdirSync(root);
	const file = join(root, "canary.txt");
	writeFileSync(file, "first");
	const { writeContentHandler } = createFilesIpc(root);
	const target = { projectId: "project-1", relativePath: "canary.txt" };
	const revisionOfFirst = "sha256:" + createHash("sha256").update("first").digest("hex");
	try {
		await writeContentHandler({}, target, "second", undefined, revisionOfFirst);
		assert.equal(readFileSync(file, "utf8"), "second", "指纹对得上就正常写");
		// 外部（另一个编辑器 / git checkout / agent）改了文件，编辑器的旧指纹必须被拒绝。
		writeFileSync(file, "third");
		await assert.rejects(() => writeContentHandler({}, target, "overwritten", undefined, revisionOfFirst), /PROJECT_FILE_CHANGED/);
		assert.equal(readFileSync(file, "utf8"), "third", "拒绝时磁盘一个字节都不能变");
		// 不传指纹保持旧行为（显式覆盖），不把可选参数变成强制。
		await writeContentHandler({}, target, "allowed", undefined, undefined);
		assert.equal(readFileSync(file, "utf8"), "allowed");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
