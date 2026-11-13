/**
 * 会话/资源对象的传输域（上传 → 加密信封 → 云端对象；云端对象 → 解密 → 原子落位）。
 * 从 `CloudSyncManager` 原样搬出：对象键、DSH `.zstd` 文本管线、M9 落位目标解析、
 * 挂载映射与 pending 待映射区选择一律保持原行为。
 *
 * 宿主只提供四处只读事实（主密码、设备标识、挂载映射），写入的状态推进仍留在宿主。
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SyncedFile } from "../../../shared/types/cloudSync.ts";
import { localProjectPath } from "../../../shared/projectLocation.ts";
import type { CloudSyncInternalResource, CloudSyncInternalSession } from "../CloudSyncScanner.ts";
import { CLOUD_SYNC_SCANNER_LIMITS } from "../CloudSyncScanner.ts";
import type { CloudSyncMount } from "../../../shared/types/cloudSync.ts";
import type { CloudSyncManagerOptions } from "../CloudSyncManager.ts";
import { dshSessionObjectKey, GLOBAL_SYNC_PROJECT_ID, resolveGlobalSessionPath, resolveProjectSessionPath, sessionObjectKey } from "../payload.ts";
import { decryptObject as decryptObjectEnvelope, encryptObject as encryptObjectEnvelope, ensureNoSymlinkEscape, hashFile, readDshSessionText, readDshSessionTextHash, readTextBounded, writeDshSessionContent, writeFileAtomic } from "./objectIo.ts";
import type { PiDeckCloudObjectStorage } from "../objectStorage.ts";

/** 传输域的窄接口：密码/设备标识/挂载映射都是宿主已有单一事实，不在此新增状态。 */
export interface CloudSyncSessionObjectTransferHost {
	requirePassword(): string;
	deviceId(): string;
	deviceName(): string;
	/** M9 挂载映射只读查询（注册表未初始化时 undefined）。 */
	mountEntry(remoteProjectId: string): CloudSyncMount | undefined;
}

export class CloudSyncSessionObjectTransfer {
	private readonly host: CloudSyncSessionObjectTransferHost;
	private readonly options: CloudSyncManagerOptions;

	constructor(host: CloudSyncSessionObjectTransferHost, options: CloudSyncManagerOptions) {
		this.host = host;
		this.options = options;
	}

	async uploadSessionObject(item: CloudSyncInternalSession, provider: PiDeckCloudObjectStorage): Promise<void> {
		// DSH 会话：.zstd 先解压成文本再走统一加密管线（contentHash 也是对文本计算）。
		if (item.candidate.scope === "dsh") {
			const content = await readDshSessionText(item.filePath);
			const key = dshSessionObjectKey(item.candidate.sessionId);
			const file = await this.encryptObject(content);
			await provider.writeObject(key, Buffer.from(JSON.stringify(file), "utf8"));
			return;
		}
		const content = await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxSessionBytes);
		const key = sessionObjectKey(item.candidate.sessionId);
		const file = await this.encryptObject(content);
		await provider.writeObject(key, Buffer.from(JSON.stringify(file), "utf8"));
	}

	async uploadResourceObject(item: CloudSyncInternalResource, provider: PiDeckCloudObjectStorage): Promise<void> {
		const content = await readTextBounded(item.filePath, CLOUD_SYNC_SCANNER_LIMITS.maxResourceBytes);
		const hash = createHash("sha256").update(content, "utf8").digest("hex");
		const key = `pideck-files/${hash}.enc`;
		const file = await this.encryptObject(content);
		await provider.writeObject(key, Buffer.from(JSON.stringify(file), "utf8"));
	}

	async encryptObject(content: string): Promise<SyncedFile> {
		return encryptObjectEnvelope({ password: this.host.requirePassword(), deviceId: this.host.deviceId(), deviceName: this.host.deviceName(), appVersion: this.options.appVersion }, content);
	}

	async decryptObject(bytes: Uint8Array): Promise<string> {
		return decryptObjectEnvelope(bytes, this.host.requirePassword());
	}

	/** 下载单个会话对象并写入目标路径（hash 相同则跳过）。 */
	async downloadSessionRef(sessionRef: import("../../../shared/types/cloudSync.ts").CloudSyncSessionRef, provider: PiDeckCloudObjectStorage): Promise<void> {
		if (sessionRef.scope === "dsh") {
			await this.downloadDshSession(sessionRef, provider);
			return;
		}
		const target = await this.resolveSessionTarget(sessionRef);
		const root = this.sessionTargetRoot(sessionRef);
		if (!target || !root) return;
		await mkdir(dirname(target), { recursive: true });
		await ensureNoSymlinkEscape(root, target);
		const object = await provider.readObject(sessionRef.objectKey);
		if (!object.found || !object.bytes) return;
		const existing = await this.readExistingHash(target);
		if (existing === sessionRef.contentHash) return;
		const content = await this.decryptObject(object.bytes);
		await writeFileAtomic(target, content);
	}

	/** DSH 会话恢复：解密文本后按原格式写回（.zstd 重新压缩，hash 比较基于解压文本）。 */
	private async downloadDshSession(sessionRef: import("../../../shared/types/cloudSync.ts").CloudSyncSessionRef, provider: PiDeckCloudObjectStorage): Promise<void> {
		const target = await this.resolveSessionTarget(sessionRef);
		const root = this.sessionTargetRoot(sessionRef);
		if (!target || !root) return;
		const existingHash = await readDshSessionTextHash(target);
		if (existingHash === sessionRef.contentHash) return;
		const object = await provider.readObject(sessionRef.objectKey);
		if (!object.found || !object.bytes) return;
		const content = await this.decryptObject(object.bytes);
		await mkdir(dirname(target), { recursive: true });
		await ensureNoSymlinkEscape(root, target);
		await writeDshSessionContent(target, content);
	}

	/**
	 * 资源落位目标（M9 自选路径感知）：
	 * `~/` 前缀 = home 相对自选路径 → 用户 home（不是 agent 根目录）；machine-only → 全局 agentRoot；
	 * 否则全局 → agentRoot；本地项目 → 项目路径；否则查挂载映射；无 → null。
	 */
	resolveResourceTarget(projectId: string, relativePath: string): { root: string; relative: string } | null {
		if (relativePath.startsWith("~/")) {
			return { root: this.options.homeDir, relative: relativePath.slice(2) };
		}
		const root = this.resolveResourceScopeRoot(projectId);
		if (!root) return null;
		return { root, relative: relativePath };
	}

	/** 下载单个资源 bundle 并写入对应作用域目录。 */
	async downloadResourceBundle(projectId: string, bundle: import("../../../shared/types/cloudSync.ts").CloudSyncFileBundle, provider: PiDeckCloudObjectStorage): Promise<void> {
		const targetInfo = this.resolveResourceTarget(projectId, bundle.relativePath);
		if (!targetInfo) return;
		const content = bundle.content ?? (await this.readObjectText(provider, bundle.objectKey ?? ""));
		if (content === undefined) return;
		const target = join(targetInfo.root, targetInfo.relative);
		await mkdir(dirname(target), { recursive: true });
		await ensureNoSymlinkEscape(targetInfo.root, target);
		await writeFileAtomic(target, content);
	}

	/** M9：资源落位根目录 —— 全局 → agentRoot；本地项目 → 项目路径；否则查挂载映射；无 → null。 */
	private resolveResourceScopeRoot(projectId: string): string | undefined {
		if (projectId === GLOBAL_SYNC_PROJECT_ID) return join(this.options.homeDir, ".pi", "agent");
		const project = this.options.listProjects().find((candidate) => candidate.id === projectId);
		const projectPath = project ? localProjectPath(project) : undefined;
		if (projectPath) return projectPath;
		return this.host.mountEntry(projectId)?.localPath;
	}

	async resolveSessionTarget(sessionRef: import("../../../shared/types/cloudSync.ts").CloudSyncSessionRef): Promise<string | null> {
		if (sessionRef.scope === "global") {
			return resolveGlobalSessionPath(this.options.homeDir, sessionRef.relativePath);
		}
		if (sessionRef.scope === "dsh") {
			// DSH 会话：$DSH_HOME/sessions/<relativePath>；无 DSH_HOME 则跳过。
			return this.options.dshHomeDir ? join(this.options.dshHomeDir, "sessions", sessionRef.relativePath) : null;
		}
		const project = this.options.listProjects().find((candidate) => candidate.id === sessionRef.projectId);
		const projectPath = project ? localProjectPath(project) : undefined;
		if (projectPath) return resolveProjectSessionPath(projectPath, sessionRef.relativePath, ".pi/sessions");
		// M9：已挂载的云端项目 → 落挂载目录；否则进 pending 待映射区。
		const mount = this.host.mountEntry(sessionRef.projectId ?? "");
		if (mount) return resolveProjectSessionPath(mount.localPath, sessionRef.relativePath, ".pi/sessions");
		return join(this.options.userDataDir, "cloud-sync-pending", sessionRef.projectId ?? "unknown", sessionRef.relativePath);
	}

	sessionTargetRoot(sessionRef: import("../../../shared/types/cloudSync.ts").CloudSyncSessionRef): string | null {
		if (sessionRef.scope === "global") {
			return join(this.options.homeDir, ".pi", "agent", "sessions");
		}
		if (sessionRef.scope === "dsh") {
			return this.options.dshHomeDir ? join(this.options.dshHomeDir, "sessions") : null;
		}
		const project = this.options.listProjects().find((candidate) => candidate.id === sessionRef.projectId);
		const projectPath = project ? localProjectPath(project) : undefined;
		if (projectPath) return join(projectPath, ".pi", "sessions");
		return this.host.mountEntry(sessionRef.projectId ?? "")?.localPath ?? null;
	}

	async readExistingHash(filePath: string): Promise<string | null> {
		try {
			return await hashFile(filePath);
		} catch {
			return null;
		}
	}

	private async readObjectText(provider: PiDeckCloudObjectStorage, key: string): Promise<string | undefined> {
		if (!key) return undefined;
		const result = await provider.readObject(key);
		if (!result.found || !result.bytes) return undefined;
		return this.decryptObject(result.bytes);
	}
}
