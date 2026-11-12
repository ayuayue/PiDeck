import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * 远端会话发现的产品口径（本次改动：项目级作用域 + 项目级 sessionDir）。
 *
 * 这组用例锁四件事，都是现场问题换来的：
 *
 * 1. **同一主机上的两个项目不共享列表**：侧栏区块挂在项目下，主机级扫描会把 B 的会话挂到 A 名下；
 * 2. **项目级 `.pi/settings.json` 的 `sessionDir` 生效**：pi 的 settings 是 user + project 合并的，
 *    项目级写相对路径（`.pi/sessions`）时 pi 就写在那里，只扫默认根永远发现不了（也是现场报告的空列表）；
 * 3. **身份唯一且与运行时登记同源**：项目级根用 `project:<encoded-cwd>/` 命名空间，默认根保持旧 id
 *    （既存记录不迁移），同一文件的两种推导必须一致；
 * 4. **fail-closed**：没归属/没 catalog/非法项目配置都以稳定码拒绝，不猜、不静默退回默认根。
 */

const scannerModule = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { createRemoteSessionScanner, REMOTE_SESSION_CODES, REMOTE_SESSION_PROJECT_ID_PREFIX } = scannerModule;
const { encodePiSessionDirectory } = loadTsCommonJs("src/main/remote/remoteSessionProjectMatch.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const HOME = "/home/dev";
const AGENT_DIR = HOME + "/.pi/agent";
const DEFAULT_ROOT = AGENT_DIR + "/sessions";
const PROJECT_A = { id: "project-a", remotePath: "/srv/app-a" };
const PROJECT_B = { id: "project-b", remotePath: "/srv/app-b" };

const plain = (value) => JSON.parse(JSON.stringify(value));

const BASE = mkdtempSync(join(tmpdir(), "pideck-remote-project-scope-"));
after(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/**
 * 远端替身：以**绝对路径**建模文件系统（目录表 + 文件内容）。`withProjectSession` 的 root 被记下来，
 * 相对路径按当前 root 解析——「扫描到底用了哪个根」因此是被观测的事实，而不是从结果推断。
 */
function fakeRemote(options = {}) {
	const home = options.home ?? HOME;
	const dirs = options.dirs ?? {};
	const files = options.files ?? {};
	const roots = [];
	const frames = [];
	let currentRoot = null;
	const absOf = (relative) => (relative === "." ? currentRoot : currentRoot + "/" + relative);
	const describe = (relative) => {
		const absolute = absOf(relative);
		const content = files[absolute];
		if (content !== undefined) return { path: relative, kind: "file", bytes: content.length, mtimeMs: 7 };
		if (dirs[absolute] !== undefined) return { path: relative, kind: "directory", bytes: 0, mtimeMs: 1 };
		return { path: relative, kind: "missing", bytes: 0, mtimeMs: 0 };
	};
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			if (method === "fs.list") {
				const absolute = absOf(params.path);
				const entries = dirs[absolute];
				if (entries === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				// helper 契约：文件项必须带 bytes（目录项不得带）。替身按文件表补齐，fixture 才能只写名字。
				return { entries: entries.map((entry) => (entry.kind === "file" ? { name: entry.name, kind: "file", bytes: (files[absolute + "/" + entry.name] ?? Buffer.alloc(0)).length } : entry)) };
			}
			if (method === "fs.statMany") return { entries: params.paths.map(describe) };
			if (method === "fs.stat") {
				// helper 契约：单条 stat **不带** path（那是 statMany 的字段）。
				const { kind, bytes, mtimeMs } = describe(params.path);
				return { kind, bytes, mtimeMs };
			}
			if (method === "fs.read") {
				const content = files[absOf(params.path)];
				if (content === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				const slice = content.subarray(params.offset, params.offset + params.bytes);
				return { chunk: Buffer.from(slice).toString("base64"), bytes: slice.length, eof: params.offset + slice.length >= content.length };
			}
			throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: "METHOD_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async () => home,
		async withProjectSession(_hostId, root, task) {
			roots.push(root);
			if (dirs[root] === undefined) return { ok: false, code: "PATH_NOT_FOUND" };
			currentRoot = root;
			return { ok: true, value: await task(session) };
		},
	};
	return { port, roots, frames };
}

/** 远端目录/文件的一条便捷构造：`dir(path, names)` + `file(path, text)`。 */
function tree() {
	const dirs = {};
	const files = {};
	const api = {
		dir(path, entries = []) {
			dirs[path] = entries.map((entry) => (typeof entry === "string" ? { name: entry, kind: "file" } : entry));
			return api;
		},
		file(path, text) {
			const content = Buffer.from(text, "utf8");
			files[path] = content;
			return api;
		},
		settings(dirPath, value) {
			// 项目根与 `.pi` 目录都要存在：读项目 settings 时 withRoot 的 root 就是项目根。
			const parent = dirPath.slice(0, dirPath.lastIndexOf("/"));
			if (parent.length > 0 && dirs[parent] === undefined) api.dir(parent);
			const text = JSON.stringify(value);
			api.dir(dirPath);
			return api.file(dirPath + "/settings.json", text);
		},
		build() {
			return { dirs, files };
		},
	};
	return api;
}

function scannerFor(remote, extra = {}) {
	return createRemoteSessionScanner({ port: remote.port, projectCandidates: () => [PROJECT_A, PROJECT_B], ...extra });
}

test("同一主机两个项目：各自只列出自己的会话（encoded-cwd 目录作用域）", async () => {
	const t = tree()
		.dir(AGENT_DIR)
		.dir(DEFAULT_ROOT, [
			{ name: encodePiSessionDirectory(PROJECT_A.remotePath), kind: "directory" },
			{ name: encodePiSessionDirectory(PROJECT_B.remotePath), kind: "directory" },
		])
		.dir(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_A.remotePath), ["a.jsonl"])
		.dir(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_B.remotePath), ["b.jsonl"])
		.file(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_A.remotePath) + "/a.jsonl", "{}")
		.file(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_B.remotePath) + "/b.jsonl", "{}");
	const fixture = t.build();
	const remote = fakeRemote(fixture);

	const a = await scannerFor(remote).scan(HOST, PROJECT_A.id);
	assert.equal(a.ok, true, JSON.stringify(a));
	assert.deepEqual(plain(a.entries.map((entry) => entry.remoteSessionId)), [encodePiSessionDirectory(PROJECT_A.remotePath) + "/a.jsonl"], "项目 A 只能看到自己的会话");

	const b = await scannerFor(remote).scan(HOST, PROJECT_B.id);
	assert.equal(b.ok, true, JSON.stringify(b));
	assert.deepEqual(plain(b.entries.map((entry) => entry.remoteSessionId)), [encodePiSessionDirectory(PROJECT_B.remotePath) + "/b.jsonl"], "项目 B 只能看到自己的会话");
});

test("项目级 .pi/settings.json 的 sessionDir（相对路径）生效：扫该目录，id 走 project: 命名空间", async () => {
	const projectSessions = PROJECT_A.remotePath + "/.pi/sessions";
	const t = tree()
		.dir(AGENT_DIR)
		.dir(DEFAULT_ROOT, [{ name: encodePiSessionDirectory(PROJECT_A.remotePath), kind: "directory" }])
		.dir(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_A.remotePath), ["legacy.jsonl"])
		.file(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_A.remotePath) + "/legacy.jsonl", "{}")
		.settings(PROJECT_A.remotePath + "/.pi", { sessionDir: ".pi/sessions" })
		.dir(projectSessions, ["project.jsonl"])
		.file(projectSessions + "/project.jsonl", "{}");
	const remote = fakeRemote(t.build());

	const result = await scannerFor(remote).scan(HOST, PROJECT_A.id);
	assert.equal(result.ok, true, JSON.stringify(result));
	const ids = plain(result.entries.map((entry) => entry.remoteSessionId)).sort();
	assert.deepEqual(ids, [
		// 默认根里的旧会话仍在（id 规则不变）。
		encodePiSessionDirectory(PROJECT_A.remotePath) + "/legacy.jsonl",
		// 项目级根本次新增，带命名空间；两份布局同时可见。
		REMOTE_SESSION_PROJECT_ID_PREFIX + encodePiSessionDirectory(PROJECT_A.remotePath) + "/project.jsonl",
	]);
});

test("项目还没有任何会话：encoded 目录不存在是空列表，不是失败", async () => {
	const t = tree().dir(AGENT_DIR).dir(DEFAULT_ROOT);
	const remote = fakeRemote(t.build());
	const result = await scannerFor(remote).scan(HOST, PROJECT_A.id);
	assert.deepEqual(plain(result), { ok: true, entries: [] });
});

test("项目级 sessionDir 是绝对路径（项目外）也支持；非法值对该项目 fail-closed", async () => {
	const shared = "/srv/shared-sessions";
	const absoluteFixture = tree()
		.dir(AGENT_DIR)
		.dir(DEFAULT_ROOT)
		.settings(PROJECT_A.remotePath + "/.pi", { sessionDir: shared })
		.dir(shared, ["x.jsonl"])
		.file(shared + "/x.jsonl", "{}")
		.build();
	const absolute = await scannerFor(fakeRemote(absoluteFixture)).scan(HOST, PROJECT_A.id);
	assert.equal(absolute.ok, true, JSON.stringify(absolute));
	assert.deepEqual(plain(absolute.entries.map((entry) => entry.remoteSessionId)), [REMOTE_SESSION_PROJECT_ID_PREFIX + encodePiSessionDirectory(PROJECT_A.remotePath) + "/x.jsonl"]);

	// 相对值逃出根 / 非字符串 / 控制字节：拒绝而不是静默退回默认根（会给出看起来正常但错的列表）。
	// （`../../outside` 从 `/srv/app-a` 解析出来是 `/outside`——仍在根上，pi 也是这么解析的，所以它合法。）
	for (const bad of ["../../../outside", 42, "a\u0000b"]) {
		const fixture = tree()
			.dir(AGENT_DIR)
			.dir(DEFAULT_ROOT)
			.settings(PROJECT_A.remotePath + "/.pi", { sessionDir: bad })
			.build();
		const result = await scannerFor(fakeRemote(fixture)).scan(HOST, PROJECT_A.id);
		assert.deepEqual(plain(result), { ok: false, code: REMOTE_SESSION_CODES.sessionDirInvalid }, JSON.stringify(bad) + " answered " + JSON.stringify(result));
	}
});

test("identityForPath：默认根保持旧 id，项目级根走命名空间，根外拒绝", async () => {
	const projectSessions = PROJECT_A.remotePath + "/.pi/sessions";
	const fixture = tree()
		.dir(AGENT_DIR)
		.dir(DEFAULT_ROOT)
		.settings(PROJECT_A.remotePath + "/.pi", { sessionDir: ".pi/sessions" })
		.dir(projectSessions, ["project.jsonl"])
		.file(projectSessions + "/project.jsonl", "{}")
		.build();
	const scanner = scannerFor(fakeRemote(fixture));
	const encoded = encodePiSessionDirectory(PROJECT_A.remotePath);

	const fromDefault = await scanner.identityForPath({ hostId: HOST, projectId: PROJECT_A.id, projectRemotePath: PROJECT_A.remotePath, remotePath: DEFAULT_ROOT + "/" + encoded + "/legacy.jsonl" });
	assert.deepEqual(plain(fromDefault), { ok: true, remoteSessionId: encoded + "/legacy.jsonl" }, "默认根的 id 规则不变（既存记录不迁移）");

	const fromProject = await scanner.identityForPath({ hostId: HOST, projectId: PROJECT_A.id, projectRemotePath: PROJECT_A.remotePath, remotePath: projectSessions + "/project.jsonl" });
	assert.deepEqual(plain(fromProject), { ok: true, remoteSessionId: REMOTE_SESSION_PROJECT_ID_PREFIX + encoded + "/project.jsonl" });

	// 两个推导必须与扫描给的 id 一致：同一文件在侧栏只能有一条记录。
	const scanned = await scanner.scan(HOST, PROJECT_A.id);
	assert.equal(scanned.ok, true);
	assert.deepEqual(plain(scanned.entries.map((entry) => entry.remoteSessionId)), [REMOTE_SESSION_PROJECT_ID_PREFIX + encoded + "/project.jsonl"]);

	const outside = await scanner.identityForPath({ hostId: HOST, projectId: PROJECT_A.id, projectRemotePath: PROJECT_A.remotePath, remotePath: "/etc/passwd" });
	assert.deepEqual(plain(outside), { ok: false, code: REMOTE_SESSION_CODES.locatorUnresolved });
});

test("登记项目级会话：文件在项目根内被确认，catalog 写绝对 remotePath 与命名空间 id", async () => {
	const projectSessions = PROJECT_A.remotePath + "/.pi/sessions";
	const fixture = tree()
		.dir(AGENT_DIR)
		.dir(DEFAULT_ROOT)
		.settings(PROJECT_A.remotePath + "/.pi", { sessionDir: ".pi/sessions" })
		.dir(projectSessions, ["project.jsonl"])
		.file(projectSessions + "/project.jsonl", '{"type":"session_info","name":"Named"}')
		.build();
	const ensured = [];
	const catalog = {
		async ensureRemoteSession(input) {
			ensured.push(plain(input));
			return { record: { id: "stable-1" }, created: true };
		},
	};
	const scanner = scannerFor(fakeRemote(fixture), { catalog, projectIdForHost: () => "wrong-project" });
	const id = REMOTE_SESSION_PROJECT_ID_PREFIX + encodePiSessionDirectory(PROJECT_A.remotePath) + "/project.jsonl";

	const registered = await scanner.register({ hostId: HOST, remoteSessionId: id });
	assert.equal(registered.ok, true, JSON.stringify(registered));
	// 归属来自命名空间本身（不再依赖 host 级 matchRemoteSessionProject 的猜测）。
	assert.equal(ensured[0].projectId, PROJECT_A.id);
	assert.equal(ensured[0].remoteSessionId, id);
	assert.equal(ensured[0].remotePath, projectSessions + "/project.jsonl", "catalog 存绝对路径：读/写/归档不再依赖会话根");
	assert.equal(ensured[0].updatedAt, 7);
	assert.equal(ensured[0].title, "project");

	// 标题走同一个根推导：读到的必须是项目级目录里的那个文件。
	const title = await scanner.title({ hostId: HOST, remoteSessionId: id });
	assert.equal(title.ok, true, JSON.stringify(title));
	assert.equal(title.title, "Named");
});

test("登记 fail-closed：未知项目命名空间零远端请求；没有 catalog 不建立会话", async () => {
	const empty = fakeRemote(tree().dir(AGENT_DIR).dir(DEFAULT_ROOT).build());
	const scanner = scannerFor(empty, { catalog: { ensureRemoteSession: async () => ({ record: { id: "s" }, created: true }) } });
	const unknown = await scanner.register({ hostId: HOST, remoteSessionId: REMOTE_SESSION_PROJECT_ID_PREFIX + "--srv-unknown--/x.jsonl" });
	assert.deepEqual(plain(unknown), { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved });
	assert.equal(empty.roots.length, 0, "归属不明时一个远端帧都不该发");

	const noCatalog = scannerFor(fakeRemote(tree().dir(AGENT_DIR).dir(DEFAULT_ROOT).build()));
	const encoded = encodePiSessionDirectory(PROJECT_A.remotePath);
	const refused = await noCatalog.register({ hostId: HOST, remoteSessionId: encoded + "/x.jsonl" });
	assert.deepEqual(plain(refused), { ok: false, code: REMOTE_SESSION_CODES.catalogUnavailable });
});

test("host-wide 旧扫描（不带 projectId）保持旧行为：默认根整表 + 旧 id", async () => {
	const t = tree()
		.dir(AGENT_DIR)
		.dir(DEFAULT_ROOT, [{ name: encodePiSessionDirectory(PROJECT_A.remotePath), kind: "directory" }])
		.dir(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_A.remotePath), ["a.jsonl"])
		.file(DEFAULT_ROOT + "/" + encodePiSessionDirectory(PROJECT_A.remotePath) + "/a.jsonl", "{}");
	const result = await scannerFor(fakeRemote(t.build())).scan(HOST);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(plain(result.entries.map((entry) => entry.remoteSessionId)), [encodePiSessionDirectory(PROJECT_A.remotePath) + "/a.jsonl"]);
});

test("真 catalog：同一项目级会话登记两次只有一条记录，绝对 remotePath 落盘", async () => {
	const projectSessions = PROJECT_A.remotePath + "/.pi/sessions";
	const fixture = tree()
		.dir(AGENT_DIR)
		.dir(DEFAULT_ROOT)
		.settings(PROJECT_A.remotePath + "/.pi", { sessionDir: ".pi/sessions" })
		.dir(projectSessions, ["project.jsonl"])
		.file(projectSessions + "/project.jsonl", "{}")
		.build();
	const catalog = new SessionCatalog(join(BASE, "catalog-" + Math.random().toString(36).slice(2) + ".json"));
	await catalog.load();
	const scanner = scannerFor(fakeRemote(fixture), { catalog });
	const id = REMOTE_SESSION_PROJECT_ID_PREFIX + encodePiSessionDirectory(PROJECT_A.remotePath) + "/project.jsonl";

	const first = await scanner.register({ hostId: HOST, remoteSessionId: id });
	const second = await scanner.register({ hostId: HOST, remoteSessionId: id });
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.equal(second.ok, true, JSON.stringify(second));
	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal(first.sessionId, second.sessionId);
	assert.equal(catalog.listEntries().length, 1);
	assert.deepEqual(plain(catalog.getLocator(first.sessionId)), { kind: "ssh", hostId: HOST, remoteSessionId: id, remotePath: projectSessions + "/project.jsonl" });
});
