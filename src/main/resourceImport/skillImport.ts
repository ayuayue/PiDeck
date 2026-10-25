import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceImportSourceKind, ResourceImportCandidate, StoredResourceImportCandidate } from "../../shared/types/resourceImport";
import { fingerprint, hasErrorCode, MAX_FILE_BYTES, MAX_SKILL_DEPTH, MAX_SKILL_TREE_BYTES, PREVIEW_TEXT_MAX, redactSensitiveList, redactSensitiveText, safeMessage, sourceLabel } from "./common";

type SourcePath = { source: ResourceImportSourceKind; path: string };

/** Normalize an imported skill name without changing the source SKILL.md. */
export function normalizeSkillName(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized.slice(0, 64).replace(/-+$/g, "");
}

/** Read the small YAML-like frontmatter subset used by pi skills. */
export function parseSkillFrontmatter(raw: string): Record<string, string> {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const result: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index < 0) continue;
		const key = line.slice(0, index).trim();
		const value = line
			.slice(index + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key) result[key] = value;
	}
	return result;
}

export type SkillDiscovery = { dirs: string[]; error?: string };

/** Discover directories containing a real SKILL.md without following links. */
export async function findSkillDirs(root: string): Promise<SkillDiscovery> {
	const dirs: string[] = [];
	let hadUnsafeEntry = false;
	const visit = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_SKILL_DEPTH) {
			hadUnsafeEntry = true;
			return;
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			hadUnsafeEntry = true;
			return;
		}
		if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
			dirs.push(dir);
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				hadUnsafeEntry = true;
				continue;
			}
			if (entry.isDirectory()) await visit(join(dir, entry.name), depth + 1);
		}
	};
	await visit(root, 0);
	return {
		dirs,
		error: hadUnsafeEntry ? "Some skill entries were skipped because they are unsafe." : undefined,
	};
}

/** Hash every file/path in a skill tree so attachments changing after scan invalidate apply. */
export async function skillTreeFingerprint(root: string): Promise<string> {
	const hash = createHash("sha256");
	let totalBytes = 0;
	const visit = async (dir: string, depth: number, prefix: string): Promise<void> => {
		if (depth > MAX_SKILL_DEPTH) throw new Error("Skill directory is too deep.");
		const rootEntry = await lstat(dir);
		if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error("Skill source must be a directory without symbolic links.");
		const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error("Skill contains a symbolic link and cannot be imported.");
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				hash.update(`d:${relativeName}\n`);
				await visit(fullPath, depth + 1, relativeName);
				continue;
			}
			if (!entry.isFile()) throw new Error("Skill contains an unsupported file type.");
			const info = await stat(fullPath);
			if (info.size > MAX_FILE_BYTES) throw new Error("Skill file is too large.");
			totalBytes += info.size;
			if (totalBytes > MAX_SKILL_TREE_BYTES) throw new Error("Skill directory is too large.");
			hash.update(`f:${relativeName}:${info.size}\n`);
			hash.update(await readFile(fullPath));
		}
	};
	await visit(root, 0, "");
	return hash.digest("hex");
}

/** Build a candidate and keep source internals out of the public payload. */
export async function buildSkillCandidate(item: SourcePath, dir: string): Promise<StoredResourceImportCandidate> {
	const skillPath = join(dir, "SKILL.md");
	const warnings: string[] = [];
	const blockers: string[] = [];
	let raw = "";
	try {
		raw = await readFile(skillPath, "utf8");
	} catch {
		blockers.push("SKILL.md could not be read.");
	}
	const frontmatter = parseSkillFrontmatter(raw);
	const fallback = dir.split(/[\\/]/).pop() ?? "";
	const targetName = normalizeSkillName(frontmatter.name || fallback);
	if (!frontmatter.name) warnings.push("Skill name missing; directory name will be used.");
	if (!frontmatter.description) warnings.push("Description missing.");
	if (frontmatter.name && frontmatter.name.length > 64) warnings.push("The skill name exceeds 64 characters and will be truncated.");
	if (frontmatter.description && frontmatter.description.length > 1024) warnings.push("Skill description exceeds 1024 characters.");
	if (!targetName) blockers.push("Skill name cannot be converted to a safe name.");

	let sourceFingerprint = fingerprint(raw);
	try {
		sourceFingerprint = await skillTreeFingerprint(dir);
	} catch (error) {
		blockers.push(safeMessage(error, "Skill directory is not safe to import."));
	}

	return {
		candidateId: randomUUID(),
		kind: "skill",
		source: item.source,
		sourceLabel: sourceLabel(item.source),
		sourcePathLabel: item.path,
		name: frontmatter.name || fallback,
		targetName,
		description: frontmatter.description || fallback,
		importable: blockers.length === 0,
		warnings,
		blockers,
		conflict: false,
		sourcePath: dir,
		sourceFingerprint,
	};
}

export function publicSkillCandidate(candidate: StoredResourceImportCandidate): ResourceImportCandidate {
	const { sourcePath: _sourcePath, sourcePathLexical: _sourcePathLexical, sourceFingerprint: _sourceFingerprint, mcpDefinition: _mcpDefinition, ...publicCandidate } = candidate;
	return {
		...publicCandidate,
		name: redactSensitiveText(publicCandidate.name, PREVIEW_TEXT_MAX),
		targetName: redactSensitiveText(publicCandidate.targetName, PREVIEW_TEXT_MAX),
		sourcePathLabel: redactSensitiveText(publicCandidate.sourcePathLabel, PREVIEW_TEXT_MAX),
		description: redactSensitiveText(publicCandidate.description, PREVIEW_TEXT_MAX),
		warnings: redactSensitiveList(publicCandidate.warnings),
		blockers: redactSensitiveList(publicCandidate.blockers),
	};
}

/** Compatibility fallback for older test doubles; production managers expose this operation. */
export async function copySkillDirectoryAtomic(targetRoot: string, sourceDirectory: string, targetName: string): Promise<void> {
	// This helper is also used as a compatibility fallback by ResourceImportManager;
	// validate the final path component here so a future caller cannot turn a failed
	// scan into a directory traversal write.
	if (!targetName || targetName !== targetName.trim() || targetName.toLowerCase() !== targetName || targetName.length > 64 || !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,63})$/u.test(targetName)) {
		throw new Error("Skill name cannot be converted to a safe name.");
	}
	// Keep the compatibility path subject to the same complete-tree limits as the
	// production managers.  This also rejects links/special files introduced between
	// discovery and the copy operation before anything is placed in the destination.
	await skillTreeFingerprint(sourceDirectory);
	await mkdir(targetRoot, { recursive: true });
	const occupied = (await readdir(targetRoot, { withFileTypes: true })).some((entry) => entry.name.toLowerCase() === targetName.toLowerCase() || normalizeSkillName(entry.name) === targetName);
	if (occupied) throw new Error("Target already contains this skill.");
	const temporaryDirectory = join(targetRoot, `.${targetName}.${randomUUID()}.tmp`);
	try {
		await cp(sourceDirectory, temporaryDirectory, {
			recursive: true,
			errorOnExist: true,
			force: false,
			verbatimSymlinks: true,
		});
		await skillTreeFingerprint(temporaryDirectory);
		await rename(temporaryDirectory, join(targetRoot, targetName));
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Validate a source root before recursion; missing roots are represented by source status. */
export async function sourceDirectoryIsSafe(root: string): Promise<{ exists: boolean; safe: boolean; error?: string }> {
	try {
		const entry = await lstat(root);
		if (entry.isSymbolicLink() || !entry.isDirectory()) return { exists: true, safe: false, error: "Skill source is not a safe directory." };
		return { exists: true, safe: true };
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return { exists: false, safe: true };
		return { exists: true, safe: false, error: "Skill source could not be read." };
	}
}
