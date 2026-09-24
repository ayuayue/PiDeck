import { app, shell } from "electron";
import { existsSync, type Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { trashPath } from "../fs/trash";
import type { AppSettings, CreatePiSkillInput, PiSkillListResult, PiSkillLocation, PiSkillSummary } from "../../shared/types";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

const SKILL_FILE = "SKILL.md";
const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMPORT_MAX_TREE_BYTES = 50 * 1024 * 1024;
const IMPORT_MAX_DEPTH = 32;
const UNSAFE_IMPORT_TARGET = "Skill target is unavailable.";

type ImportTreeState = { totalBytes: number };

/**
 * Node errors can cross an Electron/vm realm boundary, where `instanceof Error`
 * is no longer reliable. File-system control flow only needs the stable errno code.
 */
function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

/**
 * Check containment for managed global skill paths without importing the file-tree
 * service.  SkillManager is also loaded in a small VM by legacy unit tests, so
 * keeping this boundary helper local avoids coupling that loader to a renderer-
 * unrelated filesystem module.  Global skill roots are host paths (including the
 * host-side WSL home), therefore resolve + platform-aware comparison is sufficient.
 */
function isManagedPathInside(root: string, target: string): boolean {
	const rootResolved = resolve(root);
	const targetResolved = resolve(target);
	const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	const normalizedRoot = normalize(rootResolved);
	const normalizedTarget = normalize(targetResolved);
	if (normalizedTarget === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith("\\") || normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`;
	return normalizedTarget.startsWith(prefix);
}

type SkillCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * 管理 pi 全局 Skill 目录。
 * 第一版仅操作全局目录，不触碰项目级 .pi/.agents skills，避免误删项目资产或绕过 trusted project 规则。
 */
export class SkillManager {
	private locations: PiSkillLocation[];
	/** Canonical user home used to constrain global import destinations. */
	private managedHome: string;
	/** PiDeck 设置的读取/写入（禁用列表持久化）；未配置时开关仅写 frontmatter（旧行为）。 */
	private settingsProvider: (() => AppSettings) | null = null;
	private settingsPatcher: ((patch: Partial<AppSettings>) => Promise<AppSettings>) | null = null;
	/**
	 * 内置技能覆盖层目录提供器（SkillStoreUpdater 热更新落盘目录）：
	 * 返回有效覆盖层时，安装模板优先读覆盖层里的 <name>/SKILL.md，实现技能修 bug/新增技能免发版。
	 */
	private skillOverlayProvider: (() => string | null) | null = null;

	constructor(
		home?: string,
		private readonly translate: SkillCopy = () => "Skill operation failed.",
	) {
		this.managedHome = home ?? homedir();
		this.locations = this.buildLocations(this.managedHome);
	}

	/** 注入内置技能覆盖层目录提供器（启动装配时由 SkillStoreUpdater 提供）。 */
	configureSkillOverlay(provider: () => string | null) {
		this.skillOverlayProvider = provider;
	}

	/** 注入 PiDeck 设置读写：启用后 toggle 同步持久化禁用列表（技能白名单模式的依据）。 */
	configureSettings(getSettings: () => AppSettings, patchSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>) {
		this.settingsProvider = getSettings;
		this.settingsPatcher = patchSettings;
	}

	/** 将 skill 目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.managedHome = environment?.windowsHome ?? homedir();
		this.locations = this.buildLocations(this.managedHome);
	}

	/** 当前全局技能位置副本（WSL 配置后为主机路径），供读内容 IPC 的白名单校验。 */
	getLocations(): PiSkillLocation[] {
		return this.locations.map((location) => ({ ...location }));
	}

	private buildLocations(home: string): PiSkillLocation[] {
		return [
			{
				id: "pi-global",
				label: "~/.pi/agent/skills",
				path: join(home, ".pi", "agent", "skills"),
				rootMarkdownEnabled: true,
			},
			{
				id: "agents-global",
				label: "~/.agents/skills",
				path: join(home, ".agents", "skills"),
				rootMarkdownEnabled: false,
			},
		];
	}

	async list(): Promise<PiSkillListResult> {
		const skills = (await Promise.all(this.locations.map((location) => this.scanLocation(location)))).flat();
		// 按 name 去重，优先保留 pi-global 目录下的条目
		// （避免 ~/.pi/agent/skills/ 和 ~/.agents/skills/ 不同步导致同名重复）
		const seen = new Map<string, PiSkillSummary>();
		for (const skill of skills) {
			const key = skill.name.toLowerCase();
			if (!seen.has(key) || (seen.get(key)!.sourceId !== "pi-global" && skill.sourceId === "pi-global")) {
				seen.set(key, skill);
			}
		}
		return { locations: this.locations, skills: Array.from(seen.values()) };
	}

	async create(input: CreatePiSkillInput): Promise<PiSkillSummary> {
		const location = this.requireLocation(input.locationId);
		const name = this.normalizeSkillName(input.name);
		const description = input.description.trim();
		if (!name) throw new Error(this.translate("mainSkill.nameRequiredDetailed"));
		if (!description) throw new Error(this.translate("mainSkill.descriptionRequired"));

		const skillDir = join(location.path, name);
		if (existsSync(skillDir)) throw new Error(this.translate("mainSkill.alreadyExists", { name }));
		await mkdir(skillDir, { recursive: true });
		const skillPath = join(skillDir, SKILL_FILE);
		await writeFile(skillPath, `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${name}\n\n## Usage\n\nDescribe when and how to use this skill.\n`, "utf8");
		return this.readSkill(skillPath, location, "directory");
	}

	/**
	 * Copy a complete external skill into one of PiDeck's managed global locations.
	 * The source path is supplied only by the main-process import scan cache; callers cannot
	 * provide it over IPC. The original SKILL.md and all companion assets remain byte-for-byte
	 * unchanged, and a temporary sibling directory prevents partial installs.
	 */
	async importSkillDirectory(locationId: "pi-global" | "agents-global", sourceDirectory: string, targetName: string): Promise<void> {
		const location = this.requireLocation(locationId);
		if (!targetName || this.normalizeSkillName(targetName) !== targetName || targetName.length > 64) {
			throw new Error(this.translate("mainSkill.nameRequiredDetailed"));
		}
		await this.assertImportSkillTree(sourceDirectory);

		// The global skill roots are user-managed directories, so an existing symlink or
		// junction must never be followed as a write target.  Resolve the nearest existing
		// ancestor before mkdir, then resolve again after mkdir to close the common swap gap.
		const initialRoot = await this.resolveManagedImportLocation(location);
		await mkdir(initialRoot, { recursive: true });
		const targetRoot = await this.resolveManagedImportLocation(location);

		const occupied = (await readdir(targetRoot, { withFileTypes: true }).catch(() => [])).some((entry) => entry.name.toLowerCase() === targetName.toLowerCase() || this.normalizeSkillName(entry.name) === targetName);
		if (occupied) throw new Error(this.translate("mainSkill.alreadyExists", { name: targetName }));

		const targetDirectory = join(targetRoot, targetName);
		const temporaryDirectory = join(targetRoot, `.${targetName}.${randomUUID()}.tmp`);
		const assertTargetAbsent = async (): Promise<void> => {
			const entry = await lstat(targetDirectory).catch((error: unknown) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			if (entry) throw new Error(this.translate("mainSkill.alreadyExists", { name: targetName }));
		};
		try {
			await assertTargetAbsent();
			await cp(sourceDirectory, temporaryDirectory, {
				recursive: true,
				errorOnExist: true,
				force: false,
				verbatimSymlinks: true,
			});
			// Re-check the copied tree as well as the source.  A source can change between
			// validation and cp; rejecting a link/special file in the temporary tree keeps
			// the managed destination free of unsafe entries.
			await this.assertImportSkillTree(temporaryDirectory);
			await assertTargetAbsent();
			if ((await this.resolveManagedImportLocation(location)) !== targetRoot) throw new Error(UNSAFE_IMPORT_TARGET);
			await rename(temporaryDirectory, targetDirectory);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Resolve a global skill root without following an escaping symlink/junction. */
	async resolveImportLocationPath(locationId: "pi-global" | "agents-global"): Promise<string> {
		return this.resolveManagedImportLocation(this.requireLocation(locationId));
	}

	private async resolveManagedImportLocation(location: PiSkillLocation): Promise<string> {
		const home = resolve(this.managedHome);
		const lexicalLocation = resolve(location.path);
		if (!isManagedPathInside(home, lexicalLocation)) throw new Error(UNSAFE_IMPORT_TARGET);

		let canonicalHome: string;
		try {
			canonicalHome = await realpath(home);
		} catch {
			throw new Error(UNSAFE_IMPORT_TARGET);
		}

		const existing = await lstat(lexicalLocation).catch((error: unknown) => {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		});
		if (existing) {
			if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(UNSAFE_IMPORT_TARGET);
			const canonicalLocation = await realpath(lexicalLocation).catch(() => null);
			if (!canonicalLocation || !isManagedPathInside(canonicalHome, canonicalLocation)) throw new Error(UNSAFE_IMPORT_TARGET);
			return canonicalLocation;
		}

		// The target may not exist yet.  Resolve its nearest existing parent and derive
		// the missing suffix from that canonical parent; this prevents a pre-existing
		// parent junction from redirecting mkdir outside the user home.
		let ancestor = dirname(lexicalLocation);
		while (true) {
			const ancestorEntry = await lstat(ancestor).catch((error: unknown) => {
				if (hasErrorCode(error, "ENOENT")) return null;
				throw error;
			});
			if (ancestorEntry) {
				// A redirected profile may itself contain a junction (for example OneDrive).
				// It is safe to retain an ancestor link when its canonical destination remains
				// under the managed home; the final location entry is still rejected if linked.
				if (!ancestorEntry.isSymbolicLink() && !ancestorEntry.isDirectory()) throw new Error(UNSAFE_IMPORT_TARGET);
				const canonicalAncestor = await realpath(ancestor).catch(() => null);
				if (!canonicalAncestor || !isManagedPathInside(canonicalHome, canonicalAncestor)) throw new Error(UNSAFE_IMPORT_TARGET);
				const candidate = resolve(canonicalAncestor, relative(ancestor, lexicalLocation));
				if (!isManagedPathInside(canonicalHome, candidate)) throw new Error(UNSAFE_IMPORT_TARGET);
				return candidate;
			}
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error(UNSAFE_IMPORT_TARGET);
			ancestor = parent;
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

	async toggle(skillPath: string, enabled: boolean): Promise<PiSkillSummary> {
		const skill = await this.findByPath(skillPath);
		// PiDeck enabled 只由其禁用列表控制。Pi 的 disable-model-invocation 仅阻止模型自动调用，
		// 用户仍可手动 /skill:name，因此作为独立 userOnly 状态展示。
		if (this.settingsProvider && this.settingsPatcher) {
			const current = this.settingsProvider().disabledSkills ?? [];
			const nameKey = skill.name.toLowerCase();
			const nextList = current.filter((name) => name.toLowerCase() !== nameKey);
			if (!enabled) nextList.push(skill.name);
			await this.settingsPatcher({ disabledSkills: nextList });
		}
		return this.findByPath(skill.path);
	}

	async delete(skillPath: string): Promise<void> {
		const skill = await this.findByPath(skillPath);
		// 目录型 skill 删除整个目录；根 markdown skill 仅删除单个 md 文件。
		// 用户 skill 是内容资产：走系统回收站（可恢复）并记审计日志，拒绝 rm 硬删。
		await trashPath(skill.type === "directory" ? skill.dir : skill.path, { source: "skills:delete" });
	}

	async openFolder(skillPath?: string): Promise<void> {
		if (!skillPath) {
			await mkdir(this.locations[0].path, { recursive: true });
			await shell.openPath(this.locations[0].path);
			return;
		}
		const skill = await this.findByPath(skillPath);
		await shell.openPath(skill.dir);
	}

	/**
	 * 把打包内置的「用量查询自定义」技能模板复制到全局技能目录
	 * （~/.pi/agent/skills/usage-probe/SKILL.md）。
	 *
	 * 为什么启动时自动安装：usage-probe 模板是 pideck 打包产物（resources/skills），
	 * 而 pi 加载 skill 只扫用户全局目录（~/.pi/agent/skills、~/.agents/skills），
	 * 不读 pideck 资源目录——必须落到用户技能目录，pi 才能发现并 /skill:usage-probe 触发。
	 * 幂等覆盖：模板随应用更新同步；用户自定义配置写在 usage-probes.json，不在此文件。
	 */
	/**
	 * 把打包内置的技能模板（resources/skills/<name>/SKILL.md）复制到用户全局技能目录。
	 * 为什么抽公共实现：内置技能不止一个（usage-probe、image-gen 等），复制逻辑完全一致，
	 * 只有技能名不同——单一 helper 避免每个技能重复一段一样的文件复制代码。
	 */
	private async installTemplate(skillName: string): Promise<{ success: true; path: string } | { success: false; error: string }> {
		try {
			// 覆盖层优先：热更新把有差异的技能写进 userData/skills-overlay（结构同
			// <builtin>/skills/<name>/SKILL.md），安装时读生效源，避免「更新成功但装旧模板」。
			const overlayDir = this.skillOverlayProvider?.() ?? null;
			const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
			const templatePath = overlayDir ? join(overlayDir, skillName, SKILL_FILE) : join(root, "skills", skillName, SKILL_FILE);
			const content = await readFile(templatePath, "utf8");
			const targetDir = join(this.locations[0].path, skillName);
			await mkdir(targetDir, { recursive: true });
			const targetPath = join(targetDir, SKILL_FILE);
			// 模板正文随应用更新同步；用户自行设置的 user-only 标记仍需保留。
			const previous = await readFile(targetPath, "utf8").catch(() => null);
			const wasUserOnly = previous !== null && this.parseFrontmatter(previous)["disable-model-invocation"] === "true";
			await writeFile(targetPath, content, "utf8");
			if (wasUserOnly) {
				await writeFile(targetPath, this.setFrontmatterBoolean(content, "disable-model-invocation", true), "utf8");
			}
			return { success: true, path: targetPath };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async installUsageProbeTemplate(): Promise<{ success: true; path: string } | { success: false; error: string }> {
		return this.installTemplate("usage-probe");
	}

	async installImageGenTemplate(): Promise<{ success: true; path: string } | { success: false; error: string }> {
		return this.installTemplate("image-gen");
	}

	/**
	 * 安装内置的「环境诊断」技能模板（resources/skills/pideck-doctor/SKILL.md）。
	 * 用户在问题反馈页生成诊断报告后，可让 pi 直接读报告分析排障（/skill:pideck-doctor）。
	 */
	async installPideckDoctorTemplate(): Promise<{ success: true; path: string } | { success: false; error: string }> {
		return this.installTemplate("pideck-doctor");
	}

	private async scanLocation(location: PiSkillLocation): Promise<PiSkillSummary[]> {
		await mkdir(location.path, { recursive: true });
		const entries = await readdir(location.path, { withFileTypes: true }).catch(() => []);
		const skills: PiSkillSummary[] = [];
		const ancestors = new Set<string>();
		const canonicalLocation = await realpath(location.path).catch(() => null);
		if (canonicalLocation) ancestors.add(canonicalLocation);
		for (const entry of entries) {
			const fullPath = join(location.path, entry.name);
			const kind = await this.getEntryKind(fullPath, entry);
			if (kind === "directory") {
				await this.collectDirectorySkills(fullPath, location, skills, ancestors);
			} else if (location.rootMarkdownEnabled && kind === "file" && entry.name.toLowerCase().endsWith(".md")) {
				skills.push(await this.readSkill(fullPath, location, "markdown"));
			}
		}
		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async getEntryKind(fullPath: string, entry: Dirent): Promise<"directory" | "file" | "other"> {
		if (entry.isDirectory()) return "directory";
		if (entry.isFile()) return "file";
		if (!entry.isSymbolicLink()) return "other";

		const target = await stat(fullPath).catch(() => null);
		if (!target) return "other";
		if (target.isDirectory()) return "directory";
		if (target.isFile()) return "file";
		return "other";
	}

	private async collectDirectorySkills(dir: string, location: PiSkillLocation, out: PiSkillSummary[], ancestors = new Set<string>()) {
		const canonicalDir = await realpath(dir).catch(() => null);
		if (!canonicalDir || ancestors.has(canonicalDir)) return;

		// 只记录当前递归链，避免软连接环路；不同入口仍保留各自的 Skill 路径。
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(canonicalDir);

		const skillPath = join(dir, SKILL_FILE);
		if (existsSync(skillPath)) {
			out.push(await this.readSkill(skillPath, location, "directory"));
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if ((await this.getEntryKind(fullPath, entry)) === "directory") {
				await this.collectDirectorySkills(fullPath, location, out, nextAncestors);
			}
		}
	}

	private async readSkill(skillPath: string, location: PiSkillLocation, type: PiSkillSummary["type"]): Promise<PiSkillSummary> {
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
			// PiDeck 完全禁用保存在 settings.disabledSkills，不改写 Pi 的自动调用语义。
			userOnly: frontmatter["disable-model-invocation"] === "true",
			enabled: !this.isDisabledInSettings(name),
			valid: warnings.length === 0,
			warnings,
		};
	}

	/** 技能名是否在 PiDeck settings 禁用列表（小写比较；未配置 settings 时视为未禁用）。 */
	private isDisabledInSettings(name: string): boolean {
		if (!this.settingsProvider) return false;
		const key = name.toLowerCase();
		return (this.settingsProvider().disabledSkills ?? []).some((disabledName) => disabledName.toLowerCase() === key);
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
			value = value.replace(/^['\"]|['\"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	private setFrontmatterBoolean(raw: string, key: string, value: boolean) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return `---\n${key}: ${value}\n---\n\n${raw}`;
		const lines = match[1].split(/\r?\n/);
		let changed = false;
		const nextLines = lines.map((line) => {
			if (!line.trim().startsWith(`${key}:`)) return line;
			changed = true;
			return `${key}: ${value}`;
		});
		if (!changed) nextLines.push(`${key}: ${value}`);
		return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
	}

	private validateSkill(name: string, description: string) {
		const warnings: string[] = [];
		if (!name) warnings.push(this.translate("mainSkill.warningNameRequired"));
		if (name && !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)) {
			warnings.push(this.translate("mainSkill.warningNameCharacters"));
		}
		if (name.length > 64) warnings.push(this.translate("mainSkill.warningNameTooLong"));
		if (!description) warnings.push(this.translate("mainSkill.warningDescriptionRequired"));
		if (description.length > 1024) warnings.push(this.translate("mainSkill.warningDescriptionTooLong"));
		return warnings;
	}

	/** frontmatter 缺 name 时的回退名：markdown 取文件名（去扩展名），目录取目录名。
	 *  不能直接用 dirname().pop()——markdown 技能会显示成父目录名「skills」。 */
	private fallbackSkillName(skillPath: string, type: PiSkillSummary["type"]): string {
		return type === "markdown" ? basename(skillPath, extname(skillPath)) : basename(dirname(skillPath));
	}

	/** 重命名 Skill：按类型分流——目录技能重命名技能目录，markdown 技能只重命名单个文件。
	 *  markdown 技能的 skill.dir 是技能根目录（如 ~/.pi/agent/skills），绝不能当重命名
	 *  目标，否则整个技能根目录会被改名搬走，其余技能全部从列表消失（数据丢失事故）。 */
	async rename(skillPath: string, newName: string): Promise<PiSkillSummary> {
		const skill = await this.findByPath(skillPath);
		const normalizedNew = this.normalizeSkillName(newName);
		if (!normalizedNew) throw new Error(this.translate("mainSkill.nameRequired"));

		const displayName = newName.trim();
		const isDirectory = skill.type === "directory";
		// 目录技能目标 = 技能自身目录；markdown 技能目标 = 同目录下的 <新名>.md 单文件。
		// parentDir 用标准库 dirname 计算，禁止手写路径分隔符拼接（POSIX 下会拼出非法路径）。
		const oldTarget = isDirectory ? skill.dir : skill.path;
		const parentDir = dirname(oldTarget);
		const newTarget = isDirectory ? join(parentDir, normalizedNew) : join(parentDir, `${normalizedNew}${extname(skill.path)}`);

		if (oldTarget === newTarget) throw new Error(this.translate("mainSkill.sameName"));
		if (existsSync(newTarget)) throw new Error(this.translate("mainSkill.alreadyExists", { name: normalizedNew }));

		// 先在旧位置读原文，rename 成功后再把 frontmatter 写到新位置：
		// 中途失败不会留下「frontmatter 已改名、文件/目录还在原地」的部分变更。
		const raw = await readFile(skill.path, "utf8");
		await rename(oldTarget, newTarget);
		const newSkillPath = isDirectory ? join(newTarget, SKILL_FILE) : newTarget;
		await writeFile(newSkillPath, this.setFrontmatterName(raw, displayName), "utf8");

		// 禁用列表同步迁移：旧名条目替换为新名，避免孤儿数据与白名单双源漂移
		await this.migrateDisabledSkillName(skill.name, displayName);

		// 找对应的 location（搜索所有 locations）
		const reloaded = await this.readSkill(newSkillPath, this.locations.find((l) => newSkillPath.startsWith(l.path)) ?? this.locations[0], skill.type);
		return reloaded;
	}

	/** 重命名后同步 PiDeck settings 禁用列表：旧名条目替换为新名（大小写不敏感比较）。
	 *  未配置 settings 或旧名不在列表时静默跳过，不产生空写。 */
	private async migrateDisabledSkillName(oldName: string, newDisplayName: string): Promise<void> {
		if (!this.settingsProvider || !this.settingsPatcher) return;
		const oldKey = oldName.toLowerCase();
		const newKey = newDisplayName.toLowerCase();
		if (oldKey === newKey) return;
		const current = this.settingsProvider().disabledSkills ?? [];
		if (!current.some((name) => name.toLowerCase() === oldKey)) return;
		const nextList = current.filter((name) => name.toLowerCase() !== oldKey).filter((name) => name.toLowerCase() !== newKey);
		nextList.push(newDisplayName);
		await this.settingsPatcher({ disabledSkills: nextList });
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

	/** 规范化 Skill 名称：保留 Unicode 字母（含中文等）、数字和连字符 */
	private normalizeSkillName(value: string) {
		return value
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}-]+/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
	}

	private requireLocation(id: PiSkillLocation["id"]) {
		const location = this.locations.find((item) => item.id === id);
		if (!location) throw new Error(this.translate("mainSkill.unknownLocation", { id }));
		return location;
	}

	private async findByPath(skillPath: string) {
		const { skills } = await this.list();
		const skill = skills.find((item) => item.path === skillPath);
		if (!skill) throw new Error(this.translate("mainSkill.notFound"));
		return skill;
	}
}
