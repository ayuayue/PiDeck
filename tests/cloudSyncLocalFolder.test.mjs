import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalFolderObjectStorage } from "../src/main/cloudSync/adapters/LocalFolderObjectStorage.ts";
import { createCloudSyncObjectStorage } from "../src/main/cloudSync/adapters/index.ts";
import { normalizeLocalFolderConfig } from "../src/main/cloudSync/providerConfig.ts";
import { parseProviderConfigInput } from "../src/main/cloudSync/parseProviderConfig.ts";
import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { isCloudSyncConditionalWriteError } from "../src/main/cloudSync/objectStorage.ts";
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

async function withTempFolder(run) {
	const base = await mkdtemp(join(tmpdir(), "pideck-local-sync-"));
	try {
		return await run(base);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

// ── Adapter unit tests ─────────────────────────────────────────────────────

test("local folder adapter connects (creates the folder) and returns account", async () => {
	await withTempFolder(async (base) => {
		const folder = join(base, "sync-dir"); // 尚不存在，连接时自动创建
		const storage = new LocalFolderObjectStorage({ folderPath: folder });
		const { account } = await storage.connect();
		assert.equal(account.id, "local");
		assert.equal(account.name, folder);
		assert.deepEqual(await storage.getAccount(), account);
		await storage.disconnect();
		assert.equal(await storage.getAccount(), null);
	});
});

test("local folder adapter writes, reads and deletes objects with revisions", async () => {
	await withTempFolder(async (base) => {
		const folder = join(base, "sync-dir");
		const storage = new LocalFolderObjectStorage({ folderPath: folder });
		await storage.connect();

		const key = "pideck-sessions/session-a.jsonl.enc";
		const bytes = Buffer.from([0, 1, 2, 255, 10]);
		const write = await storage.writeObject(key, bytes);
		assert.equal(write.created, true);
		assert.ok(typeof write.revision === "string" && write.revision.length > 0);

		const read = await storage.readObject(key);
		assert.equal(read.found, true);
		assert.deepEqual(Buffer.from(read.bytes), bytes);
		assert.equal(read.revision, write.revision);

		// 磁盘上真实落盘，且不留临时文件
		assert.deepEqual(Buffer.from(await readFile(join(folder, key))), bytes);
		const names = await readdir(folder, { recursive: true });
		assert.ok(!names.some((name) => String(name).includes(".tmp-")));

		// 覆盖写：created=false，内容更新
		const updated = Buffer.from("v2");
		const overwrite = await storage.writeObject(key, updated);
		assert.equal(overwrite.created, false);
		assert.deepEqual(Buffer.from((await storage.readObject(key)).bytes), updated);

		assert.deepEqual(await storage.deleteObject(key), { deleted: true });
		assert.deepEqual(await storage.deleteObject(key), { deleted: false });
		assert.deepEqual(await storage.readObject(key), { found: false, key, bytes: null });
	});
});

test("local folder adapter supports create-only and conditional writes", async () => {
	await withTempFolder(async (base) => {
		const storage = new LocalFolderObjectStorage({ folderPath: join(base, "sync-dir") });
		await storage.connect();
		const key = "pideck-index.json";

		// create-only：不存在时允许，存在时报冲突
		assert.equal((await storage.writeObject(key, Buffer.from("a"), { expectedRevision: null })).created, true);
		await assert.rejects(
			() => storage.writeObject(key, Buffer.from("b"), { expectedRevision: null }),
			(error) => isCloudSyncConditionalWriteError(error),
		);

		// 条件写：过期 revision 冲突，匹配 revision 成功
		const stale = await storage.readObject(key);
		await assert.rejects(
			() => storage.writeObject(key, Buffer.from("c"), { expectedRevision: "0" }),
			(error) => isCloudSyncConditionalWriteError(error),
		);
		assert.equal((await storage.writeObject(key, Buffer.from("c"), { expectedRevision: stale.revision })).created, false);

		// 条件删除：过期 revision 冲突
		const current = await storage.readObject(key);
		await assert.rejects(
			() => storage.deleteObject(key, { expectedRevision: "0" }),
			(error) => isCloudSyncConditionalWriteError(error),
		);
		assert.deepEqual(await storage.deleteObject(key, { expectedRevision: current.revision }), { deleted: true });
	});
});

test("local folder adapter rejects unsafe object keys and unconnected use", async () => {
	await withTempFolder(async (base) => {
		const storage = new LocalFolderObjectStorage({ folderPath: join(base, "sync-dir") });
		for (const key of ["../escape", "a/../../b", "a\\b", "/absolute", "pideck-index.json\0"]) {
			await assert.rejects(() => storage.readObject(key), TypeError);
			await assert.rejects(() => storage.writeObject(key, Buffer.from("x")), TypeError);
			await assert.rejects(() => storage.deleteObject(key), TypeError);
		}
		// 未连接时拒绝操作
		await assert.rejects(() => storage.readObject("pideck-index.json"), /not connected/);
	});
});

test("local folder adapter reports local-file capabilities", async () => {
	await withTempFolder(async (base) => {
		const storage = new LocalFolderObjectStorage({ folderPath: join(base, "sync-dir") });
		assert.deepEqual(await storage.getCapabilities(), {
			revisions: true,
			conditionalWrites: true,
			atomicReplacement: true,
		});
	});
});

// ── Config / boundary tests ────────────────────────────────────────────────

test("local folder config requires an absolute, control-free path", async () => {
	assert.equal(normalizeLocalFolderConfig({ folderPath: "C:\\Users\\you\\OneDrive\\PiDeck" }).folderPath, "C:\\Users\\you\\OneDrive\\PiDeck");
	assert.equal(normalizeLocalFolderConfig({ folderPath: "/home/you/sync" }).folderPath, "/home/you/sync");
	assert.throws(() => normalizeLocalFolderConfig({ folderPath: "relative/path" }), /absolute/);
	assert.throws(() => normalizeLocalFolderConfig({ folderPath: "" }), TypeError);
	assert.throws(() => normalizeLocalFolderConfig({ folderPath: "C:\\x\0y" }), /control/);
	assert.throws(() => normalizeLocalFolderConfig({}), TypeError);
	assert.throws(() => normalizeLocalFolderConfig(null), TypeError);
});

test("parseProviderConfigInput accepts local and rejects invalid shapes", () => {
	assert.deepEqual(parseProviderConfigInput({ provider: "local", config: { folderPath: "C:\\sync" } }), {
		provider: "local",
		config: { folderPath: "C:\\sync" },
	});
	assert.throws(() => parseProviderConfigInput({ provider: "local", config: { folderPath: "" } }), /Local folder config is invalid/);
	assert.throws(() => parseProviderConfigInput({ provider: "local", config: {} }), /Local folder config is invalid/);
	assert.throws(() => parseProviderConfigInput({ provider: "unknown", config: {} }), /Unknown cloud provider/);
});

test("factory creates the local folder adapter for provider local", async () => {
	const storage = createCloudSyncObjectStorage("local", { folderPath: "C:\\sync" });
	assert.ok(storage instanceof LocalFolderObjectStorage);
	assert.equal(storage.providerId, "local");
});

// ── Manager end-to-end with the real local adapter ─────────────────────────

test("manager syncs a selected session through the local sync folder end to end", async () => {
	await withTempFolder(async (base) => {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		const syncFolder = join(base, "sync-dir");
		const sessionsDir = join(homeDir, ".pi", "agent", "sessions", "2026");
		await mkdir(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "session-a.jsonl");
		await writeFile(sessionFile, '{"type":"session_info","name":"A"}\n{"role":"user","content":"hi"}\n', "utf8");

		const records = [{
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

		const createManager = () => new CloudSyncManager({
			userDataDir,
			homeDir,
			deviceName: "test",
			appVersion: "0.0.0-test",
			listProjects: () => [],
			listSessionRecords: () => records,
			getDesktopSettings: minimalSettings,
			updateDesktopSettings: async () => undefined,
			// 不注入 createAdapter：走真实工厂，local → LocalFolderObjectStorage
		});

		const manager = createManager();
		await manager.initialize();
		await manager.setupMasterKey(PASSWORD);
		await manager.configureProvider({ provider: "local", config: { folderPath: syncFolder } });
		assert.equal(manager.getStateSnapshot().providers.local.configured, true);
		await manager.connectProvider("local");

		const tree = await manager.scanSelection();
		const globalNode = tree.projects.find((node) => node.projectId === "__global__");
		assert.ok(globalNode);
		const selectionId = globalNode.sessions[0].selectionId;
		await manager.updateSelection({ selectedSessionIds: [selectionId], selectedResourceIds: [] });

		const pushed = await manager.syncNow();
		assert.equal(pushed.pushed, true);

		// 加密对象真实落盘到同步文件夹
		const indexBytes = await readFile(join(syncFolder, "pideck-index.json"));
		assert.ok(indexBytes.length > 0);
		const sessionRaw = await readFile(join(syncFolder, "pideck-sessions/session-a.jsonl.enc"), "utf8");
		assert.ok(!sessionRaw.includes('"role":"user"')); // 密文，不含明文会话正文

		// 重启（新实例同目录）→ 锁定 → 解锁 → 幂等同步不重复上传
		const filesBefore = await readdir(syncFolder, { recursive: true });
		const manager2 = createManager();
		await manager2.initialize();
		assert.equal(manager2.securityState(), "LOCKED");
		assert.equal(await manager2.unlock(PASSWORD), true);
		await manager2.connectProvider("local");
		const idle = await manager2.syncNow();
		assert.equal(idle.pushed, false);
		const filesAfter = await readdir(syncFolder, { recursive: true });
		assert.deepEqual([...filesAfter].sort(), [...filesBefore].sort());

		await manager.dispose();
		await manager2.dispose();
	});
});
