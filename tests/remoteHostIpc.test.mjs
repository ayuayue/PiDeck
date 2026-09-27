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

/** 用桩替换 store/pin，并记录调用：本用例只验 IPC 边界的校验与 senderId 绑定，不碰文件系统。 */
function addFlowHandlers(options = {}) {
	const calls = { createDraft: [], offerPin: [], confirmPin: [], sent: [] };
	const handlers = new Map();
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteHostStore": {
				RemoteHostStore: {
					async open() {
						return {
							getSnapshot: () => ({ revision: 7 }),
							async createDraft(draft, revision) {
								calls.createDraft.push({ draft, revision });
								return { id: HOST_ID };
							},
							async offerPin(hostId, senderId, revision) {
								calls.offerPin.push({ hostId, senderId, revision });
								if (options.offerFails) throw new Error("REMOTE_HOST_PIN_INVALID");
								return { requestId: "req-1", expiresAt: 123, hostId, hostName: "10.81.2.15", user: "deploy", port: 22, hostKeyFingerprints: ["SHA256:abc"] };
							},
							async confirmPin(answer, revision) {
								calls.confirmPin.push({ answer, revision });
								if (options.confirmFails) throw new Error("CONFIRMATION_EXPIRED");
								// 桩必须**真的执行** sender 绑定，否则「把 senderId 写死」这种改动测不出来：
								// 真实 broker 会拒绝来自其他窗口的回答，替身放行就等于把这条防线测没了。
								const offered = calls.offerPin.at(-1);
								if (offered !== undefined && offered.senderId !== answer.senderId) throw new Error("CONFIRMATION_INVALID");
								return answer.choice === "approve" ? { id: answer.hostId } : null;
							},
						};
					},
				},
			},
			"../remote/SshHostPinStore": {
				SshHostPinStore: class {
					dispose() {}
				},
			},
		},
	});
	registerRemoteHostIpc({ enabled: true, userDataDir: "/tmp/ignored", list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }), ...options.register });
	const sender = {
		id: 42,
		isDestroyed: () => false,
		send: (channel, payload) => calls.sent.push({ channel, payload }),
	};
	return { handlers, calls, sender };
}

test("add validates every field before the store is touched", async () => {
	const { handlers, calls, sender } = addFlowHandlers();
	const handler = handlers.get("remote:add");
	for (const bad of [
		null,
		{},
		{ label: "", hostName: "ok.example" },
		{ label: "ok", hostName: "" },
		{ label: "ok", hostName: "has space" },
		{ label: "ok", hostName: "ok.example", user: "bad user" },
		{ label: "ok", hostName: "ok.example", port: 0 },
		{ label: "ok", hostName: "ok.example", port: 70000 },
		{ label: "ok", hostName: "ok.example", port: "not-a-port" },
		{ label: "\u0000evil", hostName: "ok.example" },
		{ label: "x".repeat(200), hostName: "ok.example" },
	]) {
		const result = await handler({ sender }, bad);
		assert.equal(result.ok, false, `${JSON.stringify(bad)} must be rejected`);
		assert.equal(result.code, "REMOTE_HOST_ADD_INVALID");
	}
	assert.equal(calls.createDraft.length, 0, "invalid input must not reach the store");
});

test("add binds the pin offer to the calling webContents, not a renderer-supplied id", async () => {
	// 这是整个添加流程的安全核心：broker 只接受「被展示指纹的那个窗口」的回答。
	// 若能由渲染层自报 senderId，任何脚本都能替用户确认指纹。
	const { handlers, calls, sender } = addFlowHandlers();
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15", user: "deploy" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, status: "pending" });
	assert.equal(calls.offerPin[0].senderId, 42, "the broker's sender binding must come from event.sender.id");
	// 渲染层即使自报 senderId 也不被采纳（readAddInput 根本不读该字段）。
	const spoof = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15", senderId: 1 });
	assert.equal(spoof.ok, true);
	assert.equal(calls.offerPin[1].senderId, 42, "a renderer-supplied senderId must be ignored");
});

test("add pushes the fingerprint request to the asking window", async () => {
	const { handlers, calls, sender } = addFlowHandlers();
	await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.equal(calls.sent.length, 1);
	assert.equal(calls.sent[0].channel, "remote:pin-request");
	// 指纹必须真的推给用户——确认的本质就是让他核对这个值。
	assert.deepEqual(JSON.parse(JSON.stringify(calls.sent[0].payload.hostKeyFingerprints)), ["SHA256:abc"]);
	assert.equal(calls.sent[0].payload.requestId, "req-1");
});

test("add reports a stable code when the offer fails, and sends nothing", async () => {
	const { handlers, calls, sender } = addFlowHandlers({ offerFails: true });
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "REMOTE_HOST_PIN_INVALID" });
	assert.equal(calls.sent.length, 0, "a failed offer must not push a confirmation dialog");
});

test("answerPin validates its inputs and its sender before the store is touched", async () => {
	const { handlers, calls, sender } = addFlowHandlers();
	const handler = handlers.get("remote:answer-pin");
	for (const args of [
		["", HOST_ID, "approve"],
		["x".repeat(200), HOST_ID, "approve"],
		["req-1", "not-an-id", "approve"],
		["req-1", HOST_ID, "maybe"],
		["req-1", HOST_ID, undefined],
	]) {
		const result = await handler({ sender }, ...args);
		assert.equal(result.ok, false, `${JSON.stringify(args)} must be rejected`);
	}
	// senderId 非法的窗口不能回答。
	const noSender = await handler({ sender: { id: 0, isDestroyed: () => false } }, "req-1", HOST_ID, "approve");
	assert.equal(noSender.ok, false);
	assert.equal(calls.confirmPin.length, 0, "invalid answers must not reach the store");
});

test("approving saves the pin and denying leaves the draft unverified", async () => {
	// 先走一次 add，让桩记住这次确认被推给了哪个 sender（否则桩无法执行绑定检查）。
	const approved = addFlowHandlers();
	await approved.handlers.get("remote:add")({ sender: approved.sender }, { label: "serve", hostName: "10.81.2.15" });
	const approveResult = await approved.handlers.get("remote:answer-pin")({ sender: approved.sender }, "req-1", HOST_ID, "approve");
	assert.deepEqual(JSON.parse(JSON.stringify(approveResult)), { ok: true, hostId: HOST_ID, approved: true });
	assert.equal(approved.calls.confirmPin[0].answer.choice, "approve");

	const denied = addFlowHandlers();
	await denied.handlers.get("remote:add")({ sender: denied.sender }, { label: "serve", hostName: "10.81.2.15" });
	const denyResult = await denied.handlers.get("remote:answer-pin")({ sender: denied.sender }, "req-1", HOST_ID, "deny");
	// 拒绝是正常结果而不是失败：没保存 pin，draft 保持未验证。
	assert.deepEqual(JSON.parse(JSON.stringify(denyResult)), { ok: true, hostId: HOST_ID, approved: false });
});

test("an answer from a different window is refused", async () => {
	// broker 的 sender 绑定：指纹展示给窗口 A，窗口 B 的回答必须无效——否则任何脚本都能替用户确认。
	const { handlers, calls, sender } = addFlowHandlers();
	await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	const other = { id: 99, isDestroyed: () => false, send: () => undefined };
	const result = await handlers.get("remote:answer-pin")({ sender: other }, "req-1", HOST_ID, "approve");
	assert.equal(result.ok, false);
	assert.equal(result.code, "CONFIRMATION_INVALID");
	// 回答确实到达了桩（说明拦截发生在绑定检查处，而不是被前面的校验挡住）。
	assert.equal(calls.confirmPin.at(-1).answer.senderId, 99);
});

test("a store error while answering becomes a stable code, not a thrown message", async () => {
	const { handlers, sender } = addFlowHandlers({ confirmFails: true });
	const result = await handlers.get("remote:answer-pin")({ sender }, "req-1", HOST_ID, "approve");
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "CONFIRMATION_EXPIRED" });
});

test("scan and add honour the feature gate", async () => {
	const { handlers } = addFlowHandlers({ register: { enabled: false } });
	for (const channel of ["remote:scan-config", "remote:add", "remote:answer-pin"]) {
		const result = await handlers.get(channel)({ sender: { id: 42, isDestroyed: () => false } }, { label: "x", hostName: "y" }, HOST_ID, "approve");
		assert.equal(result.ok, false, `${channel} must be gated`);
		assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	}
});

test("the new add-host channels are declared and bridged in all three places", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	for (const [key, channel] of [
		["remoteHostScanConfig", "remote:scan-config"],
		["remoteHostAdd", "remote:add"],
		["remoteHostAnswerPin", "remote:answer-pin"],
		["remoteHostPinRequest", "remote:pin-request"],
	])
		assert.match(shared, new RegExp(`${key}:\\s*"${channel}"`));
	assert.match(preload, /scanConfig:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostScanConfig/);
	assert.match(preload, /add:\s*\(input[\s\S]{0,120}?ipcRenderer\.invoke\(ipcChannels\.remoteHostAdd/);
	assert.match(preload, /answerPin:\s*\(requestId[\s\S]{0,160}?ipcRenderer\.invoke\(ipcChannels\.remoteHostAnswerPin/);
	// 订阅必须返回 unsubscribe（项目硬性规则），否则窗口销毁后仍在推送。
	assert.match(preload, /onPinRequest:\s*\(callback[\s\S]{0,200}?subscribe\(ipcChannels\.remoteHostPinRequest/);
});
