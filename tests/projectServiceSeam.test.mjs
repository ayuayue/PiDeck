/**
 * 工作区面板服务缝（S 检查点）的行为测试。
 *
 * 断言的是 provider 的真实路由、收据、错误与代数边界，不是源码形状：
 * - 读面位置无关；目录页的 truncated/revision/generation/未知 children 原样返回；
 * - 文件写返回既有收据（文本 version、删除 trashId、改名后的 target）；
 * - 文本保存只接受 readText 的 version；缺失/空串零调用拒绝，绝不取 entry 令牌或重新 open；
 * - 远端 Git 写与纯事实强刷显式 unsupported，且绝不调用授权 snapshot；
 * - 项目身份与连接代数在触达 IPC 前围栏。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createProjectServices, PROJECT_SERVICE_CODES, ProjectServiceError } = loadTsCommonJs("src/renderer/src/services/projectServices.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const localProject = { id: "p1", name: "p1", lastOpenedAt: 0, path: "C:/p1", environment: "windows" };
const remoteProject = { id: "p2", name: "p2", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p2" } };
const FULL_HELPER = [
	"fs.watch",
	"fs.searchNames",
	"fs.searchContent",
	"git.status",
	"git.workspaceDiff",
	"git.log",
	"git.repos",
	"git.refs",
	"git.compare",
	"git.stage",
	"git.unstage",
	"git.commit",
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
			remoteSnapshot: async () => {
				record("git.remoteSnapshot", []);
				throw new Error("authorization snapshot must not be used as a force refresh");
			},
			refreshRemoteSnapshot: async () => {
				record("git.refreshRemoteSnapshot", []);
				throw new Error("authorization snapshot must not be used as a force refresh");
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
	await services.files.openInEditor(target);
	await services.files.showInFolder(target);
	assert.deepEqual(names(calls), ["files.readContent", "files.writeContent", "files.create", "files.rename", "files.delete", "files.open", "files.showInFolder"]);
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
	assert.deepEqual(names(calls), ["remoteHosts.createProjectFile", "remoteHosts.createProjectDirectory", "remoteHosts.statProjectEntry", "remoteHosts.renameProjectEntry", "remoteHosts.statProjectEntry", "remoteHosts.deleteProjectEntry"]);
	assert.deepEqual(calls[3].args, ["p2", "src/b.ts", "src/c.ts", "entry-v1"]);
	assert.deepEqual(calls[5].args, ["p2", "src/c.ts", "entry-v1"]);
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

test("远端 Git 写与纯事实强刷：显式 unsupported、零调用，绝不使用授权 snapshot", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	const repo = { projectId: "p2", relativePath: "" };
	const actions = [
		() => services.git.refresh(repo),
		() => services.git.stage([{ projectId: "p2", relativePath: "a.ts" }], repo),
		() => services.git.commit("msg", repo),
		() => services.git.discard([{ group: "workingTree", target: { projectId: "p2", relativePath: "a.ts" } }], repo),
		() => services.git.createBranch("topic", "create", repo),
		() => services.git.checkout("main", repo),
		() => services.git.fetch(repo),
		() => services.git.pull(repo),
		() => services.git.push(repo),
		() => services.git.syncFacts(repo),
		() => services.git.recoveryList(repo),
		() => services.git.init(),
		() => services.git.deleteFiles([{ projectId: "p2", relativePath: "a.ts" }], repo),
		() => services.git.worktreeList(),
		() => services.git.worktreeCreate("topic"),
		() => services.git.worktreeRemove({ projectId: "p2", relativePath: "wt" }),
	];
	for (const action of actions) {
		await assert.rejects(action, (error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported);
	}
	assert.deepEqual(calls, [], "不得退化成 status，也不得调用 remoteSnapshot/refreshRemoteSnapshot");
	assert.equal(services.capabilities.git.write, false);
	assert.equal(services.capabilities.git.forceRefresh, false);
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
