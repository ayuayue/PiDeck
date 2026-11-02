import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createManualTimers, createPinnedClient, createPinnedHostFixture, flushMicrotasks } from "./helpers/sshPinnedHostFixture.mjs";

/*
 * F4 independent verification of the project-level root status (task-20, H3).
 *
 * The design under test is (i): a drifted root is a property of *one project's persisted path*, not of the
 * host, so a moved directory must not make its healthy neighbours on the same host look broken. That claim
 * is only worth anything if it is asserted directly, so the central test here builds two projects on one
 * host, drifts one of them, and then reads both statuses back through the IPC channel while counting every
 * helper request the queries caused.
 *
 * The status channel is driven at its real boundary: the production registerRemoteProjectIpc over a stubbed
 * ipcMain, with the production connection service over the production manager (only the launcher, the
 * bootstrap and the root probe are substituted), so the recorded failure is the one the service actually
 * recorded and not a fake agreeing with itself.
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
	stubs: { electron: { ipcMain: { handle: undefined } } },
});
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const ROOT_A = "/srv/app";
const ROOT_B = "/srv/other";
const ROOT_C = "/srv/third";
const STATUS_CHANNEL = "remote:project-root-status";
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
/** The old-helper fixture: these builds answered `hello` long before content search existed. */
const FIXTURE_CAPABILITIES = ["echo", "fs.stat", "fs.list", "fs.read", "fs.searchNames"];

const plain = (value) => JSON.parse(JSON.stringify(value));

/** The same fake launcher the earlier batches used: it answers the handshake and echoes the launched root. */
function createFakeLauncher(options = {}) {
	const requests = [];
	return {
		requests,
		launcher: {
			async start(request) {
				requests.push(request);
				const command = (request.invocation?.args ?? []).join(" ");
				const requestedRoot = /--root '([^']*)'/.exec(command);
				const askedRoot = requestedRoot === null ? null : requestedRoot[1];
				const canonical = typeof options.canonicalRoot === "function" && askedRoot !== null ? options.canonicalRoot(askedRoot) : askedRoot;
				const emitter = new EventEmitter();
				const exitListeners = new Set();
				let answered = false;
				return {
					pid: 4321,
					write(line) {
						const frame = JSON.parse(line);
						if (frame.method !== "hello" || answered) return;
						answered = true;
						const result = {
							protocolVersion: 1,
							platform: "linux",
							arch: "x64",
							home: "/home/dev",
							root: canonical,
							capabilities: typeof options.capabilities === "function" ? options.capabilities() : FIXTURE_CAPABILITIES,
							helperVersion: "1.6.0",
							nodeVersion: "v22.14.0",
							pid: 321,
						};
						queueMicrotask(() => emitter.emit("stdout", JSON.stringify({ v: 1, hostId: frame.hostId, generation: frame.generation, id: frame.id, ok: true, result })));
					},
					onExit(listener) {
						exitListeners.add(listener);
						return () => exitListeners.delete(listener);
					},
					onStdoutLine(listener) {
						emitter.on("stdout", listener);
						return () => emitter.off("stdout", listener);
					},
					onStderrLine() {
						return () => undefined;
					},
					async stop() {
						for (const listener of [...exitListeners]) listener({ kind: "stopped", code: null, signal: null });
					},
				};
			},
		},
	};
}

/**
 * Two remote projects on one host over the production service. Only the launcher, the bootstrap port and the
 * root probe are substituted; the manager, the reducer and the service are the shipped ones.
 */
async function projectHarness(t) {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const control = { canonicalByRoot: new Map(), probeFailsFor: new Set(), verifyCalls: [], bootstraps: 0, rootMap: new Map(), capabilities: undefined };
	const fake = createFakeLauncher({ canonicalRoot: (requested) => control.rootMap.get(requested) ?? requested, capabilities: () => control.capabilities ?? FIXTURE_CAPABILITIES });
	const ports = {
		bootstrap: async () => {
			control.bootstraps += 1;
			return { bundleSha256: "a".repeat(64), deployRoot: "/home/dev/.pideck/remote-host" };
		},
		resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v22.14.0", probed: 1 }),
		createSentinel: () => "sentinel00000001",
		createNonce: () => "nonce-000000000001",
		verifyRoot: async ({ hostId, userPath }) => {
			control.verifyCalls.push({ hostId, userPath });
			if (control.probeFailsFor.has(userPath)) throw new Error("REMOTE_BROWSE_ROOT_UNRESOLVED");
			const override = control.canonicalByRoot.get(userPath);
			return { canonicalPath: override === undefined ? userPath : override };
		},
	};
	const states = [];
	const service = createRemoteHostConnectionService({
		userDataDir: directory,
		client,
		launcher: fake.launcher,
		nodePath: "/usr/bin/node",
		ports,
		onStateChange: (entry) => states.push({ hostId: entry.hostId, state: entry.state.state, code: entry.state.lastCode }),
	});
	t.after(() => service.dispose());
	const read = (root) => service.withProjectSession(profile.id, root, async () => "ran");
	return { directory, profile, fake, control, states, service, read };
}

/** Register the project IPC domain over a stubbed ipcMain and hand back the captured handlers. */
function registerProjectIpc(service, hostId, locators) {
	const handlers = new Map();
	const electron = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
	const module = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", { stubs: { electron } });
	module.registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/ignored",
		service: () => service,
		projects: {
			enroll: async () => ({ projectId: "unused" }),
			locator: (projectId) => locators[projectId],
		},
	});
	void hostId;
	return handlers;
}

async function rootStatus(handlers, projectId) {
	const handler = handlers.get(STATUS_CHANNEL);
	assert.ok(handler !== undefined, "remoteProjectIpc must register the frozen channel " + STATUS_CHANNEL + " (registered: " + [...handlers.keys()].join(",") + ")");
	return handler({}, projectId);
}

test("a drifted project is needs-attention while its healthy neighbour on the same host stays ok", async (t) => {
	const { profile, fake, control, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
		"project-b": { kind: "ssh", hostId: profile.id, remotePath: ROOT_B },
	});
	// When the shared contract carries the constant it must be exactly the frozen literal; the handler lookup
	// below is what proves the registration used it.
	if (ipcChannels.remoteProjectRootStatus !== undefined) assert.equal(ipcChannels.remoteProjectRootStatus, STATUS_CHANNEL);

	// Both projects start healthy on the same host. In the default single-session mode reading B replaced the
	// session of A, so A has no live session to answer for: its capabilities are unknown, not B's hello list
	// (a pooled service that keeps A's session alive may report A's own list here - never a sibling's).
	assert.equal((await read(ROOT_A)).ok, true);
	assert.equal((await read(ROOT_B)).ok, true);
	assert.deepEqual(plain(await rootStatus(handlers, "project-a")), { ok: true, value: { status: "ok" } }, "the session of B root must not answer for project A");
	assert.deepEqual(plain(await rootStatus(handlers, "project-b")), { ok: true, value: { status: "ok", helperCapabilities: FIXTURE_CAPABILITIES } });

	// Project A's persisted path is re-pointed somewhere else. Switching back to A is where the service
	// re-probes it; the probe now canonicalizes to a different path.
	control.canonicalByRoot.set(ROOT_A, ROOT_A + "-moved");
	const refused = await read(ROOT_A);
	assert.equal(refused.ok, false, JSON.stringify(refused));
	assert.equal(refused.code, "SSH_PROJECT_ROOT_CHANGED");

	// The healthy neighbour keeps serving on the same host...
	const healthy = await read(ROOT_B);
	assert.equal(healthy.ok, true, "a healthy project must not be blocked by its neighbour's drift: " + JSON.stringify(healthy));

	// ...and the statuses say exactly that.
	const statusA = await rootStatus(handlers, "project-a");
	assert.equal(statusA.ok, true, JSON.stringify(statusA));
	assert.equal(statusA.value.status, "needs-attention", "the drifted project must be flagged: " + JSON.stringify(statusA));
	assert.match(statusA.value.code, STABLE_CODE, "the recorded reason must be a stable code");
	const statusB = await rootStatus(handlers, "project-b");
	assert.equal(statusB.ok, true, JSON.stringify(statusB));
	assert.equal(statusB.value.status, "ok", "design (i): the neighbour's status must stay ok, got " + JSON.stringify(statusB));
	assert.equal(statusB.value.code, undefined, "a healthy project has no reason code");

	// Repeated queries are stable and must not accumulate state.
	assert.deepEqual(plain(await rootStatus(handlers, "project-a")), plain(statusA));
	assert.deepEqual(plain(await rootStatus(handlers, "project-b")), plain(statusB));
	void fake;
});

test("root status 暴露 hello 能力清单：旧 helper 由能力回退决定内容搜索边界", async (t) => {
	// 1) Before any live session the status must not invent capabilities: the query itself opens no session.
	const cold = await projectHarness(t);
	const coldHandlers = registerProjectIpc(cold.service, cold.profile.id, { "project-a": { kind: "ssh", hostId: cold.profile.id, remotePath: ROOT_A } });
	const coldStatus = await rootStatus(coldHandlers, "project-a");
	assert.equal(coldStatus.ok, true);
	assert.equal(coldStatus.value.helperCapabilities, undefined, "no live session => unknown, never a guessed list");
	assert.equal(cold.fake.requests.length, 0, "the status query itself must not connect");

	// 2) An old helper declares its vocabulary without fs.searchContent: the renderer sees exactly that and falls back.
	const oldHelper = await projectHarness(t);
	const oldHandlers = registerProjectIpc(oldHelper.service, oldHelper.profile.id, { "project-a": { kind: "ssh", hostId: oldHelper.profile.id, remotePath: ROOT_A } });
	assert.equal((await oldHelper.read(ROOT_A)).ok, true);
	const oldStatus = await rootStatus(oldHandlers, "project-a");
	assert.deepEqual(plain(oldStatus.value.helperCapabilities), FIXTURE_CAPABILITIES, "the reported list is the helper's own hello answer");
	assert.equal(oldStatus.value.helperCapabilities.includes("fs.searchContent"), false, "an old helper must not be reported as content-search capable");

	// 3) A helper that declares fs.searchContent is reported as capable: this is the only source of the renderer gate.
	const newHelper = await projectHarness(t);
	newHelper.control.capabilities = [...FIXTURE_CAPABILITIES, "fs.searchContent"];
	const newHandlers = registerProjectIpc(newHelper.service, newHelper.profile.id, { "project-a": { kind: "ssh", hostId: newHelper.profile.id, remotePath: ROOT_A } });
	assert.equal((await newHelper.read(ROOT_A)).ok, true);
	const newStatus = await rootStatus(newHandlers, "project-a");
	assert.equal(newStatus.value.helperCapabilities.includes("fs.searchContent"), true, "a capable helper must be visible to the renderer gate");
});

test("the status query is read-only: no session work, no helper request, no state change", async (t) => {
	const { profile, fake, control, states, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
	});
	assert.equal((await read(ROOT_A)).ok, true);
	// A ready session is not re-probed, so the host is moved onto project B first: the next read of A has to
	// re-establish and therefore runs the root probe that records the failure.
	assert.equal((await read(ROOT_B)).ok, true);
	control.canonicalByRoot.set(ROOT_A, ROOT_A + "-moved");
	assert.equal((await read(ROOT_A)).ok, false);

	const requestsBefore = fake.requests.length;
	const bootstrapsBefore = control.bootstraps;
	const verifiesBefore = control.verifyCalls.length;
	const statesBefore = states.length;
	const probesBefore = control.verifyCalls.map((call) => call.userPath).length;

	for (let index = 0; index < 5; index += 1) {
		const status = await rootStatus(handlers, "project-a");
		assert.equal(status.ok, true);
		assert.equal(status.value.status, "needs-attention");
	}
	assert.equal(fake.requests.length, requestsBefore, "a status query must not launch a process");
	assert.equal(control.bootstraps, bootstrapsBefore, "a status query must not bootstrap a helper");
	assert.equal(control.verifyCalls.length, verifiesBefore, "a status query must not probe the remote");
	assert.equal(control.verifyCalls.map((call) => call.userPath).length, probesBefore);
	assert.equal(states.length, statesBefore, "a status query must not change any connection state");
});

test("a successful re-check clears the recorded failure back to ok", async (t) => {
	const { profile, control, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
	});
	assert.equal((await read(ROOT_A)).ok, true);
	assert.equal((await read(ROOT_B)).ok, true);
	control.canonicalByRoot.set(ROOT_A, ROOT_A + "-moved");
	assert.equal((await read(ROOT_A)).ok, false);
	assert.equal((await rootStatus(handlers, "project-a")).value.status, "needs-attention");

	// The directory is put back: the next establishment must succeed and clear the recorded reason.
	control.canonicalByRoot.delete(ROOT_A);
	assert.equal((await read(ROOT_A)).ok, true, "the restored root must be readable again");
	const cleared = await rootStatus(handlers, "project-a");
	assert.equal(cleared.value.status, "ok", "a successful re-check must clear the recorded failure: " + JSON.stringify(cleared));
	assert.equal(cleared.value.code, undefined);
});

test("an unresolvable root records its own stable code", async (t) => {
	const { profile, control, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
	});
	assert.equal((await read(ROOT_A)).ok, true);
	assert.equal((await read(ROOT_B)).ok, true);
	control.probeFailsFor.add(ROOT_A);
	const refused = await read(ROOT_A);
	assert.equal(refused.ok, false);
	const status = await rootStatus(handlers, "project-a");
	assert.equal(status.value.status, "needs-attention");
	assert.equal(status.value.code, "SSH_PROJECT_ROOT_UNRESOLVED", "the probe's own code must be what is recorded");
});

test("root status 按本项目 root 查询能力：兄弟 root 与主机级清单都不能冒充", async () => {
	const calls = { rootStatus: [], capabilities: [], hostCapabilities: 0, sessions: 0 };
	// 同主机两个项目各有自己的清单；第三个项目在这台主机上没有会话。
	const capabilitiesByRoot = new Map([
		[ROOT_A, ["echo", "root-a"]],
		[ROOT_B, ["echo", "root-b"]],
	]);
	const service = {
		projectRootStatus: (hostId, root) => {
			calls.rootStatus.push({ hostId, root });
			return { status: "ok" };
		},
		projectHelperCapabilities: (hostId, root) => {
			calls.capabilities.push({ hostId, root });
			return capabilitiesByRoot.get(root);
		},
		// 主机级入口仍供真正的主机控制面使用；项目事实查询不得消费它。
		helperCapabilities: () => {
			calls.hostCapabilities += 1;
			return [...FIXTURE_CAPABILITIES, "fs.searchContent"];
		},
		withProjectSession: async () => {
			calls.sessions += 1;
			throw new Error("a status query must not establish a session");
		},
	};
	const handlers = registerProjectIpc(service, HOST_ID, {
		"project-a": { kind: "ssh", hostId: HOST_ID, remotePath: ROOT_A },
		"project-b": { kind: "ssh", hostId: HOST_ID, remotePath: ROOT_B },
		"project-c": { kind: "ssh", hostId: HOST_ID, remotePath: ROOT_C },
	});
	// A 得到的是 A 自己 root 的清单，B 得到 B 的：handler 不会拿兄弟 root 的答案顶上。
	assert.deepEqual(plain(await rootStatus(handlers, "project-a")), { ok: true, value: { status: "ok", helperCapabilities: ["echo", "root-a"] } });
	assert.deepEqual(plain(await rootStatus(handlers, "project-b")), { ok: true, value: { status: "ok", helperCapabilities: ["echo", "root-b"] } });
	assert.deepEqual(
		calls.capabilities,
		[
			{ hostId: HOST_ID, root: ROOT_A },
			{ hostId: HOST_ID, root: ROOT_B },
		],
		"能力查询必须带项目自己的 canonical root",
	);
	// 第三个项目在这台主机上没有会话：unknown，不回退主机级清单。
	assert.deepEqual(plain(await rootStatus(handlers, "project-c")), { ok: true, value: { status: "ok" } });
	assert.deepEqual(calls.capabilities.at(-1), { hostId: HOST_ID, root: ROOT_C });
	assert.equal(calls.hostCapabilities, 0, "主机级 helperCapabilities 不是项目事实入口");
	assert.equal(calls.sessions, 0, "状态查询不得建立会话");
	assert.deepEqual(calls.rootStatus, [
		{ hostId: HOST_ID, root: ROOT_A },
		{ hostId: HOST_ID, root: ROOT_B },
		{ hostId: HOST_ID, root: ROOT_C },
	]);
});

test("unknown, non-ssh and invalid project ids are refused with stable codes", async (t) => {
	const { profile, service } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
		"project-local": { kind: "local", environment: "native", localPath: "/tmp/local-project" },
	});
	for (const projectId of ["project-missing", "project-local", "", 7, undefined, null]) {
		const status = await rootStatus(handlers, projectId);
		assert.equal(status.ok, false, JSON.stringify(projectId) + " must be refused: " + JSON.stringify(status));
		assert.match(status.code, STABLE_CODE, JSON.stringify(projectId) + " answered " + status.code);
	}
});

test("the whole domain is inert when the feature gate is off", async (t) => {
	const { profile, control, fake, service } = await projectHarness(t);
	const handlers = new Map();
	const electron = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
	loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", { stubs: { electron } }).registerRemoteProjectIpc({
		enabled: false,
		userDataDir: "/tmp/ignored",
		service: () => service,
		projects: { enroll: async () => ({ projectId: "x" }), locator: () => ({ kind: "ssh", hostId: profile.id, remotePath: ROOT_A }) },
	});
	const status = await rootStatus(handlers, "project-a");
	assert.equal(status.ok, false);
	assert.equal(status.code, "REMOTE_FEATURE_DISABLED");
	assert.equal(fake.requests.length, 0);
	assert.equal(control.bootstraps, 0);
});

/*
 * Rendering-branch guard for the project-level status tag. The state machine and the IPC channel are
 * asserted above; what this pins is that the tag cannot silently disappear, cannot turn into noise for a
 * healthy project, and cannot lose one of its two dictionaries.
 */

test("the needs-attention tag renders only for a needs-attention status and is mounted by the project tree", () => {
	const tag = readFileSync("src/renderer/src/components/sidebar/RemoteProjectStatusTag.tsx", "utf8");
	// ok / unavailable / unknown all render nothing: the tag exists only to surface something actionable.
	assert.match(tag, /if\s*\(status\?\.status !== "needs-attention"\)\s*return null;/, "the tag must render nothing unless the status needs attention");
	assert.ok(tag.includes('t("sidebar.remoteProject.needsAttention")'), "the tag must use its own copy key");
	// A missing code still shows the tag, with the generic hint; a code becomes the troubleshooting hint.
	assert.match(tag, /status\.code === null[\s\S]{0,200}?needsAttentionHint"/);
	assert.match(tag, /needsAttentionHintCode", \{ code: status\.code \}/);

	const tree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
	assert.ok(tree.includes('import { RemoteProjectStatusTag } from "./RemoteProjectStatusTag"'), "the tree must import the tag");
	assert.match(tree, /isRemoteProject\(project\)\s*\?\s*<RemoteProjectStatusTag projectId=\{project\.id\}\s*\/>\s*:\s*null/, "the tag must be mounted for remote projects only");
	// One batched, host-scoped query for the whole list instead of a query per row.
	assert.ok(tree.includes("useRemoteProjectRootStatuses("), "the tree must use the batched status hook");

	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const key of ["sidebar.remoteProject.needsAttention", "sidebar.remoteProject.needsAttentionHint", "sidebar.remoteProject.needsAttentionHintCode"]) {
		assert.ok(zh.includes('"' + key + '":'), "zh-CN is missing " + key);
		assert.ok(en.includes('"' + key + '":'), "en-US is missing " + key);
	}
});
