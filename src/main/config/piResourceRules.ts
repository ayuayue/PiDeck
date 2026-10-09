/**
 * pi 原生资源配置规则的纯函数层（计划 A2）。
 *
 * 语义（pi 0.99.2 `package-manager.js` / `settings.md`）：
 * - `extensions/skills/prompts/themes` 数组支持：`!pattern` 排除、`+path` 精确包含、
 *   `-path` 精确排除；生效顺序是 排除 → 精确包含 → 精确排除（不是「最后一条赢」）。
 * - 精确等于目标路径的规则由本模块生成；用户手写的 glob/其它路径一律不动。
 * - `builtin:<name>`（扩展）用同一套 `+`/`-` 语法。
 *
 * 这里只做「怎么改数组」的纯计算，不读写文件、不解析真实资源来源——
 * 那是 PiResourceConfigService 的职责。
 */

import { minimatch } from "minimatch";
import type { PiBuiltinExtension, PiResourceKind } from "../../shared/types/piResources";
import { builtinSpecifier } from "../../shared/types/piResources";

/** 归一化用于比较；大小写与分隔符差异在 Windows 上不构成不同资源。 */
export function normalizeResourceValue(value: string, platform: NodeJS.Platform = process.platform): string {
	const trimmed = value.trim();
	const unified = trimmed.replace(/\\/g, "/");
	return platform === "win32" ? unified.toLowerCase() : unified;
}

function isExactMatch(entry: string, value: string, platform: NodeJS.Platform): boolean {
	if (entry.startsWith("+") || entry.startsWith("-")) {
		return normalizeResourceValue(entry.slice(1), platform) === normalizeResourceValue(value, platform);
	}
	return normalizeResourceValue(entry, platform) === normalizeResourceValue(value, platform);
}

/** 数组里是否已有「精确等于该值」的条目（不含更宽的 glob）。 */
export function hasExactResourceEntry(entries: readonly string[], value: string, platform: NodeJS.Platform = process.platform): boolean {
	return entries.some((entry) => isExactMatch(entry, value, platform));
}

/**
 * 去掉所有精确指向该值的 `+value`/`-value` 过滤规则。
 * **显式路径条目（plain）一律保留**：它是来源声明而不是过滤规则，删掉资源就从发现集合消失，
 * 「停用再启用」永远回不来（见计划 4.1）。
 */
export function stripExactResourceRules(entries: readonly string[], value: string, platform: NodeJS.Platform = process.platform): string[] {
	return entries.filter((entry) => {
		if (!entry.startsWith("+") && !entry.startsWith("-")) return true;
		return !isExactMatch(entry, value, platform);
	});
}

/**
 * 去掉「恰好指向某个包安装目录」的精确规则（`+`/`-` 前缀）。
 *
 * 背景（2026-10 事故）：旧禁用记录迁移曾把「指向包安装的禁用」写成顶层 `extensions` 的
 * `-<包目录>`。pi 的精确匹配只认资源文件路径（包内入口文件），包目录规则对 pi 是惰性的，
 * 但列表投影按值相等比对会命中 → 包内扩展显示成已停用，开关写成功后弹回（Windows/Linux
 * 同码，差别只在磁盘上是否残留这条规则）。
 *
 * 只删除「精确等于包目录」的规则：包内**文件**路径的精确规则对 pi 有效，动了会改变真实
 * 加载结果；plain 声明条目一律保留（删掉会让来源从发现集合消失，见 stripExactResourceRules）。
 */
export function stripPackageRootResourceRules(options: { entries: readonly string[]; packageDirs: readonly string[]; platform?: NodeJS.Platform }): { entries: string[]; removed: string[] } {
	const platform = options.platform ?? process.platform;
	const targets = new Set(options.packageDirs.map((dir) => normalizeResourceValue(dir, platform)));
	const entries: string[] = [];
	const removed: string[] = [];
	for (const entry of options.entries) {
		const isRule = entry.startsWith("+") || entry.startsWith("-");
		if (isRule && targets.has(normalizeResourceValue(entry.slice(1), platform))) {
			removed.push(entry);
			continue;
		}
		entries.push(entry);
	}
	return { entries, removed };
}

/**
 * 把一条资源置为启用/停用。
 *
 * - 启用：移除精确负项，再按需补一个精确 `+value`（覆盖用户更宽的 `!glob`）。
 * - 停用：移除精确正项，写精确 `-value`。
 * - 不删除显式路径条目（`plain`）：显式来源被删掉后，`-` 也匹配不到，资源会直接消失；
 *   「停用再启用」必须能回到原状（见计划 4.1）。
 */
export function setResourceRuleEnabled(options: { entries: readonly string[]; value: string; enabled: boolean; platform?: NodeJS.Platform }): string[] {
	const { entries, value, enabled } = options;
	const cleaned = stripExactResourceRules(entries, value, options.platform ?? process.platform);
	// 显式路径（plain）一律保留：删了后就再也匹配不到，停用-启用无法往返。
	return enabled ? [...cleaned, `+${value}`] : [...cleaned, `-${value}`];
}

/** 切换已启用资源时删除仅用于覆盖的 `+` 条目，同时保留用户显式路径。 */
export function restoreResourceRuleEntries(options: { entries: readonly string[]; value: string; before?: readonly string[]; platform?: NodeJS.Platform }): string[] {
	const platform = options.platform ?? process.platform;
	return stripExactResourceRules(options.entries, options.value, platform);
}

/**
 * 从原始条目 + 生效判定计算某条资源的有效状态。
 * `resolved` 是上游（pi 语义模拟）给出的「该值是否被加载」，未知时调用方传 undefined → unavailable。
 */
export function effectiveResourceState(resolved: boolean | undefined): "enabled" | "disabled" | "unavailable" {
	if (resolved === undefined) return "unavailable";
	return resolved ? "enabled" : "disabled";
}

// ── 包整体启停 ──────────────────────────────────────────────

/** 一组包过滤快照：四类资源各自的原始值（字符串 source 时是 undefined = 沿用包声明）。 */
export type PackageFilterSnapshot = Partial<Record<PiResourceKind, string[]>>;

export type PackageEntryShape = {
	source?: string;
	[filter: string]: unknown;
};

/**
 * 生成整包停用后的包条目：只覆盖四类过滤为 `[]`，保留 source 与其它未知字段。
 * （`[]` 表示「不加载该类」，与 pi 的普通包语义一致。）
 */
export function disablePackageFilters<T extends PackageEntryShape>(entry: T): T & PackageFilterSnapshot {
	return { ...entry, extensions: [], skills: [], prompts: [], themes: [] };
}

/** 该条目是否等于「被本模块整包停用」的形状（用于幂等判断）。 */
export function isPackageFullyDisabled(entry: PackageEntryShape): boolean {
	return (["extensions", "skills", "prompts", "themes"] as PiResourceKind[]).every((kind) => Array.isArray(entry[kind]) && (entry[kind] as unknown[]).length === 0);
}

/**
 * 项目层 delta（`autoload:false`）的整包停用/强制启用过滤。
 * - 停用：`["!*", "!.*"]`（排除所有文件，含隐藏文件与隐藏目录下的文件）
 * - 强制启用：`["*", ".*"]`
 * 不能写成四个空数组：delta 里的 `[]` 是「没有覆盖」，不是「全部禁用」。
 */
export const PACKAGE_DELTA_DISABLE_PATTERNS: readonly string[] = ["!*", "!.*"];
export const PACKAGE_DELTA_ENABLE_PATTERNS: readonly string[] = ["*", ".*"];

export function disablePackageDeltaFilters<T extends PackageEntryShape>(entry: T): T & PackageFilterSnapshot {
	return {
		...entry,
		extensions: [...PACKAGE_DELTA_DISABLE_PATTERNS],
		skills: [...PACKAGE_DELTA_DISABLE_PATTERNS],
		prompts: [...PACKAGE_DELTA_DISABLE_PATTERNS],
		themes: [...PACKAGE_DELTA_DISABLE_PATTERNS],
	};
}

export function enablePackageDeltaFilters<T extends PackageEntryShape>(entry: T): T & PackageFilterSnapshot {
	return {
		...entry,
		extensions: [...PACKAGE_DELTA_ENABLE_PATTERNS],
		skills: [...PACKAGE_DELTA_ENABLE_PATTERNS],
		prompts: [...PACKAGE_DELTA_ENABLE_PATTERNS],
		themes: [...PACKAGE_DELTA_ENABLE_PATTERNS],
	};
}

/** 该条目是否等于「被本模块整包停用」的 delta 形状。 */
export function isPackageDeltaFullyDisabled(entry: PackageEntryShape): boolean {
	return (["extensions", "skills", "prompts", "themes"] as PiResourceKind[]).every((kind) => {
		const value = entry[kind];
		return Array.isArray(value) && value.length === PACKAGE_DELTA_DISABLE_PATTERNS.length && PACKAGE_DELTA_DISABLE_PATTERNS.every((pattern, index) => value[index] === pattern);
	});
}

// ── 有效状态投影 ────────────────────────────────────────────

/**
 * 按 pi 的原生顺序判定一个资源值是否被加载：排除(`!`) → 强制包含(`+`) → 强制排除(`-`)。
 * 这是给「列表显示」用的投影，运行时真值仍是 pi 自己（见计划 3.3）。
 * `baseEntries` 为下层（项目层读全局层时传入）原始条目。
 */
export function projectResourceEnabled(options: { baseEntries?: readonly string[]; entries: readonly string[]; value: string; baseDir: string; matcher?: (value: string, patterns: string[], baseDir: string) => boolean }): boolean {
	const evaluate = (entries: readonly string[]): boolean => {
		const excludes = entries.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
		const forceIncludes = entries.filter((entry) => entry.startsWith("+") && !entry.startsWith("++")).map((entry) => entry.slice(1));
		const forceExcludes = entries.filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1));
		let enabled = true;
		if (excludes.some((pattern) => patternMatches(options.value, pattern, options.baseDir))) enabled = false;
		if (forceIncludes.some((pattern) => patternMatches(options.value, pattern, options.baseDir))) enabled = true;
		if (forceExcludes.some((pattern) => patternMatches(options.value, pattern, options.baseDir))) enabled = false;
		return enabled;
	};
	// 项目层：先按全局得出结果，再叠加项目层条目（与 pi 的两层合并近似一致）。
	if (options.baseEntries && options.baseEntries.length > 0 && !evaluate(options.baseEntries)) {
		// 全局已排除：只有项目层精确 `+` 才能重新启用。
		const forceIncludes = options.entries.filter((entry) => entry.startsWith("+")).map((entry) => entry.slice(1));
		return forceIncludes.some((pattern) => patternMatches(options.value, pattern, options.baseDir));
	}
	return evaluate(options.entries);
}

/**
 * 精确规则匹配，**逐条对齐 pi 的 matchesAnyExactPattern**（真实冒烟校准，2026-10-01）：
 * - 非技能文件：条目 === 相对路径（相对 baseDir）或 === 绝对路径才命中；
 * - SKILL.md：额外命中父目录的相对路径 / 绝对路径；
 * - **不匹配裸文件名或裸目录名**——此前实现多加了 basename 匹配，导致投影把
 *   pi 实际会加载的资源显示成已停用（pi 对 `-目录名` 不生效，冒烟已复现）。
 * `!`/`+`/`-` 前缀由调用方剥掉后传入；`*` 通配走简化全路径/文件名匹配（仅 `!` 排除用）。
 */
function patternMatches(value: string, pattern: string, baseDir: string): boolean {
	const valuePosix = value.replace(/\\/g, "/");
	const patternPosix = pattern.replace(/\\/g, "/");
	// normalizeExactPattern：剥掉 "./" 前缀后转 POSIX（pi 同款）。
	const normalized = patternPosix.startsWith("./") ? patternPosix.slice(2) : patternPosix;
	const baseDirPosix = baseDir.replace(/\\/g, "/").replace(/\/$/, "");
	const rel = baseDirPosix ? relativePosix(baseDirPosix, valuePosix) : valuePosix;
	const isSkillFile = (valuePosix.split("/").pop() ?? "") === "SKILL.md";
	const parentDir = isSkillFile ? valuePosix.slice(0, valuePosix.lastIndexOf("/")) : undefined;
	const parentRel = parentDir && baseDirPosix ? relativePosix(baseDirPosix, parentDir) : undefined;
	if (patternPosix.includes("*") || patternPosix.includes("?")) {
		// 通配（仅 `!` 排除路径用到）：全路径或文件名的简化 glob。
		const escaped = patternPosix
			.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".");
		try {
			const re = new RegExp(`^${escaped}$`);
			return re.test(valuePosix) || re.test(valuePosix.split("/").pop() ?? "") || (parentDir ? re.test(parentDir) : false);
		} catch {
			return false;
		}
	}
	if (normalized === rel || normalized === valuePosix) return true;
	if (!isSkillFile) return false;
	return normalized === parentRel || normalized === parentDir;
}

/** POSIX 版 path.relative（分隔符已归一，纯字符串推导避免跨平台 path 语义差异）。 */
function relativePosix(from: string, to: string): string {
	const a = from.split("/");
	const b = to.split("/");
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
	const up = a
		.slice(i)
		.filter((segment) => segment.length > 0)
		.map(() => "..");
	const rest = b.slice(i);
	return [...up, ...rest].join("/");
}

// ── 原生内置扩展 ────────────────────────────────────────────

/**
 * 切换某个原生内置扩展在本层的状态。
 * 与原生的关系：`-builtin:mcp` 停用；启用时删除精确负项并补 `+builtin:mcp`
 * （覆盖用户更宽的 `!builtin:*`）。
 */
export function setBuiltinExtensionEnabled(options: { entries: readonly string[]; name: PiBuiltinExtension; enabled: boolean }): string[] {
	const specifier = builtinSpecifier(options.name);
	// builtin 是虚拟标识符，不是 Windows 文件路径；按 pi 的精确规则清理，保留用户 glob。
	const cleaned = options.entries.filter((entry) => !(entry.startsWith("+") || entry.startsWith("-")) || !builtinPatternMatches(specifier, entry.slice(1), true));
	return options.enabled ? [...cleaned, `+${specifier}`] : [...cleaned, `-${specifier}`];
}

/**
 * 投影 pi 的内置扩展规则：全局按 ! → + → - 生效，项目按最后一条匹配的覆盖规则生效。
 * 两层顺序不同（package-manager 的 isEnabledByOverrides / applyAutoloadDisabledPatterns），
 * 不能合并成同一套求值；plain 来源声明不算显式覆盖。
 */
export function resolveBuiltinExtensionState(options: { baseEntries?: readonly string[]; entries: readonly string[]; name: PiBuiltinExtension; platform?: NodeJS.Platform }): { enabled: boolean; explicitInLayer: boolean; explicitInBase: boolean } {
	const specifier = builtinSpecifier(options.name);
	const matches = (entry: string): boolean => {
		if (entry.startsWith("!")) return builtinPatternMatches(specifier, entry.slice(1), false);
		return (entry.startsWith("+") || entry.startsWith("-")) && builtinPatternMatches(specifier, entry.slice(1), true);
	};
	const evaluateGlobal = (entries: readonly string[]): boolean => {
		let enabled = !entries.some((entry) => entry.startsWith("!") && matches(entry));
		if (entries.some((entry) => entry.startsWith("+") && matches(entry))) enabled = true;
		if (entries.some((entry) => entry.startsWith("-") && matches(entry))) enabled = false;
		return enabled;
	};
	let enabled = evaluateGlobal(options.baseEntries ?? options.entries);
	if (options.baseEntries !== undefined) {
		for (const entry of options.entries) {
			if (matches(entry)) enabled = entry.startsWith("+");
		}
	}
	return {
		enabled,
		explicitInLayer: options.entries.some(matches),
		explicitInBase: (options.baseEntries ?? []).some(matches),
	};
}

/** 虚拟路径区分大小写；! 用 minimatch，+/- 只剥 ./ 前缀后精确匹配，与 pi 一致。 */
function builtinPatternMatches(value: string, pattern: string, exact: boolean): boolean {
	const normalized = pattern.replace(/\\/g, "/");
	if (exact) return (normalized.startsWith("./") ? normalized.slice(2) : normalized) === value;
	return minimatch(value, normalized);
}
