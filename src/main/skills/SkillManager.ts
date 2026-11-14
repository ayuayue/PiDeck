import { app } from "electron";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { trashPath } from "../fs/trash";
import { openSystemPath } from "../fs/openPath";
import type { AppSettings, CreatePiSkillInput, PiSkillListResult, PiSkillLocation, PiSkillSummary } from "../../shared/types";
import type { WslEnvironment } from "../wsl/WslPaths";
import { pideckBundledSkillsDir } from "./pideckSkillsPath";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

const SKILL_FILE = "SKILL.md";
/** 技能目录里除 SKILL.md 之外要一起落盘的附件（相对文件名）。
 *  2026-11-14：pideck-web-api 的 restart-peer.mjs 删掉了。它是 curl 三步的封装，而技能正文
 *  直接给 curl 就够用——封装多出一层要维护的判断逻辑（等多久算空闲、连不上算什么），
 *  多出来的判断本身成了 bug 来源。现在没有技能需要附件，保留这张表是为了下一个。 */
const SKILL_EXTRA_FILES: Record<string, string[]> = {};
const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMPORT_MAX_TREE_BYTES = 50 * 1024 * 1024;
const IMPORT_MAX_DEPTH = 32;
const UNSAFE_IMPORT_TARGET = "Skill target is unavailable.";

/**
 * 技能目录递归扫描时跳过的条目（2027-02 性能审计）。
 *
 * 技能根是用户手工维护的目录，但用户常把整个仓库/工作副本放进去；node_modules、
 * 各类构建产物与 .git 里永远不会有 SKILL.md，原实现却会一路递归到底——一次
 * skills:list 就能扫出上千目录（实测本机 125 目录已需约 250 次 syscall）。
 * 只跳过明确无关的产物目录与隐藏目录，不跳普通业务目录（技能可以嵌套）。
 */
const SKILL_WALK_SKIP_NAMES = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", ".cache"]);

/** 递归扫描是否跳过该目录项（隐藏目录 + 常见产物目录）。 */
export function shouldSkipSkillWalkEntry(name: string): boolean {
	return name.startsWith(".") || SKILL_WALK_SKIP_NAMES.has(name);
}

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
	/** 原生配置开关/状态（A4：迁移完成后禁用列表不再是真值来源）。 */
	private nativeToggle: ((skillPath: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>) | null = null;
	private nativeEnabledReader: ((skillPath: string) => boolean | undefined) | null = null;
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

	/** 注入 PiDeck 设置读写：旧禁用列表的兼容通道（原生服务未装配时使用；迁移后为空）。 */
	configureSettings(getSettings: () => AppSettings, patchSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>) {
		this.settingsProvider = getSettings;
		this.settingsPatcher = patchSettings;
	}

	/** 将 skill 目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		// 技能根整体换了一套目录：不清缓存的话，切换 WSL 用户后 1.5s 内仍返回旧环境的列表。
		this.invalidateListCache();
		this.managedHome = environment?.windowsHome ?? homedir();
		this.locations = this.buildLocations(this.managedHome);
	}

	/** 当前全局技能位置副本（WSL 配置后为主机路径），供读内容 IPC 的白名单校验。 */
	getLocations(): PiSkillLocation[] {
		return this.locations.map((location) => ({ ...location }));
	}

	/**
	 * 本次 spawn 应通过 `--skill` 注入的内置技能目录（按开关过滤）。
	 *
	 * 过滤读的是 pi settings.json 的投影（与技能列表开关同源）：`--skill` 注入不受
	 * pi 自己的自动发现/过滤规则约束，停用的内置技能必须在拼命令行时剔除。
	 * 目录很小（≤ 内置技能数），不做缓存，避免开关后拿到旧值。
	 */
	getBundledSkillLoadPaths(): string[] {
		const location = this.locations.find((item) => item.id === "pideck-global");
		if (!location) return [];
		let entries: Dirent[];
		try {
			entries = readdirSync(location.path, { withFileTypes: true });
		} catch {
			return [];
		}
		const paths: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const dir = join(location.path, entry.name);
			const skillFile = join(dir, SKILL_FILE);
			if (!existsSync(skillFile)) continue;
			if (this.nativeEnabledReader?.(skillFile) === false) continue;
			paths.push(dir);
		}
		return paths.sort();
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
			// PiDeck 自带技能：pi 不自动扫描这个目录，只有 PiDeck spawn 时用
			// `--skill` 注入，避免终端里的 pi（TUI）也加载桌面端专用技能。
			{
				id: "pideck-global",
				label: "~/.pi/agent/pideck-skills",
				path: pideckBundledSkillsDir(home),
				rootMarkdownEnabled: true,
			},
		];
	}

	/**
	 * 列表结果缓存（2027-02 性能审计）：list() 原先每次都对两个技能根做
	 * mkdir → realpath → 递归 readdir → 逐个 readFile(SKILL.md 全文，只为 frontmatter)，
	 * 本机 125 目录约 7-13ms、约 250 次 syscall；ComposerSkillPicker 打开、设置页打开、
	 * 每次 toggle（前后各一次全扫）都会付。技能目录由用户手工维护、变更频率极低，
	 * 用 1.5s TTL + 本类所有写操作显式失效：写后立刻列表一致，纯读路径几乎零成本。
	 */
	private listCache: { at: number; value: PiSkillListResult } | null = null;
	private static readonly LIST_CACHE_TTL_MS = 1_500;

	/** 技能根被本类改动后调用：下一次 list() 重新扫盘。 */
	private invalidateListCache(): void {
		this.listCache = null;
	}

	async list(): Promise<PiSkillListResult> {
		const cached = this.listCache;
		if (cached && Date.now() - cached.at < SkillManager.LIST_CACHE_TTL_MS) return cached.value;
		const skills = (await Promise.all(this.locations.map((location) => this.scanLocation(location)))).flat();
		// 按 name 去重：同名时以 pi 实际会加载的那份为准。
		// pi 先加载 `--skill` 注入的内置技能，再加载自动发现目录，所以
		// pideck-global 优先级最高；其余沿用 pi-global > agents-global
		// （避免两个全局目录不同步导致同名重复）。
		const seen = new Map<string, PiSkillSummary>();
		const sourceRank = (sourceId: PiSkillLocation["id"]) => (sourceId === "pideck-global" ? 0 : sourceId === "pi-global" ? 1 : 2);
		for (const skill of skills) {
			const key = skill.name.toLowerCase();
			const existing = seen.get(key);
			if (!existing || sourceRank(skill.sourceId) < sourceRank(existing.sourceId)) {
				seen.set(key, skill);
			}
		}
		const value = { locations: this.locations, skills: Array.from(seen.values()) };
		this.listCache = { at: Date.now(), value };
		return value;
	}

	async create(input: CreatePiSkillInput): Promise<PiSkillSummary> {
		this.invalidateListCache();
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
		this.invalidateListCache();
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
		this.invalidateListCache();
		const skill = await this.findByPath(skillPath);
		// 原生配置优先：迁移完成后弃用列表已清空，开关直接写 pi 原生过滤规则
		// （`-<path>` 停用 / `+<path>` 启用），与 TUI 的 pi config 等价。
		if (this.nativeToggle) {
			const result = await this.nativeToggle(skill.path, enabled);
			if (!result.ok) throw new Error(this.translate("mainSkill.toggleFailed", { error: result.error ?? "unknown" }));
			// 变更后再次失效：toggle 内部 findByPath→list() 会把「改之前」的结果写进缓存
			this.invalidateListCache();
			return this.findByPath(skill.path);
		}
		// 兼容路径（原生服务未装配）：仍写 PiDeck 私有禁用列表。
		// Pi 的 disable-model-invocation 仅阻止模型自动调用，用户仍可手动 /skill:name，
		// 因此作为独立 userOnly 状态展示。
		if (this.settingsProvider && this.settingsPatcher) {
			const current = this.settingsProvider().disabledSkills ?? [];
			const nameKey = skill.name.toLowerCase();
			const nextList = current.filter((name) => name.toLowerCase() !== nameKey);
			if (!enabled) nextList.push(skill.name);
			await this.settingsPatcher({ disabledSkills: nextList });
		}
		// 同上：设置已变，缓存里是改之前的状态
		this.invalidateListCache();
		return this.findByPath(skill.path);
	}

	/**
	 * 注入原生开关（`PiResourceConfigService.setFileResourceEnabled`）。
	 * 装配后技能开关写 pi settings.json；未装配时退回旧禁用列表（见 toggle）。
	 */
	configureNativeToggle(toggle: (skillPath: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>): void {
		this.nativeToggle = toggle;
	}

	/** 注入原生有效状态读取（迁移完成后以 pi 原生过滤为准）。 */
	configureNativeEnabledReader(reader: (skillPath: string) => boolean | undefined): void {
		this.nativeEnabledReader = reader;
	}

	async delete(skillPath: string): Promise<void> {
		this.invalidateListCache();
		const skill = await this.findByPath(skillPath);
		// 目录型 skill 删除整个目录；根 markdown skill 仅删除单个 md 文件。
		// 用户 skill 是内容资产：走系统回收站（可恢复）并记审计日志，拒绝 rm 硬删。
		await trashPath(skill.type === "directory" ? skill.dir : skill.path, { source: "skills:delete" });
	}

	async openFolder(skillPath?: string): Promise<void> {
		if (!skillPath) {
			await mkdir(this.locations[0].path, { recursive: true });
			await openSystemPath(this.locations[0].path);
			return;
		}
		const skill = await this.findByPath(skillPath);
		await openSystemPath(skill.dir);
	}

	/**
	 * 把随包分发的技能模板（resources/skills/<name>/SKILL.md）落到用户目录。
	 *
	 * 目标位置分两类：
	 * - `pideck-global`（默认）：桌面端专用技能（usage-probe / image-gen / pideck-doctor）。
	 *   该目录不在 pi 的自动发现根里，只有 PiDeck spawn 时用 `--skill` 注入，
	 *   终端里直接启动的 pi（TUI）不会加载。
	 * - `pi-global`：通用技能（mcp-setup）仍放回 pi 的全局技能目录，TUI 与 PiDeck 共用。
	 *
	 * 幂等覆盖：模板随应用更新同步；用户自定义配置写在各自的数据文件，不在此文件。
	 * `disable-model-invocation` 是用户手动设置的「仅手动调用」标记，覆盖时保留。
	 */
	async installTemplate(skillName: string, locationId: "pideck-global" | "pi-global" = "pideck-global"): Promise<{ success: true; path: string } | { success: false; error: string }> {
		try {
			const location = this.requireLocation(locationId);
			// 老版本把桌面端技能装在 pi 的自动发现根里：先迁移，TUI 才不会再加载。
			if (locationId === "pideck-global") await this.migrateLegacyBundledSkill(skillName);
			// 覆盖层优先：热更新把有差异的技能写进 userData/skills-overlay（结构同
			// <builtin>/skills/<name>/SKILL.md），安装时读生效源，避免「更新成功但装旧模板」。
			const overlayDir = this.skillOverlayProvider?.() ?? null;
			const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
			const templatePath = overlayDir ? join(overlayDir, skillName, SKILL_FILE) : join(root, "skills", skillName, SKILL_FILE);
			const content = await readFile(templatePath, "utf8");
			const targetDir = join(location.path, skillName);
			await mkdir(targetDir, { recursive: true });
			const targetPath = join(targetDir, SKILL_FILE);
			// 模板正文随应用更新同步；用户自行设置的 user-only 标记仍需保留。
			const previous = await readFile(targetPath, "utf8").catch(() => null);
			const wasUserOnly = previous !== null && this.parseFrontmatter(previous)["disable-model-invocation"] === "true";
			await writeFile(targetPath, content, "utf8");
			for (const file of SKILL_EXTRA_FILES[skillName] ?? []) {
				const from = overlayDir ? join(overlayDir, skillName, file) : join(root, "skills", skillName, file);
				if (!existsSync(from)) continue;
				await writeFile(join(targetDir, file), await readFile(from), "utf8");
			}
			if (wasUserOnly) {
				await writeFile(targetPath, this.setFrontmatterBoolean(content, "disable-model-invocation", true), "utf8");
			}
			// 模板落盘同样是技能根变更：列表缓存必须失效（否则安装后 1.5s 内看不到）
			this.invalidateListCache();
			return { success: true, path: targetPath };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * 迁移旧版本装在 `~/.pi/agent/skills/<name>` 的内置技能。
	 *
	 * 只搬 PiDeck 自己创建的普通目录：软链（技能库工具会把库里的技能链进来）和普通文件
	 * 都不是 PiDeck 建的，搬/删会破坏用户配置，原样留给用户处理。
	 * 迁移失败不阻断安装：新副本照常落到内置目录，旧副本只是继续对 TUI 可见。
	 */
	private async migrateLegacyBundledSkill(skillName: string): Promise<void> {
		const legacyDir = join(this.requireLocation("pi-global").path, skillName);
		const targetDir = join(this.requireLocation("pideck-global").path, skillName);
		if (existsSync(targetDir)) return;
		const entry = await lstat(legacyDir).catch(() => null);
		if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return;
		await mkdir(dirname(targetDir), { recursive: true });
		await rename(legacyDir, targetDir).catch(() => undefined);
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
			// 忽略开发产物与隐藏目录（2027-02 性能审计）：技能目录里的 node_modules / .git
			// 会被原实现递归到底，一次列表就能扫出上千个目录（且永远不含 SKILL.md）。
			if (shouldSkipSkillWalkEntry(entry.name)) continue;
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
			// 完全禁用：优先读原生过滤投影（迁移后废弃 disabledSkills）；
			// Pi 的 disable-model-invocation 是独立的「仅手动调用」语义，不改写。
			userOnly: frontmatter["disable-model-invocation"] === "true",
			enabled: this.nativeEnabledReader?.(skillPath) ?? !this.isDisabledInSettings(name),
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
		this.invalidateListCache();
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

		// 禁用列表同步迁移：旧名条目替换为新名，避免孤儿数据与原生规则双源漂移
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
