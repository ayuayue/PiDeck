import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fixture, options } from "./helpers/remoteGitFixture.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");
const { createRemoteHostOperationLock } = loadTsCommonJs("src/main/remote/RemoteHostOperationLock.ts");
const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const { createRemoteGitPanelApi } = loadTsCommonJs("src/renderer/src/utils/remoteGitPanelApi.ts");
const { createProjectServices } = loadTsCommonJs("src/renderer/src/services/projectServices.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const hostId = "01234567-89ab-4def-8123-456789abcdef",
	projectId = "owned-project";
const relativePath = "目录 空格/中文 ['file'].txt",
	target = { projectId, relativePath };

/** Production renderer strategy → registered IPC/service → NDJSON client → local helper subprocess → native Git. */
function harness(t) {
	const f = fixture(t, true, {}, "项目 空格 'git'");
	mkdirSync(join(f.root, "目录 空格"));
	writeFileSync(join(f.root, relativePath), "BASE\n");
	writeFileSync(join(f.root, "other.txt"), "OTHER\n");
	f.git("add", "--", relativePath, "other.txt");
	f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
	writeFileSync(join(f.root, relativePath), "WORKING\r\n");
	const calls = [],
		diagnostics = [],
		replies = [],
		handlers = new Map();
	let capture,
		loseNextApplied = false;
	const client = createRemoteControlClient({
		hostId,
		send: (line) => {
			const frame = JSON.parse(line);
			calls.push(frame);
			f.child.stdin.write(line + "\n");
			capture?.(frame.id);
		},
		onDiagnostic: (entry) => diagnostics.push(entry.code),
	});
	client.openConnection();
	const input = createInterface({ input: f.child.stdout });
	input.on("line", (line) => {
		const frame = JSON.parse(line);
		replies.push(frame);
		if (loseNextApplied && frame.ok && frame.result?.applied === true) {
			loseNextApplied = false;
			// Drop the reply only after the real helper has published the index; reconnect must not replay it.
			client.closeConnection();
			client.openConnection();
			client.handleLine(line);
		} else client.handleLine(line);
	});
	f.child.stdin.on("error", () => client.closeConnection());
	f.child.on("exit", () => client.closeConnection());
	// The renderer's only data entry is the project-bound service: tokens stay inside the provider (minted per write),
	// so this harness exercises the same path production uses instead of the retired token-carrying preload shape.
	const remoteProject = { id: projectId, name: "owned", createdAt: 0, lastOpenedAt: 0, locator: { kind: "ssh", hostId, remotePath: f.root } };
	const facts = {
		projectId,
		locationKind: "ssh",
		hostId,
		hostState: "ready",
		rootStatus: "ok",
		trust: "approved",
		generation: "ssh:" + hostId + ":1",
		helperCapabilities: [
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
			"fs.watch",
		],
	};
	const session = {
		hostRevision: 7,
		request: (method, params, requestOptions) => {
			capture = requestOptions?.onRequestId;
			try {
				return client.request(method, params, requestOptions);
			} finally {
				capture = undefined;
			}
		},
		cancel: (id, requestOptions) => client.cancel(id, requestOptions),
	};
	const lock = createRemoteHostOperationLock();
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (key, work) => handlers.set(key, work) } } } });
	const port = registerRemoteGitReadIpc({
		enabled: true,
		locator: () => ({ hostId, remotePath: f.root }),
		trusted: async () => true,
		service: () => ({
			withProjectSession: (host, root, work, requestOptions) =>
				lock.run(host, async () => {
					assert.equal(root, f.root);
					assert.equal(requestOptions.requireReady, true);
					if (requestOptions.signal.aborted) return { ok: false, code: "REQUEST_CANCELLED" };
					if (!client.open) return { ok: false, code: "SSH_HOST_NOT_READY" };
					return { ok: true, value: await work(session) };
				}),
		}),
	});
	function window(id) {
		const sender = new EventEmitter();
		sender.id = id;
		sender.isDestroyed = () => false;
		const event = { sender },
			states = [];
		// One fake preload namespace wired to the real IPC handlers, so the provider's token brokerage is the thing
		// under test (the controller itself never receives a token).
		const gitApi = {
			status: (project, repo) => port.status(event, project, repo),
			remoteSnapshot: (project, repo) => handlers.get(ipcChannels.gitRemoteSnapshot)(event, project, repo),
			refreshRemoteSnapshot: (project, repo) => handlers.get(ipcChannels.gitRemoteSnapshot)(event, project, repo, true),
			remoteRefs: (project, repo) => handlers.get(ipcChannels.gitRemoteRefs)(event, project, repo),
			syncFacts: (project, repo) => handlers.get(ipcChannels.gitRemoteSyncFacts)(event, project, repo),
			historyPage: (project, options, repo) => port.historyPage(event, project, options, repo),
			repositoryList: (project) => port.repositoryListing(event, project),
			compareRefs: (project, base, head, repo) => port.compareRefs(event, project, base, head, repo),
			refs: (project, repo) => port.refs(event, project, repo),
			workspaceFileDiff: (project, group, file, repo) => port.workspaceDiff(event, project, group, file, repo),
			mutateRemoteIndex: (project, operation, group, file, token, repo) => handlers.get(ipcChannels.gitRemoteMutateIndex)(event, project, operation, group, file, token, repo),
			commitRemote: (project, message, token, repo) => handlers.get(ipcChannels.gitRemoteCommit)(event, project, message, token, repo),
			discardRemote: (project, group, file, token, repo) => handlers.get(ipcChannels.gitRemoteDiscard)(event, project, group, file, token, repo),
			createRemoteBranch: (project, name, token, repo) => handlers.get(ipcChannels.gitRemoteCreateBranch)(event, project, name, token, repo),
			switchRemoteBranch: (project, name, token, repo) => handlers.get(ipcChannels.gitRemoteSwitchBranch)(event, project, name, token, repo),
			fetchRemote: (project, remote, token, repo) => handlers.get(ipcChannels.gitRemoteFetch)(event, project, remote, token, repo),
			pushRemote: (project, remote, branch, token, repo) => handlers.get(ipcChannels.gitRemotePush)(event, project, remote, branch, token, repo),
			pullRemote: (project, remote, branch, token, repo) => handlers.get(ipcChannels.gitRemotePull)(event, project, remote, branch, token, repo),
			recoveryList: (project, repo) => handlers.get(ipcChannels.gitRemoteRecoveryList)(event, project, repo),
			recoveryRestore: (project, ref, oid, path, token, repo) => handlers.get(ipcChannels.gitRemoteRecoveryRestore)(event, project, ref, oid, path, token, repo),
			recoveryDrop: (project, ref, oid, token, repo) => handlers.get(ipcChannels.gitRemoteRecoveryDrop)(event, project, ref, oid, token, repo),
			initRemote: (project) => handlers.get(ipcChannels.gitRemoteInit)(event, project),
			remoteCommitDetail: (project, oid, repo) => handlers.get(ipcChannels.gitRemoteCommitDetail)(event, project, oid, repo),
			remoteRefFileDiff: (project, base, head, file, repo) => handlers.get(ipcChannels.gitRemoteRefFileDiff)(event, project, base, head, file, repo),
			cancelRemoteReads: (project) => handlers.get(ipcChannels.gitRemoteCancelReads)(event, project),
		};
		const services = createProjectServices(remoteProject, { files: {}, remoteHosts: {}, remoteTrust: {}, git: gitApi }, { facts });
		// Three frozen-contract gaps still use the existing preload channels; here they are the same registered handlers.
		const api = createRemoteGitPanelApi(services, { git: gitApi });
		const controller = createRemoteGitViewController(projectId, "owned-identity", api, (state) => states.push(state), "", services.capabilities.git);
		t.after(() => {
			controller.dispose();
			sender.emit("destroyed");
		});
		return { controller, sender, api, current: () => states.at(-1) };
	}
	t.after(() => {
		port.dispose();
		client.closeConnection();
		input.close();
	});
	return {
		...f,
		calls,
		diagnostics,
		replies,
		client,
		lock,
		window,
		dropAppliedReply: () => {
			loseNextApplied = true;
		},
	};
}
function scratch(f) {
	return readdirSync(join(f.root, ".git")).filter((name) => name === "index.lock" || name.startsWith("pideck-index-"));
}

const bounded = { ...options, timeout: 45_000 };

test("remote Git lost applied reply remains unknown across reconnect, keeps the real staged blob, and never replays", bounded, async (t) => {
	const f = harness(t),
		view = f.window(1);
	await view.controller.refresh();
	f.dropAppliedReply();
	await view.controller.mutate("stage", "workingTree", target);
	assert.equal(view.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(view.current().snapshot, undefined);
	assert.equal(f.git("show", ":" + relativePath), "WORKING\r\n");
	const writes = () => f.calls.filter((frame) => frame.method === "git.stage");
	assert.equal(writes().length, 1);
	assert.ok(f.diagnostics.includes("REMOTE_FRAME_STALE_GENERATION"));
	for (let cycle = 0; cycle < 3; cycle++) view.controller.invalidateConnection();
	assert.equal(view.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	await view.controller.mutate("stage", "workingTree", target);
	assert.equal(writes().length, 1);
	f.client.closeConnection();
	await view.controller.refresh();
	assert.equal(view.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	f.client.openConnection();
	await view.controller.refresh();
	assert.equal(view.current().errorCode, undefined);
	assert.equal(view.current().snapshot.groups.index[0].target.relativePath, relativePath);
	assert.equal(writes().length, 1);
	assert.equal(f.client.pendingCount(), 0);
	assert.equal(f.lock.isBusy(hostId), false);
	assert.deepEqual(scratch(f), []);
});

test("two windows sharing one real helper cannot overwrite the first index write from a stale second snapshot", bounded, async (t) => {
	const f = harness(t),
		first = f.window(1),
		second = f.window(2);
	await Promise.all([first.controller.refresh(), second.controller.refresh()]);
	await Promise.all([first.controller.mutate("stage", "workingTree", target), second.controller.mutate("stage", "workingTree", target)]);
	assert.equal(first.current().errorCode, undefined);
	assert.equal(second.current().errorCode, "GIT_RESOURCE_CHANGED");
	assert.equal(f.git("show", ":" + relativePath), "WORKING\r\n");
	assert.equal(f.git("show", ":other.txt"), "OTHER\n");
	assert.equal(f.calls.filter((frame) => frame.method === "git.stage").length, 2);
	assert.equal(f.replies.filter((frame) => frame.result?.applied === true).length, 1);
	await second.controller.refresh();
	await second.controller.mutate("unstage", "index", target);
	assert.equal(second.current().errorCode, undefined);
	assert.equal(f.git("show", ":" + relativePath), "BASE\n");
	assert.equal(readFileSync(join(f.root, relativePath), "utf8"), "WORKING\r\n");
	assert.equal(f.client.pendingCount(), 0);
	assert.equal(f.lock.isBusy(hostId), false);
	assert.deepEqual(scratch(f), []);
});

test("canceling a host-lock queued window sends zero Git writes and does not revoke another window's grant", bounded, async (t) => {
	const f = harness(t),
		first = f.window(1),
		second = f.window(2);
	await Promise.all([first.controller.refresh(), second.controller.refresh()]);
	let release, entered;
	const ready = new Promise((accept) => {
		entered = accept;
	});
	const blocked = f.lock.run(hostId, () => {
		entered();
		return new Promise((accept) => {
			release = accept;
		});
	});
	await ready;
	const pending = first.controller.mutate("stage", "workingTree", target);
	await new Promise((accept) => setImmediate(accept));
	first.controller.invalidateConnection();
	release();
	await blocked;
	await pending;
	assert.equal(first.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(
		f.calls.some((frame) => frame.method === "git.stage"),
		false,
	);
	assert.equal(f.git("show", ":" + relativePath), "BASE\n");
	await second.controller.mutate("stage", "workingTree", target);
	assert.equal(second.current().errorCode, undefined);
	assert.equal(f.git("show", ":" + relativePath), "WORKING\r\n");
	assert.equal(f.calls.filter((frame) => frame.method === "git.stage").length, 1);
	assert.equal(f.client.pendingCount(), 0);
	assert.equal(f.lock.isBusy(hostId), false);
	assert.deepEqual(scratch(f), []);
});

test("bounded 24-cycle renderer/IPC/helper/native-Git soak keeps FDs, listeners, pending tables and scratch bounded", bounded, async (t) => {
	const f = harness(t),
		view = f.window(1);
	await view.controller.refresh();
	await f.client.request("echo", { text: "baseline" });
	const descriptors = () => readdirSync("/proc/" + f.child.pid + "/fd").length;
	const initialFds = descriptors(),
		head = f.git("rev-parse", "HEAD"),
		fileStats = statSync(join(f.root, relativePath), { bigint: true });
	for (let cycle = 0; cycle < 24; cycle++) {
		await view.controller.mutate("stage", "workingTree", target);
		assert.equal(view.current().errorCode, undefined, `stage cycle ${cycle}`);
		const diff = await view.api.workspaceFileDiff("index", target);
		assert.equal(diff.originalContent, "BASE\n");
		assert.equal(diff.modifiedContent, "WORKING\r\n");
		await view.controller.mutate("unstage", "index", target);
		assert.equal(view.current().errorCode, undefined, `unstage cycle ${cycle}`);
		assert.equal(f.client.pendingCount(), 0);
		assert.equal(f.lock.isBusy(hostId), false);
		assert.equal(view.sender.listenerCount("destroyed"), 1);
		assert.deepEqual(scratch(f), []);
		assert.equal(descriptors(), initialFds);
	}
	assert.equal(f.git("show", ":" + relativePath), "BASE\n");
	assert.equal(f.git("rev-parse", "HEAD"), head);
	assert.equal(readFileSync(join(f.root, relativePath), "utf8"), "WORKING\r\n");
	const finalStats = statSync(join(f.root, relativePath), { bigint: true });
	for (const field of ["ino", "mode", "size", "mtimeNs", "ctimeNs"]) assert.equal(finalStats[field], fileStats[field]);
	assert.equal(f.calls.filter((frame) => frame.method === "git.stage" || frame.method === "git.unstage").length, 48);
	view.controller.dispose();
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
});
