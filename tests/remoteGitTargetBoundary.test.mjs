import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { remoteGitRepoScope, projectFilePath, repoRelativeFilePath } = loadTsCommonJs("src/main/git/RemoteGitService.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (_channel, _fn) => undefined } } } });

const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * T5（v5 §10.3）：public 与 legacy 的路径分界。
 *
 * 这里钉的是**纯转换函数 + 真实注册边界**：
 * - 仓库 scope 只允许一种归一化（字符串或 ProjectFileTarget），跨项目/越界/多余字段一律拒绝；
 * - 项目相对 → 仓库内只按目录前缀严格剥离（`packages/a-other/x` 不是 `packages/a` 的文件）；
 * - 共享 `git:refs` 入口接受文件树传来的 target scope，旧远端调用（字符串）行为不变。
 */
test("仓库 scope：字符串、ProjectFileTarget 与根都有确定结果；跨项目/越界/多余字段被拒绝", () => {
	assert.equal(remoteGitRepoScope(projectId, ""), "");
	assert.equal(remoteGitRepoScope(projectId, undefined), "");
	assert.equal(remoteGitRepoScope(projectId, "packages/a"), "packages/a");
	assert.equal(remoteGitRepoScope(projectId, { projectId, relativePath: "packages/a" }), "packages/a");
	assert.equal(remoteGitRepoScope(projectId, { projectId, relativePath: "" }), "");

	for (const value of ["../outside", "/absolute", "a\\b", "packages/a/.git", "x.lock/y"]) {
		assert.throws(() => remoteGitRepoScope(projectId, value), /GIT_RESULT_INVALID/, String(value));
	}
	assert.throws(() => remoteGitRepoScope(projectId, { projectId: "other", relativePath: "packages/a" }), /GIT_RESULT_INVALID/);
	assert.throws(() => remoteGitRepoScope(projectId, { projectId, relativePath: "packages/a", extra: 1 }), /GIT_RESULT_INVALID/);
});

test("项目相对 ↔ 仓库内：严格目录前缀，不接受同名前缀或跨仓目标", () => {
	// 输出方向：仓库内 → 项目相对。
	assert.equal(projectFilePath("", "a.txt"), "a.txt");
	assert.equal(projectFilePath("packages/a", "a.txt"), "packages/a/a.txt");
	assert.equal(projectFilePath("packages/a", "sub/b.txt"), "packages/a/sub/b.txt");

	// 输入方向：项目相对 → 仓库内（helper 只认仓库内路径）。
	const target = (relativePath, owner = projectId) => ({ projectId: owner, relativePath });
	assert.equal(repoRelativeFilePath(projectId, "", target("a.txt")), "a.txt");
	assert.equal(repoRelativeFilePath(projectId, "packages/a", target("packages/a/a.txt")), "a.txt");
	assert.equal(repoRelativeFilePath(projectId, "packages/a", target("packages/a/sub/b.txt")), "sub/b.txt");

	// 同名前缀不是前缀：这两个值必须被拒绝，而不是猜到“也许用户想写 a/a.txt”。
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/a-other/a.txt")), /GIT_RESULT_INVALID/);
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/a")), /GIT_RESULT_INVALID/);
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/b/a.txt")), /GIT_RESULT_INVALID/);
	// 没有前缀就是没有前缀（禁止“有前缀就剥、没前缀也当合法”）。
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("a.txt")), /GIT_RESULT_INVALID/);
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/a/a.txt", "other")), /GIT_RESULT_INVALID/);
});

function fixture() {
	const handlers = new Map();
	const calls = [];
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		async request(method, params, options) {
			calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
			options?.onRequestId?.("request-id");
			if (method === "hello") return { protocolVersion: 1, root: serviceLocator.remotePath, capabilities: ["git.status", "git.refs"] };
			if (method === "git.status") return { status: "", head: oid("a"), branch: "main" };
			if (method === "git.refs") return { head: oid("a"), branch: "main", refs: [{ fullName: "refs/heads/main", name: "main", oid: oid("a"), kind: "branch" }] };
			throw new Error("UNEXPECTED_METHOD");
		},
		async cancel(id) {
			calls.push({ method: "cancel", id });
		},
	};
	const port = registerRemoteGitReadIpc({
		enabled: true,
		locator: (id) => (id === projectId ? locator : undefined),
		trusted: async () => true,
		service: async () => ({
			async withProjectSession(_hostId, _root, work, options) {
				assert.equal(options.requireReady, true);
				return { ok: true, value: await work(session) };
			},
			connectionFacts: () => ({ connectionId: "conn-1", state: "ready" }),
		}),
	});
	return { port, calls, sender, handlers };
}

test("共享 git:refs 接受文件树传来的 ProjectFileTarget scope；跨项目/越界在开会话前拒绝", async () => {
	const f = fixture();
	const refs = await f.port.refs({ sender: f.sender }, projectId, { projectId, relativePath: "packages/a" });
	assert.deepEqual(plain(refs), [{ name: "main", fullName: "refs/heads/main", hash: oid("a"), type: "head" }]);
	assert.equal(f.calls.at(-1).repo, "packages/a", "target scope 被归一成 helper 需要的仓库内路径");

	f.calls.length = 0;
	for (const value of [{ projectId: "other", relativePath: "packages/a" }, "../outside", "packages/a/.git"]) {
		await assert.rejects(f.port.refs({ sender: f.sender }, projectId, value), /GIT_RESULT_INVALID/);
	}
	assert.equal(f.calls.length, 0, "非法 scope 一个帧都不发");

	// 旧远端调用（字符串）行为不变，根 scope 仍是空串。
	f.calls.length = 0;
	await f.port.refs({ sender: f.sender }, projectId, "");
	assert.equal(f.calls.at(-1).repo, undefined, "根 scope 不伪造 repo 字段");
});

/* ---------------------------------------------------- T5：公共 target 项目相对（helper 边界才出现仓库内路径） */

const { createRemoteGitService } = loadTsCommonJs("src/main/git/RemoteGitService.ts");
const nestedRepo = "packages/nested";
const serviceLocator = { hostId: "remote-host", remotePath: "/workspace/project" };

/** 真实 service + 绑定的假 helper 会话：断言的是“helper 到底看到什么”，不是内部字段。 */
function service(overrides = {}) {
	const calls = [];
	const session = {
		hostRevision: 1,
		async request(method, params, options) {
			calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
			options?.onRequestId?.(`request-${calls.length}`);
			if (method === "hello") return { protocolVersion: 1, root: serviceLocator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.stage", "git.discard", "git.refFileDiff", "git.commitDetail", "git.compare", "git.recoveryRestore"] };
			if (method === "git.status") return { status: Buffer.from("M  a.txt\0?? sub/b.txt\0").toString("base64"), head: oid("a"), branch: "main", revision: "c".repeat(64) };
			if (method === "git.workspaceDiff" || method === "git.refFileDiff") return { originalContent: "base\n", modifiedContent: "working\n" };
			if (method === "git.commitDetail") return { oid: params.oid, parents: [], authorName: "A", authorEmail: "a@x", authorTimeSec: 1, committerName: "A", committerEmail: "a@x", committerTimeSec: 1, subject: "s", message: "m", files: [{ status: "M", path: "a.txt" }] };
			if (method === "git.compare") return { base: { ref: params.base, oid: oid("a") }, head: { ref: params.head, oid: oid("b") }, files: [{ status: "M", path: "a.txt" }] };
			if (method === "git.discard") return { applied: true, recoveryRef: null, path: params.path, mode: "restored" };
			if (method === "git.recoveryRestore") return { applied: true, path: params.path, bytes: 3 };
			return { applied: true };
		},
		async cancel() {
			return undefined;
		},
	};
	return { calls, git: createRemoteGitService({ locator: () => serviceLocator, trusted: async () => true, withProject: async (_target, task) => task(session), ...overrides }) };
}

const grant = (kind, repoPath = "") => ({ kind, revision: "f".repeat(64), hostRevision: 1, target: serviceLocator, repoPath });
const projectFilePathOf = (relativePath) => ({ projectId, relativePath });

test("嵌套仓 status：公共 target/displayPath 都是项目相对，helper 仍拿仓库内路径", async () => {
	const { calls, git } = service();
	const snapshot = await git.status(projectId, nestedRepo);
	const resources = [...snapshot.groups.index, ...snapshot.groups.workingTree, ...snapshot.groups.untracked];
	const byPath = new Map(resources.map((resource) => [resource.target.relativePath, resource]));
	assert.deepEqual([...byPath.keys()].sort(), ["packages/nested/a.txt", "packages/nested/sub/b.txt"]);
	assert.equal(byPath.get("packages/nested/a.txt").path, "packages/nested/a.txt");
	assert.equal(byPath.get("packages/nested/a.txt").displayPath, "packages/nested/a.txt");
	assert.equal(calls.find((call) => call.method === "git.status").repo, nestedRepo, "选择器仍按仓库 scope 发帧");
});

test("嵌套仓 workspaceDiff/写面/refFileDiff：项目相对输入 → 仓库内帧；输出仍是项目相对", async () => {
	const { calls, git } = service();
	const target = projectFilePathOf(`${nestedRepo}/a.txt`);

	const diff = await git.workspaceDiff(projectId, "workingTree", target, nestedRepo);
	assert.deepEqual(plain(calls.at(-1).params), { group: "workingTree", path: "a.txt" });
	assert.equal(diff.path, `${nestedRepo}/a.txt`);
	assert.deepEqual(plain(diff.target), target);

	await git.mutate(projectId, "stage", "untracked", projectFilePathOf(`${nestedRepo}/sub/b.txt`), grant("index", nestedRepo), nestedRepo);
	assert.equal(calls.at(-1).params.path, "sub/b.txt", "stage 的 helper 帧是仓库内路径");

	await git.discard(projectId, "workingTree", target, grant("discard", nestedRepo), nestedRepo);
	assert.equal(calls.at(-1).params.path, "a.txt");

	const revisionDiff = await git.refFileDiff(projectId, null, oid("b"), target, nestedRepo);
	assert.equal(calls.at(-1).params.path, "a.txt");
	assert.equal(revisionDiff.path, `${nestedRepo}/a.txt`);
	assert.deepEqual(plain(revisionDiff.target), target);

	const restored = await git.recoveryRestore(projectId, "refs/pideck/recovery/x", oid("a"), `${nestedRepo}/a.txt`, grant("restore", nestedRepo), nestedRepo);
	assert.equal(calls.at(-1).params.path, "a.txt");
	assert.equal(restored.path, `${nestedRepo}/a.txt`);
});

test("嵌套仓 commitDetail/compare：文件路径同样是项目相对（可直接回传给 refFileDiff）", async () => {
	const { git } = service();
	const detail = await git.commitDetail(projectId, oid("d"), nestedRepo);
	assert.equal(detail.files[0].path, `${nestedRepo}/a.txt`);
	const compared = await git.compare(projectId, "refs/heads/main", "refs/tags/v1", nestedRepo);
	assert.equal(compared.files[0].path, `${nestedRepo}/a.txt`);
});

test("跨仓与同名前缀一律拒绝：公共 target 只有一种语义（不做前缀猜测）", async () => {
	const { calls, git } = service();
	await git.status(projectId, "");
	const frames = calls.length;
	for (const relativePath of ["packages/nested-other/a.txt", "packages/other/a.txt", "a.txt", "other/packages/nested/a.txt"]) {
		assert.throws(() => git.workspaceDiff(projectId, "workingTree", projectFilePathOf(relativePath), nestedRepo), /GIT_RESULT_INVALID/, relativePath);
		assert.throws(() => git.mutate(projectId, "stage", "workingTree", projectFilePathOf(relativePath), grant("index", nestedRepo), nestedRepo), /GIT_RESULT_INVALID/, relativePath);
		assert.throws(() => git.refFileDiff(projectId, null, oid("b"), projectFilePathOf(relativePath), nestedRepo), /GIT_RESULT_INVALID/, relativePath);
	}
	assert.equal(calls.length, frames, "非法 target 一个帧都不发（包括 hello）");
});

/* ------------------------------------------ 渲染层：控制器不重写 target（不再按前缀猜仓库） */

test("远端控制器（嵌套 scope）：项目相对的 target 原样传给服务，不重新加前缀也不接受旧形状", async () => {
	const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
	const nested = "packages/nested";
	const target = { projectId, relativePath: `${nested}/a.txt` };
	const resource = { target, path: target.relativePath, displayPath: target.relativePath, status: 5, letter: "M" };
	const snapshot = { head: null, branch: "main", groups: { merge: [], index: [], workingTree: [resource], untracked: [] } };
	const calls = [];
	const controller = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => undefined,
			status: async () => ({ ok: true, snapshot }),
			refresh: async () => ({ ok: true, snapshot }),
			branches: async () => ({ ok: true, info: { current: "main", branches: ["main"] } }),
			workspaceFileDiff: async (group, file, repoPath) => {
				calls.push({ kind: "diff", group, file, repoPath });
				return { path: file.relativePath, target: file, displayPath: file.relativePath, originalContent: "old", modifiedContent: "new" };
			},
			mutateIndex: async (operation, group, file, repoPath) => {
				calls.push({ kind: "mutate", operation, group, file, repoPath });
				return { ok: true };
			},
		},
		() => undefined,
		nested,
	);

	await controller.refresh();
	await controller.mutate("stage", "workingTree", target);
	await controller.openDiff("workingTree", target);
	assert.deepEqual(
		plain(calls),
		[
			{ kind: "mutate", operation: "stage", group: "workingTree", file: target, repoPath: nested },
			{ kind: "diff", group: "workingTree", file: target, repoPath: nested },
		],
		"target 已经是项目相对：控制器只透传，前缀由 main 在 helper 边界剥",
	);

	// 旧形状（仓库内路径）不再被当成“某个仓库里的文件”：写入口按快照校验后拒绝，diff 只是把 target
	// 原样交给 main，由 main 的严格前缀规则拒绝——两侧都不补前缀。
	calls.length = 0;
	await controller.mutate("stage", "workingTree", { projectId, relativePath: "a.txt" });
	assert.deepEqual(calls, [], "仓库内路径不在项目相对的快照里：写入口拒绝而不是补前缀");
	await controller.openDiff("workingTree", { projectId, relativePath: "a.txt" });
	assert.deepEqual(calls, [{ kind: "diff", group: "workingTree", file: { projectId, relativePath: "a.txt" }, repoPath: nested }], "diff 原样透传，由 main 的 repoRelativeFilePath 拒绝；控制器不猜前缀");
});
