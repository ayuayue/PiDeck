import { readFile } from "node:fs/promises";
import type { Project } from "../../shared/types/project";
import { writeDurableJsonFile } from "../persistence/durableJsonStore";
import { decodeProjectStoreSnapshot, encodeProjectStoreSnapshot, type DecodedProjectStoreSnapshot } from "./projectStoreCodec";

type SnapshotSource = "primary" | "backup";
type SnapshotRead = { kind: "missing"; source: SnapshotSource } | { kind: "invalid"; source: SnapshotSource; error: string } | { kind: "valid"; source: SnapshotSource; snapshot: DecodedProjectStoreSnapshot };

export type LoadedProjectStore = {
	projects: Project[];
	revision: number;
	needsRewrite: boolean;
	skipNextBackup: boolean;
};

export class ProjectStoreRecoveryError extends Error {
	readonly code = "PROJECT_STORE_NEEDS_REPAIR";

	constructor(primary: string, backup: string) {
		super(`PROJECT_STORE_NEEDS_REPAIR: primary=${primary}; backup=${backup}`);
		this.name = "ProjectStoreRecoveryError";
	}
}

/** Selects the highest valid primary/backup revision and fails closed if neither can be read. */
export async function loadProjectStore(filePath: string): Promise<LoadedProjectStore> {
	const primary = await readSnapshot(filePath, "primary");
	const backup = await readSnapshot(`${filePath}.bak`, "backup");
	const candidates = [primary, backup].filter((candidate): candidate is Extract<SnapshotRead, { kind: "valid" }> => candidate.kind === "valid");
	if (candidates.length === 0) {
		if (primary.kind === "missing" && backup.kind === "missing") {
			return { projects: [], revision: 0, needsRewrite: false, skipNextBackup: false };
		}
		throw new ProjectStoreRecoveryError(snapshotReadDescription(primary), snapshotReadDescription(backup));
	}

	const selected = candidates.reduce((best, candidate) => (candidate.snapshot.revision > best.snapshot.revision ? candidate : best));
	const fromBackup = selected.source === "backup";
	return {
		projects: selected.snapshot.projects,
		revision: selected.snapshot.revision,
		needsRewrite: fromBackup || selected.snapshot.sourceVersion === 1,
		skipNextBackup: fromBackup,
	};
}

export async function writeProjectStoreSnapshot(filePath: string, projects: Project[], revision: number, options: { skipBackup?: boolean } = {}): Promise<void> {
	const snapshot = encodeProjectStoreSnapshot(projects, revision);
	await writeDurableJsonFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, {
		backupPath: `${filePath}.bak`,
		skipBackup: options.skipBackup,
		backupFailurePolicy: "throw",
	});
}

async function readSnapshot(filePath: string, source: SnapshotSource): Promise<SnapshotRead> {
	try {
		const snapshot = decodeProjectStoreSnapshot(parseJson(await readFile(filePath, "utf8")));
		return { kind: "valid", source, snapshot };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing", source };
		return { kind: "invalid", source, error: errorMessage(error) };
	}
}

function parseJson(text: string): unknown {
	return JSON.parse(text);
}

function snapshotReadDescription(result: SnapshotRead): string {
	if (result.kind === "missing") return "missing";
	if (result.kind === "invalid") return result.error;
	return `valid revision ${result.snapshot.revision}`;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
