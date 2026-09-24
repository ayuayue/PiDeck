import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { readSettingsObject, readStringArray, resolveFromBase, splitResourceEntries, applyPatterns, SKILL_FILE } from "./resourceWhitelist";
import { resolveConfiguredPackageResources } from "./packageResourceResolver";

/**
 * 运行时可发现资源（packages、settings 显式路径、祖先 .agents/skills、显式扩展路径）的
 * 只读描述。它与 pi 0.85 的 resolver 共用同一个发现实现，让配置管理页能看到「pi 实际会
 * 加载哪些资源」，同时把不可直接编辑的来源与可编辑的本地文件目录严格区分。
 *
 * 所有条目都带 `managed: true`（由 package 或 settings 声明管理）或来自祖先目录，
 * 因此 UI 只允许启停/卸载操作，禁止把这些文件接入 Skill/Prompt 的内联编辑/重命名/
 * 文件删除流——受包管理器管理的资源不允许被当作本地文件直接修改。
 */

export type ResourceDiscoverySourceId = "package-user" | "package-project" | "settings-user" | "settings-project" | "ancestor-agents";

export type DiscoveredSkillResource = {
	/** 稳定身份：sourceId:name（与 ProjectResourceOverrides.disabledGlobalSkills 同构）。 */
	id: string;
	name: string;
	/** SKILL.md 绝对路径。 */
	path: string;
	/** 技能目录绝对路径。 */
	dir: string;
	sourceId: ResourceDiscoverySourceId;
	sourceLabel: string;
	description: string;
	/** Pi 禁止模型自动调用，但用户仍可通过 /skill:name 手动调用。 */
	userOnly: boolean;
	/** 是否可用（排除 PiDeck settings 禁用列表后）。 */
	enabled: boolean;
	/** 由 package / settings 声明或来自祖先目录：不得当作本地文件直接编辑。 */
	managed: boolean;
};

export type DiscoveredPromptResource = {
	/** 稳定身份：规范化名称（与 disabledGlobalPrompts 同构）。 */
	name: string;
	path: string;
	sourceId: ResourceDiscoverySourceId;
	sourceLabel: string;
	description: string;
	enabled: boolean;
	managed: boolean;
};

export type DiscoveredExtensionResource = {
	/** 稳定身份：source（scope-qualified 禁用列表同构）。 */
	source: string;
	path: string;
	sourceId: ResourceDiscoverySourceId;
	sourceLabel: string;
	/** 物理安装位置的作用域（user 全局 npm / project .pi/npm）。 */
	physicalScope: "user" | "project";
	enabled: boolean;
	managed: boolean;
};

export type ResourceDiscoveryOptions = {
	/** WSL 场景传入 Windows 侧 home；缺省 homedir()。 */
	agentHomeDir?: string;
	/** 会话项目根（pi 的 cwd）。 */
	cwd?: string;
	/** False when the trust decision rejects project resources. */
	includeProjectResources?: boolean;
	/** PiDeck 全局 settings 中禁用的全局技能名（比较时小写）。 */
	disabledSkillNames?: string[];
	/** PiDeck 项目 .pi/settings.json 中完全禁用的项目技能名。 */
	disabledProjectSkillNames?: string[];
	/** PiDeck 全局 settings 中禁用的全局模板名（比较时小写）。 */
	disabledPromptNames?: string[];
	/** PiDeck 项目 .pi/settings.json 中禁用的项目模板名。 */
	disabledProjectPromptNames?: string[];
	/** 当前项目禁用的全局模板名。 */
	disabledGlobalPromptNames?: string[];
	/** PiDeck settings 中禁用的扩展条目（scope+source）。 */
	disabledExtensions?: { scope: "user" | "project" | "unknown"; source: string }[];
};

export function discoverSkills(options: ResourceDiscoveryOptions): DiscoveredSkillResource[] {
	const home = options.agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");
	const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
	const projectBaseDir = join(cwd, ".pi");
	const includeProjectResources = options.includeProjectResources !== false;

	const userSettings = readSettingsObject(join(agentDir, "settings.json"));
	const projectSettings = includeProjectResources ? readSettingsObject(join(projectBaseDir, "settings.json")) : {};
	const disabledGlobalKeys = new Set((options.disabledSkillNames ?? []).map((name) => name.toLowerCase()));
	const disabledProjectKeys = new Set((options.disabledProjectSkillNames ?? []).map((name) => name.toLowerCase()));
	const isGlobalSkillEnabled = (name: string) => !disabledGlobalKeys.has(name.toLowerCase());
	const isProjectSkillEnabled = (name: string) => !disabledProjectKeys.has(name.toLowerCase());

	const result: DiscoveredSkillResource[] = [];
	const seen = new Set<string>();
	const add = (resource: DiscoveredSkillResource) => {
		if (seen.has(resource.id)) return;
		seen.add(resource.id);
		result.push(resource);
	};

	// settings.skills 显式路径（user + project），按 settings 过滤后作为 managed 条目。
	const { plain: userPlain, patterns: userPatterns } = splitResourceEntries(Array.isArray(userSettings.skills) ? userSettings.skills : []);
	const { plain: projectPlain, patterns: projectPatterns } = splitResourceEntries(Array.isArray(projectSettings.skills) ? projectSettings.skills : []);
	for (const item of collectSettingsSkillFiles(agentDir, userPlain, userPatterns)) {
		const name = readSkillName(item);
		add({
			id: `settings-user:${name}`,
			name,
			path: item,
			dir: dirname(item),
			sourceId: "settings-user",
			sourceLabel: "settings.skills",
			description: readSkillDescription(item),
			userOnly: readSkillUserOnly(item),
			enabled: isGlobalSkillEnabled(name),
			managed: true,
		});
	}
	if (includeProjectResources) {
		for (const item of collectSettingsSkillFiles(projectBaseDir, projectPlain, projectPatterns)) {
			const name = readSkillName(item);
			add({
				id: `settings-project:${name}`,
				name,
				path: item,
				dir: dirname(item),
				sourceId: "settings-project",
				sourceLabel: "settings.skills",
				description: readSkillDescription(item),
				userOnly: readSkillUserOnly(item),
				enabled: isProjectSkillEnabled(name),
				managed: true,
			});
		}
	}

	// Ancestor .agents/skills directories (project scope only).
	if (includeProjectResources) {
		for (const item of collectAncestorAgentSkillFiles(cwd)) {
			const name = readSkillName(item);
			add({
				id: `ancestor-agents:${name}`,
				name,
				path: item,
				dir: dirname(item),
				sourceId: "ancestor-agents",
				sourceLabel: ".agents/skills",
				description: readSkillDescription(item),
				userOnly: readSkillUserOnly(item),
				enabled: isProjectSkillEnabled(name),
				managed: true,
			});
		}
	}

	// Package skills.
	for (const resource of resolveConfiguredPackageResources({
		resourceType: "skills",
		userSettingsFile: join(agentDir, "settings.json"),
		userBaseDir: agentDir,
		projectSettingsFile: includeProjectResources ? join(projectBaseDir, "settings.json") : undefined,
		projectBaseDir: includeProjectResources ? projectBaseDir : undefined,
		collectDirectory: (directory) => collectSkillDirFiles(directory, "pi"),
	})) {
		const name = readSkillName(resource.path);
		add({
			id: `${resource.scope === "project" ? "package-project" : "package-user"}:${name}`,
			name,
			path: resource.path,
			dir: dirname(resource.path),
			sourceId: resource.scope === "project" ? "package-project" : "package-user",
			sourceLabel: resource.scope === "project" ? "package (project)" : "package (user)",
			description: readSkillDescription(resource.path),
			userOnly: readSkillUserOnly(resource.path),
			enabled: resource.enabled && (resource.scope === "project" ? isProjectSkillEnabled(name) : isGlobalSkillEnabled(name)),
			managed: true,
		});
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverPrompts(options: ResourceDiscoveryOptions): DiscoveredPromptResource[] {
	const home = options.agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");
	const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
	const projectBaseDir = join(cwd, ".pi");
	const includeProjectResources = options.includeProjectResources !== false;

	const userSettings = readSettingsObject(join(agentDir, "settings.json"));
	const projectSettings = includeProjectResources ? readSettingsObject(join(projectBaseDir, "settings.json")) : {};
	const disabledGlobalKeys = new Set((options.disabledPromptNames ?? []).map((name) => name.toLowerCase()));
	const disabledProjectKeys = new Set((options.disabledProjectPromptNames ?? []).map((name) => name.toLowerCase()));
	const disabledInheritedKeys = new Set((options.disabledGlobalPromptNames ?? []).map((name) => name.toLowerCase()));
	const isGlobalPromptEnabled = (name: string) => {
		const key = name.toLowerCase();
		return !disabledGlobalKeys.has(key) && !disabledInheritedKeys.has(key);
	};
	const isProjectPromptEnabled = (name: string) => !disabledProjectKeys.has(name.toLowerCase());

	const result: DiscoveredPromptResource[] = [];
	const seen = new Set<string>();
	const add = (resource: DiscoveredPromptResource) => {
		const key = `${resource.sourceId}\u0000${resource.name}`;
		if (seen.has(key)) return;
		seen.add(key);
		result.push(resource);
	};

	const { plain: userPlain, patterns: userPatterns } = splitResourceEntries(Array.isArray(userSettings.prompts) ? userSettings.prompts : []);
	const { plain: projectPlain, patterns: projectPatterns } = splitResourceEntries(Array.isArray(projectSettings.prompts) ? projectSettings.prompts : []);
	for (const item of collectSettingsPromptFiles(agentDir, userPlain, userPatterns)) {
		const name = promptName(item);
		add({
			name,
			path: item,
			sourceId: "settings-user",
			sourceLabel: "settings.prompts",
			description: readPromptDescription(item),
			enabled: isGlobalPromptEnabled(name),
			managed: true,
		});
	}
	if (includeProjectResources) {
		for (const item of collectSettingsPromptFiles(projectBaseDir, projectPlain, projectPatterns)) {
			const name = promptName(item);
			add({
				name,
				path: item,
				sourceId: "settings-project",
				sourceLabel: "settings.prompts",
				description: readPromptDescription(item),
				enabled: isProjectPromptEnabled(name),
				managed: true,
			});
		}
	}

	for (const resource of resolveConfiguredPackageResources({
		resourceType: "prompts",
		userSettingsFile: join(agentDir, "settings.json"),
		userBaseDir: agentDir,
		projectSettingsFile: includeProjectResources ? join(projectBaseDir, "settings.json") : undefined,
		projectBaseDir: includeProjectResources ? projectBaseDir : undefined,
		collectDirectory: (directory) => collectPromptDirFiles(directory),
	})) {
		const name = promptName(resource.path);
		add({
			name,
			path: resource.path,
			sourceId: resource.scope === "project" ? "package-project" : "package-user",
			sourceLabel: resource.scope === "project" ? "package (project)" : "package (user)",
			description: readPromptDescription(resource.path),
			enabled: resource.enabled && (resource.scope === "project" ? isProjectPromptEnabled(name) : isGlobalPromptEnabled(name)),
			managed: true,
		});
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverExtensions(options: ResourceDiscoveryOptions): DiscoveredExtensionResource[] {
	const home = options.agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");
	const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
	const projectBaseDir = join(cwd, ".pi");
	const includeProjectResources = options.includeProjectResources !== false;

	const userSettings = readSettingsObject(join(agentDir, "settings.json"));
	const projectSettings = includeProjectResources ? readSettingsObject(join(projectBaseDir, "settings.json")) : {};
	const disabledKeys = new Set((options.disabledExtensions ?? []).map((entry) => `${entry.scope}:${entry.source.trim()}`));

	const result: DiscoveredExtensionResource[] = [];
	const seen = new Set<string>();
	const add = (resource: DiscoveredExtensionResource) => {
		const key = `${resource.physicalScope}\u0000${resource.source}`;
		if (seen.has(key)) return;
		seen.add(key);
		result.push(resource);
	};

	const { plain: userPlain, patterns: userPatterns } = splitResourceEntries(Array.isArray(userSettings.extensions) ? userSettings.extensions : []);
	const { plain: projectPlain, patterns: projectPatterns } = splitResourceEntries(Array.isArray(projectSettings.extensions) ? projectSettings.extensions : []);
	for (const item of collectSettingsExtensionFiles(agentDir, userPlain, userPatterns)) {
		const source = extensionSource(item);
		add({
			source,
			path: item,
			sourceId: "settings-user",
			sourceLabel: "settings.extensions",
			physicalScope: "user",
			enabled: !disabledKeys.has(`user:${source}`),
			managed: true,
		});
	}
	if (includeProjectResources) {
		for (const item of collectSettingsExtensionFiles(projectBaseDir, projectPlain, projectPatterns)) {
			const source = extensionSource(item);
			add({
				source,
				path: item,
				sourceId: "settings-project",
				sourceLabel: "settings.extensions",
				physicalScope: "project",
				enabled: !disabledKeys.has(`project:${source}`),
				managed: true,
			});
		}
	}

	for (const resource of resolveConfiguredPackageResources({
		resourceType: "extensions",
		userSettingsFile: join(agentDir, "settings.json"),
		userBaseDir: agentDir,
		projectSettingsFile: includeProjectResources ? join(projectBaseDir, "settings.json") : undefined,
		projectBaseDir: includeProjectResources ? projectBaseDir : undefined,
		collectDirectory: (directory) => collectExtensionEntryFiles(directory),
	})) {
		const source = resource.source;
		add({
			source,
			path: resource.path,
			sourceId: resource.scope === "project" ? "package-project" : "package-user",
			sourceLabel: resource.scope === "project" ? "package (project)" : "package (user)",
			physicalScope: resource.physicalScope,
			enabled: resource.enabled && !disabledKeys.has(`${resource.scope}:${source}`),
			managed: true,
		});
	}

	return result.sort((a, b) => a.source.localeCompare(b.source));
}

function readSkillName(path: string): string {
	try {
		const raw = readFileSync(path, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		if (match) {
			for (const line of match[1].split(/\r?\n/)) {
				const index = line.indexOf(":");
				if (index === -1) continue;
				if (line.slice(0, index).trim() === "name") {
					return (
						line
							.slice(index + 1)
							.trim()
							.replace(/^['"]|['"]$/g, "") || basename(dirname(path))
					);
				}
			}
		}
	} catch {
		// fall through to directory-name fallback
	}
	return basename(dirname(path));
}

function readSkillUserOnly(path: string): boolean {
	try {
		const raw = readFileSync(path, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		if (!match) return false;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1 || line.slice(0, index).trim() !== "disable-model-invocation") continue;
			return (
				line
					.slice(index + 1)
					.trim()
					.replace(/^['"]|['"]$/g, "") === "true"
			);
		}
	} catch {
		// Unreadable skill: retain it as an ordinary user-invocable skill candidate.
	}
	return false;
}

function readSkillDescription(path: string): string {
	try {
		const raw = readFileSync(path, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		if (match) {
			for (const line of match[1].split(/\r?\n/)) {
				const index = line.indexOf(":");
				if (index === -1) continue;
				if (line.slice(0, index).trim() === "description") {
					return line
						.slice(index + 1)
						.trim()
						.replace(/^['"]|['"]$/g, "");
				}
			}
		}
	} catch {
		// unreadable skill: return empty description
	}
	return "";
}

function promptName(path: string): string {
	return basename(path).replace(/\.md$/i, "");
}

function readPromptDescription(path: string): string {
	try {
		const raw = readFileSync(path, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		if (match) {
			for (const line of match[1].split(/\r?\n/)) {
				const index = line.indexOf(":");
				if (index === -1) continue;
				if (line.slice(0, index).trim() === "description") {
					return line
						.slice(index + 1)
						.trim()
						.replace(/^['"]|['"]$/g, "");
				}
			}
		}
	} catch {
		// unreadable prompt: return empty description
	}
	return "";
}

function collectSettingsSkillFiles(base: string, plain: string[], patterns: string[]): string[] {
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
			// unreadable explicit paths are ignored, as in the pi resolver
		}
	}
	const { applyPatterns: applyFilter } = requirePatterns();
	const enabled = applyFilter(allFiles, patterns, base);
	return allFiles.filter((file) => enabled.has(file));
}

function collectSettingsPromptFiles(base: string, plain: string[], patterns: string[]): string[] {
	const allFiles: string[] = [];
	for (const rawPath of plain) {
		const resolved = resolveFromBase(rawPath, base);
		if (!resolved || !existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				allFiles.push(...collectPromptDirFiles(resolved));
			} else {
				allFiles.push(resolved);
			}
		} catch {
			// unreadable explicit paths are ignored, as in the pi resolver
		}
	}
	const { applyPatterns: applyFilter } = requirePatterns();
	const enabled = applyFilter(allFiles, patterns, base);
	return allFiles.filter((file) => enabled.has(file));
}

function collectSettingsExtensionFiles(base: string, plain: string[], patterns: string[]): string[] {
	const candidates: string[] = [];
	for (const source of plain) {
		const resolved = resolveFromBase(source, base);
		if (!resolved || !existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				candidates.push(...collectExtensionEntryFiles(resolved));
			} else {
				candidates.push(resolved);
			}
		} catch {
			// unreadable explicit paths are ignored, as in the pi resolver
		}
	}
	const { applyPatterns: applyFilter } = requirePatterns();
	const enabled = applyFilter(candidates, patterns, base);
	return candidates.filter((file) => enabled.has(file));
}

/** applyPatterns 已静态导入；此函数仅为保留清晰的过滤意图。 */
function requirePatterns(): { applyPatterns: typeof applyPatterns } {
	return { applyPatterns };
}

/** 枚举目录下全部技能文件（pi 模式，无 ignore——与 pi 的 collectResourceFiles 一致）。 */
function collectSkillDirFiles(dir: string, mode: "pi" | "agents"): string[] {
	const files: string[] = [];
	collectSkillDir(dir, mode, (path) => files.push(path), dir);
	return files;
}

function collectSkillDir(dir: string, mode: "pi" | "agents", addPath: (path: string) => void, root = dir): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name !== SKILL_FILE) continue;
		const fullPath = join(dir, entry.name);
		if (isFile(fullPath)) addPath(fullPath);
		return;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (isDirectory(fullPath)) {
			collectSkillDir(fullPath, mode, addPath, root);
			continue;
		}
		if (!isFile(fullPath)) continue;
		if (!entry.name.toLowerCase().endsWith(".md")) continue;
		// 顶层 .md 根技能：pi 模式算；agents 模式只认嵌套（由递归进入的子目录提供）。
		if (mode === "pi" || dir !== root) addPath(fullPath);
	}
}

/** 递归收集全部 .md 模板（与 pi 的 collectFiles 对齐）。 */
function collectPromptDirFiles(dir: string): string[] {
	const files: string[] = [];
	collectPromptDir(dir, (path) => files.push(path));
	return files;
}

function collectPromptDir(dir: string, addPath: (path: string) => void): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (isDirectory(fullPath)) {
			collectPromptDir(fullPath, addPath);
			continue;
		}
		if (!isFile(fullPath)) continue;
		if (!entry.name.toLowerCase().endsWith(".md")) continue;
		addPath(fullPath);
	}
}

/** 与 pi 的 collectFilesFromPaths 对齐：递归收集显式扩展目录的入口文件。 */
function collectExtensionEntryFiles(dir: string): string[] {
	const result: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return result;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.endsWith(".d.ts")) continue;
		if (isDirectory(fullPath)) {
			if (existsSync(join(fullPath, "index.ts")) || existsSync(join(fullPath, "index.js"))) {
				result.push(...resolveExtensionEntryPoints(fullPath));
			}
			continue;
		}
		if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) result.push(fullPath);
	}
	return result;
}

function resolveExtensionEntryPoints(dir: string): string[] {
	for (const index of ["index.ts", "index.js"]) {
		const path = join(dir, index);
		if (existsSync(path)) return [path];
	}
	return [];
}

function collectAncestorAgentSkillFiles(startDir: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(startDir);
	while (true) {
		dirs.push(join(dir, ".agents", "skills"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const files: string[] = [];
	for (const skillDir of dirs) {
		files.push(...collectSkillDirFiles(skillDir, "agents"));
	}
	return files;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function extensionSource(path: string): string {
	return path.split(sep).pop() ?? basename(path);
}
