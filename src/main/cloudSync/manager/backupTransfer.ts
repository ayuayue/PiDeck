/**
 * 离线备份导入/导出域（`.pideckbackup`）。从 `CloudSyncManager` 原样搬出：
 * 导出复用云端管线（scanner → buildLocalIndex → encryptObject，对象字节与云对象一致），
 * 导入走云端 pull 的落位语义（路径重映射、pending 待映射区、扩展自动安装、设置白名单应用）。
 *
 * 宿主只提供只读事实（主密码配置、设备标识、扫描/索引/落位入口）与导入后的状态推进。
 */

import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudSyncExportResult, CloudSyncImportInput, CloudSyncImportMode, CloudSyncImportResult, CloudSyncMasterKeyConfig, CloudSyncMissingExtension, CloudSyncSessionRef, PiDeckSyncIndexV1, SyncedFile } from "../../../shared/types/cloudSync.ts";
import type { CloudSyncInternalResource, CloudSyncInternalSession, CloudSyncScanSnapshot } from "../CloudSyncScanner.ts";
import { CLOUD_SYNC_SCANNER_LIMITS } from "../CloudSyncScanner.ts";
import type { CloudSyncManagerOptions } from "../CloudSyncManager.ts";
import { verifyPassword } from "../EncryptionService.ts";
import { BackupFileReader, BackupFileWriter, parseBackupManifest, type PiDeckBackupManifestV1 } from "../exportImport.ts";
import { dshSessionObjectKey, filterSyncableDesktopSettings, sessionObjectKey } from "../payload.ts";
import { ensureNoSymlinkEscape, readDshSessionText, readDshSessionTextHash, readTextBounded, writeDshSessionContent, writeFileAtomic } from "./objectIo.ts";

/** 备份域需要宿主提供的窄接口：读写状态与落位入口全部留在宿主。 */
export interface CloudSyncBackupTransferHost {
	securityState(): "NO_KEY" | "LOCKED" | "UNLOCKED";
	setupMasterKey(password: string): Promise<void>;
	unlock(password: string): Promise<boolean>;
	/** 主密码配置（导入前的一致性校验）。 */
	masterKeyConfig(): CloudSyncMasterKeyConfig | null;
	deviceId(): string;
	deviceName(): string;
	/** 按当前选择偏好与排除规则扫描一次（与云端同步同一入口）。 */
	scan(): Promise<CloudSyncScanSnapshot>;
	buildLocalIndex(scan: CloudSyncScanSnapshot, selectedSessions: CloudSyncInternalSession[], selectedResources: CloudSyncInternalResource[]): Promise<PiDeckSyncIndexV1>;
	encryptObject(content: string): Promise<SyncedFile>;
	decryptObject(bytes: Uint8Array): Promise<string>;
	/** 显式密码解密（备份头部先于主密码一致性校验）。 */
	decryptObjectWith(bytes: Uint8Array, password: string): Promise<string>;
	checkAndRestoreExtensions(index: PiDeckSyncIndexV1): Promise<void>;
	restoreSensitiveContent(merged: PiDeckSyncIndexV1, remote: PiDeckSyncIndexV1): Promise<void>;
	resolveSessionTarget(sessionRef: CloudSyncSessionRef): Promise<string | null>;
	sessionTargetRoot(sessionRef: CloudSyncSessionRef): string | null;
	readExistingHash(filePath: string): Promise<string | null>;
	resolveResourceTarget(projectId: string, relativePath: string): { root: string; relative: string } | null;
	/** 导入落地后的状态推进（base/计数/时间/设备 + 持久化 + 广播），返回缺失扩展清单。 */
	commitImportedIndex(index: PiDeckSyncIndexV1, counts: { sessions: number; resources: number; deviceId: string }): Promise<CloudSyncMissingExtension[]>;
}

export class CloudSyncBackupTransfer {
	private readonly host: CloudSyncBackupTransferHost;
	private readonly options: CloudSyncManagerOptions;

	constructor(host: CloudSyncBackupTransferHost, options: CloudSyncManagerOptions) {
		this.host = host;
		this.options = options;
	}

	/**
	 * Export the current selection to a single `.pideckbackup` file.
	 *
	 * Reuses the exact cloud pipeline: scanner → buildLocalIndex → encryptObject,
	 * so exported session/resource objects are byte-identical to cloud objects and
	 * the import path shares one decryption route. Requires UNLOCKED (master key)
	 * but no connected provider.
	 */
	async exportBackup(options?: { outputPath?: string }): Promise<CloudSyncExportResult> {
		if (this.host.securityState() !== "UNLOCKED") throw new Error("Cloud sync must be unlocked");
		const outputPath = options?.outputPath;
		if (!outputPath) throw new Error("Backup output path is required");

		const scan = await this.host.scan();
		const selectedSessions = [...scan.sessions.values()].filter((item) => item.candidate.selected);
		const selectedResources = [...scan.resources.values()].filter((item) => item.candidate.selected);
		const index = await this.host.buildLocalIndex(scan, selectedSessions, selectedResources);

		const entries: Array<{ name: string; bytes: Uint8Array }> = [];
		for (const item of selectedSessions) {
			// DSH 会话：.zstd 解压为文本后打包（与上传路径一致）。
			const content = item.candidate.scope === "dsh" ? await readDshSessionText(item.filePath) : await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxSessionBytes);
			const file = await this.host.encryptObject(content);
			entries.push({
				name: item.candidate.scope === "dsh" ? dshSessionObjectKey(item.candidate.sessionId) : sessionObjectKey(item.candidate.sessionId),
				bytes: Buffer.from(JSON.stringify(file), "utf8"),
			});
		}
		for (const item of selectedResources) {
			const content = await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxResourceBytes);
			const file = await this.host.encryptObject(content);
			const hash = createHash("sha256").update(content, "utf8").digest("hex");
			entries.push({ name: `pideck-files/${hash}.enc`, bytes: Buffer.from(JSON.stringify(file), "utf8") });
		}

		const createdAt = Date.now();
		const manifest: PiDeckBackupManifestV1 = {
			schemaVersion: 1,
			createdAt,
			deviceId: this.host.deviceId(),
			deviceName: this.host.deviceName(),
			appVersion: this.options.appVersion,
			index,
			entries: entries.map((entry) => ({
				name: entry.name,
				hash: createHash("sha256").update(entry.bytes).digest("hex"),
				size: entry.bytes.byteLength,
			})),
		};
		const headerFile = await this.host.encryptObject(JSON.stringify(manifest));
		const headerBytes = Buffer.from(JSON.stringify(headerFile), "utf8");

		const writer = await BackupFileWriter.create(outputPath);
		try {
			await writer.writeHeader(headerBytes);
			for (const entry of entries) await writer.writeEntry(entry);
		} finally {
			await writer.close();
		}

		return {
			filePath: outputPath,
			createdAt,
			sessionCount: selectedSessions.length,
			resourceCount: selectedResources.length,
			entryCount: entries.length,
			bytes: (await lstat(outputPath)).size,
		};
	}

	/**
	 * Import a `.pideckbackup` file and restore it with cloud-pull semantics
	 * (path remapping, pending area, extension auto-install, settings apply).
	 *
	 * Order matters: the header is decrypted with the typed password FIRST (a
	 * corrupt file or wrong password fails before any state change), then the
	 * password is reconciled with the machine's master password: on a fresh
	 * machine (NO_KEY) it becomes the master password; otherwise it must match.
	 */
	async importBackup(input: CloudSyncImportInput): Promise<CloudSyncImportResult> {
		const reader = await BackupFileReader.open(input.filePath);
		let manifest: PiDeckBackupManifestV1;
		let entriesByName: Map<string, Uint8Array>;
		try {
			const { headerBytes } = await reader.readHeader();
			let headerRaw: string;
			try {
				headerRaw = await this.host.decryptObjectWith(headerBytes, input.password);
			} catch {
				throw new Error("Backup password is incorrect or the file is corrupted");
			}
			manifest = parseBackupManifest(headerRaw);
			entriesByName = new Map<string, Uint8Array>();
			for await (const entry of reader.entries()) {
				entriesByName.set(entry.name, entry.bytes);
			}
		} finally {
			await reader.close();
		}

		const security = this.host.securityState();
		if (security === "NO_KEY") {
			await this.host.setupMasterKey(input.password);
		} else {
			const config = this.host.masterKeyConfig();
			const matches = config ? await verifyPassword(input.password, config) : false;
			if (!matches) throw new Error("Import password does not match the master password");
			if (security === "LOCKED" && !(await this.host.unlock(input.password))) {
				throw new Error("Import password does not match the master password");
			}
		}

		return this.applyBackup(input, manifest, entriesByName);
	}

	/** 把备份清单落地：会话/资源按模式写回，配置域与云端 pull 同语义。 */
	private async applyBackup(input: CloudSyncImportInput, manifest: PiDeckBackupManifestV1, entriesByName: Map<string, Uint8Array>): Promise<CloudSyncImportResult> {
		const index = manifest.index;
		const result: CloudSyncImportResult = {
			filePath: input.filePath,
			sessionCount: 0,
			resourceCount: 0,
			sessionsRestored: 0,
			resourcesRestored: 0,
			sessionsSkipped: 0,
			resourcesSkipped: 0,
			pendingProjects: [],
			missingExtensions: [],
		};
		const pendingProjects = new Set<string>();

		for (const project of index.projects ?? []) {
			for (const sessionRef of project.sessions ?? []) {
				result.sessionCount += 1;
				const entryBytes = entriesByName.get(sessionRef.objectKey);
				if (!entryBytes) {
					result.sessionsSkipped += 1;
					continue;
				}
				const outcome = await this.restoreBackupSession(sessionRef, entryBytes, input.mode);
				if (outcome.written) result.sessionsRestored += 1;
				else result.sessionsSkipped += 1;
				if (outcome.pending) pendingProjects.add(sessionRef.projectId ?? "unknown");
			}
			const resources = project.resources;
			if (resources) {
				for (const bundle of [...(resources.prompts ?? []), ...(resources.skills ?? []), ...(resources.localExtensions ?? []), ...(resources.config ?? [])]) {
					result.resourceCount += 1;
					const content = bundle.content ?? (await this.decryptBackupEntry(entriesByName.get(bundle.objectKey ?? "")));
					if (content === undefined) {
						result.resourcesSkipped += 1;
						continue;
					}
					if (await this.restoreBackupResource(project.projectId, bundle.relativePath, content, input.mode)) {
						result.resourcesRestored += 1;
					} else {
						result.resourcesSkipped += 1;
					}
				}
			}
		}

		// 配置域：设置白名单应用、密钥本地优先、包扩展按声明自动安装（与云端 pull 一致）。
		await this.applyImportedConfig(index);

		const missingExtensions = await this.host.commitImportedIndex(index, { sessions: result.sessionCount, resources: result.resourceCount, deviceId: manifest.deviceId });

		result.pendingProjects = [...pendingProjects];
		result.missingExtensions = missingExtensions;
		return result;
	}

	private async restoreBackupSession(sessionRef: CloudSyncSessionRef, entryBytes: Uint8Array, mode: CloudSyncImportMode): Promise<{ written: boolean; pending: boolean }> {
		// DSH 会话：hash 基于解压文本、写回按原格式（.zstd 重新压缩）。
		if (sessionRef.scope === "dsh") {
			return this.restoreDshBackupSession(sessionRef, entryBytes, mode);
		}
		const target = await this.host.resolveSessionTarget(sessionRef);
		const root = this.host.sessionTargetRoot(sessionRef);
		if (!target) return { written: false, pending: false };
		const existing = await this.host.readExistingHash(target);
		if (existing === sessionRef.contentHash) return { written: false, pending: !root };
		// merge / restoreMissing：本地已有内容则保留本地（备份是快照，本地可能更新）。
		if (existing && mode !== "overwrite") return { written: false, pending: !root };
		const content = await this.host.decryptObject(entryBytes);
		await mkdir(dirname(target), { recursive: true });
		if (root) await ensureNoSymlinkEscape(root, target);
		await writeFileAtomic(target, content);
		return { written: true, pending: !root };
	}

	/** 备份导入的 DSH 会话恢复（无项目映射概念，root 恒存在或跳过）。 */
	private async restoreDshBackupSession(sessionRef: CloudSyncSessionRef, entryBytes: Uint8Array, mode: CloudSyncImportMode): Promise<{ written: boolean; pending: boolean }> {
		const target = await this.host.resolveSessionTarget(sessionRef);
		const root = this.host.sessionTargetRoot(sessionRef);
		if (!target || !root) return { written: false, pending: false };
		const existing = await readDshSessionTextHash(target);
		if (existing === sessionRef.contentHash) return { written: false, pending: false };
		if (existing !== null && mode !== "overwrite") return { written: false, pending: false };
		const content = await this.host.decryptObject(entryBytes);
		await mkdir(dirname(target), { recursive: true });
		await ensureNoSymlinkEscape(root, target);
		await writeDshSessionContent(target, content);
		return { written: true, pending: false };
	}

	private async restoreBackupResource(projectId: string, relativePath: string, content: string, mode: CloudSyncImportMode): Promise<boolean> {
		const targetInfo = this.host.resolveResourceTarget(projectId, relativePath);
		if (!targetInfo) return false;
		const target = join(targetInfo.root, targetInfo.relative);
		const existing = await this.host.readExistingHash(target);
		if (existing === createHash("sha256").update(content, "utf8").digest("hex")) return false;
		if (existing && mode !== "overwrite") return false;
		await mkdir(dirname(target), { recursive: true });
		await ensureNoSymlinkEscape(targetInfo.root, target);
		await writeFileAtomic(target, content);
		return true;
	}

	/** 解密备份内一个对象条目；缺失/损坏返回 undefined。 */
	private async decryptBackupEntry(entryBytes: Uint8Array | undefined): Promise<string | undefined> {
		if (!entryBytes) return undefined;
		try {
			return await this.host.decryptObject(entryBytes);
		} catch {
			return undefined;
		}
	}

	/** 导入后应用配置域（与云端 pull 的恢复语义一致）。 */
	private async applyImportedConfig(index: PiDeckSyncIndexV1): Promise<void> {
		if (index.settings) {
			const filtered = filterSyncableDesktopSettings(index.settings);
			if (Object.keys(filtered).length > 0) {
				await this.options.updateDesktopSettings(filtered);
			}
		}
		await this.host.checkAndRestoreExtensions(index);
		await this.host.restoreSensitiveContent(index, index);
	}
}
