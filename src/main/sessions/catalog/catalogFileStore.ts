import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { getAppLogger } from "../../logging/sharedLogger";
import { acquireStoreFileLock, currentBootId, defaultIsProcessAlive } from "../../persistence/StoreFileLock";
import { renameWithRetry } from "../../utils/fsRetry";
import type { ArchivedRemoteSessionEntry, DismissedRemoteSessionEntry, SessionCatalogEntry, SessionCatalogFile } from "../SessionCatalog";
import { cloneEntry, isRecord, isSessionLocator, normalizeEntryLocator } from "./catalogEntryProjection";
import { SESSION_CATALOG_BUSY, SESSION_CATALOG_LOCK_UNWRITABLE, SESSION_CATALOG_REVISION_CONFLICT } from "./catalogStoreCodes";

/** 落盘时要写进去的非会话状态（墓碑 / 归档索引 / 备份轮换位）：宿主持有，写盘时按值取一份。 */
export type CatalogSnapshotState = {
	readonly dismissedDshSessionIds: ReadonlySet<string>;
	readonly dismissedRemoteSessionIds: ReadonlySet<string>;
	readonly archivedRemoteSessions: ReadonlyMap<string, ArchivedRemoteSessionEntry>;
	readonly skipNextBackup: boolean;
};

/**
 * 一条远端归档条目是否可用：两个绝对路径与身份字段是恢复的全部依据。
 * 宽容读出（单条残缺只丢弃那一条）：一条坏索引不该让整份 catalog 变成不可用，
 * 而丢一条的代价是「这条归档在列表里看不到、也恢复不了」，不是数据丢失。
 */
export function readArchivedRemoteSessionEntry(value: unknown): ArchivedRemoteSessionEntry | undefined {
	if (!isRecord(value)) return undefined;
	const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
	const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
	const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
	const originalRemotePath = typeof value.originalRemotePath === "string" ? value.originalRemotePath.trim() : "";
	const archivedRemotePath = typeof value.archivedRemotePath === "string" ? value.archivedRemotePath.trim() : "";
	if (sessionId.length === 0 || hostId.length === 0 || projectId.length === 0 || originalRemotePath.length === 0 || archivedRemotePath.length === 0) return undefined;
	const archivedAt = typeof value.archivedAt === "number" && Number.isFinite(value.archivedAt) ? value.archivedAt : 0;
	const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
	const remoteSessionId = typeof value.remoteSessionId === "string" && value.remoteSessionId.length > 0 ? value.remoteSessionId : undefined;
	const remotePath = typeof value.remotePath === "string" && value.remotePath.length > 0 ? value.remotePath : undefined;
	return {
		sessionId,
		hostId,
		projectId,
		title: typeof value.title === "string" ? value.title : "",
		updatedAt,
		...(remoteSessionId !== undefined ? { remoteSessionId } : {}),
		...(remotePath !== undefined ? { remotePath } : {}),
		originalRemotePath,
		archivedRemotePath,
		archivedAt,
	};
}

/**
 * 远端墓碑在内存里的键（`Set` 查询用）：hostId 是 UUID（无空白），remoteSessionId 的形状规则已拒绝
 * 控制字节（见 RemoteSessionScanner.readRemoteSessionId）⇒ `\n` 是唯一分隔符，不会有二义。
 */

export function remoteDismissalKey(hostId: string, remoteSessionId: string): string {
	return `${hostId}\n${remoteSessionId}`;
}

/** 键还原成持久化用的结构化身份；不合法（缺分隔符/空半截）返回 undefined，该条墓碑被丢弃。 */
export function readRemoteDismissalKey(key: string): DismissedRemoteSessionEntry | undefined {
	const index = key.indexOf("\n");
	if (index <= 0 || index === key.length - 1) return undefined;
	return { hostId: key.slice(0, index), remoteSessionId: key.slice(index + 1) };
}

/** `readCatalogState` 的结果：ok/empty 是正常形态，另两种由调用方决定怎么 fail closed。 */
export type CatalogStateRead =
	| { kind: "ok"; entries: SessionCatalogEntry[]; dismissedDshSessionIds: Set<string>; dismissedRemoteSessionIds: Set<string>; archivedRemoteSessions: Map<string, ArchivedRemoteSessionEntry>; revision: number; locatorNormalizationNeeded: boolean; skipNextBackup: boolean }
	| { kind: "empty" }
	| { kind: "unsupported"; error: UnsupportedSessionCatalogVersionError | UnsupportedSessionCatalogLocatorError }
	| { kind: "unreadable"; primary: string; backup: string };

/**
 * 磁盘上的 revision（INV-5a）：旧版（v1）文件没有这个字段 ⇒ 0；字段存在但值域非法 ⇒ 整份拒绝
 * （fail closed：把损坏的版本号当 0 会让下一次重写静默地把别人的更新归零）。
 */
export function readCatalogRevision(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("SESSION_CATALOG_INVALID_REVISION");
	return value;
}

export function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

export class UnsupportedSessionCatalogVersionError extends Error {
	constructor() {
		super("SESSION_CATALOG_UNSUPPORTED_VERSION");
	}
}

export class UnsupportedSessionCatalogLocatorError extends Error {
	constructor() {
		super("SESSION_CATALOG_UNSUPPORTED_LOCATOR");
	}
}

/**
 * 读**磁盘**上的最新 catalog（primary → backup → 首次运行的空状态），与 load 的既有选择规则逐条一致：
 * primary 能读就不看 backup；primary 是“版本/locator 不认识”就停（旧版备份无权授权替换不兼容的主文件）；
 * primary 读不出来才退到 backup（并置 skipNextBackup）；两个都不存在 = 首次运行；两个都读不出来 = unreadable
 * （绝不把读不出来的快照当成“空 catalog”）。
 */
export async function readCatalogState(filePath: string): Promise<CatalogStateRead> {
	let primaryError: unknown;
	try {
		const snapshot = await readCatalogFile(filePath);
		return {
			kind: "ok",
			entries: snapshot.entries,
			dismissedDshSessionIds: snapshot.dismissedDshSessionIds,
			dismissedRemoteSessionIds: snapshot.dismissedRemoteSessionIds,
			archivedRemoteSessions: snapshot.archivedRemoteSessions,
			revision: snapshot.revision,
			locatorNormalizationNeeded: snapshot.locatorNormalizationNeeded,
			skipNextBackup: false,
		};
	} catch (error) {
		primaryError = error;
		if (error instanceof UnsupportedSessionCatalogVersionError || error instanceof UnsupportedSessionCatalogLocatorError) {
			return { kind: "unsupported", error };
		}
	}
	let backupError: unknown;
	try {
		const snapshot = await readCatalogFile(backupFilePath(filePath));
		return {
			kind: "ok",
			entries: snapshot.entries,
			dismissedDshSessionIds: snapshot.dismissedDshSessionIds,
			dismissedRemoteSessionIds: snapshot.dismissedRemoteSessionIds,
			archivedRemoteSessions: snapshot.archivedRemoteSessions,
			revision: snapshot.revision,
			locatorNormalizationNeeded: snapshot.locatorNormalizationNeeded,
			skipNextBackup: true,
		};
	} catch (error) {
		backupError = error;
	}
	if (isMissingFileError(primaryError) && isMissingFileError(backupError)) return { kind: "empty" };
	return { kind: "unreadable", primary: primaryError instanceof Error ? primaryError.message : String(primaryError), backup: backupError instanceof Error ? backupError.message : String(backupError) };
}

/**
 * 加载期归一化的落盘（best-effort）：只在磁盘仍是我们读到的那一版（revision 令牌相等）时才把内存里的
 * 归一化结果写回；令牌不等 ⇒ 另一个实例已提交更新 ⇒ 放弃本次写（下次启动重试归一化）。
 *
 * 为什么不用 enqueueMutation：那里会把磁盘内容读回内存，而本方法的**写的是内存里的归一化结果**；
 * 两者共用同一套锁与稳定码。跳过的代价只是一次重叠合并/清理延后一次启动，而错写的代价是丢别人的记录。
 */
export async function persistLoadedNormalization(filePath: string, entries: SessionCatalogEntry[], expectedRevision: number, state: CatalogSnapshotState, assertWritable: () => void): Promise<void> {
	const expected = expectedRevision;
	const lock = await acquireStoreFileLock({
		rootDir: dirname(filePath),
		lockPath: `${filePath}.lock`,
		unwritableCode: SESSION_CATALOG_LOCK_UNWRITABLE,
		bootId: currentBootId(),
		isProcessAlive: defaultIsProcessAlive,
		now: Date.now,
	});
	if (!lock) throw new Error(SESSION_CATALOG_BUSY);
	try {
		const fresh = await readCatalogState(filePath);
		const freshRevision = fresh.kind === "ok" ? fresh.revision : fresh.kind === "empty" ? 0 : -1;
		if (freshRevision !== expected) throw new Error(SESSION_CATALOG_REVISION_CONFLICT);
		await writeCatalogSnapshot(filePath, entries, expected + 1, state, assertWritable);
	} finally {
		await lock.release();
	}
}

export function backupFilePath(filePath: string): string {
	return `${filePath}.bak`;
}

export async function readCatalogFile(filePath: string): Promise<{
	entries: SessionCatalogEntry[];
	dismissedDshSessionIds: Set<string>;
	dismissedRemoteSessionIds: Set<string>;
	archivedRemoteSessions: Map<string, ArchivedRemoteSessionEntry>;
	locatorNormalizationNeeded: boolean;
	revision: number;
}> {
	const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SessionCatalogFile>;
	if (parsed.version !== undefined && parsed.version !== 1) {
		throw new UnsupportedSessionCatalogVersionError();
	}
	const revision = readCatalogRevision(parsed.revision);
	if (!Array.isArray(parsed.sessions)) {
		throw new Error(`Invalid Session catalog: ${filePath}`);
	}
	const entries = parsed.sessions.filter((entry): entry is SessionCatalogEntry => {
		const validFields = typeof entry?.id === "string" && typeof entry.projectId === "string" && typeof entry.title === "string" && (entry.environment === "native" || entry.environment === "wsl") && (entry.status === "draft" || entry.status === "active");
		if (!validFields) return false;
		if (isRecord(entry.locator) && typeof entry.locator.kind === "string" && entry.locator.kind !== "local" && entry.locator.kind !== "ssh") {
			throw new UnsupportedSessionCatalogLocatorError();
		}
		return entry.locator === undefined || isSessionLocator(entry.locator);
	});
	if (entries.length !== parsed.sessions.length) {
		throw new Error(`Session catalog contains invalid records: ${filePath}`);
	}
	// 渠道标志是渲染层显示标志的依据：只认白名单值，手改/未来版本的未知值按「无渠道」
	// 处理，不把未知字符串传给 UI（与 titleOrigin 等字段的读盘清洗同一口径）。
	for (const entry of entries) {
		if (entry.channel !== "wechat" && entry.channel !== "feishu") delete entry.channel;
	}
	const locatorNormalizationNeeded = entries.some((entry) => {
		if (entry.locator?.kind === "ssh") {
			return entry.filePath !== undefined || entry.originKey !== undefined || entry.piSessionId !== undefined || entry.wslDistro !== undefined || entry.wslUser !== undefined || entry.parentSessionPath !== undefined;
		}
		return entry.locator?.kind === "local" && (entry.filePath !== entry.locator.filePath || entry.environment !== entry.locator.environment || entry.wslDistro !== entry.locator.wslDistro || entry.wslUser !== entry.locator.wslUser);
	});
	const dismissed = Array.isArray(parsed.dismissedDshSessionIds) ? parsed.dismissedDshSessionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
	// 远端墓碑同样宽容读出：单条身份残缺（缺 hostId / 缺 remoteSessionId）只丢弃那一条，不让整份
	// catalog 变成不可用——墓碑只是「别再列出来」的排除提示，丢一条的代价是列表多一条，不是数据丢失。
	const dismissedRemote = (Array.isArray(parsed.dismissedRemoteSessions) ? parsed.dismissedRemoteSessions : []).flatMap((value) => {
		if (!isRecord(value)) return [];
		const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
		const remoteSessionId = typeof value.remoteSessionId === "string" ? value.remoteSessionId.trim() : "";
		return hostId.length === 0 || remoteSessionId.length === 0 ? [] : [remoteDismissalKey(hostId, remoteSessionId)];
	});
	// 归档索引同样宽容读出：单条残缺（缺身份/缺路径）只丢弃那一条，不让整份 catalog 不可用。
	const archivedRemoteSessions = new Map<string, ArchivedRemoteSessionEntry>();
	for (const value of Array.isArray(parsed.archivedRemoteSessions) ? parsed.archivedRemoteSessions : []) {
		const entry = readArchivedRemoteSessionEntry(value);
		if (entry !== undefined) archivedRemoteSessions.set(entry.sessionId, entry);
	}
	return {
		entries: entries.map(normalizeEntryLocator),
		dismissedDshSessionIds: new Set(dismissed),
		dismissedRemoteSessionIds: new Set(dismissedRemote),
		archivedRemoteSessions,
		locatorNormalizationNeeded,
		revision,
	};
}

export async function writeCatalogSnapshot(filePath: string, entries: SessionCatalogEntry[], revision: number, state: CatalogSnapshotState, assertWritable: () => void): Promise<void> {
	assertWritable();
	const snapshot: SessionCatalogFile = {
		version: 1,
		// 单调递增的写版本（INV-5a）：写者必须先读过同一版本才能提交，见 enqueueMutation。
		revision,
		sessions: entries.map(cloneEntry),
		// 旧 catalog 没有该字段；空数组也写出，重启后删除墓碑不丢。
		dismissedDshSessionIds: [...state.dismissedDshSessionIds],
		// 同上：远端墓碑也持久化，否则重启后「移除过的会话」会重新出现在可导入列表里。
		dismissedRemoteSessions: [...state.dismissedRemoteSessionIds].flatMap((key) => {
			const identity = readRemoteDismissalKey(key);
			return identity === undefined ? [] : [identity];
		}),
		// 归档索引同样持久化：丢它就是「归档了的远端会话既看不到也恢复不了」。
		archivedRemoteSessions: [...state.archivedRemoteSessions.values()].map((entry) => ({ ...entry })),
	};
	await mkdir(dirname(filePath), { recursive: true });
	const nonce = randomUUID();
	const tempPath = `${filePath}.${nonce}.tmp`;
	const backupPath = backupFilePath(filePath);
	const backupTempPath = `${backupPath}.${nonce}.tmp`;
	try {
		const handle = await open(tempPath, "w");
		try {
			await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		if (!state.skipNextBackup) {
			try {
				await copyFile(filePath, backupTempPath);
				await renameWithRetry(backupTempPath, backupPath);
			} catch (error) {
				await unlink(backupTempPath).catch(() => undefined);
				if (isMissingFileError(error)) {
					// 首次写入：主文件还不存在，没有可备份的内容，属正常情况
				} else {
					// 备份轮换失败不能阻断 catalog 写入（新建会话等操作会因此失败）：
					// .bak 只是崩溃恢复的冗余副本，主文件仍是原子替换，旧内容在失败时原样保留。
					void getAppLogger()?.warn("session-catalog", "Backup rotation failed, continuing without backup", {
						cause: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		await renameWithRetry(tempPath, filePath);
	} finally {
		await unlink(tempPath).catch(() => undefined);
		await unlink(backupTempPath).catch(() => undefined);
	}
}
