import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("remote host channel is declared, bridged, and registered by the release policy", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const main = readFileSync("src/main/index.ts", "utf8");
	const catalog = readFileSync("src/main/remote/RemoteHostCatalogView.ts", "utf8");
	assert.match(shared, /remoteHostsList:\s*"remote:hosts-list"/);
	assert.match(preload, /remoteHosts:\s*\{[\s\S]*?ipcRenderer\.invoke\(ipcChannels\.remoteHostsList\)/);
	const { REMOTE_FEATURE_AVAILABLE } = loadTsCommonJs("src/main/remote/remoteFeaturePolicy.ts");
	assert.equal(REMOTE_FEATURE_AVAILABLE, true, "stable and dev builds must both provide remote capability");
	assert.match(main, /import \{ REMOTE_FEATURE_AVAILABLE \} from "\.\/remote\/remoteFeaturePolicy"/);
	assert.match(main, /const remoteFeatureEnabled = REMOTE_FEATURE_AVAILABLE;/);
	assert.match(main, /registerRemoteHostIpc\(\{[\s\S]{0,400}?enabled:\s*remoteFeatureEnabled/);
	// 目录读取在装配处接上「主机退役即清 trust 决策」的钩子（P4.4b；与 pin 清理同一位置、同一重试语义）。
	assert.match(main, /openRemoteHostCatalogView\(app\.getPath\("userData"\),\s*\{\s*onHostRetired:[\s\S]{0,200}?forgetHost\(hostId\)/);
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
	// 密码登录：connect 多一个可选的本次口令，仍然走同一条通道。
	assert.match(preload, /connect:\s*\(hostId: string, password\?: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostConnect/);
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
	// `~/.ssh/...` 的展开目标是**本机** home（F4）；注入固定值，测试不依赖运行机器的真实 HOME。
	const home = options.home ?? (process.platform === "win32" ? "C:\\Users\\tester" : "/home/tester");
	// 真实 store 的 revision 存在磁盘上，每个 open() 读回的是**同一份状态**。桩若每次 open()
	// 都从 7 重开，就与真实语义不符（一次写入会被下一次 open 遗忘）。
	let revision = 7;
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"node:os": { homedir: () => home, userInfo: () => ({ username: "tester" }) },
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
	return { handlers, calls, sender, home };
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

test("add expands an SSH-config IdentityFile ~/... to a local absolute path before the draft (F4)", async () => {
	const { handlers, calls, sender, home } = addFlowHandlers();
	const handler = handlers.get("remote:add");
	// 真实 config 里最常见的形态：候选列表把 `IdentityFile ~/.ssh/id_*` 原样带过来。
	const result = await handler({ sender }, { label: "serve", hostName: "10.81.2.15", user: "deploy", identityFile: "~/.ssh/id_ed25519" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, status: "verified" });
	assert.equal(calls.createDraft.length, 1);
	assert.equal(calls.createDraft[0].draft.identityFile, join(home, ".ssh", "id_ed25519"));
	// 展开对象是本机 home：保存值必须能被 host store 的 isAbsolute 判据接受，而不是原样带 `~`。
	assert.equal(calls.createDraft[0].draft.identityFile.startsWith("~"), false);

	// 绝对路径同样被接受（规范化后保存）。
	const absolute = join(home, ".ssh", "id_rsa");
	const second = await handler({ sender }, { label: "serve2", hostName: "host2.example", identityFile: absolute });
	assert.equal(second.ok, true);
	assert.equal(calls.createDraft[1].draft.identityFile, absolute);
});

test("add refuses identity-file forms it cannot normalize with a dedicated stable code (F4)", async () => {
	const { handlers, calls, sender } = addFlowHandlers();
	const handler = handlers.get("remote:add");
	for (const identityFile of ["~root/.ssh/id_ed25519", ".ssh/id_ed25519", "keys/id", "~/.ssh/id\u0000_ed25519", `~/${"x".repeat(4090)}`]) {
		const result = await handler({ sender }, { label: "serve", hostName: "10.81.2.15", identityFile });
		assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(identityFile)}`);
		// 与「表单字段不合法」区分：这是真实配置形态的路径问题，UI 的 `{code}` 文案能直接指出原因。
		assert.equal(result.code, "REMOTE_HOST_IDENTITY_FILE_INVALID");
	}
	assert.equal(calls.createDraft.length, 0, "an invalid identity path must not create a draft (no opaque REMOTE_HOST_STORE_INVALID)");

	// 不填 identityFile 时字段保持缺省（store 里没有这个 key，表示走 alias/agent 身份链）。
	const omitted = await handler({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.equal(omitted.ok, true);
	assert.equal("identityFile" in calls.createDraft[0].draft, false);
});

test("add binds the pin offer to the calling webContents, not a renderer-supplied id", async () => {
	// 自动信任（TOFU）仍然把 offer/answer 绑在 window 上：broker 只认签发它的那个 webContents，
	// 渲染层自报的 senderId 一律不采纳。这条防线不随「去掉弹框」而消失。
	const { handlers, calls, sender } = addFlowHandlers();
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15", user: "deploy" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, status: "verified" });
	assert.equal(calls.offerPin[0].senderId, 42, "the broker's sender binding must come from event.sender.id");
	assert.equal(calls.confirmPin[0].answer.senderId, 42, "the automatic approval must answer as the same window");
	assert.equal(calls.confirmPin[0].answer.choice, "approve");
	// 渲染层即使自报 senderId 也不被采纳（readAddInput 根本不读该字段）。
	const spoof = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15", senderId: 1 });
	assert.equal(spoof.ok, true);
	assert.equal(calls.offerPin[1].senderId, 42, "a renderer-supplied senderId must be ignored");
});

test("add performs first-use trust in one step: no fingerprint prompt is pushed", async () => {
	// 产品决定（用户授权）：首次 host key 由主进程在同一动作里记录（TOFU，同 VSCode Remote），
	// 不再弹「请核对 SHA256」——那一步对用户是仪式成本，而不是他能做的判断。
	// 安全边界没有放宽：主机密钥**变化**仍由连接期的 pin 文件 + StrictHostKeyChecking=yes 拦住。
	const { handlers, calls, sender } = addFlowHandlers();
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.equal(result.status, "verified");
	assert.equal(calls.sent.length, 0, "no confirmation prompt may be pushed to the renderer");
	assert.equal(calls.confirmPin.length, 1, "the offer is approved inside the same add call");
});

test("add reports a stable code when the offer fails, and sends nothing", async () => {
	const { handlers, calls, sender } = addFlowHandlers({ offerFails: true });
	const result = await handlers.get("remote:add")({ sender }, { label: "serve", hostName: "10.81.2.15" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "REMOTE_HOST_PIN_INVALID" });
	assert.equal(calls.sent.length, 0, "a failed offer must not push a confirmation dialog");
});

test("scan and add honour the feature gate", async () => {
	const { handlers } = addFlowHandlers({ register: { enabled: false } });
	for (const channel of ["remote:scan-config", "remote:add"]) {
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
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, hostId: HOST_ID, status: "verified" });
	assert.equal(calls.createDraft[0].expected, 7, "the draft is written against the revision read before it");
	assert.equal(calls.offerPin[0].expected, 8, "the offer must use the revision the draft committed, not the pre-write one");
	// 自动 approve 仍走 CAS：期望值同样取「当前」revision（offer 不写入，所以还是 8）。
	assert.equal(calls.confirmPin[0].expected, 8);
});

test("the add-host channels are declared and bridged in all three places", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	for (const [key, channel] of [
		["remoteHostScanConfig", "remote:scan-config"],
		["remoteHostAdd", "remote:add"],
	])
		assert.match(shared, new RegExp(`${key}:\\s*"${channel}"`));
	assert.match(preload, /scanConfig:\s*\(\)?\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostScanConfig/);
	assert.match(preload, /add:\s*\(input[\s\S]{0,120}?ipcRenderer\.invoke\(ipcChannels\.remoteHostAdd/);
	// 去掉人工确认后不得留下悬空通道/桥接（否则就是第二套死路径）。
	assert.doesNotMatch(shared, /remoteHostAnswerPin|remoteHostPinRequest/);
	assert.doesNotMatch(preload, /answerPin|onPinRequest/);
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

test("add approves the offer on the same pin store that issued it", async () => {
	// 保留这条用例的真正目的：待确认状态挂在 pin store 的 broker 上，换实例就找不到。
	// 弹框去掉后，offer 与自动 approve 都在同一次 remote:add 里完成，因此必须共用同一个实例——
	// 否则「添加即验证」会静默退化成「添加后永远未验证」。
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
	assert.equal(add.ok, true, `add must succeed: ${JSON.stringify(add)}`);
	assert.equal(add.status, "verified");
	// 整个流程只应建一个 pin store；两个就说明待确认状态被分到了两个 broker 上。
	assert.equal(instances, 1, "offer and automatic approval must share one pin store");
	assert.equal(requests.size, 1);
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
	const calls = { diagnose: 0, completeActivation: [], discard: [], forget: [], clearLock: [], clearRebindLock: [], sent: [] };
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
					async clearStaleRebindLock(observerPid, confirmation) {
						calls.clearRebindLock.push({ observerPid, confirmation });
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
	const { handlers, calls } = repairHandlers({ status: "ready", findings: [] });
	const result = await handlers.get("remote:repair-diagnose")({});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, findings: [] });
	// 健康 store 也要 diagnose：残留 rebind 锁与状态无关，跳过会把唯一的出路藏起来。
	assert.equal(calls.diagnose, 1);
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

test("clear-rebind-lock 不带 host：确认之后才清理残留的重新绑定锁", async () => {
	const { handlers, calls, sender } = repairHandlers({ findings: [{ reason: "REMOTE_HOST_REBIND_LOCK_PRESENT", classification: "lock", hostIds: [], actions: ["clear-rebind-lock"] }] });
	const run = await handlers.get("remote:repair-run")({ sender }, "clear-rebind-lock");
	assert.deepEqual(JSON.parse(JSON.stringify(run)), { ok: true, status: "pending" });
	assert.equal(calls.clearRebindLock.length, 0, "请求阶段不执行任何写入");

	const answered = await handlers.get("remote:repair-answer")({ sender }, calls.sent[0].payload.requestId, "approve");
	assert.deepEqual(JSON.parse(JSON.stringify(answered)), { ok: true, ran: true });
	assert.equal(calls.clearRebindLock.length, 1);
	assert.equal(calls.clearRebindLock[0].observerPid, process.pid);
	assert.equal(calls.clearRebindLock[0].confirmation.requestId, calls.sent[0].payload.requestId);
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
	// 诊断没有给出任何动作 = 当前状态不允许这个修复，UI 不能凭空发明一个。
	const { handlers, calls, sender } = repairHandlers({ status: "ready", findings: [] });
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
 * 远端项目登记与按 projectId 的只读浏览（Phase 3 第二段）。
 *
 * 关键边界：
 * - 登记是**独立决定**（写 ProjectStore），与浏览根确认是两套 broker action/通道/表；
 * - canonical 值由 main 解析并持有，渲染层只能提交 `{ hostId, candidatePath }`；
 * - 按 projectId 读取时 root 来自 store 的 locator，且同主机 root 切换必须串行（单 helper 会话）。
 */
function projectHandlers(options = {}) {
	const calls = { resolve: [], list: [], read: [], search: [], sent: [], setRoot: [], connects: [] };
	const roots = new Map();
	// 测试用的项目库：只支持 ssh locator（本入口不处理本机项目）。
	const projects = options.projects ?? {};
	const handlers = new Map();
	// G1 拆分后项目域有自己的注册入口；stub 的 specifier 与拆分前一致（同一目录下的 ../remote/*）。
	const projectIpcModule = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot(input) {
					calls.resolve.push(input);
					// 第 1 次是 offer 时解析用户输入的路径；第 2 次起是 approve 时的复核。
					if (options.resolveFails) throw new Error("REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY");
					if (options.recheckFails === true && calls.resolve.length > 1) throw new Error("REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY");
					if (typeof options.resolveCanonical === "function") return { canonicalPath: options.resolveCanonical(input, calls.resolve.length) };
					return { canonicalPath: options.canonicalPath ?? "/srv/real-project" };
				},
			},
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: ({ port }) => ({
					async search(hostId, path, query) {
						calls.search.push({ hostId, path, query, portHasRequest: typeof port.request === "function" });
						if (options.searchFails !== undefined) throw new Error(options.searchFails);
						return { entries: options.searchEntries ?? [{ path: "src/app.ts", name: "app.ts", kind: "file", bytes: 10 }], scanned: 3, truncated: options.searchTruncated === true };
					},
				}),
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: ({ port }) => ({
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
	const projectIpc = projectIpcModule.registerRemoteProjectIpc({
		enabled: options.enabled ?? true,
		userDataDir: "/tmp/ignored",
		directoryReader: {
			async read({ session, relative }) {
				calls.list.push({ hostId: HOST_ID, path: relative === "" ? "." : relative, portHasRequest: typeof session.request === "function" });
				if (options.listFails) return { ok: false, code: "REMOTE_WORKSPACE_LIST_TOO_LARGE" };
				const entries = options.listEntries ?? [
					{ name: "src", kind: "directory" },
					{ name: "readme.md", kind: "file", bytes: 12 },
				];
				return { ok: true, value: { entries, scanned: entries.length, truncated: false } };
			},
		},
		service: () => ({
			client: { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: {}, run: async () => ({ exitCode: 0, stdout: "" }) },
			async request() {},
			async cancel() {},
			async connect(hostId) {
				calls.connects.push(hostId);
				if (options.connectFails) return { ok: false, hostId, code: "SSH_CONNECTION_FAILED" };
				return { ok: true, hostId, state: { hostId, generation: 1, state: "ready", attempts: 0, latched: false } };
			},
			async disconnect() {},
			setWorkspaceRoot(hostId, root) {
				calls.setRoot.push({ hostId, root });
				if (root === undefined) roots.delete(hostId);
				else roots.set(hostId, root);
			},
			/**
			 * 生产实现把「切根 + 建立会话 + 整次读取」收在这个边界里。本文件只验 IPC 边界的校验与适配，
			 * 所以替身只保留这里要断言的可观测行为（同 root 不重建、切 root 记一次 setRoot/connect）；
			 * 真实的串行与恢复语义由 tests/remoteProjectReadConcurrency.test.mjs 打穿真实 service 验证。
			 */
			async withProjectSession(hostId, root, task) {
				if (options.connectFails) return { ok: false, code: "SSH_CONNECTION_FAILED" };
				if (roots.get(hostId) !== root) {
					calls.setRoot.push({ hostId, root });
					roots.set(hostId, root);
					calls.connects.push(hostId);
				}
				return { ok: true, value: await task({ hostId, request: async () => ({}), cancel: async () => ({ cancelled: true }) }) };
			},
			// 项目事实与能力按 (hostId, canonicalRoot) 回答：替身只在自己记着的那个 root 上认账，
			// 兄弟 root 一律 undefined——这正是项目缓存围栏要证明的东西。
			projectConnectionFacts(hostId, root) {
				return roots.get(hostId) === root ? { connectionId: hostId + "#fake#1", state: "ready" } : undefined;
			},
			projectHelperCapabilities() {
				return ["fs.list"];
			},
			listDiagnostics: () => [],
			async dispose() {},
		}),
		...(options.noProjectsPort
			? {}
			: {
					projects: {
						async enroll(input) {
							calls.enroll = calls.enroll ?? [];
							calls.enroll.push(input);
							if (options.enrollFails) throw new Error("PROJECT_STORE_NEEDS_REPAIR");
							return { projectId: options.projectId ?? "project-remote-1" };
						},
						locator: (projectId) => projects[projectId],
					},
				}),
	});
	const sender = { id: 42, isDestroyed: () => false, send: (channel, payload) => calls.sent.push({ channel, payload }) };
	return { handlers, calls, sender, projectIpc };
}

async function confirmEnroll(harness, path = "/srv/link-project") {
	await harness.handlers.get("remote:project-enroll")({ sender: harness.sender }, HOST_ID, path);
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	const answer = await harness.handlers.get("remote:project-answer")({ sender: harness.sender }, requestId, "approve");
	return { requestId, answer };
}

test("enrolling a project probes the host then asks the user to confirm the canonical path", async () => {
	const harness = projectHandlers({ canonicalPath: "/srv/real-project" });
	const result = await harness.handlers.get("remote:project-enroll")({ sender: harness.sender }, HOST_ID, "/srv/link-project");
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, value: { status: "pending", hostId: HOST_ID, canonicalPath: "/srv/real-project" } });
	assert.equal(harness.calls.resolve.length, 1, "the host is probed with what the user typed");
	assert.equal(harness.calls.resolve[0].userPath, "/srv/link-project");
	const pushed = harness.calls.sent.at(-1);
	assert.equal(pushed.channel, "remote:project-enroll-confirm", "enrollment has its own push channel");
	assert.equal(pushed.payload.requestedPath, "/srv/link-project");
	assert.equal(pushed.payload.canonicalPath, "/srv/real-project");
	assert.equal(harness.calls.enroll, undefined, "nothing is persisted before the user approves");
});

test("approving an enrollment writes the durable record with the main-held canonical path", async () => {
	const harness = projectHandlers({ canonicalPath: "/srv/real-project", projectId: "project-remote-9" });
	const { answer } = await confirmEnroll(harness, "/srv/link-project");
	assert.deepEqual(JSON.parse(JSON.stringify(answer)), { ok: true, value: { enrolled: true, projectId: "project-remote-9" } });
	assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.enroll)), [{ hostId: HOST_ID, canonicalRemotePath: "/srv/real-project" }], "the store gets the canonical value, never the typed one");
	// 确认是一次复核而不仅是落库：复核的是「用户看到的 canonical 值」本身，而不是他当初敲的路径。
	assert.equal(harness.calls.resolve.length, 2, "approval re-probes the root it is about to persist");
	assert.equal(harness.calls.resolve[1].userPath, "/srv/real-project", "and it re-probes the confirmed canonical value");
});

test("a root that moved during the confirmation window is refused instead of enrolled", async () => {
	// 确认弹框是真实时间窗口：其间 /srv/real-project 可能被删掉，或路径上的 symlink 被改指。
	// 只写「用户看到过的那个字符串」不够——那个字符串此刻必须仍解析成它自己。
	const harness = projectHandlers({
		resolveCanonical: (_input, index) => (index === 1 ? "/srv/real-project" : "/srv/other-project"),
	});
	const { answer } = await confirmEnroll(harness, "/srv/link-project");
	assert.equal(answer.ok, false);
	assert.equal(answer.code, "REMOTE_PROJECT_ROOT_CHANGED");
	assert.equal(harness.calls.enroll, undefined, "a moved boundary must persist nothing");
});

test("a root that disappeared during the confirmation window is refused instead of enrolled", async () => {
	const harness = projectHandlers({ canonicalPath: "/srv/real-project", recheckFails: true });
	const { answer } = await confirmEnroll(harness, "/srv/link-project");
	assert.equal(answer.ok, false);
	assert.equal(answer.code, "REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY");
	assert.equal(harness.calls.enroll, undefined, "an unresolvable boundary must persist nothing");
});

test("denying an enrollment persists nothing", async () => {
	const harness = projectHandlers();
	await harness.handlers.get("remote:project-enroll")({ sender: harness.sender }, HOST_ID, "/srv/x");
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	const denied = await harness.handlers.get("remote:project-answer")({ sender: harness.sender }, requestId, "deny");
	assert.deepEqual(JSON.parse(JSON.stringify(denied)), { ok: true, value: { enrolled: false } });
	assert.equal(harness.calls.enroll, undefined);
});

test("an enrollment cannot be answered by another window", async () => {
	const harness = projectHandlers();
	await harness.handlers.get("remote:project-enroll")({ sender: harness.sender }, HOST_ID, "/srv/x");
	const requestId = harness.calls.sent.at(-1).payload.requestId;
	const other = { id: 99, isDestroyed: () => false, send: () => undefined };
	const result = await harness.handlers.get("remote:project-answer")({ sender: other }, requestId, "approve");
	assert.equal(result.ok, false);
	assert.equal(harness.calls.enroll, undefined, "a foreign window must not be able to enroll");
});

test("an enrollment confirmation is one-shot", async () => {
	const harness = projectHandlers();
	const { requestId } = await confirmEnroll(harness);
	const again = await harness.handlers.get("remote:project-answer")({ sender: harness.sender }, requestId, "approve");
	assert.equal(again.ok, false, "a replayed requestId must be refused");
});

test("a root that cannot be resolved is never offered for enrollment", async () => {
	const harness = projectHandlers({ resolveFails: true });
	const result = await harness.handlers.get("remote:project-enroll")({ sender: harness.sender }, HOST_ID, "/srv/file-not-dir");
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY");
	assert.equal(harness.calls.sent.length, 0, "nothing is offered for confirmation");
});

test("per-project reads resolve the locator, switch the root and read relative to it", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } } });
	const listed = await harness.handlers.get("remote:project-list")({}, "project-remote-1", "");
	assert.deepEqual(JSON.parse(JSON.stringify(listed)), {
		ok: true,
		value: {
			entries: [
				{ name: "src", kind: "directory" },
				{ name: "readme.md", kind: "file", bytes: 12 },
			],
			// 目录事实的版本号（W3）：值第一次装载后是 1；两个读者拿到同一个数说明看的是同一份事实。
			revision: 1,
			truncated: false,
			scanned: 2,
		},
	});
	assert.deepEqual(harness.calls.setRoot, [{ hostId: HOST_ID, root: "/srv/app" }], "the project's root is handed to the connection");
	assert.deepEqual(harness.calls.connects, [HOST_ID], "and the session is established with it");
	assert.deepEqual(harness.calls.list, [{ hostId: HOST_ID, path: ".", portHasRequest: true }]);

	const read = await harness.handlers.get("remote:project-read")({}, "project-remote-1", "readme.md");
	assert.deepEqual(JSON.parse(JSON.stringify(read)), { ok: true, value: { contentBase64: Buffer.from("hello").toString("base64"), bytes: 5, mtimeMs: 1 } });
});

test("the project trash directory is hidden from the root listing but not from a user subdirectory", async () => {
	const harness = projectHandlers({
		projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } },
		listEntries: [
			{ name: ".pideck-trash", kind: "directory" },
			{ name: "src", kind: "directory" },
		],
	});
	const root = await harness.handlers.get("remote:project-list")({}, "project-remote-1", "");
	assert.deepEqual(JSON.parse(JSON.stringify(root)), { ok: true, value: { entries: [{ name: "src", kind: "directory" }], revision: 1, truncated: false, scanned: 2 } }, "the reserved trash namespace is not a user-visible root entry");
	const nested = await harness.handlers.get("remote:project-list")({}, "project-remote-1", "src");
	assert.deepEqual(
		JSON.parse(JSON.stringify(nested)),
		{
			ok: true,
			value: {
				entries: [
					{ name: ".pideck-trash", kind: "directory" },
					{ name: "src", kind: "directory" },
				],
				// 同一个事实缓存里的下一个目录：装载即发新版本号。
				revision: 2,
				truncated: false,
				scanned: 2,
			},
		},
		"a same-named entry inside a subdirectory is user data and stays visible",
	);
});

test("recursive search does not return entries inside the project trash", async () => {
	const harness = projectHandlers({
		projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } },
		searchEntries: [
			{ path: ".pideck-trash/20261017-abcd1234/entry.json", name: "entry.json", kind: "file", bytes: 10 },
			{ path: ".pideck-trashish/app.ts", name: "app.ts", kind: "file", bytes: 10 },
			{ path: "src/app.ts", name: "app.ts", kind: "file", bytes: 10 },
		],
	});
	const found = await harness.projectIpc.searchProject("project-remote-1", "", "app");
	assert.deepEqual(
		JSON.parse(JSON.stringify(found)),
		{
			ok: true,
			value: {
				entries: [
					{ path: ".pideck-trashish/app.ts", name: "app.ts", kind: "file", bytes: 10 },
					{ path: "src/app.ts", name: "app.ts", kind: "file", bytes: 10 },
				],
				scanned: 3,
				truncated: false,
			},
		},
		"only the reserved first segment is filtered; a lookalike user path stays searchable",
	);
});

test("a second read of the same project does not reconfigure the session", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } } });
	await harness.handlers.get("remote:project-list")({}, "project-remote-1", "");
	await harness.handlers.get("remote:project-list")({}, "project-remote-1", "src");
	assert.deepEqual(harness.calls.setRoot, [{ hostId: HOST_ID, root: "/srv/app" }], "the root is set once, not per read");
	assert.equal(harness.calls.connects.length, 1, "the session is not torn down for a same-root read");
});

test("switching between two projects on one host re-establishes the session with the new root", async () => {
	const harness = projectHandlers({
		projects: {
			"project-a": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/a" },
			"project-b": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/b" },
		},
	});
	await harness.handlers.get("remote:project-list")({}, "project-a", "");
	await harness.handlers.get("remote:project-list")({}, "project-b", "");
	assert.deepEqual(
		harness.calls.setRoot,
		[
			{ hostId: HOST_ID, root: "/srv/a" },
			{ hostId: HOST_ID, root: "/srv/b" },
		],
		"each project's root is applied",
	);
	assert.equal(harness.calls.connects.length, 2, "a different root tears down and rebuilds the session");
});

test("the legacy search channel is gone; the handle still serves files:search-page", () => {
	const shared = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	// 2026-11-07 收口：renderer 只经公共 files:search-page，旧通道与 preload 方法一并下线。
	assert.ok(!shared.includes("remoteProjectSearch:"), "旧通道常量必须已删除");
	assert.ok(!preload.includes("searchProject:"), "preload 不再暴露旧入口");
	assert.equal(typeof projectHandlers().projectIpc.searchProject, "function", "main 内部 handle 仍供 files:search-page 使用");
});

test("per-project search resolves the locator, switches the root and returns rebuilt fields", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } } });
	const found = await harness.projectIpc.searchProject("project-remote-1", "", "app");
	assert.deepEqual(JSON.parse(JSON.stringify(found)), { ok: true, value: { entries: [{ path: "src/app.ts", name: "app.ts", kind: "file", bytes: 10 }], scanned: 3, truncated: false } });
	assert.deepEqual(harness.calls.setRoot, [{ hostId: HOST_ID, root: "/srv/app" }], "the project's root is handed to the connection");
	assert.deepEqual(harness.calls.search, [{ hostId: HOST_ID, path: ".", query: "app", portHasRequest: true }], "the empty relative path is the project root, spelled the reader's way");
});

test("search passes truncation through instead of pretending a partial answer is complete", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } }, searchTruncated: true });
	const found = await harness.projectIpc.searchProject("project-remote-1", "", "app");
	assert.equal(found.ok, true);
	assert.equal(found.value.truncated, true, "a capped walk must be visible to the UI");
});

test("an invalid search query is refused at the boundary without touching the host", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } } });
	for (const bad of ["", "a".repeat(129), "a\u0000b", 42, null, undefined]) {
		const result = await harness.projectIpc.searchProject("project-remote-1", "", bad);
		assert.equal(result.ok, false, JSON.stringify(bad) + " must be refused");
		assert.equal(result.code, "QUERY_INVALID");
	}
	assert.equal(harness.calls.search.length, 0, "no frame may leave with an invalid query");
	assert.equal(harness.calls.setRoot.length, 0, "and the session is not even configured");
});

test("a renderer cannot widen the search boundary with an absolute or traversing path", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } } });
	for (const bad of ["/etc", "../outside", "src/../../etc", "a//b", "./x", "a\\b", "x\u0000y"]) {
		const result = await harness.projectIpc.searchProject("project-remote-1", bad, "app");
		assert.equal(result.ok, false, JSON.stringify(bad) + " must be refused for search");
		assert.equal(result.code, "REMOTE_PROJECT_PATH_INVALID");
	}
	assert.equal(harness.calls.search.length, 0, "nothing may reach the reader");
});

test("search surfaces reader failures as stable codes", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } }, searchFails: "RESULT_TOO_LARGE" });
	const result = await harness.projectIpc.searchProject("project-remote-1", "", "app");
	assert.equal(result.ok, false);
	assert.equal(result.code, "RESULT_TOO_LARGE", "the reader's own bounded-result refusal is relayed unchanged");
});

test("per-project reads reject a project that is not an ssh project", async () => {
	const harness = projectHandlers({ projects: { "local-1": { kind: "local", environment: "native", localPath: "/srv/local" } } });
	const listed = await harness.handlers.get("remote:project-list")({}, "local-1", "");
	assert.equal(listed.ok, false);
	assert.equal(listed.code, "UNSUPPORTED_PROJECT_LOCATION");
	assert.equal(harness.calls.list.length, 0, "a local project never reaches the remote reader");
});

test("per-project reads refuse an unknown project", async () => {
	const harness = projectHandlers({ projects: {} });
	const listed = await harness.handlers.get("remote:project-list")({}, "missing", "");
	assert.equal(listed.ok, false);
	assert.equal(listed.code, "REMOTE_PROJECT_NOT_FOUND");
});

test("a renderer cannot widen a project boundary with an absolute or traversing path", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } } });
	for (const bad of ["/etc/passwd", "../outside", "src/../../etc", "a//b", "./x", "a\\b", "x\u0000y"]) {
		const listed = await harness.handlers.get("remote:project-list")({}, "project-remote-1", bad);
		assert.equal(listed.ok, false, `${JSON.stringify(bad)} must be refused for list`);
		assert.equal(listed.code, "REMOTE_PROJECT_PATH_INVALID");
	}
	assert.equal(harness.calls.list.length, 0, "nothing may reach the reader");
	assert.equal(harness.calls.setRoot.length, 0, "and no session is configured for a bad path");
});

test("per-project read refuses the root as a file target", async () => {
	const harness = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } } });
	const read = await harness.handlers.get("remote:project-read")({}, "project-remote-1", "");
	assert.equal(read.ok, false);
	assert.equal(read.code, "REMOTE_PROJECT_PATH_INVALID");
});

test("per-project reads surface connection and reader failures as stable codes", async () => {
	const failingConnect = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } }, connectFails: true });
	const connectResult = await failingConnect.handlers.get("remote:project-list")({}, "project-remote-1", "");
	assert.equal(connectResult.ok, false);
	assert.equal(connectResult.code, "SSH_CONNECTION_FAILED");

	const failingReader = projectHandlers({ projects: { "project-remote-1": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } }, listFails: true, readFails: true });
	assert.equal((await failingReader.handlers.get("remote:project-list")({}, "project-remote-1", "")).code, "REMOTE_WORKSPACE_LIST_TOO_LARGE");
	assert.equal((await failingReader.handlers.get("remote:project-read")({}, "project-remote-1", "a")).code, "REMOTE_WORKSPACE_READ_FAILED");
});

test("enrollment and per-project reads need the projects port", async () => {
	const harness = projectHandlers({ noProjectsPort: true });
	const enrolled = await harness.handlers.get("remote:project-enroll")({ sender: harness.sender }, HOST_ID, "/srv/x");
	assert.equal(enrolled.ok, false);
	assert.equal(enrolled.code, "REMOTE_PROJECT_ENROLL_UNAVAILABLE");
	assert.equal((await harness.handlers.get("remote:project-list")({}, "project-remote-1", "")).code, "REMOTE_PROJECT_ENROLL_UNAVAILABLE");
});

test("every project channel honours the feature gate", async () => {
	const harness = projectHandlers({ enabled: false });
	for (const [channel, args] of [
		["remote:project-enroll", [{ sender: harness.sender }, HOST_ID, "/srv"]],
		["remote:project-answer", [{ sender: harness.sender }, "req", "approve"]],
		["remote:project-list", [{}, "project-remote-1", ""]],
		["remote:project-read", [{}, "project-remote-1", "a"]],
	]) {
		const result = await harness.handlers.get(channel)(...args);
		assert.equal(result.ok, false, `${channel} must be gated`);
		assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	}
	assert.equal(harness.calls.resolve.length, 0, "a gated build must not probe the host");
	assert.equal(harness.calls.sent.length, 0);
});
