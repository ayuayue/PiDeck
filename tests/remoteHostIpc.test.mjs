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
	assert.match(catalog, /createRemoteHostReferenceRegistry\(join\(userDataDir,\s*"session-catalog\.json"\),\s*join\(userDataDir,\s*"projects\.json"\)\)/);
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
	const calls = { createDraft: [], offerPin: [], confirmPin: [], sent: [], discarded: [] };
	const handlers = new Map();
	// 真实 store 的 revision 存在磁盘上，每个 open() 读回的是**同一份状态**。桩若每次 open()
	// 都从 7 重开，就与真实语义不符（一次写入会被下一次 open 遗忘）。
	let revision = 7;
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteHostStore": {
				RemoteHostStore: {
					async open() {
						return {
							getSnapshot: () => ({ revision }),
							async createDraft(draft, expected) {
								calls.createDraft.push({ draft, expected });
								if (expected !== revision) throw new Error("REMOTE_HOST_REVISION_CONFLICT");
								revision += 1;
								return { id: HOST_ID };
							},
							async offerPin(hostId, senderId, expected) {
								calls.offerPin.push({ hostId, senderId, expected });
								// 与真实 store 同一道门：期望值不是当前 revision 就冲突。
								if (expected !== revision) throw new Error("REMOTE_HOST_REVISION_CONFLICT");
								if (options.offerFails) throw new Error("REMOTE_HOST_PIN_INVALID");
								return { requestId: "req-1", expiresAt: 123, hostId, hostName: "10.81.2.15", user: "deploy", port: 22, hostKeyFingerprints: ["SHA256:abc"] };
							},
							async discardUnverifiedDraft(hostId, expected) {
								calls.discarded.push({ hostId, expected });
								if (expected !== revision) throw new Error("REMOTE_HOST_REVISION_CONFLICT");
								if (options.discardFails) throw new Error("REMOTE_HOST_DISCARD_INVALID");
								revision += 1;
								return hostId;
							},
							async confirmPin(answer, expected) {
								calls.confirmPin.push({ answer, expected });
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

test("add re-reads the revision after the draft write, so the offer is not made against a stale one", async () => {
	// 实跑回归（2026-09）：createDraft 提交后 revision 已变，拿写入前的值去 offerPin 必然
	// REMOTE_HOST_REVISION_CONFLICT——添加主机在 UI 上直接失败。桩现在会递增 revision 并校验期望值。
	const { handlers, calls, sender } = addFlowHandlers();
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, status: "pending" });
	assert.equal(calls.createDraft[0].expected, 7, "the draft is written against the revision read before it");
	assert.equal(calls.offerPin[0].expected, 8, "the offer must use the revision the draft committed, not the pre-write one");
});

test("answerPin validates against the current revision", async () => {
	const { handlers, calls, sender } = addFlowHandlers();
	await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	const result = await handlers.get("remote:answer-pin")({ sender }, "req-1", HOST_ID, "approve");
	assert.equal(result.ok, true);
	// 回答时不先写入，因此期望值就是当时的 revision（8：draft 写入后）。
	assert.equal(calls.confirmPin[0].expected, 8);
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

test("a service that fails to build is reported as a stable code, not an escaped rejection", async () => {
	// 实跑回归（2026-09）：客户端探测失败时，装配抛出的异常直接穿透 IPC 边界，渲染层收到
	// 「未处理异常: Error invoking remote method 'remote:diagnostics'」——用户看到的是原始
	// 异常而不是可读状态。每个用到服务的通道都必须把它转成稳定码。
	const handlers = handlersFor({
		enabled: true,
		userDataDir: "/tmp/ignored",
		list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }),
		service: async () => {
			throw new Error("SSH_CLIENT_UNSUPPORTED_PLATFORM");
		},
	});
	for (const [channel, args] of [
		["remote:connect", [HOST_ID]],
		["remote:disconnect", [HOST_ID]],
		["remote:diagnostics", [HOST_ID]],
	]) {
		const result = await handlers.get(channel)({}, ...args);
		assert.equal(result.ok, false, `${channel} must not throw`);
		assert.equal(result.code, "SSH_CLIENT_UNSUPPORTED_PLATFORM", `${channel} must surface the real reason`);
	}
});

test("a service factory that fails with free text collapses to a generic code", async () => {
	// 只有「消息本身就是一个稳定码」才透出；其余一律收敛，避免把路径/命令行带到渲染层。
	const handlers = handlersFor({
		enabled: true,
		userDataDir: "/tmp/ignored",
		list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }),
		service: async () => {
			throw new Error("failed to open /home/user/.ssh/config");
		},
	});
	const result = await handlers.get("remote:diagnostics")({}, HOST_ID);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
});

test("an async service factory is awaited and used", async () => {
	// 发现客户端是异步的，因此工厂可以是 Promise；handler 必须等它再调用。
	const { calls, service } = fakeService();
	const handlers = handlersFor({
		enabled: true,
		userDataDir: "/tmp/ignored",
		list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }),
		service: async () => service,
	});
	const result = await handlers.get("remote:connect")({}, HOST_ID);
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, state: "ready" });
	assert.deepEqual(calls.connect, [HOST_ID]);
});

test("a failed offer rolls the draft back instead of leaving an unremovable row", async () => {
	// 实跑回归（2026-09）：offer 失败时 draft 已经写进 store 了，于是每失败一次就多一条
	// 点不动的「未验证」主机（用户实测 4 次点击 = 4 条垃圾，且界面没有删除入口）。
	const { handlers, calls, sender } = addFlowHandlers({ offerFails: true });
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "REMOTE_HOST_PIN_INVALID" });
	// 回滚必须发生在 offer 之后，且用的是 offer 当时的 revision。
	assert.equal(calls.discarded.length, 1);
	assert.equal(calls.discarded[0].hostId, HOST_ID);
	assert.equal(calls.discarded[0].expected, 8, "the rollback runs against the revision the draft committed");
});

test("a successful add never rolls anything back", async () => {
	const { handlers, calls, sender } = addFlowHandlers();
	await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.equal(calls.discarded.length, 0, "a pending confirmation must keep its draft");
});

test("a failed rollback does not mask the original offer failure", async () => {
	// 回滚是尽力而为：它自己失败时不能让用户看到「清理失败」而看不到「为什么添加失败」。
	const { handlers, sender } = addFlowHandlers({ offerFails: true, discardFails: true });
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "REMOTE_HOST_PIN_INVALID" });
});

test("the connect button is only enabled for a verified, enabled host", () => {
	// 界面已经知道主机未验证（列表里显示「未验证」），就不该让用户点了才拿到
	// SSH_HOST_NOT_READY——那是把用户引到一条注定失败的路上。
	const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
	assert.match(tab, /const connectable = host\.verified && !host\.disabled/);
	assert.match(tab, /disabled=\{pending \|\| !connectable\}/);
});

test("the add and answer channels share one pin store, so the pending request survives", async () => {
	// 实跑回归（2026-09）：确认弹框里点「信任」无效，主机永远停在「未验证」——因为
	// remote:add 建了一个 pin store（待确认状态注册在它的 broker 里）并在返回前 dispose，
	// 而 remote:answer-pin 又建了一个新的空 broker，于是连**展示过指纹的那个窗口**也被拒。
	//
	// 这条用例用的是**真正的 broker 语义**：offer 在 A 注册，answer 必须在同一实例上找得到。
	const requests = new Map();
	let instances = 0;
	const handlers = new Map();
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/SshHostPinStore": {
				SshHostPinStore: class {
					constructor() {
						instances += 1;
					}
					dispose() {}
				},
			},
			"../remote/RemoteHostStore": {
				RemoteHostStore: {
					async open(_dir, options) {
						const pinStore = options?.pinStore;
						return {
							getSnapshot: () => ({ revision: 7 }),
							async createDraft() {
								return { id: HOST_ID };
							},
							async offerPin(hostId, senderId) {
								const requestId = "req-shared";
								// 待确认状态挂在**这个** pin store 的 broker 上；换实例就找不到。
								requests.set(requestId, { hostId, senderId, store: pinStore });
								return { requestId, expiresAt: 1, hostId, hostName: "10.81.2.15", user: "deploy", port: 22, hostKeyFingerprints: ["SHA256:x"] };
							},
							async confirmPin(answer) {
								const pending = requests.get(answer.requestId);
								// 与真实 broker 相同的判据：请求必须在这个实例上、且 sender 一致。
								if (!pending || pending.store !== pinStore) throw new Error("SSH_HOST_CONFIRMATION_INVALID");
								if (pending.senderId !== answer.senderId) throw new Error("SSH_HOST_CONFIRMATION_INVALID");
								return answer.choice === "approve" ? { id: answer.hostId } : null;
							},
							async discardUnverifiedDraft() {},
						};
					},
				},
			},
		},
	});
	registerRemoteHostIpc({ enabled: true, userDataDir: "/tmp/ignored", list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }) });
	const sender = { id: 42, isDestroyed: () => false, send: () => undefined };
	const add = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.equal(add.ok, true);
	const answer = await handlers.get("remote:answer-pin")({ sender }, "req-shared", HOST_ID, "approve");
	assert.equal(answer.ok, true, `answer must find the pending request: ${JSON.stringify(answer)}`);
	assert.equal(answer.approved, true);
	// 整个流程只应建一个 pin store；两个就说明待确认状态被分到了两个 broker 上。
	assert.equal(instances, 1, "the add and answer channels must share one pin store");
});

test("the state-change channel is declared and bridged with an unsubscribe", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(shared, /remoteHostStateChanged:\s*"remote:state-changed"/);
	assert.match(preload, /onStateChange:\s*\(callback[\s\S]{0,200}?subscribe\(ipcChannels\.remoteHostStateChanged/);
	// 主进程必须把 manager 的每次迁移推给窗口，否则 connect 返回之后的迁移全部丢失。
	assert.match(main, /onStateChange:\s*\(\{\s*hostId,\s*state\s*\}\)/);
	assert.match(main, /webContents\.send\(ipcChannels\.remoteHostStateChanged/);
});

test("the ui subscribes to state pushes instead of trusting only the connect result", () => {
	// 实跑回归：连接确实到达 ready，界面却显示「已离线」——因为它只 setStates(connect 的返回值)。
	const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
	assert.match(tab, /desktopApi\.remoteHosts\.onStateChange/, "the tab must subscribe to pushes");
	// 订阅必须返回并调用 unsubscribe，否则窗口销毁后仍在推送。
	assert.match(tab, /const unsubscribe = desktopApi\.remoteHosts\.onStateChange/);
	assert.match(tab, /return unsubscribe;/);
});

/**
 * needs-repair 修复通道。
 *
 * 实跑教训：store 进入 needs-repair 后拒绝一切写入（正确——它发现了跨文件不一致），但界面只显示
 * 一句 REMOTE_HOST_STORE_NEEDS_REPAIR：用户看不出原因、也没有出路。修复动作在主进程早已实现
 * （RemoteHostRepair），只是从未接出来。这些用例锁住接线后的边界。
 */

/** 用桩替换 repair/store/pin，记录调用；不碰文件系统。 */
function repairHandlers(options = {}) {
	const calls = { diagnose: 0, completeActivation: [], discard: [], forget: [], clearLock: [], sent: [] };
	const handlers = new Map();
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteHostRepair": {
				RemoteHostRepair: class {
					async diagnose() {
						calls.diagnose += 1;
						return options.findings ?? [{ reason: "REMOTE_HOST_PIN_ORPHAN", classification: "orphan-pin", hostIds: [HOST_ID], actions: ["complete-activation-from-pin", "discard-orphan-pin"] }];
					}
					async completeActivationFromPin(hostId, revision, confirmation) {
						calls.completeActivation.push({ hostId, revision, confirmation });
						if (options.repairFails) throw new Error("HOST_REPAIR_ROUTE_UNVERIFIED");
					}
					async discardOrphanPin(hostId, confirmation) {
						calls.discard.push({ hostId, confirmation });
					}
					async forgetTrustAnchor(hostId, revision, confirmation) {
						calls.forget.push({ hostId, revision, confirmation });
					}
					async clearStaleHostLock(observerPid, confirmation) {
						calls.clearLock.push({ observerPid, confirmation });
					}
				},
			},
			"../remote/RemoteHostStore": {
				RemoteHostStore: {
					async open() {
						return {
							getSnapshot: () => ({ status: options.status ?? "needs-repair", revision: 12, reasons: ["REMOTE_HOST_PIN_ORPHAN"], profiles: [] }),
							getProfile: (id) => (id === HOST_ID ? { id, label: "serve" } : undefined),
						};
					},
				},
			},
			"../remote/SshHostPinStore": {
				SshHostPinStore: class {
					async readPin() {}
					async deletePin() {}
					async reverifyRoute() {}
					dispose() {}
				},
			},
		},
	});
	registerRemoteHostIpc({ enabled: options.enabled ?? true, userDataDir: "/tmp/ignored", list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }) });
	const sender = { id: 42, isDestroyed: () => false, send: (channel, payload) => calls.sent.push({ channel, payload }) };
	return { handlers, calls, sender };
}

test("diagnose reports the reasons and the legal actions", async () => {
	const { handlers, calls } = repairHandlers();
	const result = await handlers.get("remote:repair-diagnose")({});
	assert.equal(result.ok, true);
	assert.equal(calls.diagnose, 1);
	const finding = result.findings[0];
	assert.equal(finding.reason, "REMOTE_HOST_PIN_ORPHAN");
	assert.equal(finding.classification, "orphan-pin");
	assert.deepEqual(JSON.parse(JSON.stringify(finding.hostIds)), [HOST_ID]);
	assert.deepEqual(JSON.parse(JSON.stringify(finding.actions)), ["complete-activation-from-pin", "discard-orphan-pin"]);
});

test("diagnose on a healthy store returns nothing to do, not an error", async () => {
	// 健康时界面应当什么都不显示；把它做成错误会让面板永远报错。
	const { handlers, calls } = repairHandlers({ status: "ready" });
	const result = await handlers.get("remote:repair-diagnose")({});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, findings: [] });
	assert.equal(calls.diagnose, 0, "a healthy store must not be diagnosed");
});

test("a repair only ever runs after the user approves it", async () => {
	const { handlers, calls, sender } = repairHandlers();
	const run = await handlers.get("remote:repair-run")({ sender }, "complete-activation-from-pin", HOST_ID);
	assert.deepEqual(JSON.parse(JSON.stringify(run)), { ok: true, status: "pending" });
	// 关键：发起时**不能**执行任何写入。
	assert.equal(calls.completeActivation.length, 0, "requesting a repair must not run it");
	assert.equal(calls.sent.length, 1);
	assert.equal(calls.sent[0].channel, "remote:repair-confirm");
	assert.equal(calls.sent[0].payload.action, "complete-activation-from-pin");
	assert.equal(calls.sent[0].payload.hostId, HOST_ID);
	assert.equal(calls.sent[0].payload.label, "serve", "the confirmation must name the target");

	// 拒绝 → 不执行。
	const denied = await handlers.get("remote:repair-answer")({ sender }, calls.sent[0].payload.requestId, "deny");
	assert.deepEqual(JSON.parse(JSON.stringify(denied)), { ok: true, ran: false });
	assert.equal(calls.completeActivation.length, 0);
});

test("approving runs the repair against the revision the user saw", async () => {
	const { handlers, calls, sender } = repairHandlers();
	await handlers.get("remote:repair-run")({ sender }, "complete-activation-from-pin", HOST_ID);
	const requestId = calls.sent[0].payload.requestId;
	const result = await handlers.get("remote:repair-answer")({ sender }, requestId, "approve");
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, ran: true });
	assert.equal(calls.completeActivation.length, 1);
	assert.equal(calls.completeActivation[0].hostId, HOST_ID);
	// 传的是用户批准时的 revision；修复模块会在锁内复核它。
	assert.equal(calls.completeActivation[0].revision, 12);
	assert.equal(calls.completeActivation[0].confirmation.requestId, requestId);
});

test("a repair answer from another window is refused", async () => {
	const { handlers, calls, sender } = repairHandlers();
	await handlers.get("remote:repair-run")({ sender }, "complete-activation-from-pin", HOST_ID);
	const requestId = calls.sent[0].payload.requestId;
	const other = { id: 99, isDestroyed: () => false, send: () => undefined };
	const result = await handlers.get("remote:repair-answer")({ sender: other }, requestId, "approve");
	assert.equal(result.ok, false);
	assert.equal(calls.completeActivation.length, 0, "a foreign window must not be able to run a repair");
});

test("an unknown or unapproved action is refused before anything is offered", async () => {
	const { handlers, calls, sender } = repairHandlers({ findings: [{ reason: "REMOTE_HOST_PIN_ORPHAN", classification: "orphan-pin", hostIds: [HOST_ID], actions: ["complete-activation-from-pin"] }] });
	// 界面不能发明动作。
	for (const action of ["drop-everything", "", null, 42]) {
		const result = await handlers.get("remote:repair-run")({ sender }, action, HOST_ID);
		assert.equal(result.ok, false, `${String(action)} must be refused`);
	}
	// 诊断没授权的动作也不能调（这里是 discard，诊断只给了 complete-activation）。
	const notAllowed = await handlers.get("remote:repair-run")({ sender }, "discard-orphan-pin", HOST_ID);
	assert.deepEqual(JSON.parse(JSON.stringify(notAllowed)), { ok: false, code: "HOST_REPAIR_NOT_APPLICABLE" });
	assert.equal(calls.sent.length, 0);
});

test("a repair that cannot be diagnosed is refused", async () => {
	const { handlers, calls, sender } = repairHandlers({ status: "ready" });
	const result = await handlers.get("remote:repair-run")({ sender }, "complete-activation-from-pin", HOST_ID);
	assert.equal(result.ok, false);
	assert.equal(calls.sent.length, 0);
});

test("a failed repair surfaces a stable code and still consumes the confirmation", async () => {
	const { handlers, calls, sender } = repairHandlers({ repairFails: true });
	await handlers.get("remote:repair-run")({ sender }, "complete-activation-from-pin", HOST_ID);
	const requestId = calls.sent[0].payload.requestId;
	const result = await handlers.get("remote:repair-answer")({ sender }, requestId, "approve");
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "HOST_REPAIR_ROUTE_UNVERIFIED" });
	// 已消费：同一个 requestId 不能重放。
	const replay = await handlers.get("remote:repair-answer")({ sender }, requestId, "approve");
	assert.equal(replay.ok, false);
});

test("an unknown request id cannot be answered", async () => {
	const { handlers, sender } = repairHandlers();
	const result = await handlers.get("remote:repair-answer")({ sender }, "never-issued", "approve");
	assert.equal(result.ok, false);
	assert.equal(result.code, "HOST_REPAIR_CONFIRMATION_REQUIRED");
});

test("every repair channel honours the feature gate", async () => {
	const { handlers, calls, sender } = repairHandlers({ enabled: false });
	for (const [channel, args] of [
		["remote:repair-diagnose", []],
		["remote:repair-run", [sender, "complete-activation-from-pin", HOST_ID]],
		["remote:repair-answer", [sender, "req", "approve"]],
	]) {
		const result = await handlers.get(channel)({}, ...args);
		assert.equal(result.ok, false, `${channel} must be gated`);
		assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	}
	assert.equal(calls.sent.length, 0);
});

test("diagnosis findings are re-validated before reaching the renderer", async () => {
	// 诊断只允许携带可枚举值：任何越界的 reason/classification/action 都在边界处收敛。
	const { handlers } = repairHandlers({
		findings: [{ reason: "/home/user/.pideck", classification: "not-a-class", hostIds: ["not-an-id", HOST_ID], actions: ["complete-activation-from-pin", "invent-an-action"] }],
	});
	const result = await handlers.get("remote:repair-diagnose")({});
	const finding = result.findings[0];
	assert.equal(finding.reason, "REMOTE_HOST_DIAGNOSTIC_UNKNOWN");
	assert.equal(finding.classification, "unknown");
	assert.deepEqual(JSON.parse(JSON.stringify(finding.hostIds)), [HOST_ID]);
	assert.deepEqual(JSON.parse(JSON.stringify(finding.actions)), ["complete-activation-from-pin"]);
});

/**
 * 远端工作区读取（Phase 3 第一段）。
 *
 * 关键边界：远端路径**不经过 ProjectStore**，因此 `Project` 上看不到它；已确认的 root 由主进程持有，
 * 渲染层只能给**相对路径**——不能自己命名边界。
 */
function workspaceHandlers(options = {}) {
	const calls = { resolve: [], list: [], read: [], sent: [], setRoot: [], connects: [] };
	const handlers = new Map();
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot(input) {
					calls.resolve.push(input);
					if (options.resolveFails) throw new Error("REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY");
					return { canonicalPath: "/srv/real-project" };
				},
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: ({ port }) => ({
					async list(hostId, path) {
						calls.list.push({ hostId, path, portHasRequest: typeof port.request === "function" });
						if (options.listFails) throw new Error("REMOTE_WORKSPACE_LIST_TOO_LARGE");
						return {
							entries: [
								{ name: "src", kind: "directory" },
								{ name: "readme.md", kind: "file", bytes: 12 },
							],
						};
					},
					async readFile(hostId, path) {
						calls.read.push({ hostId, path });
						if (options.readFails) throw new Error("REMOTE_WORKSPACE_READ_FAILED");
						return { content: Buffer.from("hello"), bytes: 5, mtimeMs: 1 };
					},
				}),
			},
			"../remote/RemoteHostStore": {
				RemoteHostStore: {
					async open() {
						return { getSnapshot: () => ({ status: "ready", revision: 1, profiles: [] }), getProfile: () => ({ id: HOST_ID, label: "serve" }) };
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
	// 连接服务替身：暴露 client（解析 root 需要）与 request/cancel（reader 的传输端口）。
	registerRemoteHostIpc({
		enabled: options.enabled ?? true,
		userDataDir: "/tmp/ignored",
		list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }),
		service: () => ({
			client: { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: {}, run: async () => ({ exitCode: 0, stdout: "" }) },
			async request() {},
			async cancel() {},
			async connect(hostId) {
				calls.connects = calls.connects ?? [];
				calls.connects.push(hostId);
				return { ok: true, hostId, state: { hostId, generation: 1, state: "ready", attempts: 0, latched: false } };
			},
			async disconnect() {},
			setWorkspaceRoot(hostId, root) {
				calls.setRoot = calls.setRoot ?? [];
				calls.setRoot.push({ hostId, root });
			},
			getWorkspaceRoot: () => undefined,
			listDiagnostics: () => [],
			async dispose() {},
		}),
	});
	const sender = { id: 42, isDestroyed: () => false, send: (channel, payload) => calls.sent.push({ channel, payload }) };
	return { handlers, calls, sender };
}

/** 走完整个确认流程，让主进程持有一个已确认的 root。 */
async function confirmRoot(harness, path = "/srv/link-project") {
	await harness.handlers.get("remote:workspace-resolve-root")({ sender: harness.sender }, HOST_ID, path);
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	await harness.handlers.get("remote:workspace-answer-root")({ sender: harness.sender }, requestId, "approve");
	return requestId;
}

test("resolving a root probes the host, then asks the user to confirm the canonical path", async () => {
	const harness = workspaceHandlers();
	const result = await harness.handlers.get("remote:workspace-resolve-root")({ sender: harness.sender }, HOST_ID, "/srv/link-project");
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, canonicalPath: "/srv/real-project" });
	assert.equal(harness.calls.resolve.length, 1, "the host is probed with the path the user typed");
	assert.equal(harness.calls.resolve[0].userPath, "/srv/link-project");
	// 确认展示的是**canonical** 路径：用户确认的必须是真正会被 confinement 的那个目录。
	const pushed = harness.calls.sent.at(-1);
	assert.equal(pushed.channel, "remote:workspace-root-confirm");
	assert.equal(pushed.payload.requestedPath, "/srv/link-project");
	assert.equal(pushed.payload.canonicalPath, "/srv/real-project");
});

test("nothing is readable until the user confirms a root", async () => {
	const harness = workspaceHandlers();
	// 未确认：任何读取都必须被拒，而不是回落到某个隐含 root。
	for (const channel of ["remote:workspace-list", "remote:workspace-read"]) {
		const result = await harness.handlers.get(channel)({}, HOST_ID, "src");
		assert.equal(result.ok, false, `${channel} must refuse before a root is confirmed`);
		assert.equal(result.code, "REMOTE_WORKSPACE_ROOT_NOT_CONFIRMED");
	}
	assert.equal(harness.calls.list.length + harness.calls.read.length, 0);
});

test("denying a root confirmation leaves nothing readable", async () => {
	const harness = workspaceHandlers();
	await harness.handlers.get("remote:workspace-resolve-root")({ sender: harness.sender }, HOST_ID, "/srv/link-project");
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	const denied = await harness.handlers.get("remote:workspace-answer-root")({ sender: harness.sender }, requestId, "deny");
	assert.deepEqual(JSON.parse(JSON.stringify(denied)), { ok: true, confirmed: false });
	const after = await harness.handlers.get("remote:workspace-list")({}, HOST_ID, "");
	assert.equal(after.ok, false);
	assert.equal(after.code, "REMOTE_WORKSPACE_ROOT_NOT_CONFIRMED");
});

test("a confirmed root makes the relative listing readable", async () => {
	const harness = workspaceHandlers();
	await confirmRoot(harness);
	const root = await harness.handlers.get("remote:workspace-get-root")({});
	assert.deepEqual(JSON.parse(JSON.stringify(root)), { ok: true, canonicalPath: "/srv/real-project" });
	// 只返回界面要渲染的字段。
	const listed = await harness.handlers.get("remote:workspace-list")({}, HOST_ID, "");
	assert.deepEqual(JSON.parse(JSON.stringify(listed)), {
		ok: true,
		entries: [
			{ name: "src", kind: "directory" },
			{ name: "readme.md", kind: "file", bytes: 12 },
		],
	});
	assert.equal(harness.calls.list[0].path, ".", "the root is the reader's own spelling of it, not the empty string the UI uses");
	assert.equal(harness.calls.list[0].portHasRequest, true, "the reader must be given the service as its transport port");
	// 真机回归：reader 拒绝空路径（readRequestPath 要求非空），根必须翻成它自己的写法，
	// 否则真实主机上 fs.list 直接 PROTOCOL_INVALID —— 这正是第一次真机跑出来的结果。
	assert.equal(harness.calls.list[0].path, ".", "the root must be translated to the reader spelling");
});

test("a renderer cannot widen the boundary with an absolute or traversing path", async () => {
	// 这是本段的核心边界：渲染层只能命名 root **之内**的位置。
	const harness = workspaceHandlers();
	await confirmRoot(harness);
	for (const bad of ["/etc/passwd", "../outside", "src/../../etc", "a//b", "./x", "a\\b", "x\u0000y", 5, null]) {
		const listed = await harness.handlers.get("remote:workspace-list")({}, HOST_ID, bad);
		assert.equal(listed.ok, false, `${JSON.stringify(bad)} must be refused for list`);
		assert.equal(listed.code, "REMOTE_WORKSPACE_PATH_INVALID");
		const read = await harness.handlers.get("remote:workspace-read")({}, HOST_ID, bad);
		assert.equal(read.ok, false, `${JSON.stringify(bad)} must be refused for read`);
	}
	assert.equal(harness.calls.list.length + harness.calls.read.length, 0, "nothing may reach the reader");
});

test("an empty path lists the root but can never be read as a file", async () => {
	const harness = workspaceHandlers();
	await confirmRoot(harness);
	const listed = await harness.handlers.get("remote:workspace-list")({}, HOST_ID, "");
	assert.equal(listed.ok, true);
	const read = await harness.handlers.get("remote:workspace-read")({}, HOST_ID, "");
	assert.equal(read.ok, false);
	assert.equal(read.code, "REMOTE_WORKSPACE_PATH_INVALID");
});

test("reads return base64 and the reader's own size", async () => {
	const harness = workspaceHandlers();
	await confirmRoot(harness);
	const read = await harness.handlers.get("remote:workspace-read")({}, HOST_ID, "readme.md");
	assert.deepEqual(JSON.parse(JSON.stringify(read)), { ok: true, contentBase64: Buffer.from("hello").toString("base64"), bytes: 5, mtimeMs: 1 });
});

test("a confirmed root belongs to one host", async () => {
	// root 是对某台主机的边界；另一台主机必须重走确认，不能借用。
	const harness = workspaceHandlers();
	await confirmRoot(harness);
	const other = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
	const listed = await harness.handlers.get("remote:workspace-list")({}, other, "");
	assert.equal(listed.ok, false);
	assert.equal(listed.code, "REMOTE_WORKSPACE_ROOT_NOT_CONFIRMED");
});

test("a root confirmation cannot be answered by another window", async () => {
	const harness = workspaceHandlers();
	await harness.handlers.get("remote:workspace-resolve-root")({ sender: harness.sender }, HOST_ID, "/srv/x");
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	const other = { id: 99, isDestroyed: () => false, send: () => undefined };
	const result = await harness.handlers.get("remote:workspace-answer-root")({ sender: other }, requestId, "approve");
	assert.equal(result.ok, false);
	// 外窗口的批准不能生效。
	const listed = await harness.handlers.get("remote:workspace-list")({}, HOST_ID, "");
	assert.equal(listed.ok, false);
});

test("reader failures surface as stable codes", async () => {
	const harness = workspaceHandlers({ listFails: true, readFails: true });
	await confirmRoot(harness);
	assert.equal((await harness.handlers.get("remote:workspace-list")({}, HOST_ID, "")).code, "REMOTE_WORKSPACE_LIST_TOO_LARGE");
	assert.equal((await harness.handlers.get("remote:workspace-read")({}, HOST_ID, "a")).code, "REMOTE_WORKSPACE_READ_FAILED");
});

test("a root that cannot be resolved never becomes confirmable", async () => {
	const harness = workspaceHandlers({ resolveFails: true });
	const result = await harness.handlers.get("remote:workspace-resolve-root")({ sender: harness.sender }, HOST_ID, "/srv/file-not-dir");
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY");
	assert.equal(harness.calls.sent.length, 0, "nothing is offered for confirmation");
});

test("every workspace channel honours the feature gate", async () => {
	// 门禁关闭时，连「有没有 root」都不该能被问到。
	const harness = workspaceHandlers({ enabled: false });
	for (const [channel, args] of [
		["remote:workspace-resolve-root", [{ sender: harness.sender }, HOST_ID, "/srv"]],
		["remote:workspace-answer-root", [{ sender: harness.sender }, "req", "approve"]],
		["remote:workspace-get-root", []],
		["remote:workspace-list", [{}, HOST_ID, ""]],
		["remote:workspace-read", [{}, HOST_ID, "a"]],
	]) {
		const result = await harness.handlers.get(channel)(...args);
		assert.equal(result.ok, false, `${channel} must be gated`);
		assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	}
	assert.equal(harness.calls.resolve.length, 0, "a gated build must not probe the host");
	assert.equal(harness.calls.sent.length, 0);
});

test("denying a new root also clears the previously confirmed one", async () => {
	// 危险形态：已确认 A（读取可用）→ 请求切到 B → 用户拒绝 B。
	// 若此时仍保留 A，界面显示的是 B 而实际读的是 A —— 用户以为自己在看一个他没确认过的边界。
	// 采取 fail-closed：拒绝即清空，用户想要 A 就再确认一次。
	const harness = workspaceHandlers();
	await confirmRoot(harness, "/srv/root-a");
	assert.equal((await harness.handlers.get("remote:workspace-list")({}, HOST_ID, "")).ok, true, "A is usable once confirmed");

	await harness.handlers.get("remote:workspace-resolve-root")({ sender: harness.sender }, HOST_ID, "/srv/root-b");
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	const denied = await harness.handlers.get("remote:workspace-answer-root")({ sender: harness.sender }, requestId, "deny");
	assert.deepEqual(JSON.parse(JSON.stringify(denied)), { ok: true, confirmed: false });

	const after = await harness.handlers.get("remote:workspace-list")({}, HOST_ID, "");
	assert.equal(after.ok, false, "the old root must not survive a denial");
	assert.equal(after.code, "REMOTE_WORKSPACE_ROOT_NOT_CONFIRMED");
	assert.equal((await harness.handlers.get("remote:workspace-get-root")({})).ok, false);
});

test("a confirmed root is handed to the connection and the session is re-established", async () => {
	// 实跑回归（2026-09）：确认了 root，列目录却回 PATH_OUTSIDE_ROOT。原因是 root 不是「读时的过滤器」，
	// 而是 helper 启动时的 `--root`——当时那条会话是 host-only 启动的，什么路径都服务不了。
	// 所以确认必须同时做两件事：把 root 交给连接，并用它重建会话。
	const harness = workspaceHandlers();
	await confirmRoot(harness, "/srv/real-project");
	assert.deepEqual(harness.calls.setRoot, [{ hostId: HOST_ID, root: "/srv/real-project" }], "the root must reach the connection");
	assert.deepEqual(harness.calls.connects, [HOST_ID], "and the session must be re-established with it");
});

test("a denied root is never handed to the connection", async () => {
	const harness = workspaceHandlers();
	await harness.handlers.get("remote:workspace-resolve-root")({ sender: harness.sender }, HOST_ID, "/srv/x");
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	await harness.handlers.get("remote:workspace-answer-root")({ sender: harness.sender }, requestId, "deny");
	assert.equal(harness.calls.setRoot.length, 0, "a denied root must not reconfigure the session");
	assert.equal(harness.calls.connects.length, 0);
});
