import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端项目只读操作链（可自动化部分）。
 *
 * 覆盖：登记（enroll offer → approve，写**真实 ProjectStore**）→ 立即打开 → 两项目交替读取
 * （含多分块中途切根）→ 断线恢复 → 重启找回项目并继续读取。
 *
 * 明确未覆盖（需要真实 SSH 主机或 Electron UI，不得用桩结果冒充）：
 * - “添加主机”整条链路（指纹独立核验、pin、真实 bootstrap/helper 上传）；
 * - 登记前对远端目录做 canonical 解析（resolveRemoteBrowseRoot）的真实 SSH 探测；
 * - 渲染层侧栏“+”交互、确认弹框、真实窗口会话。
 * 本文件把 resolveRemoteBrowseRoot 换成一个返回固定 canonical 值的替身，因此它验证的是
 * “canonical 值由 main 持有 → 确认 → 落库 → 按 projectId 读取”的这一段，而不是探测本身。
 *
 * 假末端与 tests/remoteProjectReadIsolation.test.mjs 同构：真实 RemoteWorkspaceReader +
 * 真实 registerRemoteHostIpc + 真实 createRemoteHostConnectionService，只替换 SSH 传输层。
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
const ROOT_A = "/srv/app-a";
const ROOT_B = "/srv/app-b";
const CHUNK = 1024 * 1024;
const FILE_SIZE = CHUNK + 16;
const MTIME = 1_700_000_000_000;
const FILL_A = 0x41;
const FILL_B = 0x42;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (value) => JSON.parse(JSON.stringify(value));
const decode = (result) => Buffer.from(result.value.contentBase64, "base64");
const expected = (fill) => Buffer.alloc(FILE_SIZE, fill);

/** 可控假远端：per-root 内容不同，尺寸与 mtime 相同（串根不会被收尾 stat 拦下）。 */
function fakeRemote() {
	const roots = new Map();
	const readGates = [];
	const put = (root, path, fill) => {
		const files = roots.get(root) ?? new Map();
		files.set(path, { content: Buffer.alloc(FILE_SIZE, fill), mtimeMs: MTIME });
		roots.set(root, files);
	};
	put(ROOT_A, "data.txt", FILL_A);
	put(ROOT_B, "data.txt", FILL_B);
	const fileFor = (root, path) => {
		const file = roots.get(root)?.get(path);
		if (file === undefined) {
			const error = new Error("PATH_NOT_FOUND");
			error.code = "PATH_NOT_FOUND";
			throw error;
		}
		return file;
	};
	const gateRead = (root, path, offset) => {
		let notifyEntered;
		const entered = new Promise((resolve) => {
			notifyEntered = resolve;
		});
		let release;
		const wait = new Promise((resolve) => {
			release = resolve;
		});
		const gate = { root, path, offset, entered, wait, release, notifyEntered, engaged: false };
		readGates.push(gate);
		return gate;
	};
	return {
		gateRead,
		gateFor: (root, path, offset) => readGates.find((gate) => !gate.engaged && gate.root === root && gate.path === path && gate.offset === offset),
		stat(root, path) {
			const file = fileFor(root, path);
			return { kind: "file", bytes: file.content.length, mtimeMs: file.mtimeMs };
		},
		list(root, path) {
			return [...(roots.get(root) ?? new Map()).entries()].map(([name, file]) => ({ name, kind: "file", bytes: file.content.length }));
		},
		read(root, path, offset, wanted) {
			const file = fileFor(root, path);
			const end = Math.min(file.content.length, offset + wanted);
			const slice = file.content.subarray(offset, end);
			return { chunk: Buffer.from(slice).toString("base64"), bytes: slice.length, eof: offset + slice.length >= file.content.length };
		},
	};
}

/** 假 SSH manager：每个 manager 固定绑一个 root，另有 drop() 模拟传输掉线。 */
function fakeManagerPorts(remote) {
	const calls = { bootstrap: 0, connects: [], managers: [] };
	const ports = {
		calls,
		bootstrap: async () => ({ bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host", active: "/home/remote/.pideck/remote-host/bundles/" + "a".repeat(64) }),
		resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v24.11.0", probed: 1 }),
		createSentinel: () => "sentinel-00000000",
		createNonce: () => "nonce-000000000001",
		// 会话建立时的边界复核（lead F3）：默认回显请求路径，避免替身去打真实 SSH。
		verifyRoot: async ({ userPath }) => ({ canonicalPath: userPath }),
		createManager: (input) => {
			const root = input.helperSession.root;
			const manager = {
				root,
				state: "disconnected",
				/** withProjectSession 用状态决定「复用 / 复活 / 重建」，所以假 manager 也要能回答它。 */
				getState(hostId) {
					return { hostId, generation: 1, state: manager.state, attempts: 0, latched: false, lastCode: "SSH_HOST_NOT_READY" };
				},
				async connect(hostId) {
					manager.state = "ready";
					calls.connects.push({ hostId, root });
					return { hostId, generation: 1, state: "ready", attempts: 0, latched: false };
				},
				async disconnect() {
					manager.state = "disconnected";
				},
				listDiagnostics: () => [],
				async dispose() {},
				async cancel() {
					return { cancelled: false, reason: "already-settled" };
				},
				/** 模拟传输掉线：会话不再 ready，但没有经过 remote:disconnect（用户显式断开）。 */
				drop() {
					manager.state = "disconnected";
				},
				async request(hostId, method, params, options) {
					if (manager.state !== "ready") throw new Error("SSH_HOST_NOT_READY");
					options?.onRequestId?.("req-" + method);
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
			calls.managers.push(manager);
			return manager;
		},
	};
	return ports;
}

async function writeHostStore(userDataDir) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision: 7, profiles: [], retiredHostIds: [] }));
}

function loadProjectStore(userDataDir) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: { electron: { app: { getPath: () => userDataDir }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } } },
	});
}

/**
 * 一段“主进程生命周期”：真实 ProjectStore（真实 projects.json）+ 真实 service + 真实 IPC 注册。
 * 用同一个 userDataDir 建第二个实例即模拟重启。
 */
async function createLifecycle(userDataDir, remote, ports, browseRoot = async ({ userPath }) => ({ canonicalPath: userPath })) {
	const { ProjectStore } = loadProjectStore(userDataDir);
	const projectStore = new ProjectStore();
	await projectStore.load();

	const handlers = new Map();
	const stubs = {
		electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
		// 真实探测需要 SSH 主机；这里用可配置替身（见文件头“未覆盖”）。默认把用户输入当 canonical。
		"../remote/RemoteBrowseRoot": { resolveRemoteBrowseRoot: browseRoot },
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
	const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
	registerRemoteHostIpc({
		enabled: true,
		userDataDir,
		list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }),
		service: () => service,
	});
	registerRemoteProjectIpc({
		enabled: true,
		userDataDir,
		service: () => service,
		directoryReader: {
			async read({ canonicalRoot }) {
				const entries = remote.list(canonicalRoot, ".");
				return { ok: true, value: { entries, scanned: entries.length, truncated: false } };
			},
		},
		projects: {
			enroll: async ({ hostId, canonicalRemotePath }) => ({ projectId: (await projectStore.addRemote({ hostId, canonicalRemotePath })).id }),
			locator: (projectId) => {
				const project = projectStore.get(projectId);
				return project !== undefined && project.locator?.kind === "ssh" ? project.locator : undefined;
			},
		},
	});
	const sender = { id: 42, isDestroyed: () => false, send: () => undefined };
	return { handlers, service, projectStore, sender };
}

async function withChain(run, options = {}) {
	const userDataDir = await mkdtemp(join(tmpdir(), "pideck-remote-chain-"));
	try {
		await writeHostStore(userDataDir);
		const remote = fakeRemote();
		const ports = fakeManagerPorts(remote);
		const browseRoot = options.browseRoot;
		const first = await createLifecycle(userDataDir, remote, ports, browseRoot);
		await run({ first, remote, ports, userDataDir, createLifecycle: () => createLifecycle(userDataDir, remote, ports, browseRoot) });
		await first.service.dispose();
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

const readProject = (lifecycle, projectId, path = "data.txt") => lifecycle.handlers.get("remote:project-read")({}, projectId, path);
const listProject = (lifecycle, projectId, path = "") => lifecycle.handlers.get("remote:project-list")({}, projectId, path);

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

/** 只做登记 offer（approve 由用例自己驱动），返回 main 推送的 requestId。 */
async function offerEnroll(lifecycle, candidatePath) {
	const sent = [];
	lifecycle.sender.send = (channel, payload) => sent.push({ channel, payload });
	const offered = await lifecycle.handlers.get("remote:project-enroll")({ sender: lifecycle.sender }, HOST_ID, candidatePath);
	return { offered, requestId: sent.at(-1)?.payload?.requestId };
}

const answerEnroll = (lifecycle, requestId, choice) => lifecycle.handlers.get("remote:project-answer")({ sender: lifecycle.sender }, requestId, choice);

test("enrolling a project persists a real ssh record and the project is readable immediately", async () => {
	await withChain(async ({ first }) => {
		const projectId = await enrollWithPush(first, ROOT_A);
		const stored = first.projectStore.get(projectId);
		assert.deepEqual(plain(stored.locator), { kind: "ssh", hostId: HOST_ID, remotePath: ROOT_A }, "the durable record must hold the main-held canonical locator");
		const listed = await listProject(first, projectId);
		assert.equal(listed.ok, true, "the fresh project must be listable right away: " + JSON.stringify(listed));
		assert.ok(plain(listed.value.entries).some((entry) => entry.name === "data.txt"));
		const opened = await readProject(first, projectId);
		assert.equal(opened.ok, true, "and immediately readable: " + JSON.stringify(opened));
		assert.ok(decode(opened).equals(expected(FILL_A)));
	});
});

test("a directory that moved during the confirmation window is refused instead of enrolled", async () => {
	// 确认窗口是真实时间：目录被删/软链改指后，写进用户被展示的那个值就等于确认了一个已不存在的边界。
	// 复核必须发生在写库之前，且拒绝时 store 里不能留下任何 ssh 记录。
	let probes = 0;
	const browseRoot = async ({ userPath }) => {
		probes += 1;
		return { canonicalPath: probes === 1 ? userPath : "/srv/moved-elsewhere" };
	};
	await withChain(
		async ({ first }) => {
			const { offered, requestId } = await offerEnroll(first, ROOT_A);
			assert.equal(offered.ok, true, "the offer itself must succeed: " + JSON.stringify(offered));
			assert.equal(offered.value.canonicalPath, ROOT_A);

			const approved = await answerEnroll(first, requestId, "approve");
			assert.equal(approved.ok, false, "a root that no longer resolves to itself must not be enrolled: " + JSON.stringify(approved));
			assert.equal(approved.code, "REMOTE_PROJECT_ROOT_CHANGED");
			assert.equal(first.projectStore.list().filter((project) => project.locator?.kind === "ssh").length, 0, "nothing may be persisted when the recheck fails");
		},
		{ browseRoot },
	);
});

test("a host that fails re-verification during the confirmation window is refused instead of enrolled", async () => {
	let probes = 0;
	const browseRoot = async ({ userPath }) => {
		probes += 1;
		// 复审失败且没有稳定码：必须落到本层自己的 REMOTE_PROJECT_ROOT_UNRESOLVED，不能放行写库。
		if (probes > 1) throw new Error("probe failed: host disabled");
		return { canonicalPath: userPath };
	};
	await withChain(
		async ({ first }) => {
			const { offered, requestId } = await offerEnroll(first, ROOT_A);
			assert.equal(offered.ok, true);

			const approved = await answerEnroll(first, requestId, "approve");
			assert.equal(approved.ok, false, "a host that can no longer be verified must not be enrolled: " + JSON.stringify(approved));
			assert.equal(approved.code, "REMOTE_PROJECT_ROOT_UNRESOLVED");
			assert.equal(first.projectStore.list().filter((project) => project.locator?.kind === "ssh").length, 0);
		},
		{ browseRoot },
	);
});

test("two projects alternate reads across multiple chunks without mixing roots", async () => {
	await withChain(async ({ first, remote }) => {
		const projectA = await enrollWithPush(first, ROOT_A);
		const projectB = await enrollWithPush(first, ROOT_B);
		assert.notEqual(projectA, projectB, "the two roots must be two distinct projects");

		const gate = remote.gateRead(ROOT_A, "data.txt", 0);
		const pendingA = readProject(first, projectA);
		await gate.entered;
		// A 的多分块读进行中：B 的整次读必须排队，等 A 的锁释放后才开始。
		const pendingB = readProject(first, projectB);
		const bTracker = settleTracker(pendingB);
		await sleep(150);
		assert.equal(bTracker.settled, false, "project B must queue behind project A's whole read");
		gate.release();

		const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
		assert.equal(resultB.ok, true, "project B must be readable: " + JSON.stringify(resultB));
		assert.ok(decode(resultB).equals(expected(FILL_B)), "project B must read its own bytes");
		assert.equal(resultA.ok, true, "project A must settle ok: " + JSON.stringify(resultA));
		const bytesA = decode(resultA);
		const mixedAt = bytesA.findIndex((value) => value !== FILL_A);
		assert.equal(mixedAt, -1, "project A must return only project A's bytes; first foreign byte at " + mixedAt);

		// A/B/A：再切回 A，仍然只读到 A。
		const again = await readProject(first, projectA);
		assert.equal(again.ok, true);
		assert.equal(
			decode(again).findIndex((value) => value !== FILL_A),
			-1,
			"switching back to A must read A again",
		);
	});
});

test("a dropped connection recovers on the next read of the same project", async () => {
	await withChain(async ({ first, ports }) => {
		const projectA = await enrollWithPush(first, ROOT_A);
		assert.equal((await readProject(first, projectA)).ok, true);

		const manager = ports.calls.managers.at(-1);
		manager.drop(); // 传输掉线，不是用户显式断开

		const recovered = await readProject(first, projectA);
		assert.equal(recovered.ok, true, "a dropped session must be re-established for the same root: " + JSON.stringify(recovered));
		assert.ok(decode(recovered).equals(expected(FILL_A)));
	});
});

test("after a restart the persisted project is found again and stays readable", async () => {
	await withChain(async ({ first, createLifecycle }) => {
		const projectA = await enrollWithPush(first, ROOT_A);
		assert.equal((await readProject(first, projectA)).ok, true);
		await first.service.dispose();

		const second = await createLifecycle();
		try {
			const listed = await listProject(second, projectA);
			assert.equal(listed.ok, true, "the persisted project must still resolve after a restart: " + JSON.stringify(listed));
			const again = await readProject(second, projectA);
			assert.equal(again.ok, true);
			assert.ok(decode(again).equals(expected(FILL_A)), "and read project A's bytes");
		} finally {
			await second.service.dispose();
		}
	});
});

/**
 * 登记并返回 projectId：sender.send 需要记录 main 发出的 requestId，所以每个 lifecycle 的
 * sender 都带一个 sent 数组。
 */
async function enrollWithPush(lifecycle, candidatePath) {
	const sent = [];
	lifecycle.sender.send = (channel, payload) => sent.push({ channel, payload });
	const offered = await lifecycle.handlers.get("remote:project-enroll")({ sender: lifecycle.sender }, HOST_ID, candidatePath);
	assert.equal(offered.ok, true, "enroll offer must be accepted: " + JSON.stringify(offered));
	const push = sent.at(-1);
	assert.equal(push.channel, "remote:project-enroll-confirm");
	assert.equal(push.payload.canonicalPath, candidatePath, "the main-held canonical path must be what the user confirms");
	const approved = await lifecycle.handlers.get("remote:project-answer")({ sender: lifecycle.sender }, push.payload.requestId, "approve");
	assert.equal(approved.ok, true, "enroll approve must succeed: " + JSON.stringify(approved));
	return approved.value.projectId;
}
