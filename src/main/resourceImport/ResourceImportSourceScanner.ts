import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ConfigManager } from "../config/ConfigManager";
import { homeFromPiAgentDir, isMcpServerName } from "../config/mcpConfig";
import { createProjectFileReadBoundary, FILE_OUTSIDE_PROJECT_ERROR, resolveProjectFileReadPath, resolveProjectFileWritePath, type ProjectFileReadBoundary } from "../files/projectFileAccess";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { ResourceImportCandidate, ResourceImportKind, ResourceImportScanInput, ResourceImportSourceKind, ResourceImportSourceStatus, StoredResourceImportCandidate } from "../../shared/types/resourceImport";
import { fingerprint, hasErrorCode, isRecord, MAX_FILE_BYTES, MAX_SKILL_CANDIDATES, redactSensitiveText, sourceLabel } from "./common";
import { convertMcpDefinition, extractMcpServersWithStatus, mcpTransportOf, parseMcpSource, probeMcpCandidates, publicMcpCandidate } from "./mcpImport";
import { buildSkillCandidate, findSkillDirs, publicSkillCandidate, skillTreeFingerprint, sourceDirectoryIsSafe } from "./skillImport";

/** Minimal registered-project shape needed while reading an external project source. */
export type ResourceImportProject = {
	id: string;
	path: string;
	kind?: "chat";
	environment?: "windows" | "wsl";
};

type SourcePath = {
	source: ResourceImportSourceKind;
	path: string;
	/** Project sources are resolved through this canonical boundary before reading. */
	projectBoundary?: ProjectFileReadBoundary;
};

/**
 * Private MCP source state held only for the lifetime of a scan. Candidate
 * fingerprints alone are insufficient: a source with zero servers can still
 * change after the user sees a combined scan result.
 */
export type McpSourceSnapshot = {
	source: ResourceImportSourceKind;
	sourcePathLexical: string;
	canonicalPath?: string;
	projectSource: boolean;
	exists: boolean;
	fingerprint?: string;
	readError?: string;
	/** The project read boundary rejected this source at scan time. */
	boundaryRejected?: boolean;
};

/**
 * Private skill-source state held only for a scan session. Candidate fingerprints
 * catch edits inside discovered skill packages, while the directory list catches
 * a package appearing or disappearing after a scan (including a source that was
 * empty when the dialog opened).
 */
export type SkillSourceSnapshot = {
	source: ResourceImportSourceKind;
	sourcePathLexical: string;
	canonicalPath?: string;
	projectSource: boolean;
	exists: boolean;
	discoveryError?: string;
	discoveredDirs: string[];
};

export type ResourceImportScanCandidates = {
	sources: ResourceImportSourceStatus[];
	stored: StoredResourceImportCandidate[];
	mcpSourceSnapshots: McpSourceSnapshot[];
	skillSourceSnapshots: SkillSourceSnapshot[];
};

/** Keep a rejected project source excluded without treating an unchanged rejection as stale. */
function isProjectBoundaryError(error: unknown): boolean {
	return hasErrorCode(error, FILE_OUTSIDE_PROJECT_ERROR) || (error instanceof Error && error.message === FILE_OUTSIDE_PROJECT_ERROR);
}

/**
 * Scans external Claude/Codex sources and owns source freshness checks. Keeping this
 * filesystem-oriented work outside ResourceImportManager lets that manager focus on
 * short-lived scan authorization, target selection, and writes.
 */
export class ResourceImportSourceScanner {
	constructor(
		private readonly configManager: ConfigManager,
		private readonly projectResourceManager: ProjectResourceManager,
		private readonly getProject: (id: string) => ResourceImportProject | undefined,
	) {}

	async scan(input: ResourceImportScanInput): Promise<ResourceImportScanCandidates> {
		return input.kind === "mcp" ? this.scanMcp(input) : this.scanSkills(input);
	}

	/** Build the renderer-safe view only after the manager has applied target conflicts. */
	publicCandidates(kind: ResourceImportKind, candidates: StoredResourceImportCandidate[]): ResourceImportCandidate[] {
		return kind === "mcp" ? candidates.map(publicMcpCandidate) : candidates.map(publicSkillCandidate);
	}

	/** Ensure all sources and every discovered candidate still match the displayed scan. */
	async assertFresh(kind: ResourceImportKind, candidates: StoredResourceImportCandidate[], sourceProjectId: string | undefined, mcpSourceSnapshots: McpSourceSnapshot[], skillSourceSnapshots: SkillSourceSnapshot[]): Promise<void> {
		// MCP sources include empty and malformed files in the scan snapshot. A change to
		// any of them invalidates the entire combined result, rather than silently
		// importing against a mixture of old and new vendor config.
		for (const source of mcpSourceSnapshots) {
			await this.assertMcpSourceFresh(source, sourceProjectId);
		}
		// Skill sources can be empty at scan time. Re-discover every source root so a
		// newly-created package cannot be silently omitted from the user's selection.
		for (const source of skillSourceSnapshots) {
			await this.assertSkillSourceFresh(source, sourceProjectId);
		}
		// Validate every discovered source before the first write. Even an unselected
		// candidate belongs to the scan snapshot; accepting a partially stale snapshot
		// would make the result depend on which rows the renderer happened to select.
		for (const candidate of candidates) {
			await this.assertCandidateFresh(candidate, kind, sourceProjectId);
		}
	}

	/** Remove control characters and credential-looking values from source diagnostics. */
	publicSourceStatuses(sources: ResourceImportSourceStatus[]): ResourceImportSourceStatus[] {
		return sources.map((source) => ({
			...source,
			pathLabel: redactSensitiveText(source.pathLabel),
			...(source.error === undefined ? {} : { error: redactSensitiveText(source.error) }),
		}));
	}

	private async sourcePaths(input: ResourceImportScanInput): Promise<SourcePath[]> {
		const home = homeFromPiAgentDir(this.configManager.getConfigDir()) || homedir();
		const paths: SourcePath[] =
			input.kind === "mcp"
				? [
						{ source: "claude-global", path: join(home, ".claude.json") },
						{ source: "claude-global", path: join(home, ".claude", "mcp-configs", "mcp-servers.json") },
						{ source: "codex-global", path: join(home, ".codex", "config.toml") },
					]
				: [
						{ source: "claude-global", path: join(home, ".claude", "skills") },
						{ source: "codex-global", path: join(home, ".codex", "skills") },
					];
		if (!input.sourceProjectId) return paths;
		const project = this.getProject(input.sourceProjectId);
		if (!project || project.kind === "chat") return paths;
		const root = await this.projectResourceManager.resolveProjectRoot(input.sourceProjectId);
		const projectBoundary = await createProjectFileReadBoundary(root);
		paths.push(
			input.kind === "mcp" ? { source: "claude-project", path: join(root, ".mcp.json"), projectBoundary } : { source: "claude-project", path: join(root, ".claude", "skills"), projectBoundary },
			input.kind === "mcp" ? { source: "codex-project", path: join(root, ".codex", "config.toml"), projectBoundary } : { source: "codex-project", path: join(root, ".agents", "skills"), projectBoundary },
		);
		return paths;
	}

	private async readTextSource(path: string): Promise<{ raw?: string; exists: boolean; error?: string }> {
		try {
			const info = await stat(path);
			if (!info.isFile()) return { exists: true, error: "Source is not a regular file." };
			if (info.size > MAX_FILE_BYTES) return { exists: true, error: "Source file is too large." };
			return { raw: await readFile(path, "utf8"), exists: true };
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return { exists: false };
			return { exists: true, error: "Source could not be read." };
		}
	}

	/**
	 * Resolve a project-owned source for read-only scanning. Existing paths use the
	 * canonical read resolver; missing paths still pass through the write-path resolver
	 * solely to validate every existing ancestor and reject an escaping symlink/reparse
	 * point before the optional source is reported as absent.
	 */
	private async resolveProjectSourcePath(item: SourcePath): Promise<string | undefined> {
		if (!item.projectBoundary) return item.path;
		try {
			return await resolveProjectFileReadPath(item.projectBoundary, item.path);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
			await resolveProjectFileWritePath(item.projectBoundary, item.path);
			return undefined;
		}
	}

	private async scanMcp(input: ResourceImportScanInput): Promise<ResourceImportScanCandidates> {
		const sources: ResourceImportSourceStatus[] = [];
		const stored: StoredResourceImportCandidate[] = [];
		const mcpSourceSnapshots: McpSourceSnapshot[] = [];
		for (const item of await this.sourcePaths(input)) {
			const status: ResourceImportSourceStatus = { source: item.source, pathLabel: item.path, exists: false };
			sources.push(status);
			let sourcePath: string | undefined;
			try {
				sourcePath = await this.resolveProjectSourcePath(item);
			} catch (error) {
				// A rejected project source is part of the combined scan snapshot too. If it
				// later becomes readable, it could produce candidates that were not shown in
				// the dialog, so apply must force a fresh scan. An unchanged boundary rejection
				// remains safely excluded and must not block an independent source's import.
				const boundaryRejected = isProjectBoundaryError(error);
				status.exists = true;
				status.error = boundaryRejected ? "Source path is outside the project boundary." : "Source could not be resolved.";
				mcpSourceSnapshots.push({
					source: item.source,
					sourcePathLexical: item.path,
					projectSource: Boolean(item.projectBoundary),
					exists: true,
					readError: status.error,
					...(boundaryRejected ? { boundaryRejected: true } : {}),
				});
				continue;
			}
			if (!sourcePath) {
				mcpSourceSnapshots.push({
					source: item.source,
					sourcePathLexical: item.path,
					projectSource: Boolean(item.projectBoundary),
					exists: false,
				});
				continue;
			}
			const sourceFile = await this.readTextSource(sourcePath);
			status.exists = sourceFile.exists;
			mcpSourceSnapshots.push({
				source: item.source,
				sourcePathLexical: item.path,
				canonicalPath: sourcePath,
				projectSource: Boolean(item.projectBoundary),
				exists: sourceFile.exists,
				...(sourceFile.raw === undefined ? {} : { fingerprint: fingerprint(sourceFile.raw) }),
				...(sourceFile.error === undefined ? {} : { readError: sourceFile.error }),
			});
			if (!sourceFile.exists || sourceFile.error || sourceFile.raw === undefined) {
				if (sourceFile.error) status.error = sourceFile.error;
				continue;
			}
			const parsed = parseMcpSource(sourceFile.raw, sourcePath.toLowerCase().endsWith(".toml"), status);
			if (!parsed) continue;
			for (const entry of extractMcpServersWithStatus(parsed, sourcePath.toLowerCase().endsWith(".toml"), status)) {
				const sourceDef = isRecord(entry.value) ? entry.value : {};
				const warnings: string[] = [];
				const blockers: string[] = [];
				if (!isRecord(entry.value)) blockers.push("MCP server definition must be an object.");
				const definition = convertMcpDefinition(sourceDef, sourcePath.toLowerCase().endsWith(".toml"), warnings, blockers);
				if (!isMcpServerName(entry.name) || entry.name.trim() !== entry.name) blockers.push("MCP name is invalid for PiDeck.");
				stored.push({
					candidateId: randomUUID(),
					kind: "mcp",
					source: item.source,
					sourceLabel: sourceLabel(item.source),
					sourcePathLabel: item.path,
					name: entry.name,
					targetName: entry.name,
					description: typeof sourceDef.description === "string" ? sourceDef.description : "",
					importable: blockers.length === 0 && Boolean(definition),
					warnings,
					blockers,
					conflict: false,
					transport: mcpTransportOf(definition),
					preview: definition ? { command: definition.command, args: definition.args, url: definition.url } : undefined,
					sourcePath,
					sourcePathLexical: item.path,
					sourceFingerprint: fingerprint(sourceFile.raw),
					mcpDefinition: definition ?? undefined,
				});
			}
		}
		await probeMcpCandidates(this.configManager, stored);
		return {
			sources,
			stored,
			mcpSourceSnapshots,
			skillSourceSnapshots: [],
		};
	}

	private async scanSkills(input: ResourceImportScanInput): Promise<ResourceImportScanCandidates> {
		const sources: ResourceImportSourceStatus[] = [];
		const stored: StoredResourceImportCandidate[] = [];
		const skillSourceSnapshots: SkillSourceSnapshot[] = [];
		for (const item of await this.sourcePaths(input)) {
			const status: ResourceImportSourceStatus = { source: item.source, pathLabel: item.path, exists: false };
			sources.push(status);
			// Check the lexical source root before canonicalizing it. The project read
			// resolver correctly rejects links that escape the registered root, but an
			// in-project root symlink would otherwise be flattened and evade the skill
			// import rule that source directories themselves must not be links.
			const lexicalRoot = await sourceDirectoryIsSafe(item.path);
			if (lexicalRoot.exists && !lexicalRoot.safe) {
				status.exists = true;
				status.error = lexicalRoot.error;
				skillSourceSnapshots.push({
					source: item.source,
					sourcePathLexical: item.path,
					projectSource: Boolean(item.projectBoundary),
					exists: true,
					discoveryError: lexicalRoot.error,
					discoveredDirs: [],
				});
				continue;
			}
			let sourceRoot: string | undefined;
			try {
				sourceRoot = await this.resolveProjectSourcePath(item);
			} catch {
				status.exists = true;
				status.error = "Source path is outside the project boundary.";
				skillSourceSnapshots.push({
					source: item.source,
					sourcePathLexical: item.path,
					projectSource: Boolean(item.projectBoundary),
					exists: true,
					discoveryError: status.error,
					discoveredDirs: [],
				});
				continue;
			}
			if (!sourceRoot) {
				skillSourceSnapshots.push({
					source: item.source,
					sourcePathLexical: item.path,
					projectSource: Boolean(item.projectBoundary),
					exists: false,
					discoveredDirs: [],
				});
				continue;
			}
			const root = await sourceDirectoryIsSafe(sourceRoot);
			status.exists = root.exists;
			if (!root.safe) {
				status.error = root.error;
				skillSourceSnapshots.push({
					source: item.source,
					sourcePathLexical: item.path,
					canonicalPath: sourceRoot,
					projectSource: Boolean(item.projectBoundary),
					exists: root.exists,
					discoveryError: root.error,
					discoveredDirs: [],
				});
				continue;
			}
			if (!root.exists) {
				skillSourceSnapshots.push({
					source: item.source,
					sourcePathLexical: item.path,
					canonicalPath: sourceRoot,
					projectSource: Boolean(item.projectBoundary),
					exists: false,
					discoveredDirs: [],
				});
				continue;
			}
			const discovery = await findSkillDirs(sourceRoot);
			if (discovery.error) status.error = discovery.error;
			skillSourceSnapshots.push({
				source: item.source,
				sourcePathLexical: item.path,
				canonicalPath: sourceRoot,
				projectSource: Boolean(item.projectBoundary),
				exists: true,
				discoveryError: discovery.error,
				discoveredDirs: discovery.dirs.map((dir) => this.skillDirKey(sourceRoot, dir)).sort(),
			});
			for (const dir of discovery.dirs) {
				if (stored.length >= MAX_SKILL_CANDIDATES) {
					status.error = "Too many skill candidates; remaining entries were omitted.";
					break;
				}
				const candidate = await buildSkillCandidate(item, dir);
				// Project roots are canonicalized for safe reads. Retain the corresponding
				// lexical candidate path in the private scan cache so apply can detect a
				// symlink/junction swap between scan and write.
				candidate.sourcePathLexical = item.projectBoundary ? join(item.path, relative(sourceRoot, dir)) : dir;
				stored.push(candidate);
			}
		}
		return {
			sources,
			stored,
			mcpSourceSnapshots: [],
			skillSourceSnapshots,
		};
	}

	/** Keep source-directory comparisons stable across path separators. */
	private skillDirKey(root: string, directory: string): string {
		return relative(root, directory).replace(/[\\/]+/g, "/");
	}

	private async assertCandidateFresh(candidate: StoredResourceImportCandidate, kind: ResourceImportKind, sourceProjectId?: string): Promise<void> {
		if (candidate.source.endsWith("-project")) {
			try {
				const resolvedPath = await this.resolveProjectScanSourcePath(candidate.source, candidate.sourcePathLexical ?? candidate.sourcePathLabel, sourceProjectId);
				if (!resolvedPath || resolvedPath !== candidate.sourcePath) {
					throw new Error("Source changed or is no longer safe. Please scan again.");
				}
			} catch (error) {
				if (error instanceof Error && error.message === "Source changed or is no longer safe. Please scan again.") throw error;
				throw new Error("Source changed or is no longer safe. Please scan again.");
			}
		}
		if (kind === "mcp") {
			const source = await this.readTextSource(candidate.sourcePath);
			if (!source.raw || fingerprint(source.raw) !== candidate.sourceFingerprint) throw new Error("Source changed. Please scan again.");
			return;
		}
		try {
			if ((await skillTreeFingerprint(candidate.sourcePath)) !== candidate.sourceFingerprint) throw new Error("Source changed. Please scan again.");
		} catch {
			throw new Error("Source changed or is no longer safe. Please scan again.");
		}
	}

	/** Resolve a stored project source again without ever accepting a new path alias. */
	private async resolveProjectScanSourcePath(source: ResourceImportSourceKind, lexicalPath: string, sourceProjectId?: string): Promise<string | undefined> {
		if (!sourceProjectId) return undefined;
		const project = this.getProject(sourceProjectId);
		if (!project || project.kind === "chat") return undefined;
		const boundary = await createProjectFileReadBoundary(await this.projectResourceManager.resolveProjectRoot(sourceProjectId));
		return this.resolveProjectSourcePath({ source, path: lexicalPath, projectBoundary: boundary });
	}

	/** Compare each scanned MCP source, including sources that produced zero candidates. */
	private async assertMcpSourceFresh(snapshot: McpSourceSnapshot, sourceProjectId?: string): Promise<void> {
		let currentPath: string | undefined;
		try {
			currentPath = snapshot.projectSource ? await this.resolveProjectScanSourcePath(snapshot.source, snapshot.sourcePathLexical, sourceProjectId) : (snapshot.canonicalPath ?? snapshot.sourcePathLexical);
		} catch (error) {
			// Keep an unchanged unsafe project source excluded, just like an unchanged
			// unsafe skills directory. A different error or a newly resolvable source is
			// stale because it may change the set of candidates shown to the user.
			if (snapshot.boundaryRejected && isProjectBoundaryError(error)) return;
			throw new Error("Source changed. Please scan again.");
		}
		if (currentPath !== snapshot.canonicalPath) throw new Error("Source changed. Please scan again.");
		if (!currentPath) {
			if (snapshot.exists) throw new Error("Source changed. Please scan again.");
			return;
		}

		const current = await this.readTextSource(currentPath);
		if (current.exists !== snapshot.exists) throw new Error("Source changed. Please scan again.");
		if (snapshot.fingerprint !== undefined) {
			if (current.raw === undefined || fingerprint(current.raw) !== snapshot.fingerprint) {
				throw new Error("Source changed. Please scan again.");
			}
			return;
		}
		if (current.raw !== undefined || current.error !== snapshot.readError) {
			throw new Error("Source changed. Please scan again.");
		}
	}

	/** Re-discover one scanned skill root before any write. */
	private async assertSkillSourceFresh(snapshot: SkillSourceSnapshot, sourceProjectId?: string): Promise<void> {
		// A scan may legitimately contain an unsafe/unreadable *other* vendor source
		// alongside importable packages from a safe source. It must stay excluded, but
		// it must not make confirmation of those safe packages impossible merely because
		// it is still the same rejected directory. A transition back to a readable
		// directory remains stale so the new candidates are never silently omitted.
		const rejectedAtScan = snapshot.exists && snapshot.canonicalPath === undefined && snapshot.discoveryError !== undefined;
		const lexicalRoot = await sourceDirectoryIsSafe(snapshot.sourcePathLexical);
		if (rejectedAtScan && lexicalRoot.exists && !lexicalRoot.safe && lexicalRoot.error === snapshot.discoveryError) {
			return;
		}
		let currentPath: string | undefined;
		try {
			currentPath = snapshot.projectSource ? await this.resolveProjectScanSourcePath(snapshot.source, snapshot.sourcePathLexical, sourceProjectId) : (snapshot.canonicalPath ?? snapshot.sourcePathLexical);
		} catch {
			// A project source can be rejected by the canonical boundary because an
			// ancestor is a junction, while lstat on the leaf still looks ordinary. The
			// unchanged rejected state is safe to retain; a newly resolvable source falls
			// through below and invalidates the scan.
			if (rejectedAtScan && snapshot.discoveryError === "Source path is outside the project boundary.") return;
			throw new Error("Source changed or is no longer safe. Please scan again.");
		}
		if (currentPath !== snapshot.canonicalPath && snapshot.canonicalPath !== undefined) {
			throw new Error("Source changed or is no longer safe. Please scan again.");
		}
		if (!currentPath) {
			if (snapshot.exists) throw new Error("Source changed or is no longer safe. Please scan again.");
			return;
		}

		const root = await sourceDirectoryIsSafe(currentPath);
		if (root.exists !== snapshot.exists || !root.safe || root.error !== snapshot.discoveryError) {
			throw new Error("Source changed or is no longer safe. Please scan again.");
		}
		if (!root.exists) return;
		const discovery = await findSkillDirs(currentPath);
		const currentDirs = discovery.dirs.map((dir) => this.skillDirKey(currentPath, dir)).sort();
		if (discovery.error !== snapshot.discoveryError || currentDirs.length !== snapshot.discoveredDirs.length || currentDirs.some((dir, index) => dir !== snapshot.discoveredDirs[index])) {
			throw new Error("Source changed. Please scan again.");
		}
	}
}
