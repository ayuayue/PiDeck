import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const realFsPromises = nodeRequire("node:fs/promises");
const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const OTHER_HOST = "9c2f0f6a-7f2e-4a19-9d1b-0d5f9f2dd0aa";

const { createRemoteSessionScanner } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");

/** 跨 VM realm 的比较前先归一化（deepStrictEqual 会比较原型）。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 生产 SessionCatalog + 一个只用来数「写盘次数」的 open() 包装。 */
function loadCatalog() {
	const openCalls = [];
	const fsPromises = {
		...realFsPromises,
		open: async (...args) => {
			openCalls.push(args[0]);
			return realFsPromises.open(...args);
		},
	};
	const mod = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": fsPromises,
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
	return { mod, openCalls };
}

const catalogModule = loadCatalog().mod;
const { SessionCatalog, findRemoteSessionEntry, remoteSessionLocatorMatch } = catalogModule;

async function makeCatalog(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-session-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	const { mod, openCalls } = loadCatalog();
	const catalog = new mod.SessionCatalog(catalogPath);
	await catalog.load();
	return { catalog, catalogPath, openCalls };
}

function fixtureEntry(overrides) {
	return { id: "s-1", projectId: "p-1", title: "Entry", titleLocked: true, titleOrigin: "manual", source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1, ...overrides };
}

function sshLocator(overrides = {}) {
	return { kind: "ssh", hostId: HOST, remotePath: "ws/a.jsonl", ...overrides };
}

test("稳定 id 匹配顺序：先按 remoteSessionId 命中整表，再按 remotePath 命中整表", () => {
	const identity = { hostId: HOST, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl" };
	const pathOnly = { id: "path-only", locator: sshLocator() };
	const idMatch = { id: "id-match", locator: sshLocator({ remotePath: "legacy/absolute/a.jsonl", remoteSessionId: "ws/a.jsonl" }) };
	const otherHost = { id: "other-host", locator: sshLocator({ hostId: OTHER_HOST, remoteSessionId: "ws/a.jsonl" }) };
	assert.equal(remoteSessionLocatorMatch(idMatch.locator, identity), "remoteSessionId");
	assert.equal(remoteSessionLocatorMatch(pathOnly.locator, identity), "remotePath");
	assert.equal(remoteSessionLocatorMatch(otherHost.locator, identity), undefined);
	assert.equal(remoteSessionLocatorMatch({ kind: "local", environment: "native", filePath: "/local/a.jsonl" }, identity), undefined);
	assert.equal(remoteSessionLocatorMatch(undefined, identity), undefined);
	// 关键对抗点：表里先出现 path 命中、后面才有 id 命中时，必须选 id 命中的那条。
	assert.equal(findRemoteSessionEntry([pathOnly, idMatch], identity).id, "id-match");
	assert.equal(findRemoteSessionEntry([idMatch, pathOnly], identity).id, "id-match");
	assert.equal(findRemoteSessionEntry([pathOnly], identity).id, "path-only");
	assert.equal(findRemoteSessionEntry([otherHost], identity), undefined);
	assert.equal(findRemoteSessionEntry([], identity), undefined);
});

test("登记：重复登记命中同一条记录、同一个 stable id，且第二次不写盘", async (t) => {
	const { catalog, catalogPath, openCalls } = await makeCatalog(t);
	const input = { projectId: "p-1", hostId: HOST, remoteSessionId: "ws/2026-02-03T10-00-00_abc.jsonl", remotePath: "ws/2026-02-03T10-00-00_abc.jsonl", title: "2026-02-03T10-00-00_abc", updatedAt: 1000 };
	const first = await catalog.ensureRemoteSession(input);
	assert.equal(first.created, true);
	// 只数对 catalog 的**写**（临时文件 open）。写事务还会为跨进程锁 open 一次锁文件 —— 那不是写盘，
	// 而是 INV-5a 必需的互斥，所以按路径过滤而不是数所有 open。
	const catalogWrites = () => openCalls.filter((target) => String(target).startsWith(`${catalogPath}.`) && String(target).endsWith(".tmp")).length;
	const writesAfterFirst = catalogWrites();
	const second = await catalog.ensureRemoteSession(input);
	assert.equal(second.created, false);
	assert.equal(second.record.id, first.record.id);
	assert.equal(catalogWrites(), writesAfterFirst, "完全相同的重复登记不能再写一次 catalog");
	assert.equal(catalog.listEntries().length, 1);

	const entry = catalog.listEntries()[0];
	assert.deepEqual(plain(entry.locator), { kind: "ssh", hostId: HOST, remoteSessionId: input.remoteSessionId, remotePath: input.remotePath });
	// 远端路径绝不落到本地字段。
	assert.equal(entry.filePath, undefined);
	assert.equal(entry.originKey, undefined);
	assert.equal(entry.piSessionId, undefined);
	// 暂定标题如实标注：文件名 stem + titleOrigin=fallback（允许后续自动命名升级）。
	assert.equal(entry.title, "2026-02-03T10-00-00_abc");
	assert.equal(entry.titleOrigin, "fallback");
	assert.equal(entry.titleLocked, true);
	assert.equal(entry.status, "active");
	assert.equal(entry.updatedAt, 1000);
	// 展示层：非标准 stem 原样显示（它是暂定名，不是解析出来的会话名）；真正的 pi 时间戳 stem 显示 Untitled。
	assert.equal(first.record.title, "2026-02-03T10-00-00_abc");
	const piNamed = await catalog.ensureRemoteSession({ ...input, remoteSessionId: "ws/2026-02-03T10-00-00-000Z_abc.jsonl", remotePath: "ws/2026-02-03T10-00-00-000Z_abc.jsonl", title: "2026-02-03T10-00-00-000Z_abc", updatedAt: 1002 });
	assert.equal(piNamed.record.title, "Untitled");
	assert.equal(catalog.listEntries().find((entry) => entry.id === piNamed.record.id).titleOrigin, "fallback");
	const named = await catalog.ensureRemoteSession({ ...input, remoteSessionId: "ws/MySession.jsonl", remotePath: "ws/MySession.jsonl", title: "MySession", updatedAt: 1001 });
	assert.equal(named.record.title, "MySession");
	// 三个不同的远端文件 = 三条记录，一个都不能合并。
	assert.equal(catalog.listEntries().length, 3);

	// mtime 变化要落盘（最后活动时间/排序），并保持同一条记录。计数同样只看对 catalog 的写（锁文件 open 不算）。
	const writesBeforeTick = catalogWrites();
	const touched = await catalog.ensureRemoteSession({ ...input, updatedAt: 2000 });
	assert.equal(touched.record.id, first.record.id);
	assert.equal(touched.record.updatedAt, 2000);
	assert.equal(catalogWrites(), writesBeforeTick + 1);
});

test("登记：stable id 跨重启稳定（重新加载同一条目）", async (t) => {
	const { catalog, catalogPath } = await makeCatalog(t);
	const input = { projectId: "p-1", hostId: HOST, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", title: "a", updatedAt: 5 };
	const first = await catalog.ensureRemoteSession(input);
	const reloaded = new catalogModule.SessionCatalog(catalogPath);
	await reloaded.load();
	assert.equal(reloaded.getRecord(first.record.id).locator.remoteSessionId, "ws/a.jsonl");
	const again = await reloaded.ensureRemoteSession(input);
	assert.equal(again.created, false);
	assert.equal(again.record.id, first.record.id);
});

test("登记：命中已有记录时不改 projectId 与已确认标题，但会按冻结设计回填相对 remotePath", async (t) => {
	const { catalog, catalogPath } = await makeCatalog(t);
	await writeFile(
		catalogPath,
		JSON.stringify({
			version: 1,
			sessions: [
				fixtureEntry({ id: "path-only", locator: sshLocator() }),
				fixtureEntry({ id: "id-match", projectId: "p-old", title: "Real name", locator: sshLocator({ remotePath: "legacy/absolute/a.jsonl", remoteSessionId: "ws/a.jsonl" }) }),
				fixtureEntry({ id: "path-b", locator: sshLocator({ remotePath: "ws/b.jsonl" }) }),
			],
		}),
		"utf8",
	);
	const fresh = new catalogModule.SessionCatalog(catalogPath);
	await fresh.load();
	const matched = await fresh.ensureRemoteSession({ projectId: "p-new", hostId: HOST, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", title: "stem", updatedAt: 77 });
	// id 命中优先于 path 命中；归属与已确认标题是用户/项目侧的决定，登记不许覆盖。
	assert.equal(matched.record.id, "id-match");
	assert.equal(matched.created, false);
	assert.equal(matched.record.projectId, "p-old");
	assert.equal(matched.record.title, "Real name");
	assert.deepEqual(plain(matched.record.locator), { kind: "ssh", hostId: HOST, remotePath: "ws/a.jsonl", remoteSessionId: "ws/a.jsonl" });
	assert.equal(matched.record.updatedAt, 77);
	const byPath = await fresh.ensureRemoteSession({ projectId: "p-new", hostId: HOST, remoteSessionId: "ws/b.jsonl", remotePath: "ws/b.jsonl", title: "b", updatedAt: 78 });
	assert.equal(byPath.record.id, "path-b");
	assert.equal(byPath.created, false);
	// 旧记录只有 remotePath：命中后回填 remoteSessionId，仍是同一个 stable id。
	assert.equal(byPath.record.locator.remoteSessionId, "ws/b.jsonl");
	assert.equal(fresh.listEntries().length, 3);
});

test("登记：非法身份入参在 catalog 边界也被拒（防御直接调用）", async (t) => {
	const { catalog } = await makeCatalog(t);
	const base = { projectId: "p-1", hostId: HOST, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", title: "a", updatedAt: 1 };
	for (const patch of [{ projectId: "" }, { hostId: "h".repeat(257) }, { remoteSessionId: "x".repeat(257) }, { remotePath: "" }, { hostId: "a\u0000b" }, { title: 7 }]) {
		await assert.rejects(
			() => catalog.ensureRemoteSession({ ...base, ...patch }),
			(error) => error.message === "REMOTE_SESSION_IDENTITY_INVALID",
		);
	}
});

/** 远端替身：登记路径只需要 fs.stat（扫描覆盖在 remoteSessionScanner.test.mjs）。 */
function fakeRegisterPort(options = {}) {
	const calls = { stat: [], sessions: [], probe: [] };
	const port = {
		async remoteHome() {
			return Object.hasOwn(options, "home") ? options.home : "/home/dev";
		},
		async withProjectSession(hostId, root, task) {
			// J2：配置探测（root=<home>/.pi/agent）在这份替身里固定「读不到 settings.json」⇒ 退回默认根；
			// 探测帧与真正的登记帧分开记，避免污染 calls.sessions / calls.stat 的既有断言。
			const probing = root === "/home/dev/.pi/agent";
			(probing ? calls.probe : calls.sessions).push(probing ? root : { hostId, root });
			if (options.sessionFailure) return { ok: false, code: options.sessionFailure };
			const session = {
				async request(method, params) {
					if (probing) {
						calls.probe.push(method + ":" + params.path);
						throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
					}
					if (method !== "fs.stat" && method !== "fs.statMany") throw new Error("PROTOCOL_INVALID");
					const describe = (path) => {
						const file = (options.files ?? {})[path];
						if (file === undefined) throw new Error("PATH_NOT_FOUND");
						calls.stat.push(path);
						return { path, kind: file.kind ?? "file", bytes: file.bytes ?? 4, mtimeMs: file.mtimeMs ?? 3 };
					};
					if (method === "fs.statMany") return { entries: params.paths.map(describe) };
					const { kind, bytes, mtimeMs } = describe(params.path);
					return { kind, bytes, mtimeMs };
				},
				async cancel() {
					return { cancelled: false };
				},
			};
			return { ok: true, value: await task(session) };
		},
	};
	return { port, calls };
}

function fakeCatalog(options = {}) {
	const ensured = [];
	return {
		ensured,
		catalog: {
			async ensureRemoteSession(input) {
				ensured.push(input);
				if (options.throwCode) throw new Error(options.throwCode);
				return { record: { id: "stable-1" }, created: ensured.length === 1 };
			},
		},
	};
}

test("登记：先在远端确认文件存在，再写 catalog（标题是 stem、updatedAt 是 mtime）", async () => {
	const { port, calls } = fakeRegisterPort({ files: { "ws/a.jsonl": { bytes: 9, mtimeMs: 42 } } });
	const { catalog, ensured } = fakeCatalog();
	const scanner = createRemoteSessionScanner({ port, catalog, projectIdForHost: () => "p-1" });
	const result = await scanner.register({ hostId: HOST, remoteSessionId: "ws/a.jsonl" });
	assert.deepEqual(plain(result), { ok: true, sessionId: "stable-1", created: true, remoteSessionId: "ws/a.jsonl", remotePath: "/home/dev/.pi/agent/sessions/ws/a.jsonl" });
	assert.deepEqual(calls.sessions, [{ hostId: HOST, root: "/home/dev/.pi/agent/sessions" }]);
	assert.deepEqual(calls.stat, ["ws/a.jsonl"]);
	assert.deepEqual(plain(ensured), [{ projectId: "p-1", hostId: HOST, remoteSessionId: "ws/a.jsonl", remotePath: "/home/dev/.pi/agent/sessions/ws/a.jsonl", title: "a", updatedAt: 42 }]);
});

test("登记：远端不存在的 id 转述 PATH_NOT_FOUND，且不写 catalog", async () => {
	const { port } = fakeRegisterPort({ files: {} });
	const { catalog, ensured } = fakeCatalog();
	const result = await createRemoteSessionScanner({ port, catalog, projectIdForHost: () => "p-1" }).register({ hostId: HOST, remoteSessionId: "ws/missing.jsonl" });
	assert.deepEqual(plain(result), { ok: false, code: "PATH_NOT_FOUND" });
	assert.deepEqual(ensured, []);
});

test("登记：目标不是普通文件时拒绝", async () => {
	const { port } = fakeRegisterPort({ files: { "ws/dir.jsonl": { kind: "directory" } } });
	const { catalog, ensured } = fakeCatalog();
	const result = await createRemoteSessionScanner({ port, catalog, projectIdForHost: () => "p-1" }).register({ hostId: HOST, remoteSessionId: "ws/dir.jsonl" });
	assert.deepEqual(plain(result), { ok: false, code: "NOT_A_FILE" });
	assert.deepEqual(ensured, []);
});

test("登记：畸形 remoteSessionId 一个帧都不发", async () => {
	const invalid = ["", "/abs/a.jsonl", "../a.jsonl", "ws/../a.jsonl", "a\\b.jsonl", "noext.txt", "ws//a.jsonl", "ws/.jsonl", ".jsonl", "x".repeat(300) + ".jsonl", "."];
	for (const remoteSessionId of invalid) {
		const { port, calls } = fakeRegisterPort();
		const { catalog } = fakeCatalog();
		const result = await createRemoteSessionScanner({ port, catalog, projectIdForHost: () => "p-1" }).register({ hostId: HOST, remoteSessionId });
		assert.deepEqual(plain(result), { ok: false, code: "REMOTE_SESSION_ID_INVALID" }, remoteSessionId.slice(0, 20));
		assert.deepEqual(calls.sessions, []);
		assert.deepEqual(calls.stat, []);
	}
});

test("登记：项目归属解析不出、缺 catalog、home 不可用、会话建立失败各自的稳定码", async () => {
	const { port } = fakeRegisterPort({ files: { "ws/a.jsonl": {} } });
	const { catalog } = fakeCatalog();
	const input = { hostId: HOST, remoteSessionId: "ws/a.jsonl" };
	assert.deepEqual(plain(await createRemoteSessionScanner({ port, catalog }).register(input)), { ok: false, code: "REMOTE_SESSION_PROJECT_UNRESOLVED" });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port, projectIdForHost: () => "p-1" }).register(input)), { ok: false, code: "REMOTE_SESSION_CATALOG_UNAVAILABLE" });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: fakeRegisterPort({ home: undefined }).port, catalog, projectIdForHost: () => "p-1" }).register(input)), { ok: false, code: "REMOTE_SESSION_HOME_UNAVAILABLE" });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: fakeRegisterPort({ sessionFailure: "SSH_HOST_NOT_READY" }).port, catalog, projectIdForHost: () => "p-1" }).register(input)), { ok: false, code: "SSH_HOST_NOT_READY" });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port }).register({ hostId: "", remoteSessionId: "ws/a.jsonl" })), { ok: false, code: "REMOTE_SESSION_HOST_ID_INVALID" });
});

test("登记：catalog 的稳定码原样转述，自由文本折叠成 REGISTER_FAILED（不泄漏路径）", async () => {
	const input = { hostId: HOST, remoteSessionId: "ws/a.jsonl" };
	const { port } = fakeRegisterPort({ files: { "ws/a.jsonl": {} } });
	const coded = fakeCatalog({ throwCode: "REMOTE_SESSION_IDENTITY_INVALID" });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port, catalog: coded.catalog, projectIdForHost: () => "p-1" }).register(input)), { ok: false, code: "REMOTE_SESSION_IDENTITY_INVALID" });
	const leaky = fakeCatalog({ throwCode: "EACCES: /home/secret/session-catalog.json" });
	const failed = await createRemoteSessionScanner({ port, catalog: leaky.catalog, projectIdForHost: () => "p-1" }).register(input);
	assert.deepEqual(plain(failed), { ok: false, code: "REMOTE_SESSION_REGISTER_FAILED" });
	assert.equal(JSON.stringify(failed).includes("secret"), false);
});

/** readHead：一个只回答 fs.stat / fs.read 的精确协议替身。 */
const readerModule = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { createRemoteWorkspaceReader, REMOTE_WORKSPACE_MAX_HEAD_BYTES } = readerModule;

function fakeReaderPort(options = {}) {
	const calls = { stat: [], read: [] };
	const content = options.content ?? Buffer.alloc(options.stat?.bytes ?? 0, "x");
	const port = {
		// 这是 reader 的 port 形状（hostId 在第一位），不是已建立会话的 session 形状。
		async request(hostId, method, params) {
			void hostId;
			if (method === "fs.stat") {
				calls.stat.push(params.path);
				const stat = options.statOverrides?.shift() ?? options.stat;
				if (stat === undefined) throw new Error("PATH_NOT_FOUND");
				return { kind: stat.kind ?? "file", bytes: stat.bytes ?? 0, mtimeMs: stat.mtimeMs ?? 0 };
			}
			if (method === "fs.read") {
				calls.read.push({ path: params.path, offset: params.offset, bytes: params.bytes });
				if (options.readResult) return options.readResult(params);
				const slice = content.subarray(params.offset, params.offset + params.bytes);
				return { chunk: Buffer.from(slice).toString("base64"), bytes: slice.length, eof: params.offset + slice.length >= content.length };
			}
			throw new Error("PROTOCOL_INVALID");
		},
	};
	return { port, calls };
}

async function refusalCode(promise) {
	try {
		await promise;
	} catch (error) {
		return error.code ?? error.message;
	}
	assert.fail("expected a refusal");
}

test("readHead：上限是 64 KiB，只发一次有界 fs.read，永不整文件读", async () => {
	assert.equal(REMOTE_WORKSPACE_MAX_HEAD_BYTES, 64 * 1024);
	const small = fakeReaderPort({ stat: { bytes: 100, mtimeMs: 7 }, content: Buffer.alloc(100, "a") });
	const reader = createRemoteWorkspaceReader({ port: small.port });
	const head = await reader.readHead(HOST, "a.jsonl", REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head.bytes, 100);
	assert.equal(head.size, 100);
	assert.equal(head.truncated, false);
	assert.equal(head.mtimeMs, 7);
	assert.equal(head.content.length, 100);
	assert.deepEqual(small.calls.read, [{ path: "a.jsonl", offset: 0, bytes: 100 }]);

	// 200 KB 的文件只要 64 KiB：请求总量必须恰好等于上限（这就是「不整文件读」）。
	const big = fakeReaderPort({ stat: { bytes: 200000, mtimeMs: 8 }, content: Buffer.alloc(200000, "b") });
	const head2 = await createRemoteWorkspaceReader({ port: big.port }).readHead(HOST, "big.jsonl", REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head2.bytes, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head2.size, 200000);
	assert.equal(head2.truncated, true);
	assert.equal(big.calls.read.length, 1);
	assert.equal(
		big.calls.read.reduce((sum, call) => sum + call.bytes, 0),
		REMOTE_WORKSPACE_MAX_HEAD_BYTES,
	);
});

test("readHead：空文件不读、目录拒读、maxBytes 越界或非法都不发帧", async () => {
	const empty = fakeReaderPort({ stat: { bytes: 0, mtimeMs: 1 } });
	const head = await createRemoteWorkspaceReader({ port: empty.port }).readHead(HOST, "empty.jsonl", 1024);
	assert.deepEqual(plain({ bytes: head.bytes, size: head.size, truncated: head.truncated }), { bytes: 0, size: 0, truncated: false });
	assert.deepEqual(empty.calls.read, []);

	const directory = fakeReaderPort({ stat: { kind: "directory", bytes: 4096 } });
	assert.equal(await refusalCode(createRemoteWorkspaceReader({ port: directory.port }).readHead(HOST, "dir", 1024)), "NOT_A_FILE");
	assert.deepEqual(directory.calls.read, []);

	for (const maxBytes of [REMOTE_WORKSPACE_MAX_HEAD_BYTES + 1, 1024 * 1024]) {
		const over = fakeReaderPort({ stat: { bytes: 10 } });
		assert.equal(await refusalCode(createRemoteWorkspaceReader({ port: over.port }).readHead(HOST, "a.jsonl", maxBytes)), "RESULT_TOO_LARGE");
		assert.deepEqual(over.calls.stat, []);
		assert.deepEqual(over.calls.read, []);
	}
	for (const maxBytes of [0, -1, 1.5, Number.NaN, "1024", undefined]) {
		const invalid = fakeReaderPort({ stat: { bytes: 10 } });
		assert.equal(await refusalCode(createRemoteWorkspaceReader({ port: invalid.port }).readHead(HOST, "a.jsonl", maxBytes)), "PROTOCOL_INVALID", String(maxBytes));
		assert.deepEqual(invalid.calls.stat, []);
	}
});

test("readHead：尺寸自洽兜底——对端答非所问即 PROTOCOL_INVALID", async () => {
	// 文件缩小：stat 说 100，只读回 40 字节且自称到尾。
	const shrunk = fakeReaderPort({ stat: { bytes: 100, mtimeMs: 1 }, readResult: () => ({ chunk: Buffer.alloc(40, "c").toString("base64"), bytes: 40, eof: true }) });
	assert.equal(await refusalCode(createRemoteWorkspaceReader({ port: shrunk.port }).readHead(HOST, "a.jsonl", 1024)), "PROTOCOL_INVALID");
	// eof 说谎：拿到请求的全长却声称还有更多，而 stat 说这就是整个文件。
	const lying = fakeReaderPort({ stat: { bytes: 50, mtimeMs: 1 }, readResult: (params) => ({ chunk: Buffer.alloc(params.bytes, "d").toString("base64"), bytes: params.bytes, eof: false }) });
	assert.equal(await refusalCode(createRemoteWorkspaceReader({ port: lying.port }).readHead(HOST, "a.jsonl", 1024)), "PROTOCOL_INVALID");
	// 非法 hostId / 路径同样在发帧前拒绝。
	const untouched = fakeReaderPort({ stat: { bytes: 10 } });
	const reader = createRemoteWorkspaceReader({ port: untouched.port });
	assert.equal(await refusalCode(reader.readHead("", "a.jsonl", 16)), "PROTOCOL_INVALID");
	assert.equal(await refusalCode(reader.readHead(HOST, "", 16)), "PROTOCOL_INVALID");
	assert.deepEqual(untouched.calls.stat, []);
});
