import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import {
	BACKUP_FORMAT_VERSION,
	BACKUP_MAGIC,
	BackupFileReader,
	BackupFileWriter,
	encodeBackupContainer,
	parseBackupContainer,
	parseBackupManifest,
} from "../src/main/cloudSync/exportImport.ts";
import { createDefaultExternalEditorSettings } from "../src/shared/types/project.ts";

const PASSWORD = "correct horse battery staple";
const SESSION_CONTENT = '{"type":"session_info","name":"A"}\n{"role":"user","content":"hi"}\n';

function minimalSettings() {
	return {
		theme: "dark",
		accent: "green",
		favoriteModels: [],
		externalEditors: createDefaultExternalEditorSettings(),
	};
}

function makeManager({ userDataDir, homeDir, records = [], projects = [], installExtension, listExtensions }) {
	return new CloudSyncManager({
		userDataDir,
		homeDir,
		deviceName: "test",
		appVersion: "0.0.0-test",
		listProjects: () => projects,
		listSessionRecords: () => records,
		getDesktopSettings: minimalSettings,
		updateDesktopSettings: async () => undefined,
		...(installExtension ? { installExtension } : {}),
		...(listExtensions ? { listExtensions } : {}),
	});
}

async function withTemp(run) {
	const base = await mkdtemp(join(tmpdir(), "pideck-backup-"));
	try {
		return await run(base);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

/** 在 machine 的 home 下放置一个全局会话，并返回 records。 */
async function makeGlobalSession(homeDir) {
	const sessionsDir = join(homeDir, ".pi", "agent", "sessions", "2026");
	await mkdir(sessionsDir, { recursive: true });
	const sessionFile = join(sessionsDir, "session-a.jsonl");
	await writeFile(sessionFile, SESSION_CONTENT, "utf8");
	return [{
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
}

/** 导出 machine A 的全量选择为一个备份文件。 */
async function exportAll(base, homeDir, records, extraOptions = {}) {
	const userDataDir = join(base, "userData-a");
	const manager = makeManager({ userDataDir, homeDir, records });
	await manager.initialize();
	await manager.setupMasterKey(PASSWORD);
	const tree = await manager.scanSelection();
	const selectionIds = tree.projects.flatMap((project) => project.sessions).map((session) => session.selectionId);
	await manager.updateSelection({ selectedSessionIds: selectionIds, selectedResourceIds: [] });
	const outputPath = join(base, extraOptions.fileName ?? "backup.pideckbackup");
	const result = await manager.exportBackup({ outputPath });
	await manager.dispose();
	return result;
}

// ── Container format (pure) ────────────────────────────────────────────────

test("backup container encodes and parses header + entries", () => {
	const header = Buffer.from("encrypted-header-bytes");
	const entries = [
		{ name: "pideck-index.json", bytes: Buffer.from("first") },
		{ name: "pideck-sessions/session-a.jsonl.enc", bytes: Buffer.from([1, 2, 3, 255]) },
	];
	const data = encodeBackupContainer(header, entries);
	assert.equal(Buffer.from(data.subarray(0, BACKUP_MAGIC.length)).toString("ascii"), BACKUP_MAGIC);
	const parsed = parseBackupContainer(data);
	assert.equal(parsed.formatVersion, BACKUP_FORMAT_VERSION);
	assert.deepEqual(Buffer.from(parsed.headerBytes), header);
	assert.deepEqual(parsed.entries.map((entry) => entry.name), entries.map((entry) => entry.name));
	assert.deepEqual(Buffer.from(parsed.entries[1].bytes), Buffer.from([1, 2, 3, 255]));
});

test("backup container rejects corrupt or hostile input", () => {
	assert.throws(() => parseBackupContainer(Buffer.from("short")), /truncated/);

	const badMagic = Buffer.from(encodeBackupContainer(Buffer.from("h"), []));
	badMagic.write("NOTPIDECK!!", 0, "ascii");
	assert.throws(() => parseBackupContainer(badMagic), /Not a PiDeck backup/);

	const badVersion = Buffer.from(encodeBackupContainer(Buffer.from("h"), []));
	badVersion.writeUInt32LE(99, BACKUP_MAGIC.length);
	assert.throws(() => parseBackupContainer(badVersion), /version/);

	const full = Buffer.from(encodeBackupContainer(Buffer.from("h"), [{ name: "x", bytes: Buffer.from("abc") }]));
	assert.throws(() => parseBackupContainer(full.subarray(0, full.length - 2)), /truncated/);
});

test("backup container bounds: oversized header and entry are rejected", () => {
	const hugeHeader = Buffer.alloc(16 * 1024 * 1024 + 1);
	assert.throws(() => encodeBackupContainer(hugeHeader, []), /header is too large/);
	assert.throws(() => encodeBackupContainer(Buffer.from("h"), [{ name: "x", bytes: Buffer.alloc(512 * 1024 * 1024 + 1) }]), /entry size/);
	assert.throws(() => encodeBackupContainer(Buffer.from("h"), [{ name: "", bytes: Buffer.from("x") }]), /entry name/);
});

test("backup file writer/reader round-trips through a real file", async () => {
	await withTemp(async (base) => {
		const filePath = join(base, "backup.pideckbackup");
		const writer = await BackupFileWriter.create(filePath);
		await writer.writeHeader(Buffer.from("header-bytes"));
		await writer.writeEntry({ name: "pideck-sessions/s1.jsonl.enc", bytes: Buffer.from("entry-one") });
		await writer.writeEntry({ name: "pideck-files/abc.enc", bytes: Buffer.from([9, 9]) });
		await writer.close();

		const reader = await BackupFileReader.open(filePath);
		try {
			const { formatVersion, headerBytes } = await reader.readHeader();
			assert.equal(formatVersion, BACKUP_FORMAT_VERSION);
			assert.equal(Buffer.from(headerBytes).toString("utf8"), "header-bytes");
			const entries = [];
			for await (const entry of reader.entries()) entries.push(entry);
			assert.deepEqual(entries.map((entry) => entry.name), ["pideck-sessions/s1.jsonl.enc", "pideck-files/abc.enc"]);
			assert.equal(Buffer.from(entries[1].bytes).toString("hex"), "0909");
		} finally {
			await reader.close();
		}
	});
});

test("backup manifest parser validates the decrypted header", () => {
	const valid = JSON.stringify({
		schemaVersion: 1,
		createdAt: 1,
		deviceId: "device-1",
		index: { schemaVersion: 1, meta: { deviceId: "device-1", appVersion: "v", syncedAt: 1 }, syncedAt: 1, projects: [] },
		entries: [],
	});
	const manifest = parseBackupManifest(valid);
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.deviceId, "device-1");

	assert.throws(() => parseBackupManifest("{not json"), /JSON/);
	assert.throws(() => parseBackupManifest(JSON.stringify({ schemaVersion: 2 })), /schema/);
	assert.throws(() => parseBackupManifest(JSON.stringify({ schemaVersion: 1, createdAt: "x", index: { projects: [] }, entries: [] })), /created-at/);
	assert.throws(() => parseBackupManifest(JSON.stringify({ schemaVersion: 1, createdAt: 1, deviceId: "d", index: { projects: [] }, entries: [{ name: "x" }] })), /entry/);
});

// ── Manager: export / import round trip ────────────────────────────────────

test("manager exports the selected session into a valid backup file", async () => {
	await withTemp(async (base) => {
		const homeDir = join(base, "home-a");
		const records = await makeGlobalSession(homeDir);
		const result = await exportAll(base, homeDir, records);
		assert.equal(result.sessionCount, 1);
		assert.equal(result.resourceCount, 0);
		assert.equal(result.entryCount, 1);
		assert.ok(result.bytes > 0);
		assert.ok(result.filePath.endsWith(".pideckbackup"));

		const bytes = await readFile(result.filePath);
		assert.equal(bytes.subarray(0, BACKUP_MAGIC.length).toString("ascii"), BACKUP_MAGIC);
	});
});

test("manager imports a backup onto a fresh machine (offline round trip)", async () => {
	await withTemp(async (base) => {
		const homeA = join(base, "home-a");
		const records = await makeGlobalSession(homeA);
		await exportAll(base, homeA, records);

		// Machine B：全新 userData/home，没有任何会话与主密码。
		const userDataB = join(base, "userData-b");
		const homeB = join(base, "home-b");
		await mkdir(homeB, { recursive: true });
		const managerB = makeManager({ userDataDir: userDataB, homeDir: homeB });
		await managerB.initialize();
		assert.equal(managerB.securityState(), "NO_KEY");

		const result = await managerB.importBackup({
			filePath: join(base, "backup.pideckbackup"),
			password: PASSWORD,
			mode: "merge",
		});
		assert.equal(result.sessionCount, 1);
		assert.equal(result.sessionsRestored, 1);
		assert.equal(result.sessionsSkipped, 0);
		assert.deepEqual(result.pendingProjects, []);

		// 会话恢复到目标路径且内容一致（密文 → 明文往返无损）。
		const restored = await readFile(join(homeB, ".pi", "agent", "sessions", "2026", "session-a.jsonl"), "utf8");
		assert.equal(restored, SESSION_CONTENT);

		// 导入密码成为新机主密码。
		assert.equal(managerB.securityState(), "UNLOCKED");
		await managerB.dispose();
	});
});

test("import modes control whether existing local files are replaced", async () => {
	await withTemp(async (base) => {
		const homeA = join(base, "home-a");
		const records = await makeGlobalSession(homeA);
		await exportAll(base, homeA, records);

		// Machine B 预先存在同名会话文件（内容不同 = 本地更新）。
		const userDataB = join(base, "userData-b");
		const homeB = join(base, "home-b");
		const target = join(homeB, ".pi", "agent", "sessions", "2026", "session-a.jsonl");
		await mkdir(join(homeB, ".pi", "agent", "sessions", "2026"), { recursive: true });
		await writeFile(target, "local-newer-content\n", "utf8");
		const managerB = makeManager({ userDataDir: userDataB, homeDir: homeB });
		await managerB.initialize();

		// merge：保留本地（跳过）
		let result = await managerB.importBackup({ filePath: join(base, "backup.pideckbackup"), password: PASSWORD, mode: "merge" });
		assert.equal(result.sessionsRestored, 0);
		assert.equal(result.sessionsSkipped, 1);
		assert.equal(await readFile(target, "utf8"), "local-newer-content\n");

		// restoreMissing：保留本地（跳过）
		result = await managerB.importBackup({ filePath: join(base, "backup.pideckbackup"), password: PASSWORD, mode: "restoreMissing" });
		assert.equal(result.sessionsRestored, 0);
		assert.equal(await readFile(target, "utf8"), "local-newer-content\n");

		// overwrite：以备份为准（覆盖）
		result = await managerB.importBackup({ filePath: join(base, "backup.pideckbackup"), password: PASSWORD, mode: "overwrite" });
		assert.equal(result.sessionsRestored, 1);
		assert.equal(result.sessionsSkipped, 0);
		assert.equal(await readFile(target, "utf8"), SESSION_CONTENT);

		await managerB.dispose();
	});
});

test("import rejects wrong password, mismatched master password and corrupt files", async () => {
	await withTemp(async (base) => {
		const homeA = join(base, "home-a");
		const records = await makeGlobalSession(homeA);
		await exportAll(base, homeA, records);
		const backupPath = join(base, "backup.pideckbackup");

		// 新机：错误密码 → 备份头解不开，且不会创建主密钥。
		const userDataB = join(base, "userData-b");
		const homeB = join(base, "home-b");
		await mkdir(homeB, { recursive: true });
		const managerB = makeManager({ userDataDir: userDataB, homeDir: homeB });
		await managerB.initialize();
		await assert.rejects(
			() => managerB.importBackup({ filePath: backupPath, password: "wrong password 123", mode: "merge" }),
			/password is incorrect or the file is corrupted/,
		);
		assert.equal(managerB.securityState(), "NO_KEY");

		// 本机已有另一个主密码（模拟已配置云同步的机器）→ 即使备份能解开也拒绝。
		await managerB.setupMasterKey("master-password-other");
		await assert.rejects(
			() => managerB.importBackup({ filePath: backupPath, password: PASSWORD, mode: "merge" }),
			/does not match the master password/,
		);

		// 损坏文件：魔数错误 → 报错且不改状态。
		const corruptPath = join(base, "corrupt.pideckbackup");
		await writeFile(corruptPath, "this is not a backup", "utf8");
		await assert.rejects(
			() => managerB.importBackup({ filePath: corruptPath, password: "master-password-other", mode: "merge" }),
			/Not a PiDeck backup/,
		);
		await managerB.dispose();
	});
});

test("project sessions without a local project land in the pending mapping area", async () => {
	await withTemp(async (base) => {
		// Machine A：项目 proj-1 下有一个项目级会话。
		const homeA = join(base, "home-a");
		const projectPath = join(base, "proj-1");
		const sessionsDir = join(projectPath, ".pi", "sessions", "2026");
		await mkdir(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "session-p.jsonl");
		await writeFile(sessionFile, SESSION_CONTENT, "utf8");
		const projects = [{ id: "proj-1", name: "proj", path: projectPath, lastOpenedAt: 1, environment: "windows" }];
		const records = [{
			id: "session-p",
			projectId: "proj-1",
			title: "Session P",
			source: "pi",
			environment: "native",
			filePath: sessionFile,
			preview: "hi",
			messageCount: 1,
			status: "active",
			createdAt: 1,
			updatedAt: 1,
		}];

		const userDataA = join(base, "userData-a");
		const managerA = makeManager({ userDataDir: userDataA, homeDir: homeA, records, projects });
		await managerA.initialize();
		await managerA.setupMasterKey(PASSWORD);
		const tree = await managerA.scanSelection();
		const projectNode = tree.projects.find((node) => node.projectId === "proj-1");
		assert.ok(projectNode, "project session should be discovered");
		const selectionId = projectNode.sessions[0].selectionId;
		await managerA.updateSelection({ selectedSessionIds: [selectionId], selectedResourceIds: [] });
		const outputPath = join(base, "backup.pideckbackup");
		const result = await managerA.exportBackup({ outputPath });
		assert.equal(result.sessionCount, 1);
		await managerA.dispose();

		// Machine B：没有 proj-1 → 落入待映射区，并报告 pendingProjects。
		const userDataB = join(base, "userData-b");
		const homeB = join(base, "home-b");
		await mkdir(homeB, { recursive: true });
		const managerB = makeManager({ userDataDir: userDataB, homeDir: homeB });
		await managerB.initialize();
		const imported = await managerB.importBackup({ filePath: outputPath, password: PASSWORD, mode: "merge" });
		assert.equal(imported.sessionsRestored, 1);
		assert.deepEqual(imported.pendingProjects, ["proj-1"]);
		const pendingFile = join(userDataB, "cloud-sync-pending", "proj-1", "2026", "session-p.jsonl");
		assert.equal(await readFile(pendingFile, "utf8"), SESSION_CONTENT);
		await managerB.dispose();
	});
});
