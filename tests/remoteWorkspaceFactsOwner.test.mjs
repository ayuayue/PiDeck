import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { createRemoteFactsHub } = loadTsCommonJs("src/main/remote/RemoteFactsNotifications.ts");

const HOST = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PROJECT = "project-remote-1";
const PROJECT_ROOT = "/srv/app";
const oid = (char) => char.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * T4 收口（第三批 A 片）：目录事实与 Git 快照事实必须由**同一个 owner** 持有。
 *
 * 验收点（任务书写死的两条）：
 * 1. 目录写 → Git status 也脏：一次文件写让两类事实一起失效，并且**只发一条**通知；
 * 2. Git 写 → 目录页不重读：Git 写只把整树标脏，自己一次目录装载都不发起。
 *
 * 判据都是行为/事实状态（装载次数、缓存 stale、通知 scope），不是内部字段名。
 */
function harness(options = {}) {
	const handlers = new Map();
	const calls = { list: [], watches: [], status: 0 };
	const state = { connectionId: "conn-1", ready: "ready" };
	const hub = createRemoteFactsHub(ipcChannels.remoteProjectFactsChanged);
	const published = [];
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot() {
					return { canonicalPath: PROJECT_ROOT };
				},
			},
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: () => ({
					async search() {
						return { entries: [], scanned: 0, truncated: false };
					},
				}),
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: () => ({
					async readFile() {
						return { content: Buffer.from("x"), bytes: 1, mtimeMs: 1 };
					},
				}),
			},
		},
	});
	const session = {
		hostRevision: 1,
		connectionId: state.connectionId,
		async request(method) {
			if (method === "hello") return { protocolVersion: 1, root: PROJECT_ROOT, capabilities: ["git.status", "git.init"] };
			if (method === "fs.watch") return { watchId: "w1" };
			if (method === "fs.unwatch") return { ok: true };
			if (method === "git.status") {
				calls.status += 1;
				return { status: Buffer.from(" M tracked.txt\0").toString("base64"), head: oid("a"), branch: "main", revision: "c".repeat(64) };
			}
			if (method === "git.init") return { branch: "main" };
			throw new Error("UNEXPECTED_METHOD");
		},
		async cancel() {
			return undefined;
		},
	};
	const service = {
		async withProjectSession(_hostId, _root, work) {
			return { ok: true, value: await work(session) };
		},
		projectConnectionFacts: (hostId, root) => (hostId === HOST && root === PROJECT_ROOT ? { connectionId: state.connectionId, state: state.ready } : undefined),
		projectHelperCapabilities: () => ["fs.watch"],
		retainProjectSessionWatch: () => undefined,
		releaseProjectSessionWatch: () => undefined,
	};
	const project = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => service,
		factsEvents: hub,
		directoryReader: {
			async read({ relative }) {
				calls.list.push(relative === "" ? "." : relative);
				return { ok: true, value: { entries: [{ name: "src", kind: "directory" }], scanned: 1, truncated: false } };
			},
		},
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (projectId) => (projectId === PROJECT ? { kind: "ssh", hostId: HOST, remotePath: PROJECT_ROOT } : undefined),
		},
	});
	// owner 侧的通知出口：和 hub 订阅同一条通道，这里直接记录载荷（订阅按 sender 分发另有单测）。
	const publish = hub.publish.bind(hub);
	hub.publish = (change) => {
		published.push(change);
		publish(change);
	};
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const git = registerRemoteGitReadIpc({
		enabled: true,
		locator: (projectId) => (projectId === PROJECT ? { kind: "ssh", hostId: HOST, remotePath: PROJECT_ROOT } : undefined),
		trusted: async () => true,
		service: async () => service,
		factsEvents: hub,
		...(options.legacy === true ? {} : { workspace: { facts: project.gitStatusFacts, afterGitWrite: project.afterGitWrite, invalidateStatuses: project.invalidateStatuses } }),
	});
	const listDir = (path = "") => handlers.get(ipcChannels.remoteProjectList)({}, PROJECT, path);
	const readStatus = () => git.status({ sender }, PROJECT, "");
	return { handlers, calls, state, published, project, git, sender, listDir, readStatus };
}

test("目录写 → Git status 也脏：一次写只标脏一条通知，下一次读重新装载", async () => {
	const h = harness();
	await h.listDir("");
	assert.equal(h.calls.list.length, 1);
	await h.readStatus();
	assert.equal(h.calls.status, 1);
	h.published.length = 0;

	// 写一个文件：目录矩阵与 Git status 一起标脏，但**不装载**。
	h.project.afterWrite(PROJECT, ["src/a.ts"]);
	assert.equal(h.calls.list.length, 1, "写只标脏：目录不重新装载");
	assert.equal(h.calls.status, 1, "写只标脏：status 不重新装载");
	assert.equal(h.published.length, 1, "一次写只发一条通知（不是目录一条 + status 一条）");
	assert.equal(h.published[0].generation, "conn-1", "通知携带本项目的连接代");
	const scopes = plain(h.published[0].scopes);
	assert.deepEqual(
		scopes.filter((scope) => scope.kind === "dir").sort((a, b) => a.path.localeCompare(b.path)),
		[
			{ kind: "dir", path: "" },
			{ kind: "dir", path: "src" },
		],
	);
	assert.deepEqual(
		scopes.filter((scope) => scope.kind === "status"),
		[{ kind: "status", repoPath: "" }],
		"已缓存过 status 的仓库必须一起标脏",
	);

	// 活跃读者重读：两类事实都重新装载（revision 前进）。
	await h.listDir("");
	await h.readStatus();
	assert.equal(h.calls.list.length, 2);
	assert.equal(h.calls.status, 2);
});

test("Git 写 → 目录页不重读：整树只标脏，目录一次装载都不发起", async () => {
	const h = harness();
	await h.listDir("");
	await h.readStatus();
	assert.equal(h.calls.list.length, 1);
	assert.equal(h.calls.status, 1);
	h.published.length = 0;

	h.project.afterGitWrite(PROJECT, "");
	assert.equal(h.calls.list.length, 1, "Git 写不得触发目录装载");
	assert.equal(h.calls.status, 1, "Git 写也不得自己再读一次 status");
	assert.equal(h.published.length, 1);
	const scopes = plain(h.published[0].scopes);
	assert.deepEqual(
		scopes.filter((scope) => scope.kind === "status"),
		[{ kind: "status", repoPath: "" }],
	);
	assert.deepEqual(
		scopes.filter((scope) => scope.kind === "tree"),
		[{ kind: "tree" }],
		"整树失效用 tree scope，不是根目录事件",
	);

	// 事实确实被标脏：下一次读重新装载。
	assert.equal(h.project.gitStatusFacts.peek(PROJECT, "")?.stale, true);
	await h.listDir("");
	await h.readStatus();
	assert.equal(h.calls.list.length, 2);
	assert.equal(h.calls.status, 2);
});

test("断连换代与项目关闭：目录与 status 一起作废（同一条 owner）", async () => {
	const h = harness();
	await h.listDir("");
	await h.readStatus();
	assert.equal(h.project.gitStatusFacts.peek(PROJECT, "")?.stale, false);

	h.project.onHostDisconnected(HOST);
	assert.equal(h.project.gitStatusFacts.peek(PROJECT, "")?.stale, true, "断连后 status 不能再代表现状");
	// 暖缓存依旧要过连接身份：主机离线时拒绝，而不是把旧事实当成功返回。
	h.state.ready = "offline";
	await assert.rejects(
		() => h.readStatus(),
		(error) => /SSH_HOST_NOT_READY/.test(String(error)),
	);
	assert.equal(h.calls.status, 1, "拒绝不触发 helper 往返");

	// 重连后重新装载（旧代不发布）。
	h.state.ready = "ready";
	h.state.connectionId = "conn-2";
	const reloaded = await h.readStatus();
	assert.equal(reloaded.workingTree[0].path, "tracked.txt", "重连后读到新代的事实");
	assert.equal(h.calls.status, 2);

	// 关闭项目：同一份 owner 把两类事实一起标脏；写面回来的迟到失效不再制造目录事件。
	h.published.length = 0;
	await h.project.closeProject(PROJECT);
	assert.equal(h.project.gitStatusFacts.peek(PROJECT, "")?.stale, true);
	h.project.afterWrite(PROJECT, ["a.txt"]);
	h.project.invalidateStatuses(PROJECT);
	const afterClose = plain(h.published.flatMap((change) => change.scopes));
	assert.deepEqual(
		afterClose.filter((scope) => scope.kind === "dir" || scope.kind === "tree"),
		[],
		"关闭后的项目不得重新制造目录事实/通知（与“没有活着的项目代”的原地语义一致）",
	);
});

test("Git 写（真实通道）走同一份 owner：status 标脏 + 只发一条通知", async () => {
	const h = harness();
	const snapshot = await h.handlers.get(ipcChannels.gitRemoteSnapshot)({ sender: h.sender }, PROJECT, "");
	assert.equal(snapshot.ok, true);
	const before = h.calls.list.length;
	const loads = h.calls.status;
	h.published.length = 0;

	// 真实写通道（init：根级、无令牌）走 read(mutating) 的失效出口。
	const init = await h.handlers.get(ipcChannels.gitRemoteInit)({ sender: h.sender }, PROJECT);
	assert.deepEqual(plain(init), { ok: true, branch: "main" });
	assert.equal(h.calls.list.length, before, "Git 写不触发目录装载");
	assert.equal(h.calls.status, loads, "Git 写不自己再读一次 status");
	assert.equal(h.published.length, 1, "Git 写只发一条通知（status + tree 同一条）");
	const scopes = plain(h.published[0].scopes);
	assert.deepEqual(
		scopes.filter((scope) => scope.kind === "status"),
		[{ kind: "status", repoPath: "" }],
	);
	assert.deepEqual(
		scopes.filter((scope) => scope.kind === "tree"),
		[{ kind: "tree" }],
	);
	assert.equal(h.project.gitStatusFacts.peek(PROJECT, "")?.stale, true, "写后事实已标脏");
});
