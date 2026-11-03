import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 同主机两个远端项目之间的并发串根隔离（A1 的验收套件）。
 *
 * 与 tests/remoteHostIpc.test.mjs 的 projectHandlers 不同，这里**不替换** RemoteWorkspaceReader：
 * 真实 reader（分块读、前后 stat 比对）跑到真实 registerRemoteHostIpc + 真实
 * createRemoteHostConnectionService 上，只把 SSH 传输层换成一个可控假 manager。
 * 这样「A 的多分块读取执行到一半时 B 切根」是真实交错，而不是桩之间的假交错。
 *
 * 缺陷基线（HEAD=f7b18947）：ensureProjectRoot 只串行 setWorkspaceRoot+connect，
 * reader 的实际 fs.* 请求在队列外；且 service.request 每次现取 manager，于是 A 的后续分块
 * 会落到 B 的 root 上。
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");

const HOST_A = "b145de8c-6330-45be-8752-f20e8e270150";
const HOST_B = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
const ROOT_A = "/srv/app-a";
const ROOT_B = "/srv/app-b";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const OTHER_HOST_PROJECT = "project-other-host";

// REMOTE_HELPER_MAX_CHUNK_BYTES = 1 MiB：文件必须大于一个 chunk 才会走多分块路径。
const CHUNK = 1024 * 1024;
const FILE_SIZE = CHUNK + 16;
const MTIME = 1_700_000_000_000;
const FILL_A = 0x41;
const FILL_B = 0x42;
const FILL_OTHER = 0x43;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 跨 realm 断言：vm 里造出来的对象原型不同，deepStrictEqual 会误判。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function decode(result) {
	return Buffer.from(result.value.contentBase64, "base64");
}

function expected(fill, bytes = FILE_SIZE) {
	return Buffer.alloc(bytes, fill);
}

/**
 * 可控假远端：per-root 文件内容不同、同名文件、尺寸与 mtime 相同。
 * 尺寸/mtime 相同是刻意的——这样「第一块来自 A、第二块来自 B」不会被收尾 stat 拦下，
 * 串根会作为一份看起来自洽的混读内容返回。
 */
function fakeRemote() {
	const roots = new Map();
	const readGates = [];
	const put = (root, path, fill, bytes = FILE_SIZE) => {
		const files = roots.get(root) ?? new Map();
		files.set(path, { content: Buffer.alloc(bytes, fill), mtimeMs: MTIME });
		roots.set(root, files);
	};
	put(ROOT_A, "data.txt", FILL_A);
	put(ROOT_B, "data.txt", FILL_B);
	// 每个 root 再放一个只有它自己有的文件：单帧 list 的结果因此可以判定「服务自哪个 root」。
	put(ROOT_A, "only-a.txt", FILL_A, 4);
	put(ROOT_B, "only-b.txt", FILL_B, 4);
	// 另一台主机上，故意用不同内容：跨主机读取不能互相串。
	put("/srv/other-host", "data.txt", FILL_OTHER);

	const fileFor = (root, path) => {
		const file = roots.get(root)?.get(path);
		if (file === undefined) {
			const error = new Error("PATH_NOT_FOUND");
			error.code = "PATH_NOT_FOUND";
			throw error;
		}
		return file;
	};

	/** 卡住某一次 fs.read：让测试能精确决定「A 读到一半」的时机。 */
	const gateRead = (root, path, offset) => {
		let markEntered;
		let release;
		const entered = new Promise((resolve) => {
			markEntered = resolve;
		});
		const wait = new Promise((resolve) => {
			release = resolve;
		});
		const gate = { root, path, offset, entered, wait, release, notifyEntered: markEntered, engaged: false };
		readGates.push(gate);
		return gate;
	};

	const gateFor = (root, path, offset) => readGates.find((gate) => !gate.engaged && gate.root === root && gate.path === path && gate.offset === offset);

	return {
		gateRead,
		gateFor,
		stat(root, path) {
			const file = fileFor(root, path);
			return { kind: "file", bytes: file.content.length, mtimeMs: file.mtimeMs };
		},
		list(root) {
			const files = roots.get(root) ?? new Map();
			return [...files.entries()].map(([name, file]) => ({ name, kind: "file", bytes: file.content.length }));
		},
		read(root, path, offset, wanted) {
			const file = fileFor(root, path);
			const end = Math.min(file.content.length, offset + wanted);
			const slice = file.content.subarray(offset, end);
			return { chunk: Buffer.from(slice).toString("base64"), bytes: slice.length, eof: offset + slice.length >= file.content.length };
		},
	};
}

/**
 * 假 SSH manager：每个 manager 固定绑一个 root（对应 helper 会话的 --root），
 * 所有请求都按这个 root 服务——和真实 SshConnectionManager/helper 的语义一致。
 */
function fakeManagerPorts(remote, overrides = {}) {
	const calls = { bootstrap: [], createManager: [], connects: [], disconnects: [], disposed: [], requests: [] };
	let requestSeq = 0;
	const ports = {
		calls,
		bootstrap: async (input) => {
			calls.bootstrap.push(input);
			if (overrides.bootstrapFails?.(calls.bootstrap.length) === true) throw new Error("SSH_BOOTSTRAP_FAILED");
			return { bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host", active: "/home/remote/.pideck/remote-host/bundles/" + "a".repeat(64) };
		},
		resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v24.11.0", probed: 1 }),
		createSentinel: () => "sentinel-00000000",
		createNonce: () => "nonce-" + String(calls.bootstrap.length + 1).padStart(12, "0"),
		// 会话建立时的边界复核（lead F3）。默认回显请求路径＝「仍 canonical 指向它自己」，
		// 否则替身会去打真实 SSH；要构造漂移就覆盖这里。
		verifyRoot: async ({ userPath }) => ({ canonicalPath: userPath }),
		createManager: (input) => {
			const root = input.helperSession.root;
			const record = { root, hostIds: [], requests: [], disconnects: [], disposed: 0 };
			calls.createManager.push({ root, generation: input.helperSession.generation });
			const manager = {
				state: "disconnected",
				/** withProjectSession 用状态决定「复用 / 复活 / 重建」，所以假 manager 也要能回答它。 */
				getState(hostId) {
					return { hostId, generation: 1, state: manager.state, attempts: 0, latched: false, lastCode: "SSH_HOST_NOT_READY" };
				},
				async connect(hostId) {
					record.hostIds.push(hostId);
					calls.connects.push({ hostId, root });
					manager.state = "ready";
					return { hostId, generation: 1, state: "ready", attempts: 0, latched: false };
				},
				async disconnect(hostId, reason) {
					record.disconnects.push({ hostId, reason });
					manager.state = "disconnected";
					calls.disconnects.push({ hostId, reason, root });
				},
				listDiagnostics: () => [],
				async dispose() {
					record.disposed += 1;
					calls.disposed.push(root);
				},
				async cancel() {
					return { cancelled: false, reason: "already-settled" };
				},
				async request(hostId, method, params, options) {
					if (manager.state !== "ready") throw new Error("SSH_HOST_NOT_READY");
					const requestId = "req-" + String((requestSeq += 1));
					options?.onRequestId?.(requestId);
					record.requests.push({ hostId, method, params });
					calls.requests.push({ hostId, method, params, root });
					if (method === "fs.stat") return remote.stat(root, params.path);
					if (method === "fs.read") {
						const gate = remote.gateFor(root, params.path, params.offset);
						if (gate !== undefined) {
							gate.engaged = true;
							gate.notifyEntered();
							await gate.wait;
						}
						return remote.read(root, params.path, params.offset, params.bytes);
					}
					throw new Error("PROTOCOL_INVALID");
				},
			};
			return manager;
		},
		...overrides.ports,
	};
	return ports;
}

/** 结构合法的 host store 快照（service 的 readiness 用 revision 判定，空 profiles 即为 ready）。 */
async function writeStore(userDataDir, revision = 7) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision, profiles: [], retiredHostIds: [] }));
}

/**
 * 把真实 IPC 注册到真实 service 上。
 * 只 stub 与本套件无关的模块（browse root / 主机 store / pin store / electron），
 * 刻意不 stub RemoteWorkspaceReader，以便真实分块读参与交错。
 */
function registerIpc({ service, projects, userDataDir, beforeProjectOperation, directoryReader }) {
	const handlers = new Map();
	const stubs = {
		electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
		"../remote/RemoteBrowseRoot": { resolveRemoteBrowseRoot: async () => ({ canonicalPath: ROOT_A }) },
		"../remote/RemoteHostStore": { RemoteHostStore: { open: async () => ({ getSnapshot: () => ({ status: "ready", revision: 1, profiles: [] }) }) } },
		"../remote/SshHostPinStore": {
			SshHostPinStore: class {
				dispose() {}
			},
		},
	};
	// G1 拆分后 hosts 域与项目域各有注册入口；两个 load 共用同一批替身（否则 fakes 不同源）。
	const { registerRemoteHostIpc } = loadTsCommonJs("src/main/ipc/remoteHostIpc.ts", { stubs });
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", { stubs });
	// 传输包装：withProjectSession 是整次项目读取的入口；在它**取锁之前**留一个 barrier，
	// 就能精确制造「这次操作还没开始，另一个项目先切根」的窗口。其余原样转发给真实 service。
	const wrapped = new Proxy(service, {
		get(target, property) {
			if (property === "withProjectSession" && beforeProjectOperation !== undefined) {
				return async (hostId, root, task) => {
					await beforeProjectOperation({ hostId, root });
					return target.withProjectSession(hostId, root, task);
				};
			}
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	registerRemoteHostIpc({
		enabled: true,
		userDataDir,
		list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }),
		service: () => wrapped,
	});
	registerRemoteProjectIpc({
		enabled: true,
		userDataDir,
		service: () => wrapped,
		directoryReader,
		projects: {
			enroll: async () => ({ projectId: PROJECT_A }),
			locator: (projectId) => projects[projectId],
		},
	});
	return handlers;
}

const LOCATORS = {
	[PROJECT_A]: { kind: "ssh", hostId: HOST_A, remotePath: ROOT_A },
	[PROJECT_B]: { kind: "ssh", hostId: HOST_A, remotePath: ROOT_B },
	[OTHER_HOST_PROJECT]: { kind: "ssh", hostId: HOST_B, remotePath: "/srv/other-host" },
};

async function withHarness({ overrides = {}, beforeProjectOperation } = {}, run) {
	const userDataDir = await mkdtemp(join(tmpdir(), "pideck-remote-project-isolation-"));
	try {
		await writeStore(userDataDir, 7);
		const remote = fakeRemote();
		const ports = fakeManagerPorts(remote, overrides);
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports, ...(overrides.serviceOptions ?? {}) });
		const handlers = registerIpc({
			service,
			projects: LOCATORS,
			userDataDir,
			beforeProjectOperation,
			directoryReader: {
				async read({ canonicalRoot }) {
					const entries = remote.list(canonicalRoot);
					return { ok: true, value: { entries, scanned: entries.length, truncated: false } };
				},
			},
		});
		const result = await run({ handlers, service, remote, ports });
		await service.dispose();
		return result;
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

const read = (handlers, projectId, path = "data.txt") => handlers.get("remote:project-read")({}, projectId, path);
const list = (handlers, projectId, path = "") => handlers.get("remote:project-list")({}, projectId, path);

/** 一个「已 settle 就置位」的观察器：用来断言某个操作在锁释放前不会完成。 */
function settleTracker(promise) {
	const tracker = { settled: false };
	promise.then(
		() => {
			tracker.settled = true;
		},
		() => {
			tracker.settled = true;
		},
	);
	return tracker;
}

test("a root switch mid multi-chunk read must not serve the rest of project A's read from project B", async () => {
	// 失败基线证据（HEAD）：A 读出 'A'*1MiB + 'B'*16 —— 前半来自 A 的 root，后半来自 B 的 root。
	// 修复后 B 的整次操作必须**排队**，所以这里只发起、不 await，等 A 的锁释放后再一起收结果。
	await withHarness({}, async ({ handlers, remote, ports }) => {
		const gate = remote.gateRead(ROOT_A, "data.txt", 0);

		const pendingA = read(handlers, PROJECT_A);
		await gate.entered; // A 的第一块 fs.read 已派发到 A 的 manager，被卡住

		const pendingB = read(handlers, PROJECT_B);
		const bTracker = settleTracker(pendingB);
		// 串行边界必须覆盖「最后一块读完」：B 的整次操作应排在 A 的读取之后，而不是插入分块之间。
		await sleep(150);
		assert.equal(bTracker.settled, false, "project B's operation must queue behind project A's whole read, not interleave with it");

		gate.release();
		const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

		assert.equal(resultB.ok, true, "project B read must succeed: " + JSON.stringify(resultB));
		assert.ok(decode(resultB).equals(expected(FILL_B)), "project B must read project B's bytes");

		assert.equal(resultA.ok, true, "project A read must settle ok: " + JSON.stringify(resultA));
		const bytesA = decode(resultA);
		const mixedAt = bytesA.findIndex((value, index) => value !== FILL_A);
		assert.equal(mixedAt, -1, "project A's read must contain only project A's bytes; first foreign byte at offset " + mixedAt + " (size " + bytesA.length + ", roots=" + JSON.stringify(ports.calls.createManager) + ")");
	});
});

test("a failed connect must not poison the next read of the same project", async () => {
	// A1 验收：连接失败后，同 root 的下一次读取要能恢复；不能因为
	// getWorkspaceRoot() 的字符串相同就跳过连接状态检查（HEAD 上第二次读直接失败）。
	await withHarness({ overrides: { bootstrapFails: (attempt) => attempt === 1 } }, async ({ handlers }) => {
		const first = await read(handlers, PROJECT_A);
		assert.equal(first.ok, false, "the first read must fail while the host cannot connect");

		const second = await read(handlers, PROJECT_A);
		assert.equal(second.ok, true, "after a transient connect failure the same root must be read again: " + JSON.stringify(second));
		assert.ok(decode(second).equals(expected(FILL_A)), "and it must be project A's bytes");
	});
});

test("an explicit disconnect must not be silently undone by a background read", async () => {
	await withHarness({}, async ({ handlers, ports }) => {
		const before = await read(handlers, PROJECT_A);
		assert.equal(before.ok, true);

		const disconnected = await handlers.get("remote:disconnect")({}, HOST_A);
		assert.equal(disconnected.ok, true);
		const connectsBefore = ports.calls.connects.length;

		const after = await read(handlers, PROJECT_A);
		assert.equal(after.ok, false, "a background read must not resurrect the session the user disconnected: " + JSON.stringify(after));
		assert.equal(ports.calls.connects.length, connectsBefore, "and it must not reconnect");
	});
});

test("an explicit connect after a user disconnect makes reads work again", async () => {
	// 反向约束：禁止静默重连不能变成「用户自己也回不来」。
	await withHarness({}, async ({ handlers, ports }) => {
		assert.equal((await read(handlers, PROJECT_A)).ok, true);
		assert.equal((await handlers.get("remote:disconnect")({}, HOST_A)).ok, true);
		assert.equal((await read(handlers, PROJECT_A)).ok, false, "reads stay refused until the user re-asserts the host");

		const reconnected = await handlers.get("remote:connect")({}, HOST_A);
		assert.equal(reconnected.ok, true, "an explicit connect must succeed: " + JSON.stringify(reconnected));

		const after = await read(handlers, PROJECT_A);
		assert.equal(after.ok, true, "after the user reconnects, the same project must be readable again: " + JSON.stringify(after));
		assert.ok(decode(after).equals(expected(FILL_A)));
		assert.ok(ports.calls.connects.length >= 2);
	});
});

test("two hosts read in parallel must not block each other", async () => {
	await withHarness({}, async ({ handlers, remote }) => {
		const gate = remote.gateRead(ROOT_A, "data.txt", 0);
		const pendingA = read(handlers, PROJECT_A);
		await gate.entered;

		const resultOther = await read(handlers, OTHER_HOST_PROJECT);
		assert.equal(resultOther.ok, true, "another host must not wait for a gated read on this host: " + JSON.stringify(resultOther));
		assert.ok(decode(resultOther).equals(expected(FILL_OTHER)), "the other host must read its own bytes");

		gate.release();
		const resultA = await pendingA;
		assert.equal(resultA.ok, true);
		assert.ok(decode(resultA).equals(expected(FILL_A)));
	});
});

test("consecutive reads of one project do not rebuild the session", async () => {
	await withHarness({}, async ({ handlers, ports }) => {
		assert.equal((await read(handlers, PROJECT_A)).ok, true);
		assert.equal((await list(handlers, PROJECT_A)).ok, true);
		assert.equal((await read(handlers, PROJECT_A)).ok, true);
		assert.equal(ports.calls.createManager.length, 1, "the same project must not rebuild its helper session");
		assert.equal(ports.calls.bootstrap.length, 1);
	});
});

test("a bounded directory read must use the root it was resolved for, even if another project switches before it starts", async () => {
	// 目录读取也必须绑定「这个项目自己的 root」。在 withProjectSession 取锁之前留窗口，
	// 让 B 的切根先真实落地，再放行 A 的操作；A 必须重新对齐到 A 的 root，而不是接着用 B 的会话。
	let enteredOperation;
	const operationEntered = new Promise((resolve) => {
		enteredOperation = resolve;
	});
	let releaseOperation;
	const operationGate = new Promise((resolve) => {
		releaseOperation = resolve;
	});
	let held = false;
	const beforeProjectOperation = async () => {
		if (held) return;
		held = true;
		enteredOperation();
		await operationGate;
	};
	await withHarness({ beforeProjectOperation }, async ({ handlers }) => {
		const pendingList = list(handlers, PROJECT_A);
		await operationEntered;

		const resultB = await read(handlers, PROJECT_B);
		assert.equal(resultB.ok, true, "project B must complete while A's operation has not started yet: " + JSON.stringify(resultB));
		assert.ok(decode(resultB).equals(expected(FILL_B)));

		releaseOperation();
		const listed = await pendingList;
		assert.equal(listed.ok, true, "project A's listing must succeed: " + JSON.stringify(listed));
		const names = plain(listed.value?.entries ?? []).map((entry) => entry.name);
		assert.ok(names.includes("only-a.txt"), "project A's listing must come from project A's root; got " + JSON.stringify(names));
		assert.ok(!names.includes("only-b.txt"), "project A's listing must never come from project B's root; got " + JSON.stringify(names));
	});
});

test("an in-flight multi-chunk read of project A is not disturbed by a same-project read", async () => {
	await withHarness({}, async ({ handlers, remote, ports }) => {
		const gate = remote.gateRead(ROOT_A, "data.txt", 0);
		const pendingFirst = read(handlers, PROJECT_A);
		await gate.entered;

		const pendingSecond = read(handlers, PROJECT_A);
		const secondTracker = settleTracker(pendingSecond);
		await sleep(150);
		assert.equal(secondTracker.settled, false, "a same-host read must queue behind the one holding the host's operation boundary");

		gate.release();
		const [first, second] = await Promise.all([pendingFirst, pendingSecond]);
		assert.equal(second.ok, true, "a same-root read must not tear down the session in use: " + JSON.stringify(second));
		assert.ok(decode(second).equals(expected(FILL_A)));
		assert.equal(first.ok, true);
		assert.ok(decode(first).equals(expected(FILL_A)), "the gated read must still return project A's bytes");
		assert.equal(ports.calls.createManager.length, 1, "no extra session may be built for a same-root read");
	});
});
