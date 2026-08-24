import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { createDefaultExternalEditorSettings } from "../src/shared/types/project.ts";

const PASSWORD = "correct horse battery staple";

function minimalSettings() {
	return {
		theme: "dark",
		accent: "green",
		favoriteModels: [],
		externalEditors: createDefaultExternalEditorSettings(),
	};
}

/** 内存对象存储：模拟 S3 的条件写入语义。 */
class InMemoryStorage {
	objects = new Map();
	connectCalls = 0;

	async connect() {
		this.connectCalls += 1;
		return { account: { id: "mem", name: "memory" } };
	}
	async disconnect() {}
	async getAccount() {
		return { id: "mem", name: "memory" };
	}
	async getCapabilities() {
		return { revisions: true, conditionalWrites: true, atomicReplacement: true };
	}
	async readObject(key) {
		const entry = this.objects.get(key);
		if (!entry) return { found: false, key, bytes: null };
		return { found: true, key, bytes: entry.bytes, revision: entry.revision };
	}
	async writeObject(key, bytes, options) {
		const existing = this.objects.get(key);
		if (options?.expectedRevision === null && existing) {
			const err = new Error("conditional");
			err.code = "conditional_write_conflict";
			throw err;
		}
		if (typeof options?.expectedRevision === "string" && (!existing || existing.revision !== options.expectedRevision)) {
			const err = new Error("conditional");
			err.code = "conditional_write_conflict";
			throw err;
		}
		const revision = `rev-${this.objects.size + 1}`;
		this.objects.set(key, { bytes, revision });
		return { created: !existing, revision };
	}
	async deleteObject(key) {
		return { deleted: this.objects.delete(key) };
	}
}

test("manager setup/unlock/lock lifecycle keeps the password out of the state file", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-mgr-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(userDataDir, { recursive: true });

		const manager = new CloudSyncManager({
			userDataDir,
			homeDir,
			deviceName: "test",
			appVersion: "0.0.0-test",
			listProjects: () => [],
			listSessionRecords: () => [],
			getDesktopSettings: minimalSettings,
			updateDesktopSettings: async () => undefined,
		});
		await manager.initialize();
		assert.equal(manager.securityState(), "NO_KEY");

		await manager.setupMasterKey(PASSWORD);
		assert.equal(manager.securityState(), "UNLOCKED");

		await manager.lock();
		assert.equal(manager.securityState(), "LOCKED");
		// 错误密码解锁失败
		assert.equal(await manager.unlock("wrong password!!"), false);
		assert.equal(await manager.unlock(PASSWORD), true);
		assert.equal(manager.securityState(), "UNLOCKED");

		// 状态文件里不能出现明文密码或派生 key
		const raw = await readFile(join(userDataDir, "cloud-sync-state.json"), "utf8");
		assert.ok(!raw.includes(PASSWORD));
		assert.ok(!raw.includes("correct"));
		const parsed = JSON.parse(raw);
		assert.ok(parsed.masterKeyConfig.salt);
		assert.ok(!parsed.providers || Object.keys(parsed.providers).length === 0);
		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("manager seals provider credentials and syncs a selected session end to end", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-mgr-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		const sessionsDir = join(homeDir, ".pi", "agent", "sessions", "2026");
		await mkdir(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "session-a.jsonl");
		await writeFile(sessionFile, '{"type":"session_info","name":"A"}\n{"role":"user","content":"hi"}\n', "utf8");

		const storage = new InMemoryStorage();
		let records = [{
			id: "session-a",
			projectId: "__global__",
			title: "Session A",
			source: "pi",
			environment: "native",
			filePath: sessionFile,
			preview: "hi",
			messageCount: 1,
			status: "active",
			createdAt: 1,
			updatedAt: 1,
		}];

		const manager = new CloudSyncManager({
			userDataDir,
			homeDir,
			deviceName: "test",
			appVersion: "0.0.0-test",
			listProjects: () => [],
			listSessionRecords: () => records,
			getDesktopSettings: minimalSettings,
			updateDesktopSettings: async () => undefined,
			// 注入内存存储替代真实 S3 适配器
			createAdapter: () => storage,
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);
		await manager.configureProvider({
			provider: "s3",
			config: {
				endpoint: "https://example.invalid",
				region: "us-east-1",
				bucket: "bucket",
				accessKeyId: "ak",
				secretAccessKey: "sk",
			},
		});
		const snapshot = manager.getStateSnapshot();
		assert.equal(snapshot.providers.s3.configured, true);
		// 凭据不进 renderer 快照
		assert.ok(!JSON.stringify(snapshot).includes("secretAccessKey"));
		assert.ok(!JSON.stringify(snapshot).includes("sk"));

		// 连接 Provider（真实流程由设置页发起；测试注入内存存储）
		await manager.connectProvider("s3");

		// 扫描并选中会话
		const tree = await manager.scanSelection();
		const globalNode = tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(globalNode);
		assert.equal(globalNode.sessions.length, 1);
		const selectionId = globalNode.sessions[0].selectionId;
		await manager.updateSelection({ selectedSessionIds: [selectionId], selectedResourceIds: [] });

		// 同步：上传会话对象 + 索引
		const result = await manager.syncNow();
		assert.equal(result.pushed, true);
		assert.ok(storage.objects.has("pideck-index.json"));
		assert.ok(storage.objects.has("pideck-sessions/session-a.jsonl.enc"));
		assert.equal(manager.getStateSnapshot().localVersion, 1);

		// 明文未出现在存储对象中（会话正文已加密）
		const sessionObject = storage.objects.get("pideck-sessions/session-a.jsonl.enc");
		const sessionRaw = Buffer.from(sessionObject.bytes).toString("utf8");
		assert.ok(!sessionRaw.includes('"role":"user"'));

		// 重启（新实例同目录）→ 锁定；解锁后重复同步不重复上传
		const manager2 = new CloudSyncManager({
			userDataDir,
			homeDir,
			deviceName: "test",
			appVersion: "0.0.0-test",
			listProjects: () => [],
			listSessionRecords: () => records,
			getDesktopSettings: minimalSettings,
			updateDesktopSettings: async () => undefined,
			createAdapter: () => storage,
		});
		await manager2.initialize();
		assert.equal(manager2.securityState(), "LOCKED");
		assert.equal(await manager2.unlock(PASSWORD), true);
		await manager2.connectProvider("s3");
		const storageSizeBefore = storage.objects.size;
		const idle = await manager2.syncNow();
		assert.equal(idle.pushed, false);
		assert.equal(storage.objects.size, storageSizeBefore);
		await manager.dispose();
		await manager2.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("manager shrink guard blocks pushing an emptied selection", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-cloud-mgr-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		const sessionsDir = join(homeDir, ".pi", "agent", "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "session-a.jsonl");
		await writeFile(sessionFile, '{"role":"user","content":"hi"}\n', "utf8");

		const storage = new InMemoryStorage();
		const manager = new CloudSyncManager({
			userDataDir,
			homeDir,
			deviceName: "test",
			appVersion: "0.0.0-test",
			listProjects: () => [],
			listSessionRecords: () => [],
			getDesktopSettings: minimalSettings,
			updateDesktopSettings: async () => undefined,
			createAdapter: () => storage,
		});
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);
		await manager.configureProvider({
			provider: "s3",
			config: {
				endpoint: "https://example.invalid",
				region: "us-east-1",
				bucket: "bucket",
				accessKeyId: "ak",
				secretAccessKey: "sk",
			},
		});
		await manager.connectProvider("s3");
		const tree = await manager.scanSelection();
		const selectionId = tree.projects[0].sessions[0].selectionId;
		await manager.updateSelection({ selectedSessionIds: [selectionId], selectedResourceIds: [] });
		const pushed = await manager.syncNow();
		assert.equal(pushed.pushed, true);

		// 清空选择但未显式确认 → 缩水保护阻止上传
		await manager.updateSelection({ selectedSessionIds: [], selectedResourceIds: [] });
		const blocked = await manager.syncNow();
		assert.equal(blocked.pushed, false);
		assert.equal(manager.getStateSnapshot().syncState, "BLOCKED");

		// 显式确认后才允许清空
		const confirmed = await manager.syncNow({ allowShrink: true });
		assert.equal(confirmed.pushed, true);
		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
