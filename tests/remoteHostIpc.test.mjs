import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function handlersFor(input) {
	const handlers = new Map();
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle(channel, handler) {
						handlers.set(channel, handler);
					},
				},
			},
		},
	});
	registerRemoteHostIpc(input);
	return handlers;
}

function handlerFor(input) {
	return handlersFor(input).get("remote:hosts-list");
}

test("remote host channel is declared, bridged, and registered behind the dev gate", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const main = readFileSync("src/main/index.ts", "utf8");
	const catalog = readFileSync("src/main/remote/RemoteHostCatalogView.ts", "utf8");
	assert.match(shared, /remoteHostsList:\s*"remote:hosts-list"/);
	assert.match(preload, /remoteHosts:\s*\{[\s\S]*?ipcRenderer\.invoke\(ipcChannels\.remoteHostsList\)/);
	// 门禁把开关接到一个局部变量上（连接服务需要懒构建），再传给注册点。
	assert.match(main, /remoteExperimentEnabled\s*=\s*!app\.isPackaged\s*&&\s*process\.env\.PIDECK_REMOTE_EXPERIMENTAL\s*===\s*"1"/);
	assert.match(main, /registerRemoteHostIpc\(\{[\s\S]{0,400}?enabled:\s*remoteExperimentEnabled/);
	assert.match(main, /openRemoteHostCatalogView\(app\.getPath\("userData"\)\)/);
	assert.match(catalog, /createRemoteHostReferenceRegistry\(join\(userDataDir,\s*"session-catalog\.json"\)\)/);
});

test("connect, disconnect and diagnostics are declared, bridged and registered", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	// 三处同步：通道常量、preload 桥接、主进程 handler。漏任何一处就是运行时 undefined。
	for (const [key, channel] of [
		["remoteHostConnect", "remote:connect"],
		["remoteHostDisconnect", "remote:disconnect"],
		["remoteHostDiagnostics", "remote:diagnostics"],
	])
		assert.match(shared, new RegExp(`${key}:\\s*"${channel}"`));
	assert.match(preload, /connect:\s*\(hostId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostConnect/);
	assert.match(preload, /disconnect:\s*\(hostId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostDisconnect/);
	assert.match(preload, /diagnostics:\s*\(hostId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostDiagnostics/);
	// 每个通道都要真的注册上，否则 UI 调用会挂在没有 handler 的通道上。
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }) });
	for (const channel of ["remote:hosts-list", "remote:connect", "remote:disconnect", "remote:diagnostics"]) assert.ok(handlers.has(channel), `${channel} must be registered`);
});

test("remote listing stays disabled without reading persisted hosts", async () => {
	let called = false;
	const handler = handlerFor({
		enabled: false,
		list: async () => {
			called = true;
			throw new Error("must not read");
		},
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.equal(called, false);
});

test("remote listing returns only UI fields and never pin metadata or identity paths", async () => {
	const handler = handlerFor({
		enabled: true,
		list: async () => ({
			snapshot: { status: "ready", reasons: [], revision: 1, retiredHostIds: [], profiles: [{ id: "host-a", label: "Test", sshHost: "serve", identityFile: "/private/key", verifiedEndpoint: { knownHostsSha256: "secret", hostKeyFingerprints: ["fingerprint"] }, disabledAt: undefined }] },
			findings: [],
		}),
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: true, status: "ready", hosts: [{ id: "host-a", label: "Test", sshHost: "serve", verified: true, disabled: false }] });
});

test("needs-repair lists only stable diagnostic fields and valid host ids", async () => {
	const hostId = "01234567-89ab-4def-8123-456789abcdef";
	const handler = handlerFor({
		enabled: true,
		list: async () => ({
			snapshot: { status: "needs-repair", reasons: ["REMOTE_HOST_LOCK_PRESENT"], revision: 1, retiredHostIds: [], profiles: [] },
			findings: [{ reason: "REMOTE_HOST_LOCK_PRESENT", classification: "lock", hostIds: [hostId, "../../private/key"], actions: ["clear-stale-lock"], privatePath: "/private/key" }],
		}),
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: true, status: "needs-repair", hosts: [], repair: [{ reason: "REMOTE_HOST_LOCK_PRESENT", classification: "lock", hostIds: [hostId] }] });
});

test("remote listing folds unexpected store errors into a stable code", async () => {
	const handler = handlerFor({
		enabled: true,
		list: async () => {
			throw new Error("private storage path");
		},
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await handler())), { ok: false, code: "REMOTE_HOST_LIST_UNAVAILABLE" });
});

/** 一个只记录调用的服务替身：真实服务有真机验证，这里只验 IPC 边界的适配与校验。 */
function fakeService(overrides = {}) {
	const calls = { connect: [], disconnect: [], diagnostics: [] };
	return {
		calls,
		service: {
			async connect(hostId) {
				calls.connect.push(hostId);
				return { ok: true, hostId, state: { hostId, generation: 1, state: "ready", attempts: 0, latched: false } };
			},
			async disconnect(hostId, reason) {
				calls.disconnect.push({ hostId, reason });
			},
			listDiagnostics(hostId) {
				calls.diagnostics.push(hostId);
				return [{ hostId, generation: 1, state: "ready", phase: "helper", code: "SSH_CONNECTION_READY", at: "2026-01-01T00:00:00.000Z" }];
			},
			...overrides,
		},
	};
}

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";

test("connect rejects a malformed host id before the service is touched", async () => {
	const { calls, service } = fakeService();
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), service: () => service });
	for (const bad of ["", "not-an-id", "../../etc", 42, null, undefined]) {
		const result = await handlers.get("remote:connect")({}, bad);
		assert.equal(result.ok, false);
		assert.equal(result.code, "REMOTE_CONNECTION_HOST_ID_INVALID");
	}
	assert.equal(calls.connect.length, 0, "renderer input must be validated before any process can start");
});

test("every remote channel honours the feature gate", async () => {
	const { calls, service } = fakeService();
	const handlers = handlersFor({ enabled: false, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), service: () => service });
	for (const channel of ["remote:connect", "remote:disconnect", "remote:diagnostics"]) {
		const result = await handlers.get(channel)({}, HOST_ID);
		assert.equal(result.ok, false);
		assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	}
	assert.equal(calls.connect.length + calls.disconnect.length + calls.diagnostics.length, 0);
});

test("connect reduces the machine snapshot to the state the UI renders", async () => {
	const { service } = fakeService();
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), service: () => service });
	const result = await handlers.get("remote:connect")({}, HOST_ID);
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, state: "ready" });
	// generation / attempts / latched 是主进程内部栅栏，不该泄漏给渲染层。
	assert.equal("generation" in result, false);
	assert.equal("latched" in result, false);
});

test("an absent connection service yields a stable code rather than throwing", async () => {
	// 只读目录视图在没有连接服务时仍须可用（当前 dev 装配的形态）。
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }) });
	for (const channel of ["remote:connect", "remote:disconnect", "remote:diagnostics"]) {
		const result = await handlers.get(channel)({}, HOST_ID);
		assert.equal(result.ok, false);
		assert.equal(result.code, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
	}
});

test("disconnect asks for a shutdown, not an abort", async () => {
	// 语义差别是真实的：abort 回 idle 可重试，shutdown 才 latch。断开必须走 shutdown。
	const { calls, service } = fakeService();
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), service: () => service });
	await handlers.get("remote:disconnect")({}, HOST_ID);
	assert.deepEqual(calls.disconnect, [{ hostId: HOST_ID, reason: "shutdown" }]);
});

test("diagnostics are re-validated and reduced to the renderer-safe shape", async () => {
	const { service } = fakeService();
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), service: () => service });
	const result = await handlers.get("remote:diagnostics")({}, HOST_ID);
	assert.equal(result.ok, true);
	assert.deepEqual(JSON.parse(JSON.stringify(result.entries)), [{ state: "ready", phase: "helper", code: "SSH_CONNECTION_READY", at: "2026-01-01T00:00:00.000Z" }]);
	// hostId / generation 不随单条诊断外发：渲染层按主机订阅，不需要每条重复身份。
	assert.equal("hostId" in result.entries[0], false);
});

test("a diagnostic carrying a path, a bad code or an unknown phase is dropped, not forwarded", async () => {
	// 这是渲染层安全边界：诊断只能承载可枚举值。任何越界条目必须被丢弃而不是透传。
	const base = { hostId: HOST_ID, generation: 1, at: "2026-01-01T00:00:00.000Z" };
	const { service } = fakeService({
		listDiagnostics: () => [
			{ ...base, state: "ready", phase: "helper", code: "SSH_CONNECTION_READY" },
			{ ...base, state: "ready", phase: "helper", code: "/home/user/.pideck/remote-host" },
			{ ...base, state: "ready", phase: "helper", code: "code with spaces" },
			{ ...base, state: "ready", phase: "helper", code: "SSH_X" },
			{ ...base, state: "not-a-state", phase: "helper", code: "SSH_X" },
			{ ...base, state: "ready", phase: "not-a-phase", code: "SSH_X" },
			{ ...base, state: "ready", phase: "helper", code: "SSH_X", at: "yesterday" },
			{ ...base, state: "ready", phase: "helper", code: "SSH_X", exitCode: 9999 },
			null,
			"string",
		],
	});
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), service: () => service });
	const result = await handlers.get("remote:diagnostics")({}, HOST_ID);
	// 只有第一条完整合法的留下：`SSH_X` 合法（3 字符以上），但其后的 at/exitCode 越界版本被丢。
	assert.deepEqual(
		JSON.parse(JSON.stringify(result.entries)).map((entry) => entry.code),
		["SSH_CONNECTION_READY", "SSH_X"],
	);
});

test("diagnostics history is capped per request", async () => {
	const { service } = fakeService({
		listDiagnostics: () => Array.from({ length: 5000 }, (_, index) => ({ hostId: HOST_ID, generation: 1, state: "ready", phase: "helper", code: `SSH_ENTRY_${index}`, at: "2026-01-01T00:00:00.000Z" })),
	});
	const handlers = handlersFor({ enabled: true, list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), service: () => service });
	const result = await handlers.get("remote:diagnostics")({}, HOST_ID);
	assert.equal(result.entries.length, 200, "one IPC call must not carry an unbounded payload");
	// 保留的是**最近**的 200 条，不是最早的。
	assert.equal(result.entries.at(-1).code, "SSH_ENTRY_4999");
});
