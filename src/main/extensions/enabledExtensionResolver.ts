import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type { DisabledExtensionEntry } from "../../shared/types";
import { INTERNAL_BUILT_IN_EXTENSIONS, listActiveBuiltInExtensionPaths, type BuiltInExtensionPathRoots } from "./builtInExtensions";
import { applyPatterns, readSettingsObject, readStringArray, resolveFromBase, splitResourceEntries } from "../resourceWhitelist";
import { readProjectResourceOverrides } from "../projects/projectResourceOverrides";
import { resolveConfiguredPackageResources } from "../packageResourceResolver";
import { discoverExtensionEntries } from "./extensionDiscovery";

const CONFIG_DIR_NAME = ".pi";

export type EnabledExtensionResolverOptions = {
	/** WSL 场景传入 Windows 侧 home；缺省 homedir()。 */
	agentHomeDir?: string;
	/** 会话项目根（pi 的 cwd），决定项目级 packages 与 .pi/extensions 目录。 */
	cwd: string;
	/** False when pi is started with --no-approve; forces a global-only whitelist. */
	includeProjectResources?: boolean;
	/** PiDeck settings 中的禁用条目（scope+source）。 */
	disabled: DisabledExtensionEntry[];
	/** 已移除的内置扩展（独立机制，不参与 disabled 列表）。 */
	removedBuiltInExtensions: readonly string[];
	/** 内置扩展资源根（dev / packaged）。 */
	builtInRoots: BuiltInExtensionPathRoots;
};

/**
 * 列出「本次会话会加载的扩展入口路径」。
 *
 * 语义（供压缩归属启发式等只读查询使用，不再用于 argv 白名单注入）：
 * 按 pi 的发现规则枚举 user/project 的 packages、本地扩展目录与 settings 显式路径，
 * 叠加原生 `!`/`+`/`-` 过滤与 PiDeck 旧禁用记录（迁移未完成时仍存在），返回最终会加载的路径。
 * **始终返回数组**（没有禁用项时就是全部），避免调用方再用 null 表达「无白名单」。
 */
export function resolveLoadableExtensionPaths(options: EnabledExtensionResolverOptions): string[] {
	const { disabled, cwd } = options;
	const includeProjectResources = options.includeProjectResources !== false;
	const projectBaseDir = join(cwd, CONFIG_DIR_NAME);
	const inheritedDisabled = includeProjectResources ? readProjectResourceOverrides(cwd).disabledGlobalExtensions : [];
	const projectDisabled = includeProjectResources ? readProjectDisabledExtensionSources(projectBaseDir) : [];

	const agentDir = join(options.agentHomeDir?.trim() || homedir(), CONFIG_DIR_NAME, "agent");
	const effectiveDisabled: DisabledExtensionEntry[] = [...disabled, ...inheritedDisabled.map<DisabledExtensionEntry>((source) => ({ scope: "user", source })), ...projectDisabled.map<DisabledExtensionEntry>((source) => ({ scope: "project", source }))];
	const disabledKeys = new Set(effectiveDisabled.map((entry) => `${entry.scope}:${entry.source.trim()}`));
	const isEnabled = (scope: DisabledExtensionEntry["scope"], source: string) => !disabledKeys.has(`${scope}:${source.trim()}`);

	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (path: string) => {
		if (!path || seen.has(path)) return;
		seen.add(path);
		paths.push(path);
	};

	const userSettingsFile = join(agentDir, "settings.json");
	const projectSettingsFile = join(projectBaseDir, "settings.json");
	const userSettings = readSettingsObject(userSettingsFile);
	const projectSettings = includeProjectResources ? readSettingsObject(projectSettingsFile) : {};
	const { plain: userPlain, patterns: userPatterns } = splitResourceEntries(Array.isArray(userSettings.extensions) ? userSettings.extensions : []);
	const { plain: projectPlain, patterns: projectPatterns } = splitResourceEntries(Array.isArray(projectSettings.extensions) ? projectSettings.extensions : []);

	// Auto discovery uses per-scope pattern bases (`~/.pi/agent` and `<cwd>/.pi`).
	const userExtensionDir = join(agentDir, "extensions");
	for (const path of discoverAutoExtensionEntries(userExtensionDir, agentDir, userPatterns)) {
		if (isEnabled("user", autoExtensionSource(userExtensionDir, path))) addPath(path);
	}
	if (includeProjectResources) {
		const projectExtensionDir = join(projectBaseDir, "extensions");
		for (const path of discoverAutoExtensionEntries(projectExtensionDir, projectBaseDir, projectPatterns)) {
			if (isEnabled("project", autoExtensionSource(projectExtensionDir, path))) addPath(path);
		}
	}

	// Explicit settings sources can point to a file or extension directory.
	for (const candidate of collectSettingsExtensionPaths(agentDir, userPlain, userPatterns)) {
		if (isEnabled("user", candidate.source)) addPath(candidate.path);
	}
	if (includeProjectResources) {
		for (const candidate of collectSettingsExtensionPaths(projectBaseDir, projectPlain, projectPatterns)) {
			if (isEnabled("project", candidate.source)) addPath(candidate.path);
		}
	}

	// Packages share one resolver so project precedence, deltas, globs, and managed installs match pi.
	for (const resource of resolveConfiguredPackageResources({
		resourceType: "extensions",
		userSettingsFile,
		userBaseDir: agentDir,
		projectSettingsFile: includeProjectResources ? projectSettingsFile : undefined,
		projectBaseDir: includeProjectResources ? projectBaseDir : undefined,
		collectDirectory: (directory) => discoverAutoExtensionEntries(directory),
	})) {
		if (resource.enabled && isEnabled(resource.scope, resource.source)) addPath(resource.path);
	}

	for (const path of listActiveBuiltInExtensionPaths(options.builtInRoots, options.removedBuiltInExtensions)) {
		const name = basename(path);
		const isInternal = (INTERNAL_BUILT_IN_EXTENSIONS as readonly string[]).includes(name);
		// 内部适配器不是用户可见扩展，必须始终跟随 RPC 加载；否则用户手动写入
		// disabledExtensions / 项目覆盖时会悄悄关闭代理隔离保护。
		if (isInternal || (!inheritedDisabled.includes(name) && isEnabled("user", name))) addPath(path);
	}
	return paths;
}

function readProjectDisabledExtensionSources(projectBaseDir: string): string[] {
	return readStringArray(readSettingsObject(join(projectBaseDir, "settings.json")), "disabledExtensions");
}

function collectSettingsExtensionPaths(baseDir: string, plain: string[], patterns: string[]): Array<{ path: string; source: string }> {
	const candidates: Array<{ path: string; source: string }> = [];
	for (const source of plain) {
		const resolved = resolveFromBase(source, baseDir);
		if (!resolved || !existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				for (const path of discoverAutoExtensionEntries(resolved)) candidates.push({ path, source });
			} else {
				candidates.push({ path: resolved, source });
			}
		} catch {
			// Unreadable explicit paths are ignored, as in pi's package manager.
		}
	}
	const enabled = applyPatterns(
		candidates.map((candidate) => candidate.path),
		patterns,
		baseDir,
	);
	return candidates.filter((candidate) => enabled.has(candidate.path));
}

function autoExtensionSource(directory: string, path: string): string {
	const firstSegment = relative(directory, path).split(sep)[0];
	return firstSegment || basename(path);
}

/** Match pi's automatic extension directory rules and return loader entry paths. */
function discoverAutoExtensionEntries(dir: string, overridesBase = dir, overrides: string[] = []): string[] {
	const candidates = discoverExtensionEntries(dir);
	const enabled = applyPatterns(candidates, overrides, overridesBase);
	return candidates.filter((path) => enabled.has(path));
}
