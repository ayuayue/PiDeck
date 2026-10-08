import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import ignore from "ignore";

/**
 * 资源白名单解析器的公共件：skills 与 prompts 白名单模式（--no-X + 逐条 --X 注入）
 * 共享的过滤规则，逐条对齐 pi 0.85 的 package-manager.js：
 *   - ignore 规则（.gitignore/.ignore/.fdignore，逐目录前缀化）
 *   - settings 数组的 override patterns（! 排除 / + 强制包含 / - 强制排除）
 *   - applyPatterns（include → exclude → force-include → force-exclude）
 *   - matchesAnyPattern（minimatch：相对路径/文件名/绝对路径；SKILL.md 额外匹配父目录）
 *   - settings.json 读取与本地路径解析
 */
export const SKILL_FILE = "SKILL.md";
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export function toPosixPath(p: string): string {
	return p.split("\\").join("/");
}

export function isFileEntry(entry: import("node:fs").Dirent, fullPath: string): boolean {
	if (entry.isFile()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(fullPath).isFile();
	} catch {
		return false;
	}
}

export function isDirEntry(entry: import("node:fs").Dirent, fullPath: string): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(fullPath).isDirectory();
	} catch {
		return false;
	}
}

/** settings 数组的 override pattern 前缀（与 pi 的 isPattern/isOverridePattern 一致）。 */
export function isOverridePattern(entry: string): boolean {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function isPattern(entry: string): boolean {
	return isOverridePattern(entry) || entry.includes("*") || entry.includes("?");
}

/** 拆分 settings 数组条目：plain（显式路径）与 patterns（过滤规则）。 */
export function splitResourceEntries(entries: unknown[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		if (isPattern(entry)) patterns.push(entry);
		else plain.push(entry);
	}
	return { plain, patterns };
}

/** 读取 settings.json 并返回对象；文件缺失/损坏返回空对象。 */
export function readSettingsObject(settingsFile: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

export function readStringArray(settings: Record<string, unknown>, key: string): string[] {
	const value = settings[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 读 pi settings.json 里用户配置的包管理器命令（npmCommand，字符串数组形态，如
 * ["pnpm", "exec", "npm"]）。包资源安装（packageResourceResolver）与扩展版本检查
 * （ExtensionManager.npmViewVersion）共用同一份配置：GUI 启动的 PATH 找不到裸 npm 时
 * （fnm/nvm XDG 布局、自定义安装位置），用户在这里指向可用的包装命令（#318/#263）。
 * 未配置或形态非法（空/含非字符串项）回落 ["npm"]。
 */
export function readConfiguredNpmCommand(settingsFile: string): string[] {
	const configured = readSettingsObject(settingsFile).npmCommand;
	if (Array.isArray(configured) && configured.length > 0 && configured.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
		return configured;
	}
	return ["npm"];
}

// ── ignore 规则（对齐 pi 的 addIgnoreRules / prefixIgnorePattern） ──

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/** 逐目录加载 .gitignore/.ignore/.fdignore，规则按相对 root 的目录前缀化（与 pi 相同）。 */
export function addIgnoreRules(ig: ReturnType<typeof ignore>, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const patterns = readFileSync(ignorePath, "utf8")
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) ig.add(patterns);
		} catch {
			// 规则文件不可读：忽略，与 pi 行为一致
		}
	}
}

// ── override patterns（对齐 pi 的 matchesAnyPattern / isEnabledByOverrides） ──

/**
 * 与 pi 的 matchesAnyPattern 对齐：pattern 依次匹配相对 baseDir 路径、文件名、
 * 绝对路径；SKILL.md 额外匹配父目录的相对路径/父目录名/父目录绝对路径。
 * prompts 文件名不是 SKILL.md，自然退化为前三种匹配（与 pi 一致）。
 */
export function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === SKILL_FILE;
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = parentDir ? toPosixPath(relative(baseDir, parentDir)) : undefined;
	const parentName = parentDir ? basename(parentDir) : undefined;
	const parentDirPosix = parentDir ? toPosixPath(parentDir) : undefined;
	return patterns.some((pattern) => {
		const normalized = toPosixPath(pattern);
		if (minimatch(rel, normalized) || minimatch(name, normalized) || minimatch(filePathPosix, normalized)) {
			return true;
		}
		if (!isSkillFile) return false;
		return Boolean(parentRel && parentName && parentDirPosix && (minimatch(parentRel, normalized) || minimatch(parentName, normalized) || minimatch(parentDirPosix, normalized)));
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

/** `+`/`-` overrides in pi 0.85 match exact paths, never glob expressions or bare filenames. */
export function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = basename(filePath) === SKILL_FILE;
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = parentDir ? toPosixPath(relative(baseDir, parentDir)) : undefined;
	const parentDirPosix = parentDir ? toPosixPath(parentDir) : undefined;
	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) return true;
		return Boolean(isSkillFile && parentRel !== undefined && parentDirPosix !== undefined && (normalized === parentRel || normalized === parentDirPosix));
	});
}

/**
 * settings 数组的 override 过滤（对齐 pi 的 isEnabledByOverrides）：
 * `!` 使用 glob 排除；`+`/`-` 只按精确路径判定，且 `-` 最后生效。
 */
export function passesOverrides(filePath: string, baseDir: string, patterns: string[]): boolean {
	const excludes = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
	const forceIncludes = patterns.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
	const forceExcludes = patterns.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) enabled = false;
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) enabled = true;
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) enabled = false;
	return enabled;
}

/** 对齐 pi 的 applyPatterns：include（普通条目，无则全量）→ exclude(!) → force-include(+) → force-exclude(-)。 */
export function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes = patterns.filter((p) => !isOverridePattern(p));
	const excludes = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
	const forceIncludes = patterns.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
	const forceExcludes = patterns.filter((p) => p.startsWith("-")).map((p) => p.slice(1));

	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}
	return new Set(result);
}

/** autoload:false 的 delta 开关语义；只返回 pattern 明确命中的资源。 */
export function applyAutoloadDisabledPatterns(allPaths: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const prefix = pattern[0];
		const target = prefix === "+" || prefix === "-" || prefix === "!" ? pattern.slice(1) : pattern;
		const exact = prefix === "+" || prefix === "-";
		const enabled = prefix !== "-" && prefix !== "!";
		for (const filePath of allPaths) {
			const matches = exact ? matchesAnyExactPattern(filePath, [target], baseDir) : matchesAnyPattern(filePath, [target], baseDir);
			if (matches) result.set(filePath, enabled);
		}
	}
	return result;
}

/**
 * 按 pi 的 resolvePath 语义解析本地路径：支持绝对路径、~（家目录）与相对 base。
 * 解析失败返回 null（调用方跳过该源）。
 */
export function resolveFromBase(input: string, base: string): string | null {
	const trimmed = input.replace(/^["']|["']$/g, "").trim();
	if (!trimmed) return null;
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return join(homedir(), trimmed.slice(2));
	}
	if (isAbsolute(trimmed)) return normalize(trimmed);
	return resolve(base, trimmed);
}
