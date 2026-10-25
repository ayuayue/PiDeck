import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigManager } from "../config/ConfigManager";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { SkillManager } from "../skills/SkillManager";
import { parseMcpConfigFile, validateMcpConfigFile } from "../config/mcpConfig";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, resolveProjectFileWritePath } from "../files/projectFileAccess";
import type { McpConfigFile } from "../../shared/types/mcp";
import type { ResourceImportApplyInput, ResourceImportScanInput, ResourceImportScanResult, ResourceImportTarget, ResourceImportReport, StoredResourceImportCandidate } from "../../shared/types/resourceImport";
import { addUnique, hasErrorCode, isConflictError, isRecord, ResourceImportConflictError, SCAN_TTL_MS, safeMessage, targetKey, MAX_FILE_BYTES, redactSensitiveText } from "./common";
import { copySkillDirectoryAtomic, findSkillDirs, normalizeSkillName, parseSkillFrontmatter } from "./skillImport";
import { ResourceImportSourceScanner, type McpSourceSnapshot, type ResourceImportProject, type SkillSourceSnapshot } from "./ResourceImportSourceScanner";
import { getAppLogger } from "../logging/sharedLogger";

// Keep the helpers available to the existing focused tests and to other main-process callers.
export { normalizeSkillName, parseSkillFrontmatter } from "./skillImport";

/**
 * Coordinates external-resource scans and applies opaque, short-lived selections.
 * External source traversal lives in ResourceImportSourceScanner so this class remains
 * an IPC/domain orchestration boundary rather than a second resource implementation.
 */
export class ResourceImportManager {
	private readonly sourceScanner: ResourceImportSourceScanner;
	private readonly scans = new Map<
		string,
		{
			expiresAt: number;
			input: ResourceImportScanInput;
			candidates: StoredResourceImportCandidate[];
			mcpSourceSnapshots: McpSourceSnapshot[];
			skillSourceSnapshots: SkillSourceSnapshot[];
			result: ResourceImportScanResult;
		}
	>();

	constructor(
		private readonly configManager: ConfigManager,
		private readonly skillManager: SkillManager,
		private readonly projectResourceManager: ProjectResourceManager,
		private readonly getProject: (id: string) => ResourceImportProject | undefined,
		private readonly isTrusted: (projectId: string, root: string) => Promise<boolean>,
		private readonly onReport?: (report: Pick<ResourceImportReport, "kind" | "imported" | "skipped" | "failed">) => void,
	) {
		this.sourceScanner = new ResourceImportSourceScanner(configManager, projectResourceManager, getProject);
	}

	async scan(input: ResourceImportScanInput): Promise<ResourceImportScanResult> {
		this.validateInput(input);
		this.pruneExpiredScans();
		if (input.target.scope === "project") await this.assertProjectTarget(input.target);
		const candidates = await this.sourceScanner.scan(input);
		const existing = input.kind === "mcp" ? await this.existingMcpNames(input.target) : await this.existingSkillNames(input.target);
		this.markConflicts(candidates.stored, existing);
		const result: ResourceImportScanResult = {
			scanId: randomUUID(),
			kind: input.kind,
			target: input.target,
			sources: this.sourceScanner.publicSourceStatuses(candidates.sources),
			candidates: this.sourceScanner.publicCandidates(input.kind, candidates.stored),
		};
		this.scans.set(result.scanId, {
			expiresAt: Date.now() + SCAN_TTL_MS,
			input,
			candidates: candidates.stored,
			mcpSourceSnapshots: candidates.mcpSourceSnapshots,
			skillSourceSnapshots: candidates.skillSourceSnapshots,
			result,
		});
		return result;
	}

	async apply(input: ResourceImportApplyInput): Promise<ResourceImportReport> {
		this.validateApplyInput(input);
		const scan = this.scans.get(input.scanId);
		if (!scan || scan.expiresAt < Date.now()) {
			this.scans.delete(input.scanId);
			throw new Error("Import scan expired. Please scan again.");
		}
		this.validateTarget(input.target, scan.input.kind);
		if (targetKey(scan.input.target) !== targetKey(input.target)) {
			// A scan is bound to the target that was shown in the dialog.  Discard it on a
			// mismatch so a caller cannot retry the same candidate set against another path.
			this.scans.delete(input.scanId);
			throw new Error("Import target changed. Please scan again.");
		}
		// Trust can be revoked while the user reviews candidates. Re-authorize the
		// selected project immediately before any freshness checks or writes so a
		// previously valid scan never grants a stale project-write capability.
		if (input.target.scope === "project") await this.assertProjectTarget(input.target);

		const byId = new Map(scan.candidates.map((candidate) => [candidate.candidateId, candidate]));
		const selected: StoredResourceImportCandidate[] = [];
		for (const candidateId of input.candidateIds) {
			const candidate = byId.get(candidateId);
			if (!candidate || selected.some((item) => item.candidateId === candidateId)) throw new Error("Invalid import candidate.");
			selected.push(candidate);
		}
		// A scan is a one-shot authorization token. Consume it before the first await so
		// two concurrent/replayed apply calls cannot both pass validation and race their
		// read-modify-write operations against the same target configuration.
		this.scans.delete(input.scanId);
		await this.sourceScanner.assertFresh(scan.input.kind, scan.candidates, scan.input.sourceProjectId, scan.mcpSourceSnapshots, scan.skillSourceSnapshots);

		const results: ResourceImportReport["results"] = [];
		try {
			for (const candidate of selected) {
				if (!candidate.importable || candidate.conflict) {
					results.push({
						candidateId: candidate.candidateId,
						name: redactSensitiveText(candidate.name),
						status: "skipped",
						reason: candidate.conflict ? "Target already contains this resource." : redactSensitiveText(candidate.blockers.join("; ") || "Resource cannot be imported."),
					});
					continue;
				}
				try {
					if (scan.input.kind === "mcp") await this.applyMcp(candidate, input.target);
					else await this.applySkill(candidate, input.target);
					// 批量导入把外部资源写进用户配置/技能目录，属持久状态变更，逐条留痕
					getAppLogger()?.info("resource-import", "Resource imported", { kind: scan.input.kind, name: redactSensitiveText(candidate.name), source: candidate.sourcePath, target: targetKey(input.target) });
					results.push({
						candidateId: candidate.candidateId,
						name: redactSensitiveText(candidate.name),
						status: "imported",
						warnings: candidate.warnings.map((warning) => redactSensitiveText(warning)),
					});
				} catch (error) {
					results.push({
						candidateId: candidate.candidateId,
						name: redactSensitiveText(candidate.name),
						status: isConflictError(error) ? "skipped" : "failed",
						reason: redactSensitiveText(safeMessage(error, "Resource import failed.")),
					});
				}
			}
		} finally {
			// The scan was consumed before freshness checks; keep this block explicit so
			// future control-flow changes cannot accidentally make a scan reusable.
			this.scans.delete(input.scanId);
		}

		const report: ResourceImportReport = {
			scanId: input.scanId,
			kind: scan.input.kind,
			results,
			imported: results.filter((item) => item.status === "imported").length,
			skipped: results.filter((item) => item.status === "skipped").length,
			failed: results.filter((item) => item.status === "failed").length,
		};
		try {
			this.onReport?.(report);
		} catch {
			// Audit logging must never turn a completed import into an IPC failure.
		}
		return report;
	}

	private pruneExpiredScans(): void {
		const now = Date.now();
		for (const [scanId, scan] of this.scans) if (scan.expiresAt < now) this.scans.delete(scanId);
	}

	private validateApplyInput(input: ResourceImportApplyInput): void {
		if (!isRecord(input) || Object.keys(input).some((key) => !["scanId", "target", "candidateIds"].includes(key)) || typeof input.scanId !== "string" || input.scanId.length < 8 || input.scanId.length > 128) throw new Error("Invalid resource import input.");
		if (!Array.isArray(input.candidateIds) || input.candidateIds.length > 1000 || !input.candidateIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) throw new Error("Invalid resource import candidate ids.");
		if (!isRecord(input.target)) throw new Error("Invalid resource import target.");
	}

	private validateInput(input: ResourceImportScanInput): void {
		if (!isRecord(input) || Object.keys(input).some((key) => !["kind", "sourceProjectId", "target"].includes(key)) || (input.kind !== "mcp" && input.kind !== "skill") || !input.target) throw new Error("Invalid resource import input.");
		this.validateTarget(input.target, input.kind);
		if (input.sourceProjectId !== undefined) {
			if (typeof input.sourceProjectId !== "string" || !input.sourceProjectId.trim() || input.sourceProjectId.length > 256) throw new Error("Invalid source project id.");
			if (!this.getProject(input.sourceProjectId)) throw new Error("Source project is not registered.");
		}
	}

	private validateTarget(target: ResourceImportTarget, kind: "mcp" | "skill"): void {
		if (!isRecord(target) || (target.scope !== "global" && target.scope !== "project")) throw new Error("Invalid resource import target.");
		const allowed = target.scope === "global" ? ["scope", "locationId"] : ["scope", "projectId", "locationId"];
		if (Object.keys(target).some((key) => !allowed.includes(key))) throw new Error("Invalid resource import target.");
		if (kind === "mcp") {
			if (target.scope === "global" && target.locationId !== "pi-global") throw new Error("Invalid MCP target.");
			if (target.scope === "project" && target.locationId !== "project-pi") throw new Error("Invalid MCP target.");
		} else {
			if (target.scope === "global" && target.locationId !== "pi-global" && target.locationId !== "agents-global") throw new Error("Invalid skill target.");
			if (target.scope === "project" && target.locationId !== "project-pi" && target.locationId !== "project-agents") throw new Error("Invalid skill target.");
		}
		if (target.scope === "project" && (typeof target.projectId !== "string" || !target.projectId.trim() || target.projectId.length > 256)) throw new Error("Invalid project id.");
	}

	private async assertProjectTarget(target: Extract<ResourceImportTarget, { scope: "project" }>): Promise<string> {
		const project = this.getProject(target.projectId);
		if (!project || project.kind === "chat") throw new Error("Project is not available for resource import.");
		const root = await this.projectResourceManager.resolveProjectRoot(target.projectId);
		if (!(await this.isTrusted(target.projectId, root))) throw new Error("Project is not trusted.");
		return root;
	}

	private markConflicts(candidates: StoredResourceImportCandidate[], existing: Set<string>): void {
		const groups = new Map<string, StoredResourceImportCandidate[]>();
		for (const candidate of candidates) {
			const key = candidate.targetName.toLowerCase();
			candidate.conflict = Boolean(key) && existing.has(key);
			if (!key || candidate.conflict) continue;
			const group = groups.get(key) ?? [];
			group.push(candidate);
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			if (group.length > 1) {
				const sources = [...new Set(group.map((candidate) => candidate.sourceLabel))].join(", ");
				const warning = sources ? `Duplicate name in this scan (${sources}); only one candidate can be imported.` : "A duplicate name exists in this scan; only one candidate can be imported.";
				// Keep the warning on the winner too, so the dialog explains why another
				// source with the same normalized name is not selectable.
				for (const candidate of group) addUnique(candidate.warnings, warning);
			}
			const winner = group.find((candidate) => candidate.importable) ?? group[0];
			for (const candidate of group) {
				if (candidate === winner) continue;
				candidate.conflict = true;
			}
		}
	}

	private async existingMcpNames(target: ResourceImportTarget): Promise<Set<string>> {
		if (target.scope === "global") {
			const snapshot = await this.configManager.getMcpConfig();
			if (snapshot.writableError) throw new Error("PiDeck MCP configuration is invalid; repair it before importing.");
			// `servers` is the effective merged view and includes read-only Claude/Codex
			// layers.  Conflict detection for a PiDeck target must inspect only the
			// writable ~/.pi/agent/mcp.json layer; otherwise importing an external entry
			// with the same name would be incorrectly disabled.
			return new Set(Object.keys(snapshot.writableFile?.mcpServers ?? {}).map((name) => name.toLowerCase()));
		}
		const file = await this.readProjectMcpConfig(target.projectId);
		return new Set(Object.keys(file.mcpServers ?? {}).map((name) => name.toLowerCase()));
	}

	private async readProjectMcpConfig(projectId: string): Promise<McpConfigFile> {
		const reader = this.projectResourceManager.readProjectMcpConfig;
		if (typeof reader === "function") return reader.call(this.projectResourceManager, projectId);
		// Production always supplies ProjectResourceManager's reader.  Keep this branch
		// only for narrow legacy/test doubles, but retain the same canonical project
		// boundary guarantees: a missing file is empty, while a link/reparse point is
		// never followed just because the full manager was not injected.
		const root = await this.projectResourceManager.resolveProjectRoot(projectId);
		const boundary = await createProjectFileReadBoundary(root);
		const lexicalPath = join(root, ".pi", "mcp.json");
		let raw = "{}";
		try {
			const safePath = await resolveProjectFileReadPath(boundary, lexicalPath);
			raw = await readFile(safePath, "utf8");
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw new Error("Project path is outside boundary.");
			// Check every existing parent even when the optional file is absent.
			await resolveProjectFileWritePath(boundary, lexicalPath);
		}
		const parsed = parseMcpConfigFile(raw);
		if (parsed.error) throw new Error(parsed.error);
		return parsed.file;
	}

	private async applyMcp(candidate: StoredResourceImportCandidate, target: ResourceImportTarget): Promise<void> {
		if (!candidate.mcpDefinition) throw new Error("MCP definition unavailable.");
		if (target.scope === "global") {
			const snapshot = await this.configManager.getMcpConfig();
			if (snapshot.writableError) throw new Error("PiDeck MCP configuration is invalid; repair it before importing.");
			if (Object.keys(snapshot.writableFile?.mcpServers ?? {}).some((name) => name.toLowerCase() === candidate.targetName.toLowerCase())) throw new ResourceImportConflictError("Target already contains this MCP server.");
			const writableFile = snapshot.writableFile ?? { mcpServers: {} };
			const file: McpConfigFile = {
				...writableFile,
				mcpServers: { ...(writableFile.mcpServers ?? {}), [candidate.targetName]: candidate.mcpDefinition },
			};
			const validationError = validateMcpConfigFile(file);
			if (validationError) throw new Error(validationError);
			const saved = await this.configManager.saveMcpConfig(file);
			if (!saved.valid) throw new Error(saved.error ?? "MCP config could not be saved.");
			return;
		}
		await this.assertProjectTarget(target);
		const file = await this.readProjectMcpConfig(target.projectId);
		if (Object.keys(file.mcpServers ?? {}).some((name) => name.toLowerCase() === candidate.targetName.toLowerCase())) throw new ResourceImportConflictError("Target already contains this MCP server.");
		file.mcpServers = { ...(file.mcpServers ?? {}), [candidate.targetName]: candidate.mcpDefinition };
		const validationError = validateMcpConfigFile(file);
		if (validationError) throw new Error(validationError);
		const writer = this.projectResourceManager.saveProjectMcpConfig;
		if (typeof writer === "function") {
			await writer.call(this.projectResourceManager, target.projectId, file);
			return;
		}
		// Compatibility fallback for old test doubles.  It deliberately mirrors the
		// project manager's boundary checks instead of writing through a lexical path.
		const root = await this.assertProjectTarget(target);
		const boundary = await createProjectFileReadBoundary(root);
		const lexicalPath = join(root, ".pi", "mcp.json");
		const initialPath = await resolveProjectFileWritePath(boundary, lexicalPath);
		await mkdir(dirname(initialPath), { recursive: true });
		const safePath = await resolveProjectFileWritePath(boundary, lexicalPath);
		const temporaryLexicalPath = join(dirname(lexicalPath), `.${randomUUID()}.mcp.tmp`);
		const temporaryPath = await resolveProjectFileWritePath(boundary, temporaryLexicalPath);
		try {
			await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			if ((await resolveProjectFileWritePath(boundary, lexicalPath)) !== safePath) {
				throw new Error("Project path is outside boundary.");
			}
			await rename(temporaryPath, safePath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}

	private async existingSkillNames(target: ResourceImportTarget): Promise<Set<string>> {
		if (target.scope === "global") {
			const location = this.skillManager.getLocations().find((item) => item.id === target.locationId);
			if (!location) return new Set<string>();
			// SkillManager validates the managed global root before it is used as an import
			// destination.  Reuse that check during scan so a symlink/junction target is
			// rejected before the dialog can offer candidates for an unsafe path.
			const resolver = this.skillManager.resolveImportLocationPath;
			const directory = typeof resolver === "function" ? await resolver.call(this.skillManager, target.locationId) : location.path;
			return this.readExistingSkillNames(directory, location.rootMarkdownEnabled);
		}
		await this.assertProjectTarget(target);
		const resolver = this.projectResourceManager.resolveResourceDirectory;
		const directory = typeof resolver === "function" ? await resolver.call(this.projectResourceManager, target.projectId, target.locationId) : join(await this.assertProjectTarget(target), target.locationId === "project-pi" ? ".pi/skills" : ".agents/skills");
		return this.readExistingSkillNames(directory, target.locationId === "project-pi");
	}

	/**
	 * Read occupancy for one selected target only.  SkillManager.list() is deliberately
	 * avoided here because it creates missing global directories; a scan/cancel must be
	 * read-only.  Immediate entries reserve their target names even when malformed, while
	 * nested directory skills and root markdown files contribute their frontmatter name.
	 */
	private async readExistingSkillNames(directory: string, rootMarkdownEnabled: boolean): Promise<Set<string>> {
		const names = new Set<string>();
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
		for (const entry of entries) {
			// A destination path cannot replace any existing entry, regardless of whether
			// that entry currently contains a valid SKILL.md.
			names.add(entry.name.toLowerCase());
			// The imported target is a normalized Pi skill name.  Reserve the normalized
			// form of existing directories too, otherwise a legacy folder such as
			// "My Skill" could sit beside a new "my-skill" directory and create an
			// ambiguous resource identity.
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const normalizedEntryName = normalizeSkillName(entry.name);
				if (normalizedEntryName) names.add(normalizedEntryName.toLowerCase());
			}
			if (rootMarkdownEnabled && entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				await this.addExistingSkillFileName(join(directory, entry.name), entry.name.slice(0, -3), names);
			}
		}
		const discovery = await findSkillDirs(directory);
		for (const dir of discovery.dirs) {
			const fallback = dir.split(/[\\/]/).pop() ?? "";
			await this.addExistingSkillFileName(join(dir, "SKILL.md"), fallback, names);
		}
		return names;
	}

	private async addExistingSkillFileName(filePath: string, fallback: string, names: Set<string>): Promise<void> {
		try {
			const entry = await lstat(filePath);
			if (!entry.isFile() || entry.size > MAX_FILE_BYTES) return;
			const frontmatter = parseSkillFrontmatter(await readFile(filePath, "utf8"));
			const name = normalizeSkillName(frontmatter.name || fallback);
			if (name) names.add(name.toLowerCase());
		} catch {
			// Occupancy discovery is best effort; apply re-checks the target atomically.
		}
	}

	private async applySkill(candidate: StoredResourceImportCandidate, target: ResourceImportTarget): Promise<void> {
		const existing = await this.existingSkillNames(target);
		if (existing.has(candidate.targetName.toLowerCase())) throw new ResourceImportConflictError("Target already contains this skill.");
		if (target.scope === "global") {
			const importer = this.skillManager.importSkillDirectory;
			if (typeof importer === "function") {
				await importer.call(this.skillManager, target.locationId, candidate.sourcePath, candidate.targetName);
				return;
			}
			const location = this.skillManager.getLocations().find((item) => item.id === target.locationId);
			if (!location) throw new Error("Skill target is unavailable.");
			await copySkillDirectoryAtomic(location.path, candidate.sourcePath, candidate.targetName);
			return;
		}
		await this.assertProjectTarget(target);
		const importer = this.projectResourceManager.importSkillDirectory;
		if (typeof importer === "function") {
			await importer.call(this.projectResourceManager, target.projectId, target.locationId, candidate.sourcePath, candidate.targetName);
			return;
		}
		const root = await this.assertProjectTarget(target);
		await copySkillDirectoryAtomic(join(root, target.locationId === "project-pi" ? ".pi/skills" : ".agents/skills"), candidate.sourcePath, candidate.targetName);
	}
}
