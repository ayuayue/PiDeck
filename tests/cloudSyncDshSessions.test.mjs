import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { CloudSyncScanner } from "../src/main/cloudSync/CloudSyncScanner.ts";
import { createDefaultExternalEditorSettings } from "../src/shared/types/project.ts";

const PASSWORD = "correct horse battery staple";

/** DSH 会话 JSONL：header（可带 cwd）+ 可选 session/title 事件 + 一条真人提示。 */
function sessionText(sessionId, { cwd, title } = {}) {
	const header = { type: "session", id: sessionId, createdAt: 1 };
	if (cwd) header.cwd = cwd;
	const lines = [JSON.stringify(header)];
	if (title) lines.push(JSON.stringify({ type: "session/title", data: { title } }));
	lines.push('{"type":"user/message","data":{"content":[{"type":"text","text":"hello world"}],"source":{"kind":"user"}}}');
	return lines.join("\n") + "\n";
}

function minimalSettings() {
	return {
		theme: "dark",
		accent: "green",
		favoriteModels: [],
		externalEditors: createDefaultExternalEditorSettings(),
	};
}

const DEFAULT_PREFERENCES = {
	selectedSessionIds: [],
	selectedResourceIds: [],
	content: {
		desktopSettings: true,
		piModels: true,
		piCredentials: true,
		dshSettings: true,
		dshCredentials: true,
		projects: true,
		catalog: true,
		prompts: true,
		skills: true,
		extensions: true,
		security: true,
		imageGen: true,
	},
};

function makeProject(id, name, path) {
	return { id, name, path, lastOpenedAt: 1, environment: "windows" };
}

/** DSH 会话的 catalog 记录（侧栏归属/标题来源）。 */
function makeDshRecord(id, projectId, title, dshSessionId) {
	return {
		id,
		projectId,
		title,
		dshSessionId,
		backend: "dsh",
		source: "pi",
		environment: "native",
		preview: "",
		messageCount: 1,
		status: "active",
		createdAt: 1,
		updatedAt: 1,
	};
}

async function withTemp(run) {
	const base = await mkdtemp(join(tmpdir(), "pideck-dsh-"));
	try {
		return await run(base);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

/** 在 dshHome 下构造一个 .zstd 会话。 */
async function makeZstdSession(dshHome, workspaceDir, sessionId, text) {
	const dir = join(dshHome, "sessions", workspaceDir, sessionId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(text, "utf8")));
}

/** 在 dshHome 下构造一个未压缩 .jsonl 会话。 */
async function makePlainSession(dshHome, workspaceDir, sessionId, text) {
	const dir = join(dshHome, "sessions", workspaceDir, sessionId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "session.jsonl"), text, "utf8");
}

/** 写 DSH 官方投影缓存（标题权威来源之一）。 */
async function makeProjectionCache(dshHome, titlesBySessionId) {
	const dir = join(dshHome, "storages");
	await mkdir(dir, { recursive: true });
	const sessions = {};
	for (const [sessionId, title] of Object.entries(titlesBySessionId)) {
		sessions[sessionId] = { rows: { title: { val: title } } };
	}
	await writeFile(join(dir, "session_projcache.json"), JSON.stringify({ tables: { sessions } }), "utf8");
}

/** 内存对象存储（模拟 S3 条件写语义）。 */
function createMemoryStorage() {
	const storage = {
		objects: new Map(),
		async connect() { return { account: { id: "mem", name: "memory" } }; },
		async disconnect() {},
		async getAccount() { return { id: "mem", name: "memory" }; },
		async getCapabilities() { return { revisions: true, conditionalWrites: true, atomicReplacement: true }; },
		async readObject(key) {
			const entry = this.objects.get(key);
			if (!entry) return { found: false, key, bytes: null };
			return { found: true, key, bytes: entry.bytes, revision: entry.revision };
		},
		async writeObject(key, bytes, options) {
			const existing = this.objects.get(key);
			if (options?.expectedRevision === null && existing) {
				const err = new Error("conditional"); err.code = "conditional_write_conflict"; throw err;
			}
			const revision = `rev-${this.objects.size + 1}`;
			this.objects.set(key, { bytes, revision });
			return { created: !existing, revision };
		},
		async deleteObject(key) { return { deleted: this.objects.delete(key) }; },
	};
	return storage;
}

function makeManager({ userDataDir, homeDir, dshHomeDir, storage, listProjects = () => [], listSessionRecords = () => [] }) {
	return new CloudSyncManager({
		userDataDir,
		homeDir,
		...(dshHomeDir ? { dshHomeDir } : {}),
		deviceName: "test",
		appVersion: "0.0.0-test",
		listProjects,
		listSessionRecords,
		getDesktopSettings: minimalSettings,
		updateDesktopSettings: async () => undefined,
		createAdapter: () => storage,
	});
}

// ── Scanner：按项目归组 + 真实会话名 ──────────────────────────────────────────

test("scanner groups DSH sessions into projects by cwd with real titles; no __dsh__ node", async () => {
	await withTemp(async (base) => {
		const dshHome = join(base, "dshHome");
		const projectPath = join(base, "work", "alpha");
		// cwd 命中已注册项目 → 归入该项目节点；标题来自日志 session/title 事件。
		await makeZstdSession(dshHome, "ws-proj", "sid-mapped", sessionText("sid-mapped", { cwd: projectPath, title: "修复登录页 Bug" }));
		// cwd 未匹配任何项目 → 工作区合成节点；标题来自日志。
		await makePlainSession(dshHome, "ws-other", "sid-other", sessionText("sid-other", { cwd: join(base, "elsewhere"), title: "调研方案" }));
		// 无标题事件：日志折叠回退到首条真人提示。
		await makePlainSession(dshHome, "ws-other", "sid-no-title", '{"type":"session","id":"sid-no-title"}\n{"type":"user/message","data":{"content":[{"type":"text","text":"把这段代码重构一下谢谢"}],"source":{"kind":"user"}}}\n');
		// 无日志文件的目录应被忽略
		await mkdir(join(dshHome, "sessions", "ws-b", "empty"), { recursive: true });

		const scanner = new CloudSyncScanner({
			homeDir: join(base, "home"),
			dshHomeDir: dshHome,
			listProjects: () => [makeProject("p1", "alpha", projectPath)],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES);

		// 不再有独立的「DSH 会话」标签节点
		assert.equal(snapshot.tree.projects.some((node) => node.projectId === "__dsh__"), false);

		// cwd 匹配的会话归入项目节点
		const projectNode = snapshot.tree.projects.find((node) => node.projectId === "p1");
		assert.ok(projectNode, "DSH session with matching cwd should live under the project node");
		const mapped = projectNode.sessions.find((session) => session.sessionId === "sid-mapped");
		assert.ok(mapped);
		assert.equal(mapped.scope, "dsh");
		assert.equal(mapped.title, "修复登录页 Bug");
		assert.equal(mapped.relativePath, "ws-proj/sid-mapped/session.jsonl.zstd");

		// cwd 未匹配 → 工作区合成节点（节点名取 cwd 末段）
		const workspaceNode = snapshot.tree.projects.find((node) => node.projectId.startsWith("dsh-ws-"));
		assert.ok(workspaceNode, "unmatched DSH sessions should live under a workspace node");
		assert.equal(workspaceNode.name, "elsewhere");
		const other = workspaceNode.sessions.find((session) => session.sessionId === "sid-other");
		assert.equal(other.title, "调研方案");
		const noTitle = workspaceNode.sessions.find((session) => session.sessionId === "sid-no-title");
		assert.equal(noTitle.title, "把这段代码重构一下谢谢");

		assert.ok(snapshot.tree.roots.some((root) => root.kind === "dsh-sessions" && root.ok));
	});
});

test("scanner prefers projection cache / catalog record for DSH project and title", async () => {
	await withTemp(async (base) => {
		const dshHome = join(base, "dshHome");
		// 无 cwd、无标题事件：归组与标题都依赖 catalog 记录。
		await makePlainSession(dshHome, "ws-x", "sid-cat", '{"type":"session","id":"sid-cat"}\n');
		// 投影缓存标题优先于日志标题。
		await makePlainSession(dshHome, "ws-x", "sid-proj", sessionText("sid-proj", { title: "日志标题旧" }));
		await makeProjectionCache(dshHome, { "sid-proj": "投影缓存标题新" });

		const scanner = new CloudSyncScanner({
			homeDir: join(base, "home"),
			dshHomeDir: dshHome,
			listProjects: () => [makeProject("p2", "beta", join(base, "beta"))],
			listSessionRecords: () => [
				makeDshRecord("rec-cat", "p2", "侧栏真实标题", "sid-cat"),
			],
		});
		const snapshot = await scanner.scan(DEFAULT_PREFERENCES);
		const projectNode = snapshot.tree.projects.find((node) => node.projectId === "p2");
		assert.ok(projectNode, "catalog-attached DSH session should group under its record project");
		const cat = projectNode.sessions.find((session) => session.sessionId === "sid-cat");
		assert.ok(cat);
		assert.equal(cat.title, "侧栏真实标题");
		// 无 cwd、无记录归属的会话 → 工作区合成节点；标题取投影缓存（优先于日志标题）。
		const workspaceNode = snapshot.tree.projects.find((node) => node.projectId.startsWith("dsh-ws-"));
		assert.ok(workspaceNode);
		const proj = workspaceNode.sessions.find((session) => session.sessionId === "sid-proj");
		assert.ok(proj);
		assert.equal(proj.title, "投影缓存标题新");
	});
});

// ── Cloud sync round trip ─────────────────────────────────────────────────

test("DSH sessions sync end to end: zstd decompressed on upload, recompressed on restore", async () => {
	await withTemp(async (base) => {
		const storage = createMemoryStorage();

		// Machine A：$DSH_HOME 下有 .zstd 会话（cwd 未匹配项目 → 工作区合成节点）。
		const userDataA = join(base, "userDataA");
		const homeA = join(base, "homeA");
		const dshHomeA = join(base, "dshHomeA");
		await makeZstdSession(dshHomeA, "ws-a", "sid-zstd", sessionText("sid-zstd"));
		const managerA = makeManager({ userDataDir: userDataA, homeDir: homeA, dshHomeDir: dshHomeA, storage });
		await managerA.initialize();
		await managerA.setupMasterKey(PASSWORD);
		await managerA.configureProvider({ provider: "s3", config: { endpoint: "https://example.invalid", region: "us-east-1", bucket: "pideck-bucket", accessKeyId: "a", secretAccessKey: "s" } });
		await managerA.connectProvider("s3");

		const tree = await managerA.scanSelection();
		const dshSessions = tree.projects.flatMap((node) => node.sessions).filter((session) => session.scope === "dsh");
		assert.equal(dshSessions.length, 1);
		assert.ok(!tree.projects.some((node) => node.projectId === "__dsh__"), "no __dsh__ node in the tree");
		const selectionId = dshSessions[0].selectionId;
		await managerA.updateSelection({ selectedSessionIds: [selectionId], selectedResourceIds: [] });

		const pushed = await managerA.syncNow();
		assert.equal(pushed.pushed, true);
		// 对象按解压文本加密存储（key 为 dsh 专用前缀）。
		const objectKey = "pideck-dsh-sessions/sid-zstd.jsonl.enc";
		assert.ok(storage.objects.has(objectKey), "should upload a dsh session object");
		const rawObject = Buffer.from(storage.objects.get(objectKey).bytes).toString("utf8");
		assert.ok(!rawObject.includes('"role":"user"')); // 密文

		// Machine B：空 $DSH_HOME，拉取恢复。
		const userDataB = join(base, "userDataB");
		const homeB = join(base, "homeB");
		const dshHomeB = join(base, "dshHomeB");
		await mkdir(dshHomeB, { recursive: true });
		const managerB = makeManager({ userDataDir: userDataB, homeDir: homeB, dshHomeDir: dshHomeB, storage });
		await managerB.initialize();
		assert.equal(managerB.securityState(), "NO_KEY");
		await managerB.setupMasterKey(PASSWORD);
		await managerB.configureProvider({ provider: "s3", config: { endpoint: "https://example.invalid", region: "us-east-1", bucket: "pideck-bucket", accessKeyId: "a", secretAccessKey: "s" } });
		await managerB.connectProvider("s3");

		const pulled = await managerB.syncNow();
		assert.equal(pulled.pulled, true);

		const restoredPath = join(dshHomeB, "sessions", "ws-a", "sid-zstd", "session.jsonl.zstd");
		const restoredBytes = await readFile(restoredPath);
		assert.equal(zstdDecompressSync(restoredBytes).toString("utf8"), sessionText("sid-zstd"));

		// 幂等：再同步不重复写入。
		await managerB.syncNow();
		const restoredBytes2 = await readFile(restoredPath);
		assert.deepEqual(restoredBytes2, restoredBytes);

		await managerA.dispose();
		await managerB.dispose();
	});
});

test("DSH session matched to a registered project syncs under that project node", async () => {
	await withTemp(async (base) => {
		const storage = createMemoryStorage();
		const projectPath = join(base, "repo", "alpha");
		const userData = join(base, "userData");
		const home = join(base, "home");
		const dshHome = join(base, "dshHome");
		await makePlainSession(dshHome, "ws-alpha", "sid-proj", sessionText("sid-proj", { cwd: projectPath, title: "给项目加上云同步" }));

		const manager = makeManager({
			userDataDir: userData,
			homeDir: home,
			dshHomeDir: dshHome,
			storage,
			listProjects: () => [makeProject("p1", "alpha", projectPath)],
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);
		const tree = await manager.scanSelection();
		const projectNode = tree.projects.find((node) => node.projectId === "p1");
		assert.ok(projectNode, "DSH session should be grouped under the matched project node");
		assert.equal(projectNode.sessions.length, 1);
		assert.equal(projectNode.sessions[0].title, "给项目加上云同步");
		await manager.dispose();
	});
});

// ── Export / import round trip ─────────────────────────────────────────────

test("DSH sessions export into a backup and restore on a fresh machine", async () => {
	await withTemp(async (base) => {
		// Machine A：导出含 DSH 会话的备份。
		const userDataA = join(base, "userDataA");
		const homeA = join(base, "homeA");
		const dshHomeA = join(base, "dshHomeA");
		await makePlainSession(dshHomeA, "ws-a", "sid-plain", sessionText("sid-plain"));
		const managerA = makeManager({ userDataDir: userDataA, homeDir: homeA, dshHomeDir: dshHomeA, storage: createMemoryStorage() });
		await managerA.initialize();
		await managerA.setupMasterKey(PASSWORD);
		const tree = await managerA.scanSelection();
		const dshSessions = tree.projects.flatMap((node) => node.sessions).filter((session) => session.scope === "dsh");
		assert.equal(dshSessions.length, 1);
		await managerA.updateSelection({ selectedSessionIds: [dshSessions[0].selectionId], selectedResourceIds: [] });
		const backupPath = join(base, "backup.pideckbackup");
		const exported = await managerA.exportBackup({ outputPath: backupPath });
		assert.equal(exported.sessionCount, 1);
		await managerA.dispose();

		// Machine B：导入恢复 DSH 会话。
		const userDataB = join(base, "userDataB");
		const homeB = join(base, "homeB");
		const dshHomeB = join(base, "dshHomeB");
		await mkdir(dshHomeB, { recursive: true });
		const managerB = makeManager({ userDataDir: userDataB, homeDir: homeB, dshHomeDir: dshHomeB, storage: createMemoryStorage() });
		await managerB.initialize();
		const imported = await managerB.importBackup({ filePath: backupPath, password: PASSWORD, mode: "merge" });
		assert.equal(imported.sessionsRestored, 1);

		const restoredPath = join(dshHomeB, "sessions", "ws-a", "sid-plain", "session.jsonl");
		assert.equal(await readFile(restoredPath, "utf8"), sessionText("sid-plain"));

		await managerB.dispose();
	});
});
