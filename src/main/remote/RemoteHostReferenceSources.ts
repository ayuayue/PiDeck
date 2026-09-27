import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isSessionLocator } from "../sessions/SessionCatalog";
import { HOST_ID } from "./RemoteHostStoreCodec";
import { HOST_REFERENCE_SOURCES, RemoteHostReferenceRegistry, type RemoteHostReferenceScan, type RemoteHostReferenceSource } from "./RemoteHostReferenceRegistry";

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function readBoundedCatalog(filePath: string): Promise<string> {
	const pathStat = await lstat(filePath);
	if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.ino !== pathStat.ino || before.dev !== pathStat.dev || before.size < 1 || before.size > MAX_CATALOG_BYTES) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		const buffer = Buffer.alloc(before.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		await handle.close();
	}
}

/** Scan only durable sessions; backup recovery and live transient records cannot certify an empty disk. */
async function scanPersistedSessions(filePath: string): Promise<RemoteHostReferenceScan> {
	let text: string;
	try {
		text = await readBoundedCatalog(filePath);
	} catch (error) {
		if (isMissingFile(error)) {
			try {
				await stat(`${filePath}.bak`);
			} catch (backupError) {
				if (isMissingFile(backupError)) return { referencedHostIds: new Set(), hits: [], complete: true, unavailable: [] };
			}
		}
		throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	}
	const snapshot: unknown = JSON.parse(text);
	if (!isRecord(snapshot) || (snapshot.version !== undefined && snapshot.version !== 1) || !Array.isArray(snapshot.sessions)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	const referencedHostIds = new Set<string>();
	const hits: { source: RemoteHostReferenceSource; recordId: string }[] = [];
	for (const entry of snapshot.sessions) {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.projectId !== "string" || typeof entry.title !== "string" || (entry.environment !== "native" && entry.environment !== "wsl") || (entry.status !== "draft" && entry.status !== "active")) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		if (entry.locator === undefined) continue;
		if (!isSessionLocator(entry.locator)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		if (entry.locator.kind === "ssh") {
			if (!HOST_ID.test(entry.locator.hostId)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
			referencedHostIds.add(entry.locator.hostId);
			hits.push({ source: "sessions", recordId: entry.id });
		}
	}
	return { referencedHostIds, hits, complete: true, unavailable: [] };
}

/** Production registration for today's local-only project/runtime shapes; mutation remains disabled. */
export function createRemoteHostReferenceRegistry(sessionCatalogFilePath: string): RemoteHostReferenceRegistry {
	if (typeof sessionCatalogFilePath !== "string" || !isAbsolute(sessionCatalogFilePath) || /[\x00-\x1f\x7f]/.test(sessionCatalogFilePath)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	const registry = new RemoteHostReferenceRegistry();
	const noReferences = { capability: { canHoldHostReferences: false }, scan: async (): Promise<RemoteHostReferenceScan> => ({ referencedHostIds: new Set(), hits: [], complete: true, unavailable: [] }) };
	for (const source of HOST_REFERENCE_SOURCES) {
		registry.register(source, source === "sessions" ? { scan: () => scanPersistedSessions(sessionCatalogFilePath) } : noReferences);
	}
	return registry;
}
