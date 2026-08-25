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
const SESSION_TEXT = '{"type":"session","id":"sid-1"}\n{"role":"user","content":"hi"}\n';

function minimalSettings() {
	return {
		theme: "dark",
		accent: "green",
		favoriteModels: [],
		externalEditors: createDefaultExternalEditorSettings(),
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

function makeManager({ userDataDir, homeDir, dshHomeDir, storage }) {
	return new CloudSyncManager({
		userDataDir,
		homeDir,
		...(dshHomeDir ? { dshHomeDir } : {}),
		deviceName: "test",
		appVersion: "0.0.0-test",
		listProjects: () => [],
		listSessionRecords: () => [],
		getDesktopSettings: minimalSettings,
		updateDesktopSettings: async () => undefined,
		createAdapter: () => storage,
	});
}

// ── Scanner ────────────────────────────────────────────────────────────────

test("scanner discovers DSH sessions (.zstd and .jsonl) under the __dsh__ node", async () => {
	await withTemp(async (base) => {
		const dshHome = join(base, "dshHome");
		await makeZstdSession(dshHome, "ws-a", "sid-zstd", SESSION_TEXT);
		await makePlainSession(dshHome, "ws-a", "sid-plain", SESSION_TEXT);
		// 无日志文件的目录应被忽略
		await mkdir(join(dshHome, "sessions", "ws-b", "empty"), { recursive: true });

		const scanner = new CloudSyncScanner({
			homeDir: join(base, "home"),
			dshHomeDir: dshHome,
			listProjects: () => [],
			listSessionRecords: () => [],
		});
		const snapshot = await scanner.scan({
			selectedSessionIds: [],
			selectedResourceIds: [],
			content: { desktopSettings: true, piModels: true, piCredentials: true, dshSettings: true, dshCredentials: true, projects: true, catalog: true, prompts: true, skills: true, extensions: true, security: true, imageGen: true },
		});
		const dshNode = snapshot.tree.projects.find((node) => node.projectId === "__dsh__");
		assert.ok(dshNode, "should have a __dsh__ node");
		assert.equal(dshNode.sessions.length, 2);
		const ids = dshNode.sessions.map((session) => session.sessionId).sort();
		assert.deepEqual(ids, ["sid-plain", "sid-zstd"]);
		const zstd = dshNode.sessions.find((session) => session.sessionId === "sid-zstd");
		assert.equal(zstd.scope, "dsh");
		assert.equal(zstd.relativePath, "ws-a/sid-zstd/session.jsonl.zstd");
		assert.ok(snapshot.tree.roots.some((root) => root.kind === "dsh-sessions" && root.ok));
	});
});

// ── Cloud sync round trip ─────────────────────────────────────────────────

test("DSH sessions sync end to end: zstd decompressed on upload, recompressed on restore", async () => {
	await withTemp(async (base) => {
		const storage = createMemoryStorage();

		// Machine A：$DSH_HOME 下有 .zstd 会话。
		const userDataA = join(base, "userDataA");
		const homeA = join(base, "homeA");
		const dshHomeA = join(base, "dshHomeA");
		await makeZstdSession(dshHomeA, "ws-a", "sid-zstd", SESSION_TEXT);
		const managerA = makeManager({ userDataDir: userDataA, homeDir: homeA, dshHomeDir: dshHomeA, storage });
		await managerA.initialize();
		await managerA.setupMasterKey(PASSWORD);
		await managerA.configureProvider({ provider: "s3", config: { endpoint: "https://example.invalid", region: "us-east-1", bucket: "pideck-bucket", accessKeyId: "a", secretAccessKey: "s" } });
		await managerA.connectProvider("s3");

		const tree = await managerA.scanSelection();
		const dshNode = tree.projects.find((node) => node.projectId === "__dsh__");
		assert.ok(dshNode && dshNode.sessions.length === 1);
		const selectionId = dshNode.sessions[0].selectionId;
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
		assert.equal(zstdDecompressSync(restoredBytes).toString("utf8"), SESSION_TEXT);

		// 幂等：再同步不重复写入。
		await managerB.syncNow();
		const restoredBytes2 = await readFile(restoredPath);
		assert.deepEqual(restoredBytes2, restoredBytes);

		await managerA.dispose();
		await managerB.dispose();
	});
});

// ── Export / import round trip ─────────────────────────────────────────────

test("DSH sessions export into a backup and restore on a fresh machine", async () => {
	await withTemp(async (base) => {
		// Machine A：导出含 DSH 会话的备份。
		const userDataA = join(base, "userDataA");
		const homeA = join(base, "homeA");
		const dshHomeA = join(base, "dshHomeA");
		await makePlainSession(dshHomeA, "ws-a", "sid-plain", SESSION_TEXT);
		const managerA = makeManager({ userDataDir: userDataA, homeDir: homeA, dshHomeDir: dshHomeA, storage: createMemoryStorage() });
		await managerA.initialize();
		await managerA.setupMasterKey(PASSWORD);
		const tree = await managerA.scanSelection();
		const dshNode = tree.projects.find((node) => node.projectId === "__dsh__");
		assert.ok(dshNode && dshNode.sessions.length === 1);
		await managerA.updateSelection({ selectedSessionIds: [dshNode.sessions[0].selectionId], selectedResourceIds: [] });
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
		assert.equal(await readFile(restoredPath, "utf8"), SESSION_TEXT);

		await managerB.dispose();
	});
});
