import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile, rm, cp, lstat, stat } from "node:fs/promises";
import { dirname, join, relative, sep, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, resolveProjectFileWritePath, type ProjectFileReadBoundary } from "../files/projectFileAccess";
import { trashPath } from "../fs/trash";
import type { CreateProjectSkillInput, PiExtensionSummary, PiPromptTemplateSummary, PiSkillLocation, PiSkillSummary, Project, ProjectInheritedResourceToggleInput, ProjectResourceDirectoryKind, ProjectResourceListResult, ProjectResourceOverrides } from "../../shared/types";
import type { McpConfigFile } from "../../shared/types/mcp";
import { parseMcpConfigFile, validateMcpConfigFile } from "../config/mcpConfig";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { emptyProjectResourceOverrides, projectResourceOverridesFromRecord, setProjectInheritedResourceEnabled } from "./projectResourceOverrides";
import { discoverExtensionEntries } from "../extensions/extensionDiscovery";

const SKILL_FILE = "SKILL.md";
const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMPORT_MAX_TREE_BYTES = 50 * 1024 * 1024;
const IMPORT_MAX_DEPTH = 32;

type ImportTreeState = { totalBytes: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(value: unknown, code: string): boolean {
	return isRecord(value) && value.code === code;
}

/** Validate project settings before any resource mutation so malformed JSON is never overwritten. */
async function readProjectSettingsForWrite(settingsFile: string, invalidJsonMessage: string): Promise<Record<string, unknown>> {
	if (!existsSync(settingsFile)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		throw new Error(invalidJsonMessage);
	}
	if (!isRecord(parsed)) throw new Error(invalidJsonMessage);
	return parsed;
}

type ProjectProvider = (projectId: string) => Project | undefined;
type ProjectPathResolver = (project: Project) => string;
type ProjectResourceCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
type ProjectResourceDiscoveryDependencies = {
	getProjectTrustDecision?: (project: Project) => Promise<boolean | null>;
	getGlobalDisabledResourceNames?: () => { skills: string[]; prompts: string[] };
};

/**
 * 管理单个项目目录内的 pi 资源。
 * 仅扫描/删除项目目录下的 .pi/.agents 资源，避免把全局 skill/extension 混入项目级弹框。
 */
export class ProjectResourceManager {
	constructor(
		private readonly getProject: ProjectProvider,
		private readonly translate: ProjectResourceCopy = () => "Project resource operation failed.",
		private readonly resolveProjectPath: ProjectPathResolver = (project) => project.path,
		private readonly discoveryDependencies: ProjectResourceDiscoveryDependencies = {},
	) {}

	/** Windows fs 边界使用主机路径；store 里的 WSL Linux 路径在此转换。 */
	private projectRoot(project: Project): string {
		return this.resolveProjectPath(project);
	}

	/** Resolve a renderer-supplied stable id through the registered project catalog. */
	getProjectRoot(projectId: string): string {
		return this.projectRoot(this.requireProject(projectId));
	}

	/**
	 * Resolve the registered project root through the canonical boundary used by all project writes.
	 * Store installs use this instead of trusting a renderer-supplied path or a symlink alias.
	 */
	async resolveProjectRoot(projectId: string): Promise<string> {
		return (await this.projectBoundary(this.requireProject(projectId))).canonicalRoot;
	}

	async list(projectId: string): Promise<ProjectResourceListResult> {
		const project = this.getProject(projectId);
		if (!project) throw new Error(this.translate("project.notFound"));
		// chat 项目没有 .pi/.agents 资源目录，浏览性质从来不适用：list 是纯只读，
		// 返回空列表而非抛错（抛错会让前端技能面板连同全局技能一起整体失败）。
		// 写入操作（createSkill/delete/toggle/rename）仍由 requireProject 拒绝。
		if (project.kind === "chat") {
			return {
				skills: [],
				extensions: [],
				skillLocations: [],
				overrides: emptyProjectResourceOverrides(),
			};
		}
		const settings = await this.readProjectSettings(project);
		const [skills, extensions] = await Promise.all([this.listSkills(project, settings), this.listExtensions(project, settings)]);
		return {
			skills,
			extensions,
			skillLocations: this.skillLocations(project),
			overrides: projectResourceOverridesFromRecord(settings),
		};
	}

	/** Ensure a user-selected project resource directory exists inside the registered root. */
	/** Import a store skill into the pi 0.85 project-local .pi/skills directory. */
	async importSkillFromStore(projectId: string, input: { name: string; description: string; content: string }): Promise<PiSkillSummary> {
		const project = this.requireProject(projectId);
		const normalizedName = this.normalizeSkillName(input.name);
		if (!normalizedName) throw new Error(this.translate("mainSkill.nameRequired"));
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainSkill.descriptionRequired"));

		const boundary = await this.projectBoundary(project);
		const lexicalPath = join(this.projectRoot(project), ".pi", "skills", normalizedName, SKILL_FILE);
		const filePath = await this.resolveProjectWritePath(project, lexicalPath);
		if (existsSync(filePath)) {
			throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: normalizedName }));
		}
		await mkdir(dirname(filePath), { recursive: true });
		const safeDescription = description.replace(/[\r\n]+/g, " ");
		const safeContent = `---\nname: ${normalizedName}\ndescription: ${safeDescription}\nsource: prompts.chat\n---\n\n${input.content}`;
		await writeFile(filePath, safeContent, "utf8");
		const safePath = await resolveProjectFileReadPath(boundary, filePath);
		const location = this.skillLocations(project).find((candidate) => candidate.id === "project-pi");
		if (!location) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		return this.readSkill(safePath, location, "directory");
	}

	async ensureResourceDirectory(projectId: string, kind: ProjectResourceDirectoryKind): Promise<string> {
		const project = this.requireProject(projectId);
		const location = kind === "prompts" ? join(this.projectRoot(project), ".pi", "prompts") : this.skillLocations(project).find((candidate) => candidate.id === kind)?.path;
		if (!location) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		const safeDirectory = await this.resolveProjectWritePath(project, location);
		await mkdir(safeDirectory, { recursive: true });
		return this.resolveExistingProjectPath(project, safeDirectory);
	}

	/**
	 * Resolve a project-owned resource directory without creating it.
	 *
	 * Import scanning uses this method to inspect occupancy while keeping scans read-only.
	 * The returned path is resolved through the same canonical boundary as every project
	 * mutation, so a missing directory still inherits the real, registered project root.
	 */
	async resolveResourceDirectory(projectId: string, kind: Exclude<ProjectResourceDirectoryKind, "prompts">): Promise<string> {
		const project = this.requireProject(projectId);
		const location = this.skillLocations(project).find((candidate) => candidate.id === kind)?.path;
		if (!location) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		return this.resolveProjectWritePath(project, location);
	}

	/**
	 * Read the project-owned `.pi/mcp.json` through the project boundary.
	 * A missing file is an empty configuration; malformed JSON/configuration is an error
	 * so an import can never replace a file the user may need to repair manually.
	 */
	async readProjectMcpConfig(projectId: string): Promise<McpConfigFile> {
		const project = this.requireProject(projectId);
		const lexicalPath = join(this.projectRoot(project), ".pi", "mcp.json");
		const entry = await lstat(lexicalPath).catch((error: unknown) => {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		});
		if (!entry) {
			// A missing optional config is normally an empty writable layer.  Still resolve
			// its nearest existing parent before returning: otherwise an escaping `.pi`
			// junction could look like a harmless absent file during scan and only fail after
			// the user has selected entries for import.
			await this.resolveProjectWritePath(project, lexicalPath);
			return {};
		}

		const safePath = await this.resolveExistingProjectPath(project, lexicalPath);
		const parsed = parseMcpConfigFile(await readFile(safePath, "utf8"));
		if (parsed.error) throw new Error(parsed.error);
		const validationError = validateMcpConfigFile(parsed.file);
		if (validationError) throw new Error(validationError);
		return parsed.file;
	}

	/**
	 * Atomically replace the project-owned `.pi/mcp.json` after boundary and schema checks.
	 * The temporary file lives beside the destination and is always cleaned up on failure.
	 */
	async saveProjectMcpConfig(projectId: string, file: McpConfigFile): Promise<void> {
		const project = this.requireProject(projectId);
		const validationError = validateMcpConfigFile(file);
		if (validationError) throw new Error(validationError);

		const boundary = await this.projectBoundary(project);
		const lexicalPath = join(this.projectRoot(project), ".pi", "mcp.json");
		const safePath = await this.resolveProjectWritePath(project, lexicalPath);
		await mkdir(dirname(safePath), { recursive: true });

		// Resolve the temporary name after creating the parent. This closes the gap where a
		// newly-created `.pi` directory could otherwise be replaced by a symlink between
		// boundary resolution and the write.
		const temporaryLexicalPath = join(dirname(safePath), `.${basename(safePath)}.${randomUUID()}.tmp`);
		const temporaryPath = await resolveProjectFileWritePath(boundary, temporaryLexicalPath);
		try {
			await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			// The final destination is resolved again after the staging write.  A project
			// directory can be swapped for a link/junction while the temporary file is being
			// written; rename must use a freshly-bound, still-canonical target rather than
			// the path accepted before that asynchronous work began.
			const latestPath = await resolveProjectFileWritePath(boundary, lexicalPath);
			if (latestPath !== safePath) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
			await rename(temporaryPath, latestPath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}

	/**
	 * Copy a complete external skill directory into a project-local target.
	 * This API is intentionally not exposed through IPC; the import manager supplies the
	 * source path from its short-lived, validated scan session.
	 */
	async importSkillDirectory(projectId: string, locationId: Exclude<ProjectResourceDirectoryKind, "prompts">, sourceDirectory: string, targetName: string): Promise<void> {
		const project = this.requireProject(projectId);
		if (!targetName || targetName !== targetName.trim() || targetName.toLowerCase() !== targetName || targetName.length > 64 || !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,63})$/u.test(targetName)) {
			throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		}
		await this.assertImportSkillTree(sourceDirectory);

		const boundary = await this.projectBoundary(project);
		const lexicalRoot = this.skillLocations(project).find((candidate) => candidate.id === locationId)?.path;
		if (!lexicalRoot) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		const safeRoot = await resolveProjectFileWritePath(boundary, lexicalRoot);
		const initialTarget = join(safeRoot, targetName);
		const occupied = existsSync(safeRoot) && (await readdir(safeRoot, { withFileTypes: true }).catch(() => [])).some((entry) => entry.name.toLowerCase() === targetName.toLowerCase() || this.normalizeSkillName(entry.name) === targetName);
		if (occupied || existsSync(initialTarget)) {
			throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: targetName }));
		}
		await mkdir(safeRoot, { recursive: true });
		// Re-resolve after creating the parent.  A project-local reparse point could be
		// swapped while the directory was being created; the canonical boundary must be
		// applied to the temporary file and final destination immediately before copying.
		const stableRoot = await resolveProjectFileWritePath(boundary, lexicalRoot);
		const stableTarget = await resolveProjectFileWritePath(boundary, join(lexicalRoot, targetName));
		const stableOccupied = (await readdir(stableRoot, { withFileTypes: true }).catch(() => [])).some((entry) => entry.name.toLowerCase() === targetName.toLowerCase() || this.normalizeSkillName(entry.name) === targetName);
		if (stableOccupied || existsSync(stableTarget)) {
			throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: targetName }));
		}
		const temporaryLexical = join(stableRoot, `.${targetName}.${randomUUID()}.tmp`);
		const temporaryPath = await resolveProjectFileWritePath(boundary, temporaryLexical);
		const assertTargetAbsent = async (): Promise<void> => {
			const entry = await lstat(stableTarget).catch((error: unknown) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			if (entry) throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: targetName }));
		};
		try {
			await assertTargetAbsent();
			await cp(sourceDirectory, temporaryPath, {
				recursive: true,
				errorOnExist: true,
				force: false,
				verbatimSymlinks: true,
			});
			await this.assertImportSkillTree(temporaryPath);
			// The source copy can take long enough for a project-local directory to be
			// replaced by a junction. Re-resolve both paths immediately before rename so
			// the final mutation still targets the registered project's canonical tree.
			if ((await resolveProjectFileReadPath(boundary, temporaryPath)) !== temporaryPath) {
				throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
			}
			if ((await resolveProjectFileWritePath(boundary, lexicalRoot)) !== stableRoot) {
				throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
			}
			if ((await resolveProjectFileWritePath(boundary, join(lexicalRoot, targetName))) !== stableTarget) {
				throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
			}
			await assertTargetAbsent();
			await rename(temporaryPath, stableTarget);
		} finally {
			await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async assertImportSkillTree(root: string, depth = 0, state: ImportTreeState = { totalBytes: 0 }): Promise<void> {
		if (depth > IMPORT_MAX_DEPTH) throw new Error("Skill directory is too deep.");
		const rootEntry = await lstat(root);
		if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
			throw new Error("Skill source must be a directory without symbolic links.");
		}
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) throw new Error("Skill contains a symbolic link and cannot be imported.");
			const fullPath = join(root, entry.name);
			if (entry.isDirectory()) {
				await this.assertImportSkillTree(fullPath, depth + 1, state);
				continue;
			}
			if (!entry.isFile()) throw new Error("Skill contains an unsupported file type.");
			const size = (await stat(fullPath)).size;
			if (size > IMPORT_MAX_FILE_BYTES) throw new Error("Skill file is too large.");
			state.totalBytes += size;
			if (state.totalBytes > IMPORT_MAX_TREE_BYTES) throw new Error("Skill directory is too large.");
		}
	}

	async createSkill(input: CreateProjectSkillInput): Promise<PiSkillSummary> {
		const project = this.requireProject(input.projectId);
		const locations = this.skillLocations(project);
		const location = locations.find((candidate) => candidate.id === input.locationId);
		if (!location) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		const normalizedName = this.normalizeSkillName(input.name);
		if (!normalizedName) throw new Error(this.translate("mainProjectResource.skillNameCharacters"));
		// 保留用户原始输入作为显示名；标准化名仅用于目录/文件路径，SKILL.md 内存原始名
		// 这样 readSkill/refresh 后 UI 展示的是用户输入的原始名称，不会被 normalizeSkillName 截断。
		const displayName = input.name.trim();
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainSkill.descriptionRequired"));

		const skillDir = await this.resolveProjectWritePath(project, join(location.path, normalizedName));
		if (existsSync(skillDir)) throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: normalizedName }));
		await mkdir(skillDir, { recursive: true });
		const skillPath = join(skillDir, SKILL_FILE);
		await writeFile(skillPath, `---\nname: ${displayName}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${displayName}\n\n## Usage\n\nReplace this section with your skill instructions.\nSee https://agentskills.io/specification for the SKILL.md format.\n`, "utf8");
		// 直接构造返回结果，避免 re-read 解析偏差
		const warnings = this.validateSkill(normalizedName, description);
		return {
			id: `${location.id}:${skillPath}`,
			name: displayName,
			description,
			path: skillPath,
			dir: skillDir,
			sourceId: location.id,
			sourceLabel: location.label,
			type: "directory",
			enabled: true,
			valid: warnings.length === 0,
			warnings,
		};
	}

	async deleteSkill(projectId: string, skillPath: string): Promise<void> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		const target = await this.resolveExistingProjectPath(project, skill.type === "directory" ? skill.dir : skill.path);
		// 目录型 skill 代表一个完整能力包；删除走系统回收站（可恢复），拒绝硬删。
		await trashPath(target, { source: "projects:delete-skill" });
	}

	async toggleSkill(projectId: string, skillPath: string, enabled: boolean): Promise<PiSkillSummary> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		const safeSkillPath = await this.resolveExistingProjectPath(project, skill.path);
		const settingsFile = await this.resolveProjectWritePath(project, join(this.projectRoot(project), ".pi", "settings.json"));
		const settings = await readProjectSettingsForWrite(settingsFile, this.translate("mainConfig.invalidJson"));
		const disabled = Array.isArray(settings.disabledSkills) ? settings.disabledSkills.filter((name): name is string => typeof name === "string") : [];
		const nameKey = skill.name.toLowerCase();
		const nextDisabled = disabled.filter((name) => name.toLowerCase() !== nameKey);
		if (!enabled) nextDisabled.push(skill.name);

		// PiDeck disabledSkills 是完全禁用；Pi 的 frontmatter 只控制模型能否自动调用。
		settings.disabledSkills = nextDisabled;
		await mkdir(dirname(settingsFile), { recursive: true });
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		// 重新读取文件，获取最新 frontmatter + 禁用列表状态
		return this.readSkill(safeSkillPath, this.skillLocations(project).find((l) => l.id === skill.sourceId) ?? this.skillLocations(project)[0], skill.type, new Set(nextDisabled.map((name) => name.toLowerCase())));
	}

	async toggleExtension(projectId: string, extensionPath: string, enabled: boolean): Promise<void> {
		const project = this.requireProject(projectId);
		const safeRequestedPath = await this.resolveExistingProjectPath(project, extensionPath);
		const extension = (await this.listExtensions(project)).find((item) => item.path === safeRequestedPath);
		if (!extension?.path) throw new Error(this.translate("mainProjectResource.extensionNotFound"));
		await this.resolveExistingProjectPath(project, extension.path);
		const settingsFile = await this.resolveProjectWritePath(project, join(this.projectRoot(project), ".pi", "settings.json"));
		const settings = await readProjectSettingsForWrite(settingsFile, this.translate("mainConfig.invalidJson"));
		const disabled = Array.isArray(settings.disabledExtensions) ? settings.disabledExtensions.filter((source): source is string => typeof source === "string") : [];
		if (enabled) {
			settings.disabledExtensions = disabled.filter((source) => source !== extension.source);
		} else if (!disabled.includes(extension.source)) {
			settings.disabledExtensions = [...disabled, extension.source];
		}
		await mkdir(dirname(settingsFile), { recursive: true });
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	}

	/** Writes an override for an inherited global resource without touching the global setting. */
	async toggleInheritedResource(input: ProjectInheritedResourceToggleInput): Promise<ProjectResourceOverrides> {
		const project = this.requireProject(input.projectId);
		const rawKey = input.key.trim();
		const validSkillKey = /^(?:pi-global|agents-global):[^\u0000\r\n]+$/.test(rawKey);
		const validPlainKey = rawKey.length > 0 && !/[\u0000\r\n]/.test(rawKey);
		const valid = rawKey.length <= 1024 && (input.kind === "skill" ? validSkillKey : validPlainKey);
		if (!valid) throw new Error(this.translate("mainProjectResource.invalidInheritedKey"));
		const key = input.kind === "extension" ? rawKey : rawKey.toLowerCase();
		const settingsFile = await this.resolveProjectWritePath(project, join(this.projectRoot(project), ".pi", "settings.json"));
		return setProjectInheritedResourceEnabled(settingsFile, input.kind, key, input.enabled, this.translate("mainConfig.invalidJson"));
	}

	async deleteExtension(projectId: string, extensionPath: string): Promise<void> {
		const project = this.requireProject(projectId);
		const safeRequestedPath = await this.resolveExistingProjectPath(project, extensionPath);
		const extension = (await this.listExtensions(project)).find((item) => item.path === safeRequestedPath);
		if (!extension?.path) throw new Error(this.translate("mainProjectResource.extensionNotFound"));
		const safePath = await this.resolveExistingProjectPath(project, extension.path);
		// 扩展目录删除走系统回收站（可恢复），拒绝硬删。
		await trashPath(safePath, { source: "projects:delete-extension" });
	}

	private async listSkills(project: Project, settings?: Record<string, unknown>): Promise<PiSkillSummary[]> {
		const effectiveSettings = settings ?? (await this.readProjectSettings(project));
		const disabledKeys = this.projectDisabledSkillKeys(effectiveSettings);
		const groups = await Promise.all(
			this.skillLocations(project).map(async (location) => {
				if (!existsSync(location.path)) return [];
				try {
					const boundary = await this.projectBoundary(project);
					const safePath = await resolveProjectFileReadPath(boundary, location.path);
					return this.scanSkillLocation({ ...location, path: safePath }, disabledKeys, boundary);
				} catch {
					return [];
				}
			}),
		);
		return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
	}

	private projectDisabledSkillKeys(settings: Record<string, unknown>): Set<string> {
		if (!Array.isArray(settings.disabledSkills)) return new Set();
		return new Set(settings.disabledSkills.filter((name): name is string => typeof name === "string").map((name) => name.toLowerCase()));
	}

	private async scanSkillLocation(location: PiSkillLocation, disabledKeys: Set<string>, boundary: ProjectFileReadBoundary): Promise<PiSkillSummary[]> {
		const entries = await readdir(location.path, { withFileTypes: true }).catch(() => []);
		const skills: PiSkillSummary[] = [];
		for (const entry of entries) {
			const fullPath = join(location.path, entry.name);
			if (entry.isDirectory()) {
				await this.collectDirectorySkills(fullPath, location, skills, disabledKeys, boundary);
			} else if (location.rootMarkdownEnabled && entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				try {
					const safeFile = await resolveProjectFileReadPath(boundary, fullPath);
					skills.push(await this.readSkill(safeFile, location, "markdown", disabledKeys));
				} catch {
					// A nested symlink cannot turn an in-project list operation into an external read.
				}
			}
		}
		return skills;
	}

	private async collectDirectorySkills(dir: string, location: PiSkillLocation, out: PiSkillSummary[], disabledKeys: Set<string>, boundary: ProjectFileReadBoundary) {
		const skillPath = join(dir, SKILL_FILE);
		if (existsSync(skillPath)) {
			try {
				const safeSkillPath = await resolveProjectFileReadPath(boundary, skillPath);
				out.push(await this.readSkill(safeSkillPath, location, "directory", disabledKeys));
			} catch {
				// Treat an external SKILL.md symlink as absent without reading its target.
			}
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await this.collectDirectorySkills(join(dir, entry.name), location, out, disabledKeys, boundary);
			}
		}
	}

	private async readSkill(skillPath: string, location: PiSkillLocation, type: PiSkillSummary["type"], disabledKeys: Set<string> = new Set()): Promise<PiSkillSummary> {
		const raw = await readFile(skillPath, "utf8").catch(() => "");
		const frontmatter = this.parseFrontmatter(raw);
		const name = String(frontmatter.name ?? "").trim();
		const description = String(frontmatter.description ?? "").trim();
		const warnings = this.validateSkill(name, description);
		return {
			id: `${location.id}:${skillPath}`,
			name: name || this.fallbackSkillName(skillPath, type) || this.translate("mainSkill.unnamed"),
			description,
			path: skillPath,
			dir: dirname(skillPath),
			sourceId: location.id,
			sourceLabel: location.label,
			type,
			// 项目禁用列表代表完全禁用；disable-model-invocation 是 Pi 的独立 user-only 状态。
			userOnly: frontmatter["disable-model-invocation"] === "true",
			enabled: !disabledKeys.has(name.toLowerCase()),
			valid: warnings.length === 0,
			warnings,
		};
	}

	private async listExtensions(project: Project, settings?: Record<string, unknown>): Promise<PiExtensionSummary[]> {
		const effectiveSettings = settings ?? (await this.readProjectSettings(project));
		const boundary = await this.projectBoundary(project);
		const lexicalExtensionsDir = join(this.projectRoot(project), ".pi", "extensions");
		let extensionsDir = lexicalExtensionsDir;
		if (existsSync(lexicalExtensionsDir)) {
			try {
				extensionsDir = await resolveProjectFileReadPath(boundary, lexicalExtensionsDir);
			} catch {
				return [];
			}
		}
		const disabledExts = new Set(Array.isArray(effectiveSettings.disabledExtensions) ? effectiveSettings.disabledExtensions.filter((source): source is string => typeof source === "string") : []);
		const roots = new Map<string, string>();
		for (const entryPath of discoverExtensionEntries(extensionsDir)) {
			const relativePath = relative(extensionsDir, entryPath);
			const source = relativePath.split(sep)[0];
			if (!source || source === "." || source === "..") continue;
			try {
				// Validate both the discovered entry and its top-level root so a project-local
				// symlink/junction cannot make the management list expose an external path.
				await resolveProjectFileReadPath(boundary, entryPath);
				const safeRoot = await resolveProjectFileReadPath(boundary, join(extensionsDir, source));
				roots.set(source, safeRoot);
			} catch {
				// Runtime discovery may see the entry, but management must not cross the project boundary.
			}
		}
		return [...roots.entries()]
			.map(([source, path]) => ({
				...this.toExtensionSummary(source, path),
				enabled: !disabledExts.has(source),
			}))
			.sort((a, b) => a.source.localeCompare(b.source));
	}

	private toExtensionSummary(name: string, path: string): PiExtensionSummary {
		return {
			id: `project:${path}`,
			source: name,
			path,
			scope: "project",
		};
	}

	/** Project-owned skills from the two local skill locations (managed directories only). */
	async listProjectSkills(projectId: string): Promise<PiSkillSummary[]> {
		const project = this.requireProject(projectId);
		if (project.kind === "chat") return [];
		return this.listSkills(project);
	}

	/** Project-owned extension files under <root>/.pi/extensions (managed directories only). */
	async listProjectExtensions(projectId: string): Promise<PiExtensionSummary[]> {
		const project = this.requireProject(projectId);
		if (project.kind === "chat") return [];
		return this.listExtensions(project);
	}

	/** Prompt summaries living under <root>/.pi/prompts (managed directory only). */
	async listProjectPrompts(projectId: string): Promise<PiPromptTemplateSummary[]> {
		const project = this.requireProject(projectId);
		if (project.kind === "chat") return [];
		const boundary = await this.projectBoundary(project);
		const lexicalPromptsDir = join(this.projectRoot(project), ".pi", "prompts");
		let promptsDir = lexicalPromptsDir;
		if (existsSync(lexicalPromptsDir)) {
			try {
				promptsDir = await resolveProjectFileReadPath(boundary, lexicalPromptsDir);
			} catch {
				return [];
			}
		}
		const entries = await readdir(promptsDir, { withFileTypes: true }).catch(() => []);
		const settings = await this.readProjectSettings(project);
		const disabledNames = new Set(Array.isArray(settings.disabledPrompts) ? settings.disabledPrompts.filter((name): name is string => typeof name === "string") : []);
		const templates: PiPromptTemplateSummary[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".d.md")) continue;
			let fullPath: string;
			try {
				fullPath = await resolveProjectFileReadPath(boundary, join(lexicalPromptsDir, entry.name));
			} catch {
				continue;
			}
			const raw = await readFile(fullPath, "utf8").catch(() => "");
			if (!raw) continue;
			const name = entry.name.slice(0, -3);
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";
			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^['"]|['"]$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "project",
				enabled: !disabledNames.has(name.toLowerCase()),
			});
		}
		return templates.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * 只读的运行时资源描述（packages、settings 显式路径、祖先 .agents/skills）。
	 * 与 pi 0.85 resolver 共用同一发现实现，让管理页能看到 pi 实际会加载的资源。
	 */
	async discovery(projectId?: string) {
		let cwd: string | undefined;
		let projectResourcesAllowed = false;
		let projectSettings: Record<string, unknown> = {};
		if (projectId) {
			const project = this.getProject(projectId);
			if (!project) throw new Error(this.translate("project.notFound"));
			if (project.kind !== "chat") {
				const trustDecision = await this.discoveryDependencies.getProjectTrustDecision?.(project);
				// Drafts have no session-scoped approval yet; only a remembered approval matches runtime discovery.
				projectResourcesAllowed = trustDecision === true;
				if (projectResourcesAllowed) {
					cwd = this.projectRoot(project);
					projectSettings = await this.readProjectSettings(project);
				}
			}
		}
		const includeProjectResources = projectResourcesAllowed;
		const globalDisabled = this.discoveryDependencies.getGlobalDisabledResourceNames?.() ?? { skills: [], prompts: [] };
		const disabledNames = (value: unknown) => (Array.isArray(value) ? value : []).filter((name): name is string => typeof name === "string");
		const overrides = projectResourceOverridesFromRecord(projectSettings);
		const { discoverSkills, discoverPrompts, discoverExtensions } = await import("../resourceDiscovery");
		return {
			projectResourcesAllowed,
			overrides,
			skills: discoverSkills({
				cwd,
				includeProjectResources,
				disabledSkillNames: globalDisabled.skills,
				disabledProjectSkillNames: disabledNames(projectSettings.disabledSkills),
			}),
			prompts: discoverPrompts({
				cwd,
				includeProjectResources,
				disabledPromptNames: globalDisabled.prompts,
				disabledProjectPromptNames: disabledNames(projectSettings.disabledPrompts),
				disabledGlobalPromptNames: overrides.disabledGlobalPrompts,
			}),
			extensions: discoverExtensions({ cwd, includeProjectResources }),
		};
	}

	private skillLocations(project: Project): PiSkillLocation[] {
		return [
			{
				id: "project-pi",
				label: ".pi/skills",
				path: join(this.projectRoot(project), ".pi", "skills"),
				rootMarkdownEnabled: true,
			},
			{
				id: "project-agents",
				label: ".agents/skills",
				path: join(this.projectRoot(project), ".agents", "skills"),
				rootMarkdownEnabled: false,
			},
		];
	}

	private requireProject(projectId: string) {
		const project = this.getProject(projectId);
		if (!project) throw new Error(this.translate("project.notFound"));
		if (project.kind === "chat") throw new Error(this.translate("mainProjectResource.chatUnsupported"));
		return project;
	}

	/** frontmatter 缺 name 时的回退名：markdown 取文件名（去扩展名），目录取目录名。
	 *  不能直接用 dirname().pop()——markdown 技能会显示成父目录名「skills」。 */
	private fallbackSkillName(skillPath: string, type: PiSkillSummary["type"]): string {
		return type === "markdown" ? basename(skillPath, extname(skillPath)) : basename(dirname(skillPath));
	}

	/** 重命名项目级 Skill：按类型分流——目录技能重命名技能目录，markdown 技能只重命名单个文件。
	 *  markdown 技能的 skill.dir 是技能根目录（<root>/.pi/skills），绝不能当重命名目标，
	 *  否则整个项目技能根目录会被改名搬走，其余技能全部消失（数据丢失事故）。 */
	async renameSkill(projectId: string, skillPath: string, newName: string): Promise<PiSkillSummary> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		const normalizedNew = this.normalizeSkillName(newName);
		if (!normalizedNew) throw new Error(this.translate("mainSkill.nameRequired"));

		const displayName = newName.trim();
		const safeSkillPath = await this.resolveExistingProjectPath(project, skill.path);
		const isDirectory = skill.type === "directory";
		const oldTarget = await this.resolveExistingProjectPath(project, isDirectory ? skill.dir : skill.path);
		const parentDir = dirname(oldTarget);
		const newTarget = await this.resolveProjectWritePath(project, isDirectory ? join(parentDir, normalizedNew) : join(parentDir, `${normalizedNew}${extname(oldTarget)}`));

		if (oldTarget === newTarget) throw new Error(this.translate("mainSkill.sameName"));
		if (existsSync(newTarget)) throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: normalizedNew }));

		// 先在旧位置读原文，rename 成功后再把 frontmatter 写到新位置：
		// 中途失败不会留下「frontmatter 已改名、文件/目录还在原地」的部分变更。
		const raw = await readFile(safeSkillPath, "utf8");
		await rename(oldTarget, newTarget);
		// 目录技能新路径拼 SKILL.md；markdown 技能新路径就是改名后的单文件本身
		const newSkillPath = isDirectory ? join(newTarget, SKILL_FILE) : newTarget;
		await writeFile(newSkillPath, this.setFrontmatterName(raw, displayName), "utf8");

		// 禁用列表同步迁移：旧名条目替换为新名，避免孤儿数据与白名单双源漂移
		await this.migrateDisabledSkillName(project, skill.name, displayName);

		// 重命名后按项目 settings 重新读取禁用态与 Pi user-only frontmatter。
		return this.findSkill(project, newSkillPath);
	}

	/** 重命名后同步项目 .pi/settings.json 的 disabledSkills：旧名条目替换为新名（大小写不敏感）。
	 *  旧名不在列表时不写文件，避免为未禁用技能凭空创建 settings。 */
	private async migrateDisabledSkillName(project: Project, oldName: string, newDisplayName: string): Promise<void> {
		const oldKey = oldName.toLowerCase();
		const newKey = newDisplayName.toLowerCase();
		if (oldKey === newKey) return;
		const settingsFile = await this.resolveProjectWritePath(project, join(this.projectRoot(project), ".pi", "settings.json"));
		const settings = await readProjectSettingsForWrite(settingsFile, this.translate("mainConfig.invalidJson"));
		const disabled = Array.isArray(settings.disabledSkills) ? settings.disabledSkills.filter((name): name is string => typeof name === "string") : [];
		if (!disabled.some((name) => name.toLowerCase() === oldKey)) return;
		const nextDisabled = disabled.filter((name) => name.toLowerCase() !== oldKey && name.toLowerCase() !== newKey);
		nextDisabled.push(newDisplayName);
		settings.disabledSkills = nextDisabled;
		await mkdir(dirname(settingsFile), { recursive: true });
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	}

	/** 更新 frontmatter 中的 name 字段；若原 frontmatter 缺 name: 则置顶补全 */
	private setFrontmatterName(raw: string, name: string): string {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return `---\nname: ${name}\n---\n\n${raw}`;
		const lines = match[1].split(/\r?\n/);
		let changed = false;
		const nextLines = lines.map((line) => {
			if (line.trim().startsWith("name:")) {
				changed = true;
				return `name: ${name}`;
			}
			return line;
		});
		if (!changed) nextLines.unshift(`name: ${name}`);
		return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
	}

	private async findSkill(project: Project, skillPath: string) {
		const safeRequestedPath = await this.resolveExistingProjectPath(project, skillPath);
		const skill = (await this.listSkills(project)).find((item) => item.path === safeRequestedPath);
		if (!skill) throw new Error(this.translate("mainProjectResource.skillNotFound"));
		return skill;
	}

	private async readProjectSettings(project: Project): Promise<Record<string, unknown>> {
		const settingsFile = join(this.projectRoot(project), ".pi", "settings.json");
		if (!existsSync(settingsFile)) return {};
		try {
			const safeSettingsFile = await resolveProjectFileReadPath(await this.projectBoundary(project), settingsFile);
			const parsed: unknown = JSON.parse(await readFile(safeSettingsFile, "utf8"));
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	private async projectBoundary(project: Project): Promise<ProjectFileReadBoundary> {
		try {
			return await createProjectFileReadBoundary(this.projectRoot(project));
		} catch {
			throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		}
	}

	private async resolveExistingProjectPath(project: Project, targetPath: string): Promise<string> {
		try {
			return await resolveProjectFileReadPath(await this.projectBoundary(project), targetPath);
		} catch {
			throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		}
	}

	private async resolveProjectWritePath(project: Project, targetPath: string): Promise<string> {
		try {
			return await resolveProjectFileWritePath(await this.projectBoundary(project), targetPath);
		} catch {
			throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		}
	}

	private parseFrontmatter(raw: string) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^[\'"]|[\'"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	private validateSkill(name: string, description: string) {
		const warnings: string[] = [];
		if (!name) warnings.push(this.translate("mainSkill.warningNameRequired"));
		if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
			warnings.push(this.translate("mainProjectResource.warningNameCharacters"));
		}
		if (name.length > 64) warnings.push(this.translate("mainSkill.warningNameTooLong"));
		if (!description) warnings.push(this.translate("mainSkill.warningDescriptionRequired"));
		if (description.length > 1024) warnings.push(this.translate("mainSkill.warningDescriptionTooLong"));
		return warnings;
	}

	private normalizeSkillName(value: string) {
		// Keep project-local imports/renames aligned with the global SkillManager and
		// the external-import scanner: Unicode letters/numbers are valid path components,
		// while punctuation collapses to a single dash and names are bounded for safe IPC.
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}-]+/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
		return normalized.slice(0, 64).replace(/-+$/g, "");
	}
}
