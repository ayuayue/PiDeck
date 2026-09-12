import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import {
	addIgnoreRules,
	applyPatterns,
	isDirEntry,
	isFileEntry,
	passesOverrides,
	readSettingsObject,
	readStringArray,
	resolveFromBase,
	SKILL_FILE,
	splitResourceEntries,
	toPosixPath,
} from "../resourceWhitelist";
import {
	globalSkillOverrideKey,
	type GlobalSkillSourceId,
} from "../../shared/resourceIdentity";
import { readProjectResourceOverrides } from "../projects/projectResourceOverrides";
import { resolveConfiguredPackageResources } from "../packageResourceResolver";

/**
 * 技能白名单模式解析器：计算 RPC 启动时应通过 --skill 注入的技能路径。
 *
 * 为什么需要它：pi 的 skill frontmatter `disable-model-invocation` 只阻止模型自动调用，
 * 技能仍被加载（用户仍可 /skill:name 手动触发）。完全禁用唯一可靠的手段是
 * `--no-skills`（关自动发现）+ 显式 `--skill` 白名单（`--no-skills` 下仍加载）。
 * 但 -ns 下 pi 连目录扫描、settings.skills 数组、包技能都不发现，所以启用白名单时
 * PiDeck 必须把「pi 本来会加载的全部技能」自己枚举出来，剔除禁用项后逐条注入。
 *
 * 枚举与过滤规则逐条对齐 pi 0.85 的 DefaultPackageManager.resolve() /
 * collectSkillEntries / addIgnoreRules / isEnabledByOverrides / applyPatterns：
 *   1. ~/.pi/agent/skills（pi 模式：顶层 md 也是技能）与 ~/.agents/skills（agents 模式：只嵌套）
 *   2. <cwd>/.pi/skills（pi 模式）与 <cwd> 及祖先目录的 .agents/skills（到 git repo root）
 *   3. user/project settings.json 的 skills 数组：plain 条目 = 显式路径；
 *      `!`/`+`/`-` 前缀条目 = 自动发现过滤规则（exclude / force-include / force-exclude）
 *   4. packages：包内 skills/ 约定目录与 package.json pi.skills 声明；
 *      对象条目 { source, skills, autoload } 的过滤语义（空数组 = 全禁，autoload:false = delta）
 *   5. ignore 规则（.gitignore/.ignore/.fdignore，逐目录前缀化）应用于自动发现目录
 *
 * 返回 null = 无禁用项，白名单关闭（pi 自动发现，兼容 PiDeck 未跟踪的手动安装）；
 * 返回数组（可能为空）= 白名单开启，调用方需同时传 --no-skills。
 *
 * Package sources use their managed npm/git/local install locations, including manifest globs.
 * Explicit and auto-discovered resources retain pi's distinct base directories and override rules.
 */
export function resolveEnabledSkillPaths(
	options: SkillWhitelistResolverOptions,
): string[] | null {
	const { cwd } = options;
	const home = options.agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");
	const projectBaseDir = join(cwd, ".pi");
	const includeProjectResources = options.includeProjectResources !== false;

	// 附加 agent home（WSL 场景）：WSL 里的 pi 以 distro 内 HOME 运行，其 ~/.pi/agent/skills、
	// ~/.agents/skills 及 settings.json 的全局技能必须与 Windows 侧 home 取并集，否则 --no-skills
	// 会把 Linux 家目录技能全部关在白名单外（issue #203）。UNC（\\wsl.localhost\...）可在宿主侧
	// 直接扫描，路径随后由 PiProcess 的 WSL 参数转换还原为 distro 内 Linux 路径。
	const additionalHomes = (options.additionalAgentHomeDirs ?? [])
		.map((dir) => dir.trim())
		.filter((dir) => dir && resolve(dir) !== resolve(home));

	const projectSettings = includeProjectResources
		? readSettingsObject(join(projectBaseDir, "settings.json"))
		: {};

	// 全局与项目禁用状态分别匹配对应发现源；不能合并 name 集合，否则同名资源会跨作用域串扰。
	const globalDisabledKeys = new Set(
		(options.disabledNames ?? []).map((name) => name.toLowerCase()),
	);
	const projectDisabledKeys = new Set(
		readStringArray(projectSettings, "disabledSkills").map((name) => name.toLowerCase()),
	);
	const inheritedDisabledKeys = new Set(
		includeProjectResources
			? readProjectResourceOverrides(cwd).disabledGlobalSkills
			: [],
	);
	// 扫描过程中发现的 PiDeck 禁用/frontmatter 排除项计数：无任何禁用时返回 null（白名单关闭）。
	const excluded = { count: 0 };
	const enabledForScope = (
		skillFile: string,
		disabledKeys: Set<string>,
		globalSourceId?: GlobalSkillSourceId,
	) => {
		const enabled = isEnabledSkill(
			skillFile,
			disabledKeys,
			globalSourceId,
			inheritedDisabledKeys,
		);
		if (!enabled) excluded.count += 1;
		return enabled;
	};
	const isGlobalPiEnabled = (path: string) => enabledForScope(path, globalDisabledKeys, "pi-global");
	const isGlobalAgentsEnabled = (path: string) => enabledForScope(path, globalDisabledKeys, "agents-global");
	const isProjectEnabled = (path: string) => enabledForScope(path, projectDisabledKeys);

	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (path: string) => {
		if (!path || seen.has(path)) return;
		seen.add(path);
		paths.push(path);
	};

	// 全局 home 的发现源（~/.pi/agent/skills、~/.agents/skills、settings.json 显式路径）。
	// 主 home 与附加 home（WSL）共用同一套全局禁用判定；每个 home 的 settings.json 只约束
	// 自己作用域内的发现（patterns 不跨 home 生效，与 pi 在对应环境内运行时一致）。
	// 包资源（npm/git 安装）仍只解析主 home：UNC 逐包扫描成本高且 WSL 侧包安装罕见，
	// 待有真实需求再扩展。
	const globalAgentsSkillDirs = new Set<string>();
	const collectGlobalHomeSkills = (homeDir: string): void => {
		const homeAgentDir = join(homeDir, ".pi", "agent");
		const homeSettings = readSettingsObject(join(homeAgentDir, "settings.json"));
		const { plain, patterns } = splitResourceEntries(
			Array.isArray(homeSettings.skills) ? homeSettings.skills : [],
		);
		collectSkillDir(join(homeAgentDir, "skills"), "pi", isGlobalPiEnabled, addPath, homeAgentDir, patterns);
		const globalAgentsSkillsDir = join(homeDir, ".agents", "skills");
		// 登记 resolved 路径供祖先目录去重：同一物理 ~/.agents/skills 是全局源，即使 cwd
		//（如 WSL 内项目）沿祖先链再次碰到它，也不能按项目作用域重复枚举。
		globalAgentsSkillDirs.add(resolve(globalAgentsSkillsDir));
		collectSkillDir(
			globalAgentsSkillsDir,
			"agents",
			isGlobalAgentsEnabled,
			addPath,
			dirname(globalAgentsSkillsDir),
			patterns,
		);
		collectSettingsSkills(homeAgentDir, plain, patterns, isGlobalPiEnabled, addPath);
	};
	collectGlobalHomeSkills(home);
	for (const extraHome of additionalHomes) {
		collectGlobalHomeSkills(extraHome);
	}

	// 2) 项目资源只在 trust 放行后枚举；拒绝 trust 时白名单仅注入全局资源。
	const { plain: projectPlain, patterns: projectOverrides } = splitResourceEntries(
		Array.isArray(projectSettings.skills) ? projectSettings.skills : [],
	);
	if (includeProjectResources) {
		collectSkillDir(join(projectBaseDir, "skills"), "pi", isProjectEnabled, addPath, projectBaseDir, projectOverrides);
		for (const dir of collectAncestorAgentsSkillDirs(cwd)) {
			// 同一物理 ~/.agents/skills（任一 home 的全局源）即使出现在 cwd 祖先链上也保持全局语义。
			if (globalAgentsSkillDirs.has(resolve(dir))) continue;
			collectSkillDir(dir, "agents", isProjectEnabled, addPath, dirname(dir), projectOverrides);
		}
		// 项目 settings.json skills 数组的显式路径（plain 条目经 patterns 过滤）
		collectSettingsSkills(projectBaseDir, projectPlain, projectOverrides, isProjectEnabled, addPath);
	}

	// 4) package resources share pi 0.85's scope precedence, filters, manifest globs, and git/npm paths.
	for (const resource of resolveConfiguredPackageResources({
		resourceType: "skills",
		userSettingsFile: join(agentDir, "settings.json"),
		userBaseDir: agentDir,
		projectSettingsFile: includeProjectResources ? join(projectBaseDir, "settings.json") : undefined,
		projectBaseDir: includeProjectResources ? projectBaseDir : undefined,
		collectDirectory: (directory) => collectSkillDirFiles(directory, "pi"),
	})) {
		if (!resource.enabled) {
			excluded.count += 1;
			continue;
		}
		const enabled = resource.scope === "project"
			? isProjectEnabled(resource.path)
			: isGlobalPiEnabled(resource.path);
		if (enabled) addPath(resource.path);
	}

	// 无任何禁用（settings ∪ 项目继承覆盖 ∪ frontmatter）→ 白名单关闭，pi 默认发现全部技能。
	if (
		includeProjectResources &&
		globalDisabledKeys.size === 0 &&
		projectDisabledKeys.size === 0 &&
		inheritedDisabledKeys.size === 0 &&
		excluded.count === 0
	) {
		return null;
	}
	return paths;
}

export type SkillWhitelistResolverOptions = {
	/** WSL 场景传入 Windows 侧 home；缺省 homedir()（与 PiProcessOptions.agentHomeDir 语义一致）。 */
	agentHomeDir?: string;
	/**
	 * 附加 agent home 根目录（WSL 场景为 distro 家目录的 UNC 路径 \\wsl.localhost\<distro>\...）。
	 * 每个 home 的 ~/.pi/agent/skills、~/.agents/skills 与 settings.json skills 显式路径
	 * 都并入全局白名单（与 Windows 侧 home 取并集，issue #203）；与主 home 相同的目录忽略。
	 */
	additionalAgentHomeDirs?: string[];
	/** 会话项目根（pi 的 cwd），决定项目级 .pi/skills 与祖先 .agents/skills。 */
	cwd: string;
	/** False when the trust decision rejects project resources. */
	includeProjectResources?: boolean;
	/** PiDeck settings 中禁用的全局技能名（比较时小写）。 */
	disabledNames: string[];
};

/** 读取 frontmatter 中的技能名与 disable-model-invocation（与 SkillManager.parseFrontmatter 同规则）。 */
function readSkillMeta(skillFile: string): { name: string; modelInvocationDisabled: boolean } {
	try {
		const raw = readFileSync(skillFile, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		const fields: Record<string, string> = {};
		if (match) {
			for (const line of match[1].split(/\r?\n/)) {
				const index = line.indexOf(":");
				if (index === -1) continue;
				const key = line.slice(0, index).trim();
				const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
				if (key) fields[key] = value;
			}
		}
		return {
			name: String(fields.name ?? "").trim(),
			modelInvocationDisabled: fields["disable-model-invocation"] === "true",
		};
	} catch {
		return { name: "", modelInvocationDisabled: false };
	}
}

/**
 * 技能文件是否应注入白名单：frontmatter 无 name（读不到，注入后由 pi 校验丢弃）视为
 * 未禁用；显式禁用列表（PiDeck settings ∪ 项目 settings）或 frontmatter 的
 * disable-model-invocation（老版 PiDeck 禁用语义，仅阻止自动调用）都排除——
 * 后者一并排除让旧禁用状态升级后直接变为「不加载」，无需用户重新操作。
 */
function isEnabledSkill(
	skillFile: string,
	disabledKeys: Set<string>,
	globalSourceId?: GlobalSkillSourceId,
	inheritedDisabledKeys: ReadonlySet<string> = new Set(),
): boolean {
	const { name, modelInvocationDisabled } = readSkillMeta(skillFile);
	if (modelInvocationDisabled) return false;
	if (!name) return true;
	if (disabledKeys.has(name.toLowerCase())) return false;
	return !(
		globalSourceId &&
		inheritedDisabledKeys.has(globalSkillOverrideKey(globalSourceId, name))
	);
}

/**
 * 扫描技能目录（规则与 pi 的 collectSkillEntries 对齐）：
 * 目录内存在 SKILL.md → 该目录整体是一个技能（即使被 ignore 也不递归，与 pi 一致）；
 * 否则递归子目录，顶层 .md 文件仅 pi 模式视为技能（agents 模式只认嵌套 .md）。
 * root 为扫描入口目录；ignore 规则从 root 起逐目录加载；override patterns 按作用域传入。
 */
function collectSkillDir(
	dir: string,
	mode: "pi" | "agents",
	isPiDeckEnabled: (skillFile: string) => boolean,
	addPath: (path: string) => void,
	overridesBase: string,
	overrides: string[],
	root = dir,
	ig?: ReturnType<typeof ignore>,
): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // 目录不存在：无技能
	}
	const igRef = ig ?? ignore();
	addIgnoreRules(igRef, dir, root);

	for (const entry of entries) {
		if (entry.name !== SKILL_FILE) continue;
		const fullPath = join(dir, entry.name);
		if (!isFileEntry(entry, fullPath)) continue;
		if (igRef.ignores(toPosixPath(relative(root, fullPath)))) return;
		if (isPiDeckEnabled(fullPath) && passesOverrides(fullPath, overridesBase, overrides)) {
			addPath(fullPath);
		}
		return; // 有 SKILL.md 的目录不再递归，与 pi 一致
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

		if (isDirEntry(entry, fullPath)) {
			const relPath = toPosixPath(relative(root, fullPath));
			if (igRef.ignores(`${relPath}/`)) continue;
			collectSkillDir(fullPath, mode, isPiDeckEnabled, addPath, overridesBase, overrides, root, igRef);
			continue;
		}
		if (!isFileEntry(entry, fullPath)) continue;

		// 顶层 .md 根技能：pi 模式（~/.pi/agent/skills、.pi/skills）顶层算；
		// agents 模式（~/.agents/skills、.agents/skills）顶层忽略、嵌套才算
		const isRootLevel = dir === root;
		if (!entry.name.toLowerCase().endsWith(".md")) continue;
		if (!((mode === "pi" && isRootLevel) || (mode === "agents" && !isRootLevel))) continue;
		if (igRef.ignores(toPosixPath(relative(root, fullPath)))) continue;
		if (isPiDeckEnabled(fullPath) && passesOverrides(fullPath, overridesBase, overrides)) {
			addPath(fullPath);
		}
	}
}

/** 从 cwd 向上收集 .agents/skills 目录，到 git repo root（无仓库时到文件系统根）。 */
function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(dir);
	while (true) {
		dirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * settings.json skills 数组的显式路径（plain 条目）：文件直接注入，目录按 pi 模式递归枚举
 * （pi 的 collectFilesFromPaths → collectResourceFiles(dir, "skills") = collectSkillEntries(dir, "pi")，
 * 无 ignore）；整个显式集合再过 patterns（! + -）过滤。
 */
function collectSettingsSkills(
	base: string,
	plain: string[],
	patterns: string[],
	isPiDeckEnabled: (skillFile: string) => boolean,
	addPath: (path: string) => void,
): void {
	const allFiles: string[] = [];
	for (const rawPath of plain) {
		const resolved = resolveFromBase(rawPath, base);
		if (!resolved || !existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				allFiles.push(...collectSkillDirFiles(resolved, "pi"));
			} else {
				allFiles.push(resolved);
			}
		} catch {
			// 路径不可读：跳过，pi 侧同样会忽略
		}
	}
	const enabledSet = applyPatterns(allFiles, patterns, base);
	for (const file of allFiles) {
		if (enabledSet.has(file) && isPiDeckEnabled(file)) addPath(file);
	}
}

/** 枚举目录下全部技能文件（pi 模式，无 ignore——与 pi 的 collectResourceFiles 一致）。 */
function collectSkillDirFiles(dir: string, mode: "pi" | "agents"): string[] {
	const files: string[] = [];
	collectSkillDir(dir, mode, () => true, (path) => files.push(path), dir, []);
	return files;
}
