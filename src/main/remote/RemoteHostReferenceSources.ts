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

/**
 * Read one durable JSON file with no-follow semantics and a hard byte ceiling.
 *
 * Every reference source uses this: a symlinked, oversized, non-regular or concurrently-mutated file
 * must throw instead of being parsed, because a scan that silently reads something else can report
 * "no references" for a store that actually holds one.
 */
async function readBoundedJson(filePath: string): Promise<string> {
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

/**
 * Read a source file, or establish that it is durably absent.
 *
 * A backup that exists while the primary does not is *not* "empty": the store may still hold
 * references that only the primary would have shown, so that case throws and marks the source
 * incomplete (fail closed) rather than answering "nothing is referenced".
 */
async function readReferenceFile(filePath: string): Promise<string | undefined> {
	try {
		return await readBoundedJson(filePath);
	} catch (error) {
		if (isMissingFile(error)) {
			try {
				await stat(`${filePath}.bak`);
			} catch (backupError) {
				if (isMissingFile(backupError)) return undefined;
			}
		}
		throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	}
}

/** Scan only durable sessions; backup recovery and live transient records cannot certify an empty disk. */
async function scanPersistedSessions(filePath: string): Promise<RemoteHostReferenceScan> {
	const text = await readReferenceFile(filePath);
	if (text === undefined) return { referencedHostIds: new Set(), hits: [], complete: true, unavailable: [] };
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

/**
 * Scan durable project records for ssh locators (Phase 3 第二段).
 *
 * This source only became real once `ProjectStore` could hold an ssh locator; before that it declared
 * `canHoldHostReferences: false` and was skipped. Now it must be scanned for real — a source that is
 * skipped while it can hold references would let `retire` hard-delete a host still referenced by a
 * remote project. Any structurally suspicious record (missing/invalid ssh fields, a local record
 * carrying hostId, an unknown schema) makes the whole source incomplete rather than silently ignored.
 */
async function scanPersistedProjects(filePath: string): Promise<RemoteHostReferenceScan> {
	const text = await readReferenceFile(filePath);
	if (text === undefined) return { referencedHostIds: new Set(), hits: [], complete: true, unavailable: [] };
	const snapshot: unknown = JSON.parse(text);
	if (!isRecord(snapshot) || snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.projects)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
	const referencedHostIds = new Set<string>();
	const hits: { source: RemoteHostReferenceSource; recordId: string }[] = [];
	for (const entry of snapshot.projects) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		const locator = entry.locator;
		if (locator === undefined) continue; // v2 envelope requires locator; a missing one is a malformed record
		if (!isRecord(locator)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		if (locator.kind === "local") continue;
		if (locator.kind !== "ssh") throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		if (typeof locator.hostId !== "string" || !HOST_ID.test(locator.hostId)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INVALID");
		referencedHostIds.add(locator.hostId);
		hits.push({ source: "projects", recordId: entry.id });
	}
	return { referencedHostIds, hits, complete: true, unavailable: [] };
}

function assertReferencePath(value: unknown, code: string): asserts value is string {
	if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(code);
}

/**
 * Production registration for today's project/session shapes.
 *
 * `projects` and `sessions` are the two durable stores that can hold an ssh locator, and both are
 * scanned from disk. `host-profiles` and `runtime` declare that they structurally cannot hold a
 * reference and are skipped without affecting completeness (their hostId fields are transient or
 * self-describing, see `docs/remote-host-cross-store-design.md` §4.1).
 */
export function createRemoteHostReferenceRegistry(sessionCatalogFilePath: string, projectsFilePath: string): RemoteHostReferenceRegistry {
	assertReferencePath(sessionCatalogFilePath, "REMOTE_HOST_REFERENCE_SCAN_INVALID");
	assertReferencePath(projectsFilePath, "REMOTE_HOST_REFERENCE_SCAN_INVALID");
	const registry = new RemoteHostReferenceRegistry();
	const noReferences = { capability: { canHoldHostReferences: false }, scan: async (): Promise<RemoteHostReferenceScan> => ({ referencedHostIds: new Set(), hits: [], complete: true, unavailable: [] }) };
	const scanners: Partial<Record<RemoteHostReferenceSource, () => Promise<RemoteHostReferenceScan>>> = {
		sessions: () => scanPersistedSessions(sessionCatalogFilePath),
		projects: () => scanPersistedProjects(projectsFilePath),
	};
	for (const source of HOST_REFERENCE_SOURCES) {
		const scan = scanners[source];
		registry.register(source, scan ? { scan } : noReferences);
	}
	return registry;
}
