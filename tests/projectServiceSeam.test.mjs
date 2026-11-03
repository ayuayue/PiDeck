/**
 * 工作区面板服务缝（S 检查点）的行为测试。
 *
 * 断言的是 provider 的真实路由、收据、错误与代数边界，不是源码形状：
 * - 读面位置无关；目录页的 truncated/revision/generation/未知 children 原样返回；
 * - 文件写返回既有收据（文本 version、删除 trashId、改名后的 target）；
 * - 文本保存只接受 readText 的 version；缺失/空串零调用拒绝，绝不取 entry 令牌或重新 open；
 * - 远端 Git 写/强刷/同步/恢复走 main 的令牌经纪（provider 自持授权）；worktree 三个入口与 deleteFiles 仍显式 unsupported；
 * - 项目身份与连接代数在触达 IPC 前围栏。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createProjectServices, PROJECT_SERVICE_CODES, ProjectServiceError } = loadTsCommonJs("src/renderer/src/services/projectServices.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const OID = "a".repeat(40);

const localProject = { id: "p1", name: "p1", lastOpenedAt: 0, path: "C:/p1", environment: "windows" };
const remoteProject = { id: "p2", name: "p2", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p2" } };
const FULL_HELPER = [
	"fs.watch",
	"fs.searchNames",
	"fs.searchContent",
	"fs.uploadPrepare",
	"fs.uploadCommit",
	"fs.uploadAbort",
	"git.status",
	"git.workspaceDiff",
	"git.log",
	"git.repos",
	"git.refs",
	"git.compare",
	"git.stage",
	"git.unstage",
	"git.commit",
	"git.discard",
	"git.createBranch",
	"git.switchBranch",
	"git.fetch",
	"git.push",
	"git.pull",
	"git.syncFacts",
	"git.init",
	"git.recoveryList",
	"git.recoveryRestore",
	"git.recoveryDrop",
];
const DIRECTORY_PAGE = { entries: [{ target: { projectId: "p2", relativePath: "a" }, relativePath: "a", type: "directory", hasChildren: "unknown" }], truncated: true, revision: 7, generation: "g1" };

function remoteFacts(overrides = {}) {
	return { projectId: "p2", locationKind: "ssh", hostId: "h1", hostState: "ready", rootStatus: "ok", helperCapabilities: FULL_HELPER, trust: "approved", generation: "g1", ...overrides };
}

function testFence(generation = "g1") {
	return { generation, slot: { current: generation } };
}

function groups() {
	return { merge: [], index: [], workingTree: [], untracked: [] };
}

function makeApi(options = {}) {
	const calls = [];
	const record = (name, args) => calls.push({ name, args });
	const transferListeners = new Set();
	let transferSequence = 0;
	const emitTransfer = (event) => {
		for (const listener of transferListeners) listener(event);
	};
	const page = options.page ?? DIRECTORY_PAGE;
	const api = {
		files: {
			directoryPage: async (target, opts) => {
				record("files.directoryPage", [target, opts]);
				if (options.directoryDeferred) return options.directoryDeferred;
				return { ok: true, value: page };
			},
			search: async (projectId, query) => {
				record("files.search", [projectId, query]);
				return [];
			},
			searchContent: async (projectId, query) => {
				record("files.searchContent", [projectId, query]);
				return null;
			},
			readContent: async (target) => {
				record("files.readContent", [target]);
				return "local-content";
			},
			writeContent: async (target, content) => {
				record("files.writeContent", [target, content]);
			},
			stat: async (target) => {
				record("files.stat", [target]);
				return target.relativePath === "missing" ? { exists: false, isDirectory: false } : { exists: true, isDirectory: target.relativePath === "" };
			},
			create: async (parent, name, type) => {
				record("files.create", [parent, name, type]);
				return { projectId: parent.projectId, relativePath: parent.relativePath ? parent.relativePath + "/" + name : name };
			},
			rename: async (target, newName) => {
				record("files.rename", [target, newName]);
				const index = target.relativePath.lastIndexOf("/");
				return { projectId: target.projectId, relativePath: (index < 0 ? "" : target.relativePath.slice(0, index + 1)) + newName };
			},
			move: async (sources, targetDir) => {
				record("files.move", [sources, targetDir]);
				return sources;
			},
			delete: async (target) => {
				record("files.delete", [target]);
			},
			open: async (target) => {
				record("files.open", [target]);
			},
			showInFolder: async (target) => {
				record("files.showInFolder", [target]);
			},
		},
		git: {
			status: async (projectId, repoPath) => {
				record("git.status", [projectId, repoPath]);
				return groups();
			},
			historyPage: async (projectId, opts, repoPath) => {
				record("git.historyPage", [projectId, opts, repoPath]);
				return { ok: true, value: { commits: [], hasMore: false } };
			},
			repositoryList: async (projectId) => {
				record("git.repositoryList", [projectId]);
				return { ok: true, value: { repos: [], truncated: true, revision: 2, generation: "g1" } };
			},
			refs: async (projectId, repoPath) => {
				record("git.refs", [projectId, repoPath]);
				return [];
			},
			compareRefs: async (projectId, base, head, repoPath) => {
				record("git.compareRefs", [projectId, base, head, repoPath]);
				return { ok: true, value: { mode: "merge-base", base: { ref: base, oid: "1" }, head: { ref: head, oid: "2" }, files: [] } };
			},
			workspaceFileDiff: async (projectId, group, file, repoPath) => {
				record("git.workspaceFileDiff", [projectId, group, file, repoPath]);
				return { path: file.relativePath, target: file, displayPath: file.relativePath, originalContent: "", modifiedContent: "" };
			},
			branches: async (projectId, repoPath) => {
				record("git.branches", [projectId, repoPath]);
				return { current: "main", branches: ["main"] };
			},
			createBranch: async (projectId, name, repoPath) => {
				record("git.createBranch", [projectId, name, repoPath]);
				return { current: name, branches: [name] };
			},
			checkout: async (projectId, branch, repoPath) => {
				record("git.checkout", [projectId, branch, repoPath]);
				return { current: branch, branches: [branch] };
			},
			stage: async (projectId, targets, repoPath) => {
				record("git.stage", [projectId, targets, repoPath]);
			},
			unstage: async (projectId, targets, repoPath) => {
				record("git.unstage", [projectId, targets, repoPath]);
			},
			commit: async (projectId, message, repoPath) => {
				record("git.commit", [projectId, message, repoPath]);
			},
			discardFiles: async (projectId, resources, repoPath) => {
				record("git.discardFiles", [projectId, resources, repoPath]);
			},
			fetch: async (projectId, repoPath) => {
				record("git.fetch", [projectId, repoPath]);
			},
			pull: async (projectId, repoPath) => {
				record("git.pull", [projectId, repoPath]);
			},
			push: async (projectId, repoPath) => {
				record("git.push", [projectId, repoPath]);
			},
			init: async (projectId) => {
				record("git.init", [projectId]);
			},
			deleteFiles: async (projectId, targets, repoPath) => {
				record("git.deleteFiles", [projectId, targets, repoPath]);
			},
			worktreeList: async (projectId) => {
				record("git.worktreeList", [projectId]);
				return [];
			},
			worktreeCreate: async (projectId, branchName) => {
				record("git.worktreeCreate", [projectId, branchName]);
				return { target: { projectId, relativePath: "wt" }, branch: branchName, displayPath: "wt" };
			},
			worktreeRemove: async (projectId, target) => {
				record("git.worktreeRemove", [projectId, target]);
				return true;
			},
			aheadBehind: async (projectId, repoPath) => {
				record("git.aheadBehind", [projectId, repoPath]);
				return { ahead: 1, behind: 2 };
			},
			// 远端 Git 的写面通道（G 接令牌经纪）：作用域由末尾 repoPath 参数承载，令牌来自快照。
			remoteSnapshot: async (projectId, repo) => {
				record("git.remoteSnapshot", [projectId, repo]);
				return {
					ok: true,
					snapshot: {
						groups: groups(),
						head: OID,
						branch: "main",
						mutationToken: "mutation-token",
						commitToken: "commit-token",
						branchToken: "branch-token",
						switchToken: "switch-token",
						discardToken: "discard-token",
						restoreToken: "restore-token",
						dropToken: "drop-token",
						fetchToken: "fetch-token",
						pushToken: "push-token",
						pullToken: "pull-token",
					},
				};
			},
			refreshRemoteSnapshot: async (projectId, repo) => {
				record("git.refreshRemoteSnapshot", [projectId, repo]);
				// 令牌与普通快照不同：用来证明紧随其后的写复用的是强刷签出的那份授权。
				return {
					ok: true,
					snapshot: {
						groups: groups(),
						head: OID,
						branch: "main",
						mutationToken: "refresh-mutation-token",
						commitToken: "commit-token",
						branchToken: "branch-token",
						switchToken: "switch-token",
						discardToken: "discard-token",
						restoreToken: "restore-token",
						dropToken: "drop-token",
						fetchToken: "fetch-token",
						pushToken: "push-token",
						pullToken: "pull-token",
					},
				};
			},
			mutateRemoteIndex: async (...args) => {
				record("git.mutateRemoteIndex", args);
				return { ok: true };
			},
			commitRemote: async (...args) => {
				record("git.commitRemote", args);
				return { ok: true };
			},
			createRemoteBranch: async (...args) => {
				record("git.createRemoteBranch", args);
				return { ok: true };
			},
			switchRemoteBranch: async (...args) => {
				record("git.switchRemoteBranch", args);
				return { ok: true };
			},
			discardRemote: async (...args) => {
				record("git.discardRemote", args);
				return { ok: true, recoveryRef: "refs/pideck/recovery/r1" };
			},
			fetchRemote: async (...args) => {
				record("git.fetchRemote", args);
				return { ok: true, outcome: { upToDate: true, updated: [] } };
			},
			pullRemote: async (...args) => {
				record("git.pullRemote", args);
				return { ok: true, outcome: { mode: "up-to-date", head: OID } };
			},
			pushRemote: async (...args) => {
				record("git.pushRemote", args);
				return { ok: true, outcome: { outcome: "up-to-date", refspec: "refs/heads/main:refs/heads/main" } };
			},
			syncFacts: async (projectId, repo) => {
				record("git.syncFacts", [projectId, repo]);
				return { ok: true, facts: { branch: "main", upstream: "refs/remotes/origin/main", ahead: 0, behind: 0, remotes: ["origin"] } };
			},
			recoveryList: async (projectId, repo) => {
				record("git.recoveryList", [projectId, repo]);
				return { ok: true, entries: [], truncated: false };
			},
			recoveryRestore: async (...args) => {
				record("git.recoveryRestore", args);
				return { ok: true, path: "a.ts", bytes: 1 };
			},
			recoveryDrop: async (...args) => {
				record("git.recoveryDrop", args);
				return { ok: true };
			},
			remoteRefs: async (projectId, repo) => {
				record("git.remoteRefs", [projectId, repo]);
				return { ok: true, refs: { head: OID, branch: "main", refs: [{ fullName: "refs/heads/main", name: "main", oid: OID, kind: "branch" }] } };
			},
			initRemote: async (projectId) => {
				record("git.initRemote", [projectId]);
				return { ok: true, branch: "main" };
			},
		},
		remoteHosts: {
			searchProject: async (projectId, path, query) => {
				record("remoteHosts.searchProject", [projectId, path, query]);
				return { ok: true, value: { entries: [{ path: "src/a.ts", name: "a.ts", kind: "file", bytes: 1 }], scanned: 1, truncated: true } };
			},
			openProjectText: async (projectId, path) => {
				record("remoteHosts.openProjectText", [projectId, path]);
				return { ok: true, value: { document: { content: "remote-content", version: "text-v1" } } };
			},
			saveProjectText: async (projectId, path, content, version) => {
				record("remoteHosts.saveProjectText", [projectId, path, content, version]);
				if (options.saveResult) return options.saveResult;
				return { ok: true, value: { version: "text-v2" } };
			},
			statProjectEntry: async (projectId, path) => {
				record("remoteHosts.statProjectEntry", [projectId, path]);
				return { ok: true, value: { stat: { kind: "file", bytes: 1, mtimeMs: 1 }, version: "entry-v1" } };
			},
			createProjectFile: async (projectId, parent, name) => {
				record("remoteHosts.createProjectFile", [projectId, parent, name]);
				return { ok: true, value: { relativePath: parent ? parent + "/" + name : name, kind: "file" } };
			},
			createProjectDirectory: async (projectId, parent, name) => {
				record("remoteHosts.createProjectDirectory", [projectId, parent, name]);
				return { ok: true, value: { relativePath: parent ? parent + "/" + name : name, kind: "directory" } };
			},
			renameProjectEntry: async (projectId, source, target, version) => {
				record("remoteHosts.renameProjectEntry", [projectId, source, target, version]);
				return { ok: true, value: { relativePath: target } };
			},
			deleteProjectEntry: async (projectId, path, version) => {
				record("remoteHosts.deleteProjectEntry", [projectId, path, version]);
				return { ok: true, value: { trashId: "trash-1" } };
			},
		},
		remoteTrust: { list: async () => ({ ok: true, value: { entries: [] } }) },
		remoteTransfers: {
			onEvent: (listener) => {
				transferListeners.add(listener);
				return () => transferListeners.delete(listener);
			},
			start: async (input) => {
				record("remoteTransfers.start", [input]);
				if (input.operation === "upload" && input.source.kind === "picker") return { ok: true, value: { canceled: true } };
				transferSequence += 1;
				const jobId = "job-" + String(transferSequence).padStart(16, "0");
				if (input.operation === "upload") {
					emitTransfer({ kind: "settled", jobId, operation: "upload", outcome: "succeeded", result: { uploaded: [{ name: "a.bin", bytes: 3 }], failed: [] } });
					return { ok: true, value: { jobId, operation: "upload", total: 3 } };
				}
				emitTransfer({ kind: "settled", jobId, operation: "download", outcome: "succeeded", result: { path: "C:/downloads/a.bin", bytes: 3 } });
				return { ok: true, value: { jobId, operation: "download", total: 3 } };
			},
			cancel: async () => ({ ok: true, value: { accepted: true } }),
		},
	};
	return { api, calls };
}

function names(calls) {
	return calls.map((call) => call.name);
}

test("目录页与搜索：本地/远端同通道，truncated/revision/generation/未知 children 原样返回", async () => {
	for (const [project, facts] of [
		[localProject, undefined],
		[remoteProject, remoteFacts()],
	]) {
		const { api, calls } = makeApi();
		const services = createProjectServices(project, api, facts ? { facts } : {});
		const target = { projectId: project.id, relativePath: "" };
		const page = await services.files.listDirectory(target, { force: true });
		assert.deepEqual(plain(page), DIRECTORY_PAGE);
		assert.equal(page.entries[0].hasChildren, "unknown");
		const search = await services.files.searchFiles("calc");
		await services.files.searchContent("验收");
		if (project.id === "p1") {
			assert.deepEqual(plain(search), { results: [] });
			assert.deepEqual(names(calls), ["files.directoryPage", "files.search", "files.searchContent"]);
		} else {
			assert.deepEqual(plain(search), {
				results: [{ name: "a.ts", relativePath: "src/a.ts", displayPath: "src/a.ts", target: { projectId: "p2", relativePath: "src/a.ts" }, type: "file" }],
				truncated: true,
				scanned: 1,
				entries: [{ path: "src/a.ts", name: "a.ts", kind: "file", bytes: 1 }],
			});
			assert.deepEqual(names(calls), ["files.directoryPage", "remoteHosts.searchProject", "files.searchContent"]);
			assert.deepEqual(calls[1].args, ["p2", "", "calc"]);
		}
	}
});

test("本机文件写面：读正文/保存/新建/改名/删除返回收据，系统打开仍走本机", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(localProject, api);
	const target = { projectId: "p1", relativePath: "src/a.ts" };
	assert.equal((await services.files.readText(target)).content, "local-content");
	assert.deepEqual(plain(await services.files.writeText(target, "next")), {});
	const created = await services.files.createEntry({ projectId: "p1", relativePath: "src" }, "b.ts", "file");
	assert.deepEqual(plain(created), { target: { projectId: "p1", relativePath: "src/b.ts" }, kind: "file" });
	const renamed = await services.files.renameEntry(target, "c.ts");
	assert.deepEqual(plain(renamed.target), { projectId: "p1", relativePath: "src/c.ts" });
	const deleted = await services.files.deleteEntry(target);
	assert.deepEqual(plain(deleted), { target });
	// 跨目录移动：先 files.move 到目标父目录；目标名不同再 rename。
	const moved = await services.files.moveEntry(target, "src/c.ts");
	assert.deepEqual(plain(moved.target), { projectId: "p1", relativePath: "src/c.ts" });
	await services.files.openInEditor(target);
	await services.files.showInFolder(target);
	assert.deepEqual(names(calls), ["files.readContent", "files.writeContent", "files.create", "files.rename", "files.delete", "files.move", "files.rename", "files.open", "files.showInFolder"]);
	assert.equal(services.capabilities.files.textVersion, "none");
});

test("远端文本保存：只接受 readText 返回的 version；缺失/空串零调用拒绝", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	const target = { projectId: "p2", relativePath: "src/a.ts" };
	const read = await services.files.readText(target);
	assert.deepEqual({ ...read }, { content: "remote-content", version: "text-v1" });
	const saved = await services.files.writeText(target, "next", read.version);
	assert.deepEqual({ ...saved }, { version: "text-v2" });
	assert.deepEqual(calls.at(-1), { name: "remoteHosts.saveProjectText", args: ["p2", "src/a.ts", "next", "text-v1"] });
	assert.equal(services.capabilities.files.textVersion, "required");

	for (const missing of [undefined, ""]) {
		calls.length = 0;
		await assert.rejects(
			() => services.files.writeText(target, "next", missing),
			(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.versionRequired,
			String(missing),
		);
		assert.deepEqual(calls, [], "不得先 statProjectEntry、openProjectText 或 saveProjectText");
	}
});

test("本机文本保存没有 version 通道：传入远端令牌显式拒绝，不静默忽略", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(localProject, api);
	await assert.rejects(
		() => services.files.writeText({ projectId: "p1", relativePath: "a.ts" }, "next", "text-v1"),
		(error) => error?.code === PROJECT_SERVICE_CODES.unsupported,
	);
	assert.deepEqual(calls, []);
});

test("远端文件管理：新建按类型分流，改名/删除复用 entry 令牌并返回收据", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	const parent = { projectId: "p2", relativePath: "src" };
	const file = await services.files.createEntry(parent, "b.ts", "file");
	assert.deepEqual(plain(file), { target: { projectId: "p2", relativePath: "src/b.ts" }, kind: "file" });
	const dir = await services.files.createEntry(parent, "dir", "directory");
	assert.deepEqual(plain(dir), { target: { projectId: "p2", relativePath: "src/dir" }, kind: "directory" });
	const renamed = await services.files.renameEntry({ projectId: "p2", relativePath: "src/b.ts" }, "c.ts");
	assert.deepEqual(plain(renamed.target), { projectId: "p2", relativePath: "src/c.ts" });
	const deleted = await services.files.deleteEntry({ projectId: "p2", relativePath: "src/c.ts" });
	assert.deepEqual(plain(deleted), { target: { projectId: "p2", relativePath: "src/c.ts" }, trashId: "trash-1" });
	const moved = await services.files.moveEntry({ projectId: "p2", relativePath: "src/a.ts" }, "lib/a.ts");
	assert.deepEqual(plain(moved.target), { projectId: "p2", relativePath: "lib/a.ts" });
	assert.deepEqual(names(calls), ["remoteHosts.createProjectFile", "remoteHosts.createProjectDirectory", "remoteHosts.statProjectEntry", "remoteHosts.renameProjectEntry", "remoteHosts.statProjectEntry", "remoteHosts.deleteProjectEntry", "remoteHosts.statProjectEntry", "remoteHosts.renameProjectEntry"]);
	assert.deepEqual(calls[3].args, ["p2", "src/b.ts", "src/c.ts", "entry-v1"]);
	assert.deepEqual(calls[5].args, ["p2", "src/c.ts", "entry-v1"]);
	assert.deepEqual(calls[7].args, ["p2", "src/a.ts", "lib/a.ts", "entry-v1"]);
});

test("文件传输经 ProjectFileService：远端 picker/拖放/下载共用项目身份，本机显式 unsupported", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	const target = { projectId: "p2", relativePath: "src" };
	assert.deepEqual(plain(await services.files.uploadFiles(target, { kind: "picker" })), { ok: true, value: { canceled: true } });
	assert.deepEqual(plain(await services.files.uploadFiles(target, { kind: "paths", paths: ["C:/tmp/a.bin"] })), { ok: true, value: { uploaded: [{ name: "a.bin", bytes: 3 }], failed: [] } });
	assert.deepEqual(plain(await services.files.downloadFile({ projectId: "p2", relativePath: "src/a.bin" })), { ok: true, value: { path: "C:/downloads/a.bin", bytes: 3 } });
	assert.deepEqual(names(calls), ["remoteTransfers.start", "remoteTransfers.start", "remoteTransfers.start"]);
	assert.deepEqual(plain(calls[1].args[0]), { operation: "upload", projectId: "p2", targetRelativePath: "src", source: { kind: "paths", paths: ["C:/tmp/a.bin"] } });
	assert.deepEqual(plain(calls[2].args[0]), { operation: "download", projectId: "p2", targetRelativePath: "src/a.bin" });

	const local = createProjectServices(localProject, makeApi().api);
	for (const run of [() => local.files.uploadFiles({ projectId: "p1", relativePath: "src" }, { kind: "picker" }), () => local.files.downloadFile({ projectId: "p1", relativePath: "src/a.bin" })]) {
		await assert.rejects(run, (error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported);
	}
});

test("远端没有本机路径：系统打开显式 unsupported，且不调用任何通道", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	for (const method of ["openInEditor", "showInFolder"]) {
		await assert.rejects(
			() => services.files[method]({ projectId: "p2", relativePath: "src/a.ts" }),
			(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported,
		);
	}
	assert.equal(calls.length, 0);
});

test("项目身份：facts、target、repoPath 必须在触达 IPC 前与 services 一致", async () => {
	const { api, calls } = makeApi();
	assert.throws(
		() => createProjectServices(remoteProject, api, { facts: remoteFacts({ projectId: "p9" }) }),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	assert.throws(
		() => createProjectServices(remoteProject, api, { facts: remoteFacts({ hostId: "h9" }) }),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	await assert.rejects(
		() => services.files.readText({ projectId: "p1", relativePath: "a.ts" }),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	await assert.rejects(
		() => services.git.status({ projectId: "p1", relativePath: "" }),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	assert.equal(calls.length, 0);
});

test("代数围栏：槽位变化后旧代的成功与失败都改抛 GENERATION_STALE，且不发布结果", async () => {
	const { api } = makeApi();
	const slot = { current: "g1" };
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts(), fence: slot });
	let resolve;
	api.files.directoryPage = () =>
		new Promise((done) => {
			resolve = done;
		});
	const pending = services.files.listDirectory({ projectId: "p2", relativePath: "" });
	slot.current = "g2";
	assert.equal(services.isCurrent(), false);
	resolve({ ok: true, value: DIRECTORY_PAGE });
	await assert.rejects(pending, (error) => error?.code === PROJECT_SERVICE_CODES.generationStale);

	let reject;
	api.files.directoryPage = () =>
		new Promise((_done, fail) => {
			reject = fail;
		});
	const failing = services.files.listDirectory({ projectId: "p2", relativePath: "" });
	reject(new Error("REMOTE_CONNECTION_LOST"));
	await assert.rejects(failing, (error) => error?.code === PROJECT_SERVICE_CODES.generationStale);

	const fresh = createProjectServices(remoteProject, api, { facts: remoteFacts({ generation: "g2" }), fence: slot });
	assert.equal(fresh.isCurrent(), true);
});

test("Git 读面：本地与远端走同一公共通道；本地 workspace diff/分支列表可用", async () => {
	for (const [project, facts] of [
		[localProject, undefined],
		[remoteProject, remoteFacts()],
	]) {
		const { api, calls } = makeApi();
		const services = createProjectServices(project, api, facts ? { facts } : {});
		const repo = { projectId: project.id, relativePath: "" };
		await services.git.status(repo);
		await services.git.history({ maxCount: 10 }, repo);
		await services.git.repos();
		await services.git.refs(repo);
		await services.git.compare("main", "dev", repo);
		await services.git.workspaceDiff("workingTree", { projectId: project.id, relativePath: "a.ts" }, repo);
		assert.deepEqual(names(calls), ["git.status", "git.historyPage", "git.repositoryList", "git.refs", "git.compareRefs", "git.workspaceFileDiff"]);
		assert.equal(services.capabilities.git.read, true);
	}
	const localApi = makeApi();
	const local = createProjectServices(localProject, localApi.api);
	await local.git.branches();
	assert.deepEqual(names(localApi.calls), ["git.branches"]);
	assert.equal(local.capabilities.git.diff, true);
	assert.equal(local.capabilities.git.branchRead, true);
});

test("raw IPC 失败归一成稳定码；GIT_WRITE_RESULT_UNCONFIRMED 保留 unknown", async () => {
	const { api } = makeApi();
	const services = createProjectServices(localProject, api);
	api.git.status = async () => {
		throw new Error("Error invoking remote method 'git:status': Error: GIT_TRUST_REQUIRED");
	};
	await assert.rejects(
		() => services.git.status(),
		(error) => error instanceof ProjectServiceError && error.code === "GIT_TRUST_REQUIRED" && error.outcome === "rejected",
	);
	api.git.stage = async () => {
		throw new Error("Error invoking remote method 'git:stage': Error: GIT_WRITE_RESULT_UNCONFIRMED");
	};
	await assert.rejects(
		() => services.git.stage([{ projectId: "p1", relativePath: "a.ts" }]),
		(error) => error instanceof ProjectServiceError && error.code === "GIT_WRITE_RESULT_UNCONFIRMED" && error.outcome === "unknown",
	);
});

test("写路径代数围栏：换代时写 outcome 必须是 unknown（可能已落地），读仍是 rejected", async () => {
	const { api } = makeApi();
	const slot = { current: "g1" };
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts(), fence: slot });
	let resolveSave;
	api.remoteHosts.saveProjectText = () =>
		new Promise((resolve) => {
			resolveSave = resolve;
		});
	const pending = services.files.writeText({ projectId: "p2", relativePath: "src/a.ts" }, "next", "text-v1");
	slot.current = "g2";
	resolveSave({ ok: true, value: { version: "text-v2" } });
	await assert.rejects(pending, (error) => error?.code === PROJECT_SERVICE_CODES.generationStale && error?.outcome === "unknown");
});

test("Git 目标数组在触达 IPC 前按项目身份围栏", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(localProject, api);
	const foreign = { projectId: "p9", relativePath: "a.ts" };
	await assert.rejects(
		() => services.git.stage([foreign]),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	await assert.rejects(
		() => services.git.unstage([foreign]),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	await assert.rejects(
		() => services.git.discard([{ group: "workingTree", target: foreign }]),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	await assert.rejects(
		() => services.git.deleteFiles([foreign]),
		(error) => error?.code === PROJECT_SERVICE_CODES.projectMismatch,
	);
	assert.deepEqual(calls, []);
});

test("远端 Git 写与强刷：走 main 的令牌经纪；worktree*/deleteFiles 仍显式 unsupported", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	const repo = { projectId: "p2", relativePath: "" };
	const target = { projectId: "p2", relativePath: "a.ts" };

	// 强刷必须越过事实缓存（refreshRemoteSnapshot），不得退化成缓存 status。
	assert.deepEqual(plain(await services.git.refresh(repo)), plain(groups()));
	assert.deepEqual(names(calls), ["git.refreshRemoteSnapshot"]);
	calls.length = 0;

	// 强刷签出的 grant 被紧随其后的写复用：没有第二次 snapshot，令牌就是强刷那份。
	await services.git.stage([target], repo);
	await services.git.commit("msg", repo);
	await services.git.createBranch("topic", "create", repo);
	const checkout = await services.git.checkout("main", repo);
	await services.git.discard([{ group: "workingTree", target }], repo);
	await services.git.fetch(repo);
	await services.git.pull(repo);
	await services.git.push(repo);
	await services.git.recoveryRestore({ ref: "refs/pideck/recovery/r1", oid: OID, path: "a.ts" }, repo);
	await services.git.recoveryDrop({ ref: "refs/pideck/recovery/r1", oid: OID }, repo);
	assert.deepEqual(
		names(calls),
		[
			// stage 复用强刷快照的 grant；commit 重新确认后用自己的令牌
			"git.mutateRemoteIndex",
			"git.remoteSnapshot",
			"git.commitRemote",
			// branch：create 只创建；checkout 切换后读回分支事实
			"git.remoteSnapshot",
			"git.createRemoteBranch",
			"git.remoteSnapshot",
			"git.switchRemoteBranch",
			"git.remoteRefs",
			// discard：可恢复丢弃
			"git.remoteSnapshot",
			"git.discardRemote",
			// 同步：先读只读 syncFacts，再为各自动作现签 grant
			"git.syncFacts",
			"git.remoteSnapshot",
			"git.fetchRemote",
			"git.syncFacts",
			"git.remoteSnapshot",
			"git.pullRemote",
			"git.syncFacts",
			"git.remoteSnapshot",
			"git.pushRemote",
			// 恢复：list 只读；restore/drop 各自令牌
			"git.remoteSnapshot",
			"git.recoveryRestore",
			"git.remoteSnapshot",
			"git.recoveryDrop",
		],
		"远端写面必须只走 main 的远端通道，不得落到本机 git:* 写通道",
	);
	assert.equal(calls[0].args[4], "refresh-mutation-token", "stage 必须复用强刷快照签出的令牌");
	assert.equal(calls[2].args[2], "commit-token");
	assert.equal(calls[9].args[3], "discard-token");
	assert.deepEqual(plain(checkout), { current: "main", branches: ["main"] });

	const writes = calls.length;
	for (const action of [() => services.git.deleteFiles([target], repo), () => services.git.worktreeList(), () => services.git.worktreeCreate("topic"), () => services.git.worktreeRemove({ projectId: "p2", relativePath: "wt" })]) {
		await assert.rejects(action, (error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported);
	}
	assert.equal(calls.length, writes, "worktree*/deleteFiles 必须零调用");
	assert.equal(services.capabilities.git.write, true);
	assert.equal(services.capabilities.git.forceRefresh, true);
	assert.equal(services.capabilities.git.branchCreateMode, "both");
	assert.equal(services.capabilities.git.sync, true);
	assert.equal(services.capabilities.git.recovery, true);
	assert.equal(services.capabilities.git.init, true);
	assert.equal(services.capabilities.git.autoFetch, false);
	assert.equal(services.capabilities.git.worktree, false);
	assert.equal(services.capabilities.git.deleteFiles, false);
});

test("本机 Git：syncFacts/recovery 仍显式 unsupported（本机没有这些事实源）", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(localProject, api);
	for (const action of [() => services.git.syncFacts(), () => services.git.recoveryList(), () => services.git.recoveryRestore({ ref: "refs/pideck/recovery/r1", oid: OID, path: "a.ts" }), () => services.git.recoveryDrop({ ref: "refs/pideck/recovery/r1", oid: OID })]) {
		await assert.rejects(action, (error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported);
	}
	assert.deepEqual(calls, []);
});

test("本机 Git 写：委派既有通道；只创建分支的显式模式不被暗中追加成创建并切换", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(localProject, api);
	const repo = { projectId: "p1", relativePath: "" };
	const target = { projectId: "p1", relativePath: "a.ts" };
	await services.git.refresh(repo);
	await services.git.stage([target], repo);
	await services.git.unstage([target], repo);
	await services.git.commit("msg", repo);
	await services.git.discard([{ group: "workingTree", target }], repo);
	await services.git.checkout("dev", repo);
	await services.git.createBranch("topic", "create-and-checkout", repo);
	await services.git.fetch(repo);
	await services.git.pull(repo);
	await services.git.push(repo);
	await services.git.init();
	await services.git.deleteFiles([target], repo);
	await services.git.aheadBehind(repo);
	await services.git.worktreeList();
	await services.git.worktreeCreate("topic");
	await services.git.worktreeRemove({ projectId: "p1", relativePath: "wt" });
	assert.deepEqual(names(calls), ["git.status", "git.stage", "git.unstage", "git.commit", "git.discardFiles", "git.checkout", "git.createBranch", "git.fetch", "git.pull", "git.push", "git.init", "git.deleteFiles", "git.aheadBehind", "git.worktreeList", "git.worktreeCreate", "git.worktreeRemove"]);
	await assert.rejects(
		() => services.git.createBranch("topic", "create", repo),
		(error) => error?.code === PROJECT_SERVICE_CODES.unsupported,
	);
});

test("远端写 unknown 保留 outcome 且不重放：只发一次 save，不自动 open/stat", async () => {
	const { api, calls } = makeApi({ saveResult: { ok: false, code: "REMOTE_FILE_COMMAND_FAILED", outcome: "unknown" } });
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	await assert.rejects(
		() => services.files.writeText({ projectId: "p2", relativePath: "src/a.ts" }, "next", "text-v1"),
		(error) => error instanceof ProjectServiceError && error.outcome === "unknown" && error.code === "REMOTE_FILE_COMMAND_FAILED",
	);
	assert.deepEqual(names(calls), ["remoteHosts.saveProjectText"]);
	assert.deepEqual(calls[0].args, ["p2", "src/a.ts", "next", "text-v1"]);
});
