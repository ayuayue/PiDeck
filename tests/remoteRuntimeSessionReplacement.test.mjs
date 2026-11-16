import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as localFs from "node:fs";
import * as localFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// Exercise the real RPC consumer, catalog, replacement owner, coordinator and IPC.
// Only pi and the existing remote session-root probe are substitutes; no SSH/network.
let localFsCalls = [];
const forbidLocalFs = (module) =>
	Object.fromEntries(
		Object.keys(module).map((name) => [
			name,
			typeof module[name] === "function"
				? () => {
						localFsCalls.push(name);
						throw new Error("LOCAL_SESSION_FS_FORBIDDEN");
					}
				: module[name],
		]),
	);
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", { stubs: { "node:fs": forbidLocalFs(localFs), "node:fs/promises": forbidLocalFs(localFsPromises) } });
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");
const { createAgentSessionReplacer } = loadTsCommonJs("src/main/sessions/agentSessionReplacement.ts");
const { createSessionForkCommands } = loadTsCommonJs("src/main/sessions/sessionForkCommands.ts");
const { createRemoteRuntimePort } = loadTsCommonJs("src/main/pi/remoteRuntimePort.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const HOST = "11111111-1111-4111-8111-111111111111";
const ROOT = "/home/dev/.pi/agent/sessions";
const OLD = ROOT + "/--srv-app--/old.jsonl";
const NEW = ROOT + "/--srv-app--/new.jsonl";
const PROJECT = { id: "remote-project", name: "Remote", locator: { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Local catalog persistence is allowed; remote session files never reach local readers. */
async function setup(t, behavior = "success") {
	const dir = await mkdtemp(join(tmpdir(), "pideck-remote-replacement-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const forbidden = [];
	localFsCalls = forbidden;
	const deny = (name) => () => {
		forbidden.push(name);
		throw new Error("LOCAL_SESSION_ACCESS_FORBIDDEN");
	};
	const catalog = new SessionCatalog(join(dir, "catalog.json"), {}, deny("resolveFilePath"));
	await catalog.load();
	catalog.getLocalFilePath = deny("getLocalFilePath");
	const origin = await catalog.ensureRemoteSession({ projectId: PROJECT.id, hostId: HOST, remoteSessionId: "--srv-app--/old.jsonl", remotePath: OLD, title: "Origin", updatedAt: 1 });
	const oldEntry = plain(catalog.get(origin.record.id));
	const requests = [];
	const registrations = [];
	const events = [];
	let piFile = OLD;
	let piId = "pi-old";
	let piName = "Origin";
	const port = createRemoteRuntimePort({
		resolveCatalog: () => catalog,
		settings: () => ({}),
		resolveService: () => ({
			remoteHome: async () => "/home/dev",
			withProjectSession: async () => ({ ok: false, code: "PATH_NOT_FOUND" }),
		}),
	});
	const remoteRuntime = {
		...port,
		registerRemoteSession: async (input) => {
			registrations.push(plain(input));
			if (behavior === "registration-error") throw new Error("REMOTE_RUNTIME_UNAVAILABLE");
			const registration = await port.registerRemoteSession(input);
			if (behavior === "wrong-host") registration.record.locator.hostId = "22222222-2222-4222-8222-222222222222";
			return registration;
		},
	};
	const manager = new AgentManager(
		(id) => (id === PROJECT.id ? PROJECT : undefined),
		() => null,
		{ get: () => ({}) },
		{},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		remoteRuntime,
	);
	manager.normalizeSessionPathFromPi = deny("normalizeSessionPathFromPi");
	manager.readRecentMessagesFromSessionFile = deny("readRecentMessagesFromSessionFile");
	manager.loadMessages = deny("loadMessages");
	const tab = { id: "agent-1", projectId: PROJECT.id, deckSessionId: origin.record.id, title: "Origin", status: "idle", createdAt: 1, cwd: "/srv/app", sessionPath: OLD, sessionId: "pi-old", sessionSource: "pi", sessionEnvironment: "native" };
	manager.agents.set(tab.id, {
		tab,
		process: {
			client: {
				async request(request) {
					requests.push(plain(request));
					if (request.type === "fork" || request.type === "clone") {
						if (behavior === "rpc-error") return { success: false, error: "RPC_REJECTED" };
						if (behavior === "cancelled") return { success: true, data: { cancelled: true, text: "selected" } };
						piFile = behavior === "invalid-path" ? "/outside/new.jsonl" : NEW;
						piId = "pi-new";
						if (behavior === "transport-error") throw new Error("RPC_CLIENT_CLOSED");
						if (behavior === "rejection-after-change") return { success: false, error: "RPC_REBIND_FAILED" };
						return { success: true, data: { cancelled: false, text: "selected" } };
					}
					if (request.type === "get_state") {
						if (behavior === "state-error") throw new Error("RPC_STATE_FAILED");
						if (behavior === "missing-path") return { success: true, data: { sessionId: piId } };
						return { success: true, data: { sessionFile: piFile, sessionId: piId, sessionName: piName } };
					}
					if (request.type === "set_session_name") {
						if (behavior === "rename-error") throw new Error("RPC_RENAME_FAILED");
						piName = request.name;
						if (behavior === "rename-path-drift") piFile = ROOT + "/--srv-app--/third.jsonl";
						return { success: true };
					}
					assert.fail("Unexpected RPC: " + request.type);
				},
			},
		},
	});
	manager.messages.set(tab.id, [{ id: "old-message", role: "user", text: "Origin-only tail", timestamp: 1 }]);
	manager.sessionFileVersionByAgent.set(tab.id, "old-version");
	// 合并后自动标题的待决标记在 ExtensionUiGate 内（dev 拆分 Wave 4B），不再挂在 AgentManager 顶层。
	manager.uiGate.pendingAutomaticTitles.set(tab.id, { title: "Pending origin", sessionId: origin.record.id, runtimeGeneration: 1 });
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		manager,
		async () => ({ accepted: true }),
		undefined,
		undefined,
		undefined,
		(id) => (id === PROJECT.id ? PROJECT.locator : undefined),
	);
	coordinator.bindExistingAgent(origin.record.id, tab.id);
	const replace = createAgentSessionReplacer({
		agentManager: manager,
		sessionCatalog: catalog,
		sessionRuntimeCoordinator: coordinator,
		appLogger: { warn: (_scope, _message, detail) => events.push({ kind: "warn", detail: plain(detail) }) },
		forkedSuffix: () => "(fork)",
		resolveProjectLocator: (projectId) => (projectId === PROJECT.id ? PROJECT.locator : undefined),
		onDetached: (binding) => events.push({ kind: "detach", binding: plain(binding) }),
		onAttached: (binding) => events.push({ kind: "attach", binding: plain(binding) }),
		onRestored: (binding) => events.push({ kind: "restore", binding: plain(binding) }),
	});
	if (behavior === "metadata-error")
		catalog.update = async () => {
			throw new Error("SESSION_CATALOG_BUSY");
		};
	const handlers = new Map();
	// dev 把 fork/clone 命令链收口到 sessionForkCommands（桌面 IPC 与 Web 共用）：IPC 只转发，
	// 真正的替换语义仍由本文件注入的 replacer 承担，所以这里用与 main/index.ts 同形的装配。
	const sessionForkCommands = createSessionForkCommands({
		sessionRuntimeCoordinator: coordinator,
		agentManager: manager,
		replaceAgentSession: replace,
		isDshAgent: () => false,
		logger: { info: () => undefined },
		notifyForkCatalogRefreshed: () => undefined,
	});
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", { stubs: { electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, app: { getPath: () => dir } } } });
	registerSessionIpc({
		projectStore: { get: () => PROJECT },
		sessionCatalog: catalog,
		sessionScanner: {},
		settingsStore: { get: () => ({}) },
		sessionRuntimeCoordinator: coordinator,
		agentManager: manager,
		sessionForkCommands,
		replaceAgentSession: replace,
		mainCopy: (key) => key,
		appLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
		getMainWindow: () => undefined,
	});
	const invoke = (operation) => handlers.get(operation === "fork" ? ipcChannels.sessionsRuntimeFork : ipcChannels.sessionsRuntimeClone)({}, coordinator.getTarget(origin.record.id), "entry-1");
	return { catalog, manager, coordinator, origin, oldEntry, forbidden, requests, registrations, events, tab, invoke, replace };
}

for (const operation of ["fork", "clone"]) {
	test(`remote live ${operation} registers the RPC file as SSH and rebinds without rewriting origin`, async (t) => {
		const h = await setup(t);
		const response = await h.invoke(operation);
		assert.equal(response.ok, true, JSON.stringify(response));
		const id = response.value.targetSessionId;
		assert.notEqual(id, h.origin.record.id);
		const target = h.catalog.get(id);
		assert.deepEqual(plain(target.locator), { kind: "ssh", hostId: HOST, remoteSessionId: "--srv-app--/new.jsonl", remotePath: NEW });
		assert.equal(target.filePath, undefined);
		assert.equal(target.originKey, undefined);
		assert.equal(target.title, "Origin (fork)");
		assert.equal(target.forked, true);
		assert.equal(h.tab.sessionPath, NEW);
		assert.equal(h.tab.sessionId, "pi-new");
		assert.equal(h.tab.deckSessionId, id);
		assert.equal(h.manager.uiGate.pendingAutomaticTitles.has(h.tab.id), false, "换绑成功后旧会话的待决自动标题必须清掉");
		assert.equal(h.coordinator.getSessionId(h.tab.id), id);
		assert.equal(h.coordinator.getAgentId(h.origin.record.id), undefined);
		assert.equal(h.coordinator.validateTarget({ sessionId: h.origin.record.id, agentId: h.tab.id, runtimeGeneration: 1 }).ok, false);
		assert.deepEqual(plain(h.catalog.get(h.origin.record.id)), h.oldEntry);
		// Subsequent attach must operate on the new record, never absorb/repoint origin.
		await h.catalog.attachRuntime({ sessionId: id, remoteLocator: target.locator });
		assert.deepEqual(plain(h.catalog.get(h.origin.record.id)), h.oldEntry);
		assert.equal(h.catalog.listEntries().length, 2);
		assert.deepEqual(h.forbidden, []);
		assert.deepEqual(h.registrations, [{ hostId: HOST, projectId: PROJECT.id, projectRemotePath: PROJECT.locator.remotePath, remotePath: NEW }]);
		assert.deepEqual(
			h.events.map((event) => event.kind),
			["detach", "attach"],
		);
		assert.deepEqual(plain(h.manager.getMessageWindow(h.tab.id)), { messages: [], totalLength: 0 });
		assert.equal(h.requests[0].type, operation);
		if (operation === "fork") assert.equal(h.requests[0].entryId, "entry-1");
	});

	test(`cancelled remote ${operation} preserves identity and skips state/register/read`, async (t) => {
		const h = await setup(t, "cancelled");
		const response = await h.invoke(operation);
		assert.equal(response.ok, true);
		assert.deepEqual(plain(response.value), { cancelled: true, text: "selected" });
		assert.deepEqual(
			h.requests.map((request) => request.type),
			[operation],
		);
		assert.deepEqual(h.registrations, []);
		assert.equal(h.tab.sessionPath, OLD);
		assert.equal(h.tab.sessionId, "pi-old");
		assert.equal(h.coordinator.getSessionId(h.tab.id), h.origin.record.id);
		assert.equal(h.manager.getMessages(h.tab.id)[0].id, "old-message");
		assert.equal(h.manager.getMessageWindow(h.tab.id).fileVersion, "old-version");
		assert.equal(h.manager.uiGate.pendingAutomaticTitles.has(h.tab.id), true, "取消的 fork 不得丢失原会话的待决标题");
		assert.deepEqual(plain(h.catalog.get(h.origin.record.id)), h.oldEntry);
		assert.deepEqual(h.forbidden, []);
		assert.deepEqual(
			h.events.map((event) => event.kind),
			["detach", "restore"],
		);
	});

	test(`remote ${operation} rejection before replacement restores matching SSH origin`, async (t) => {
		const h = await setup(t, "rpc-error");
		assert.equal((await h.invoke(operation)).ok, false);
		assert.deepEqual(
			h.requests.map((request) => request.type),
			[operation, "get_state"],
		);
		assert.equal(h.coordinator.getSessionId(h.tab.id), h.origin.record.id);
		assert.deepEqual(
			h.events.map((event) => event.kind),
			["detach", "restore"],
		);
		assert.deepEqual(h.registrations, []);
		assert.deepEqual(h.forbidden, []);
	});
}

for (const behavior of ["registration-error", "invalid-path", "state-error", "missing-path", "transport-error", "rejection-after-change"]) {
	test(`remote replacement ${behavior} fails closed after RPC and preserves origin record`, async (t) => {
		const h = await setup(t, behavior);
		const response = await h.invoke("clone");
		assert.equal(response.ok, false);
		assert.equal(h.coordinator.getSessionId(h.tab.id), undefined);
		assert.equal(h.coordinator.getAgentId(h.origin.record.id), undefined);
		assert.deepEqual(plain(h.catalog.get(h.origin.record.id)), h.oldEntry);
		assert.equal(h.catalog.listEntries().length, 1);
		assert.deepEqual(
			h.events.map((event) => event.kind),
			["detach"],
		);
		assert.deepEqual(h.forbidden, []);
		assert.equal(h.requests.filter((request) => request.type === "clone").length, 1, "uncertain write must not be retried");
	});
}

test("remote suffix rename failure keeps registered SSH target with redacted warning", async (t) => {
	const h = await setup(t, "rename-error");
	const response = await h.invoke("fork");
	assert.equal(response.ok, true);
	const target = h.catalog.get(response.value.targetSessionId);
	assert.equal(target.title, "Origin");
	assert.equal(target.forked, true);
	assert.equal(target.locator.kind, "ssh");
	assert.deepEqual(plain(h.catalog.get(h.origin.record.id)), h.oldEntry);
	assert.deepEqual(h.forbidden, []);
	const warning = h.events.find((event) => event.kind === "warn");
	assert.deepEqual(warning.detail, { agentId: h.tab.id, sessionId: h.origin.record.id, code: "SESSION_FORK_SUFFIX_RENAME_FAILED" });
});

for (const behavior of ["wrong-host", "metadata-error", "rename-path-drift"]) {
	test(`remote replacement ${behavior} refuses target binding, leaving discovered file recoverable`, async (t) => {
		const h = await setup(t, behavior);
		const response = await h.invoke("clone");
		assert.equal(response.ok, false);
		assert.equal(h.coordinator.getSessionId(h.tab.id), undefined);
		assert.deepEqual(plain(h.catalog.get(h.origin.record.id)), h.oldEntry);
		assert.equal(h.catalog.listEntries().length, 2);
		assert.deepEqual(
			h.events.map((event) => event.kind),
			["detach"],
		);
		assert.deepEqual(h.forbidden, []);
	});
}

test("remote registration capability missing rejects before pi writes and restores origin", async (t) => {
	const h = await setup(t);
	h.manager.remoteRuntime = undefined;
	const response = await h.invoke("fork");
	assert.equal(response.ok, false);
	assert.match(response.error.debugDetails, /REMOTE_SESSION_CATALOG_IDENTITY_UNSUPPORTED/);
	assert.deepEqual(h.requests, []);
	assert.deepEqual(h.registrations, []);
	assert.deepEqual(h.forbidden, []);
	assert.equal(h.coordinator.getSessionId(h.tab.id), h.origin.record.id);
	assert.deepEqual(
		h.events.map((event) => event.kind),
		["detach", "restore"],
	);
});

test("remote resolver rejects a target id not belonging to the post-RPC file", async (t) => {
	const h = await setup(t);
	await assert.rejects(
		h.replace(
			h.tab.id,
			async () => {
				const result = await h.manager.cloneSession(h.tab.id);
				return { ...result, targetSessionId: h.origin.record.id };
			},
			{ markForked: true },
		),
		/REMOTE_SESSION_LOCATOR_UNRESOLVED/,
	);
	assert.equal(h.coordinator.getSessionId(h.tab.id), undefined);
	assert.deepEqual(plain(h.catalog.get(h.origin.record.id)), h.oldEntry);
	assert.equal(
		h.requests.some((request) => request.type === "set_session_name"),
		false,
	);
	assert.deepEqual(h.forbidden, []);
});
