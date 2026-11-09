import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 同主机两个远端项目之间的**读取隔离**回归（Phase 3 第一批 A）。
 *
 * 为什么这组用例必须打穿到真实 service：串根缺陷的修复落点就是 service 的会话/锁边界，
 * 如果只是在 IPC 层注入一个「假 service」，锁定逻辑就被搬进了替身，用例无论实现对错都会绿。
 * 所以这里只替换 SSH/helper 边界（ports.createManager / bootstrap），
 * RemoteHostConnectionService、registerRemoteHostIpc、RemoteWorkspaceReader 全部是生产实现。
 *
 * 假 manager 如实复刻一条真实约束：**一个 helper 会话的 --root 在它生命周期内固定**，
 * 所以它的每个 fs.* 答案只取决于自己被创建时拿到的 root。于是一旦一次读取中途被切根，
 * 后续分块就会落到新 root 的 manager 上——正是要复现的串根形态。
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const OTHER_HOST_ID = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
const PROJECTS = {
	"project-a": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/a" },
	"project-b": { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/b" },
	"project-other": { kind: "ssh", hostId: OTHER_HOST_ID, remotePath: "/srv/other" },
};

/** 每个 root 下一份同名但内容不同的文件：串根会直接表现为读到了另一个项目的内容。 */
const CONTENT = {
	[HOST_ID]: {
		"/srv/a": { "data.bin": "AAAA" },
		"/srv/b": { "data.bin": "BBBB" },
	},
	[OTHER_HOST_ID]: {
		"/srv/other": { "data.bin": "OTHER" },
	},
};
const MTIME = 100;

function profile(id) {
	const at = "2026-01-01T00:00:00.000Z";
	return { id, label: "host", sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10_000, createdAt: at, updatedAt: at };
}

async function writeStore(userDataDir, entries) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision: 7, profiles: entries.map(profile), retiredHostIds: [] }));
	const state = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	assert.equal(state.status, "ready", state.reasons.join(","));
}

/**
 * 有界等待某个可观测副作用出现。
 *
 * 不能只 drain 微任务：切根要走真实的 store 读盘，setImmediate 转几圈并不保证它已跑完，
 * 那会让「A 的读取被谁服务」变成调度运气。修复后这个条件永远不会成立，这里超时退出，
 * 测试随后才放行被 gate 住的读取。
 */
async function waitFor(predicate, timeoutMs = 750) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	return predicate();
}

function decodeBase64(value) {
	return Buffer.from(value, "base64").toString("utf8");
}

/**
 * 组装一台可控假远端 + 真实 IPC。
 *
 * gate 用来把一次读取卡在 helper 请求的**返回之前**：这样「读取仍在进行时另一个项目切根」
 * 才是确定性的，不依赖调度运气。
 */
async function harness(run) {
	const userDataDir = await mkdtemp(join(tmpdir(), "pideck-project-isolation-"));
	try {
		await writeStore(userDataDir, [HOST_ID, OTHER_HOST_ID]);
		const events = [];
		const requests = [];
		const managers = [];
		const verifyCalls = [];
		// verifyRootCanonical 用来制造「root 已漂移」；verifyRootFails 用来制造「无法复核」。
		const control = { gate: null, connectFails: false, verifyRootCanonical: undefined, verifyRootFails: false };
		let disposed = 0;

		const ports = {
			bootstrap: async () => ({ bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host" }),
			resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v24.11.0", probed: 1 }),
			createSentinel: () => "sentinel00000001",
			createNonce: () => "nonce-000000000001",
			// 真实实现是 RemoteBrowseRoot.resolveRemoteBrowseRoot（pinned readlink -f 探测）；默认回显请求值，
			// 让「复核通过」这条路径在替身上也可测。
			verifyRoot: async ({ hostId, userPath }) => {
				verifyCalls.push({ hostId, userPath });
				if (control.verifyRootFails) throw new Error("REMOTE_BROWSE_ROOT_UNRESOLVED");
				return { canonicalPath: control.verifyRootCanonical ?? userPath };
			},
			createManager: (input) => {
				// root 在会话创建时固定：这正是「切根必须重建会话」的原因。
				const root = input.helperSession.root;
				const manager = {
					root,
					state: "disconnected",
					// 真实 manager 的 disconnect(reason:"shutdown") 会 latch 机器，此后 begin-attempt 被
					// reducer 丢掉。如实复刻，否则「用户重连能否恢复」会被过于宽松的替身掩盖。
					latched: false,
					machine() {
						return { hostId: HOST_ID, generation: 1, state: manager.state, attempts: 0, lastCode: "SSH_CONNECTION_READY", latched: manager.latched };
					},
					async connect(hostId) {
						events.push("connect:" + root);
						if (manager.latched) return manager.machine();
						if (control.connectFails) {
							manager.state = "disconnected";
							throw new Error("SSH_CONNECTION_FAILED");
						}
						manager.state = "ready";
						return manager.machine();
					},
					getState(hostId) {
						return { ...manager.machine(), hostId };
					},
					async disconnect() {
						events.push("disconnect:" + root);
						manager.state = "disconnected";
						manager.latched = true;
					},
					async request(hostId, method, params) {
						// 真实 SshConnectionManager.request 只在 ready 且有活客户端时放行。
						if (manager.state !== "ready") throw new Error("SSH_CONNECTION_NOT_READY");
						requests.push({ root, method, path: params?.path });
						const gate = control.gate;
						if (gate !== null && !gate.used && gate.root === root && method === gate.method) {
							gate.used = true;
							gate.reached();
							await gate.released;
						}
						return answerFor(hostId, root, method, params);
					},
					async cancel() {
						return { cancelled: true };
					},
					listDiagnostics: () => [],
					async dispose() {
						disposed += 1;
						manager.state = "disposed";
					},
				};
				managers.push(manager);
				return manager;
			},
		};

		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });

		const handlers = new Map();
		const stubs = { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } };
		// G1 拆分后 hosts 域与项目域各有注册入口；两个 load 共用同一批替身（否则 fakes 不同源）。
		// 本套件同时用 host 通道（connect/disconnect）与项目通道，所以两个 register 都要调。
		const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", { stubs });
		const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", { stubs });
		registerRemoteHostIpc({
			enabled: true,
			userDataDir,
			list: async () => ({ snapshot: { status: "ready", revision: 7, profiles: [], retiredHostIds: [] }, findings: [] }),
			service: () => service,
		});
		registerRemoteProjectIpc({
			enabled: true,
			userDataDir,
			service: () => service,
			directoryReader: {
				async read({ canonicalRoot }) {
					const files = Object.values(CONTENT).reduce((found, roots) => found ?? roots[canonicalRoot], undefined) ?? {};
					const entries = Object.keys(files).map((name) => ({ name, kind: "file", bytes: 1 }));
					return { ok: true, value: { entries, scanned: entries.length, truncated: false } };
				},
			},
			projects: { enroll: async () => ({ projectId: "project-a" }), locator: (projectId) => PROJECTS[projectId] },
		});

		const api = {
			events,
			requests,
			managers,
			verifyCalls,
			control,
			disposedCount: () => disposed,
			list: (projectId, path = "") => handlers.get("remote:project-list")({}, projectId, path),
			read: (projectId, path) => handlers.get("remote:project-read")({}, projectId, path),
			disconnect: () => handlers.get("remote:disconnect")({}, HOST_ID),
			connect: () => handlers.get("remote:connect")({}, HOST_ID),
		};
		try {
			return await run(api);
		} finally {
			await service.dispose();
		}
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

function answerFor(hostId, root, method, params) {
	const files = CONTENT[hostId]?.[root] ?? {};
	const text = files[params?.path] ?? "";
	if (method === "fs.stat") return { kind: "file", bytes: Buffer.byteLength(text), mtimeMs: MTIME };
	if (method === "fs.read") {
		const offset = Number(params?.offset ?? 0);
		const slice = Buffer.from(text, "utf8").subarray(offset, offset + Number(params?.bytes ?? 0));
		return { chunk: slice.toString("base64"), bytes: slice.length, eof: offset + slice.length >= Buffer.byteLength(text) };
	}
	throw new Error("PROTOCOL_INVALID");
}

test("一次读取不会被同主机另一个项目的切根打断（跨项目串根）", async () => {
	await harness(async (api) => {
		// 先建立项目 A 的会话，让随后那次读取确实落在已经 ready 的会话上。
		const opened = await api.list("project-a");
		assert.equal(opened.ok, true, JSON.stringify(opened));

		let reached;
		const gated = new Promise((resolve) => {
			reached = resolve;
		});
		let release;
		const released = new Promise((resolve) => {
			release = resolve;
		});
		api.control.gate = { root: "/srv/a", method: "fs.stat", used: false, reached, released };

		const readPromise = api.read("project-a", "data.bin");
		await gated;

		// 项目 B 现在切根。修复后它必须排队等 A 的整次读取结束。
		let switchDone = false;
		const switchPromise = api.list("project-b").then((value) => {
			switchDone = true;
			return value;
		});
		// 修复后 B 必须排队等 A 整次读取结束，因此这个条件不会成立（有界超时后继续）。
		await waitFor(() => api.managers.some((entry) => entry.root === "/srv/b"));

		// 快照必须在放行之前取：此刻 A 的读取仍在进行中。
		const disposedWhileReadingA = api.disposedCount();
		release();

		const read = await readPromise;
		const switched = await switchPromise;

		assert.equal(read.ok, true, JSON.stringify(read));
		assert.equal(decodeBase64(read.value.contentBase64), "AAAA", "项目 A 的读取绝不能由项目 B 的 root 服务");
		assert.equal(disposedWhileReadingA, 0, "读取仍在进行时，承载它的 helper 会话不得被切根销毁");
		assert.equal(switched.ok, true, JSON.stringify(switched));
		assert.equal(switchDone, true);
		// A 的每一次 helper 请求都必须落在 /srv/a 的会话上。
		const duringRead = api.requests.filter((entry) => entry.path === "data.bin" && entry.root !== "/srv/a");
		assert.deepEqual(duringRead, [], "读取期间不得有请求落到别的 root 上");
	});
});

test("同目录连接失败后，下一次读取必须能重新建立会话", async () => {
	await harness(async (api) => {
		api.control.connectFails = true;
		const failed = await api.read("project-a", "data.bin");
		assert.equal(failed.ok, false, "第一次必须如实失败");

		// 主机恢复（例如刚才是瞬时故障）。root 字符串完全没变，但会话并不存在。
		api.control.connectFails = false;
		const retried = await api.read("project-a", "data.bin");
		assert.equal(retried.ok, true, "同 root 重试必须恢复，实际 " + JSON.stringify(retried));
		assert.equal(decodeBase64(retried.value.contentBase64), "AAAA");
	});
});

test("用户显式断开后，后台读取不得把连接悄悄接回来", async () => {
	await harness(async (api) => {
		const first = await api.read("project-a", "data.bin");
		assert.equal(first.ok, true);
		assert.equal((await api.disconnect()).ok, true);

		const managersBefore = api.managers.length;
		const connectsBefore = api.events.filter((entry) => entry.startsWith("connect:")).length;

		const afterDisconnect = await api.read("project-a", "data.bin");
		assert.equal(afterDisconnect.ok, false, "显式断开后读取必须明确失败，而不是静默重连");
		assert.equal(api.managers.length, managersBefore, "后台读取不得新建会话来撤销用户的断开");
		assert.equal(api.events.filter((entry) => entry.startsWith("connect:")).length, connectsBefore, "后台读取不得偷偷重连");
	});
});

test("用户显式断开后，用户自己发起的重连必须能恢复", async () => {
	await harness(async (api) => {
		assert.equal((await api.read("project-a", "data.bin")).ok, true);
		await api.disconnect();
		const reconnected = await api.connect();
		assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
		const read = await api.read("project-a", "data.bin");
		assert.equal(read.ok, true, "用户重连后必须可读，实际 " + JSON.stringify(read));
		assert.equal(decodeBase64(read.value.contentBase64), "AAAA");
	});
});

test("root 在会话建立前已被改指时，读取必须被拒且不发出任何 helper 请求", async () => {
	await harness(async (api) => {
		api.control.verifyRootCanonical = "/srv/a-moved";
		const read = await api.read("project-a", "data.bin");
		assert.equal(read.ok, false, "漂移的边界不得被读取");
		assert.equal(read.code, "SSH_PROJECT_ROOT_CHANGED");
		assert.deepEqual(api.requests, [], "会话都没建立，一个 helper 请求都不该发出");
		assert.equal(api.managers.length, 0, "也不该建立任何会话");
	});
});

test("root 无法复核时，读取必须 fail-closed", async () => {
	await harness(async (api) => {
		api.control.verifyRootFails = true;
		const read = await api.read("project-a", "data.bin");
		assert.equal(read.ok, false, "复核不了就不能读");
		assert.equal(read.code, "SSH_PROJECT_ROOT_UNRESOLVED");
		assert.deepEqual(api.requests, [], "复核失败不得发出 helper 请求");
	});
});

test("复核只在会话建立时发生，不会加到每次读取的热路径上", async () => {
	await harness(async (api) => {
		assert.equal((await api.read("project-a", "data.bin")).ok, true, "复核通过时读取照常");
		const afterFirst = api.verifyCalls.length;
		assert.ok(afterFirst >= 1, "会话建立时必须复核一次");
		assert.equal((await api.read("project-a", "data.bin")).ok, true);
		assert.equal(api.verifyCalls.length, afterFirst, "同一个已建立的会话不得每次读取都重新探测");
	});
});

test("一台主机的读取不会阻塞另一台主机", async () => {
	await harness(async (api) => {
		assert.equal((await api.list("project-a")).ok, true);

		let reached;
		const gated = new Promise((resolve) => {
			reached = resolve;
		});
		const released = Promise.withResolvers();
		api.control.gate = { root: "/srv/a", method: "fs.stat", used: false, reached, released: released.promise };

		const readA = api.read("project-a", "data.bin");
		await gated;
		const readOther = await api.read("project-other", "data.bin");
		assert.equal(readOther.ok, true, "另一台主机必须能在 A 被卡住时正常读取");
		assert.equal(decodeBase64(readOther.value.contentBase64), "OTHER");
		released.resolve();
		assert.equal((await readA).ok, true);
	});
});

test("一次读取失败不会卡死后续读取", async () => {
	await harness(async (api) => {
		api.control.gate = null;
		// 未知项目必须失败，但不能把队列/会话卡住。
		const missing = await api.read("missing-project", "data.bin");
		assert.equal(missing.ok, false);
		const read = await api.read("project-a", "data.bin");
		assert.equal(read.ok, true, "失败之后队列必须继续工作");
		assert.equal(decodeBase64(read.value.contentBase64), "AAAA");
	});
});
