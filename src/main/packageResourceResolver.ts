import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyAutoloadDisabledPatterns, applyPatterns, isOverridePattern, readConfiguredNpmCommand, readSettingsObject, resolveFromBase } from "./resourceWhitelist";

export type PackageResourceType = "extensions" | "skills" | "prompts";
export type PackageResourceScope = "user" | "project";

export type ResolvedPackageResource = {
	path: string;
	scope: PackageResourceScope;
	/** Scope that owns the physical installation. A project delta can point at a user install. */
	physicalScope: PackageResourceScope;
	source: string;
	enabled: boolean;
	/** 包自身 package.json 的 version（向上就近查找）；本地裸文件/无清单时缺省。 */
	version?: string;
};

type PackageResourceOptions = {
	resourceType: PackageResourceType;
	userSettingsFile: string;
	userBaseDir: string;
	projectSettingsFile?: string;
	projectBaseDir?: string;
	collectDirectory: (directory: string) => string[];
};

type ConfiguredPackage = {
	raw: unknown;
	source: string;
	scope: PackageResourceScope;
	baseDir: string;
	settingsFile: string;
	filter: Record<string, unknown> | null;
};

type ParsedPackageSource = { type: "npm"; name: string } | { type: "git"; host: string; path: string } | { type: "local"; path: string };

type PiManifest = Partial<Record<PackageResourceType, string[]>>;

const PACKAGE_RESOURCE_TYPES: PackageResourceType[] = ["extensions", "skills", "prompts"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredPackages(settingsFile: string, scope: PackageResourceScope, baseDir: string): ConfiguredPackage[] {
	const packages = readSettingsObject(settingsFile).packages;
	if (!Array.isArray(packages)) return [];
	const result: ConfiguredPackage[] = [];
	for (const raw of packages) {
		const filter = isRecord(raw) ? raw : null;
		const source = typeof raw === "string" ? raw : filter?.source;
		if (typeof source !== "string" || !source.trim()) continue;
		result.push({ raw, source: source.trim(), scope, baseDir, settingsFile, filter });
	}
	return result;
}

function parseNpmName(spec: string): string | null {
	const match = spec.trim().match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const name = (match?.[1] ?? spec.trim()).trim();
	if (!name || name.split("/").some((part) => !part || part === "." || part === "..")) return null;
	return name;
}

function stripGitRef(path: string): string {
	const at = path.indexOf("@");
	return at >= 0 ? path.slice(0, at) : path;
}

function validGitLocation(host: string, path: string): { host: string; path: string } | null {
	const normalizedHost = host.trim();
	const normalizedPath = stripGitRef(path)
		.replace(/^\/+/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	if (!normalizedHost || !normalizedPath || normalizedPath.split("/").length < 2) return null;
	const decoded = (value: string): string | null => {
		try {
			return decodeURIComponent(value);
		} catch {
			return null;
		}
	};
	const decodedHost = decoded(normalizedHost);
	const decodedPath = decoded(normalizedPath);
	if (decodedHost === null || decodedPath === null) return null;
	for (const candidate of [normalizedHost, decodedHost]) {
		if (candidate.includes("\0") || candidate.includes("/") || candidate.includes("\\") || candidate === "..") return null;
	}
	for (const candidate of [normalizedPath, decodedPath]) {
		if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/") || candidate.split("/").includes("..")) return null;
	}
	return { host: normalizedHost, path: normalizedPath };
}

/** Parse the managed git source forms accepted by pi without importing pi's private runtime. */
function parseGitLocation(source: string): { host: string; path: string } | null {
	let value = source.trim();
	if (value.startsWith("git:")) value = value.slice(4).trim();
	if (value.startsWith("github:")) {
		return validGitLocation("github.com", value.slice("github:".length).replace(/#.*$/, ""));
	}
	const scp = /^git@([^:]+):(.+)$/.exec(value);
	if (scp) return validGitLocation(scp[1], scp[2]);
	if (/^(?:https?|ssh|git):\/\//i.test(value)) {
		try {
			const parsed = new URL(value);
			return validGitLocation(parsed.hostname, parsed.pathname);
		} catch {
			return null;
		}
	}
	const slash = value.indexOf("/");
	if (slash > 0) {
		const host = value.slice(0, slash);
		if (host.includes(".") || host === "localhost") {
			return validGitLocation(host, value.slice(slash + 1).replace(/#.*$/, ""));
		}
	}
	return null;
}

function parsePackageSource(source: string): ParsedPackageSource {
	if (source.startsWith("npm:")) {
		const name = parseNpmName(source.slice(4));
		return name ? { type: "npm", name } : { type: "local", path: source };
	}
	if (/^(?:git:|https?:\/\/|ssh:\/\/)/i.test(source)) {
		const git = parseGitLocation(source);
		if (git) return { type: "git", ...git };
	}
	return { type: "local", path: source };
}

function managedPath(root: string, ...parts: string[]): string | null {
	const resolvedRoot = resolve(root);
	const target = resolve(resolvedRoot, ...parts);
	const rel = relative(resolvedRoot, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? target : null;
}

const globalNpmRootCache = new Map<string, string | null>();
const pnpmPackagePathCache = new Map<string, Map<string, string>>();

function npmCommand(settingsFile: string): string[] {
	return readConfiguredNpmCommand(settingsFile);
}

function packageManagerName(command: string[]): string {
	const separatorIndex = command.lastIndexOf("--");
	const executable = separatorIndex >= 0 ? command[separatorIndex + 1] : command[0];
	return basename(executable ?? "")
		.replace(/\.(?:cmd|exe)$/i, "")
		.toLowerCase();
}

function runPackageManagerSync(command: string[], args: string[]): string {
	const executable = command[0];
	if (!executable) throw new Error("Invalid npm command");
	return execFileSync(executable, [...command.slice(1), ...args], {
		encoding: "utf8",
		timeout: 5_000,
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function pnpmGlobalPackagePath(command: string[], packageName: string): string | null {
	const key = command.join("\0");
	let packages = pnpmPackagePathCache.get(key);
	if (!packages) {
		packages = new Map();
		const parsed: unknown = JSON.parse(runPackageManagerSync(command, ["list", "-g", "--depth", "0", "--json"]));
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (!isRecord(entry) || !isRecord(entry.dependencies)) continue;
				for (const [name, detail] of Object.entries(entry.dependencies)) {
					if (isRecord(detail) && typeof detail.path === "string") packages.set(name, detail.path);
				}
			}
		}
		pnpmPackagePathCache.set(key, packages);
	}
	return packages.get(packageName) ?? null;
}

function legacyGlobalNpmPackagePath(settingsFile: string, packageName: string): string | null {
	try {
		const command = npmCommand(settingsFile);
		if (packageManagerName(command) === "pnpm") {
			return pnpmGlobalPackagePath(command, packageName);
		}
		const key = command.join("\0");
		let root = globalNpmRootCache.get(key);
		if (root === undefined) {
			if (packageManagerName(command) === "bun") {
				const binDir = runPackageManagerSync(command, ["pm", "bin", "-g"]);
				root = join(dirname(binDir), "install", "global", "node_modules");
			} else {
				root = runPackageManagerSync(command, ["root", "-g"]);
			}
			globalNpmRootCache.set(key, root || null);
		}
		return root ? join(root, ...packageName.split("/")) : null;
	} catch {
		return null;
	}
}

function resolveLocalSource(source: string, baseDir: string): string | null {
	if (source.startsWith("file://")) {
		try {
			return fileURLToPath(source);
		} catch {
			return null;
		}
	}
	return resolveFromBase(source.startsWith("file:") ? source.slice(5) : source, baseDir);
}

function resolveInstalledPath(entry: ConfiguredPackage): { path: string; parsed: ParsedPackageSource } | null {
	const { source, baseDir } = entry;
	const parsed = parsePackageSource(source);
	let candidate: string | null;
	if (parsed.type === "npm") {
		const managed = managedPath(join(baseDir, "npm", "node_modules"), ...parsed.name.split("/"));
		if (managed && existsSync(managed)) return { path: managed, parsed };
		const legacy = entry.scope === "user" ? legacyGlobalNpmPackagePath(entry.settingsFile, parsed.name) : null;
		candidate = legacy && existsSync(legacy) ? legacy : managed;
	} else if (parsed.type === "git") {
		candidate = managedPath(join(baseDir, "git"), parsed.host, ...parsed.path.split("/"));
	} else {
		candidate = resolveLocalSource(parsed.path, baseDir);
	}
	return candidate && existsSync(candidate) ? { path: candidate, parsed } : null;
}

function packageIdentity(entry: ConfiguredPackage): string {
	const parsed = parsePackageSource(entry.source);
	if (parsed.type === "npm") return `npm:${parsed.name}`;
	if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
	return `local:${resolveLocalSource(parsed.path, entry.baseDir) ?? parsed.path}`;
}

/** Project package configuration wins; `autoload:false` remains a delta over the user package. */
function dedupePackages(entries: ConfiguredPackage[]): ConfiguredPackage[] {
	const result: ConfiguredPackage[] = [];
	const seen = new Map<string, number>();
	for (const entry of entries) {
		const identity = packageIdentity(entry);
		const existingIndex = seen.get(identity);
		if (existingIndex === undefined) {
			seen.set(identity, result.length);
			result.push(entry);
			continue;
		}
		const existing = result[existingIndex];
		if (existing.scope === "project" && entry.scope === "user") {
			if (existing.filter?.autoload === false) result.push(entry);
		} else if (entry.scope === "project") {
			result[existingIndex] = entry;
		}
	}
	return result;
}

/**
 * 就近向上查 package.json 读包版本：遇到第一个 package.json 就停（无 version 也停），
 * 防止把 pnpm store 根/祖先目录的版本串报给子包；仅 ENOENT 才继续向上，最多 6 跳。
 */
export function readPackageVersion(startPath: string): string | undefined {
	let current = resolve(startPath);
	for (let hops = 0; hops < 6; hops += 1) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(current, "package.json"), "utf8").replace(/^\uFEFF/, ""));
			if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
			return undefined;
		} catch (error) {
			// 文件不存在才向上找；读不了/解析失败视为「该包无版本」，不再向上串。
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

function readPiManifest(packageRoot: string): PiManifest | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8").replace(/^\uFEFF/, ""));
		if (!isRecord(parsed) || !isRecord(parsed.pi)) return null;
		const manifest: PiManifest = {};
		for (const type of PACKAGE_RESOURCE_TYPES) {
			const entries = parsed.pi[type];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[type] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}

function hasGlobPattern(value: string): boolean {
	return value.includes("*") || value.includes("?");
}

function expandManifestSource(entry: string, root: string): string[] {
	if (!hasGlobPattern(entry)) return [resolve(root, entry)];
	try {
		return globSync(entry, { cwd: root })
			.map((match) => resolve(root, match))
			.filter((path) =>
				relative(root, path)
					.split(sep)
					.every((segment) => segment === ".." || !segment.startsWith(".")),
			)
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

function collectFilesFromPaths(paths: string[], collectDirectory: (directory: string) => string[]): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const collected = statSync(path).isDirectory() ? collectDirectory(path) : [path];
			for (const file of collected) {
				const normalized = resolve(file);
				if (!seen.has(normalized)) {
					seen.add(normalized);
					files.push(normalized);
				}
			}
		} catch {
			// An unreadable package entry is ignored, matching pi's package resolver.
		}
	}
	return files;
}

function collectManifestFiles(packageRoot: string, entries: string[], collectDirectory: (directory: string) => string[]): string[] {
	const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
	const paths = sourceEntries.flatMap((entry) => expandManifestSource(entry, packageRoot));
	const allFiles = collectFilesFromPaths(paths, collectDirectory);
	const overrides = entries.filter(isOverridePattern);
	const enabled = applyPatterns(allFiles, overrides, packageRoot);
	return allFiles.filter((path) => enabled.has(path));
}

function conventionFiles(packageRoot: string, resourceType: PackageResourceType, collectDirectory: (directory: string) => string[]): string[] {
	const directory = join(packageRoot, resourceType);
	return existsSync(directory) ? collectDirectory(directory) : [];
}

function allFilterableFiles(packageRoot: string, resourceType: PackageResourceType, manifest: PiManifest | null, collectDirectory: (directory: string) => string[]): string[] {
	const entries = manifest?.[resourceType];
	return entries && entries.length > 0 ? collectManifestFiles(packageRoot, entries, collectDirectory) : conventionFiles(packageRoot, resourceType, collectDirectory);
}

function resolveOnePackage(entry: ConfiguredPackage, physicalEntry: ConfiguredPackage, resourceType: PackageResourceType, collectDirectory: (directory: string) => string[]): Array<{ path: string; enabled: boolean }> {
	const installed = resolveInstalledPath(physicalEntry);
	if (!installed) return [];
	const packageRoot = installed.path;
	if (installed.parsed.type === "local") {
		try {
			if (statSync(packageRoot).isFile()) {
				return resourceType === "extensions" ? [{ path: packageRoot, enabled: true }] : [];
			}
		} catch {
			return [];
		}
	}

	const manifest = readPiManifest(packageRoot);
	const patternsValue = entry.filter?.[resourceType];
	const patterns = Array.isArray(patternsValue) ? patternsValue.filter((item): item is string => typeof item === "string") : undefined;
	let resolved: Array<{ path: string; enabled: boolean }>;
	if (entry.filter?.autoload === false) {
		if (!patterns || patterns.length === 0) return [];
		const allFiles = allFilterableFiles(packageRoot, resourceType, manifest, collectDirectory);
		resolved = [...applyAutoloadDisabledPatterns(allFiles, patterns, packageRoot)].map(([path, enabled]) => ({ path, enabled }));
	} else if (patterns !== undefined) {
		const allFiles = allFilterableFiles(packageRoot, resourceType, manifest, collectDirectory);
		const enabled = patterns.length > 0 ? applyPatterns(allFiles, patterns, packageRoot) : new Set<string>();
		resolved = allFiles.map((path) => ({ path, enabled: enabled.has(path) }));
	} else if (entry.filter !== null) {
		const entries = manifest?.[resourceType];
		resolved = entries !== undefined ? collectManifestFiles(packageRoot, entries, collectDirectory).map((path) => ({ path, enabled: true })) : conventionFiles(packageRoot, resourceType, collectDirectory).map((path) => ({ path, enabled: true }));
	} else if (manifest) {
		const entries = manifest[resourceType];
		resolved = entries ? collectManifestFiles(packageRoot, entries, collectDirectory).map((path) => ({ path, enabled: true })) : [];
	} else {
		resolved = conventionFiles(packageRoot, resourceType, collectDirectory).map((path) => ({ path, enabled: true }));
	}

	if (resolved.length === 0 && resourceType === "extensions" && installed.parsed.type === "local" && entry.filter === null && manifest === null && !["extensions", "skills", "prompts", "themes"].some((name) => existsSync(join(packageRoot, name)))) {
		return [{ path: packageRoot, enabled: true }];
	}
	return resolved;
}

function canonicalResourceKey(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A package can disappear between collection and deduplication; retain its lexical identity
		// so the resolver remains best-effort instead of turning a transient race into a crash.
		return resolve(path);
	}
}

/**
 * Resolve configured package resources using pi 0.85 ordering and filter semantics. The result
 * retains disabled delta entries so a lower-precedence user package cannot add them back.
 */
export function resolveConfiguredPackageResources(options: PackageResourceOptions): ResolvedPackageResource[] {
	const projectEntries = options.projectSettingsFile && options.projectBaseDir ? configuredPackages(options.projectSettingsFile, "project", options.projectBaseDir) : [];
	const userEntries = configuredPackages(options.userSettingsFile, "user", options.userBaseDir);
	const allEntries = [...projectEntries, ...userEntries];
	const entries = dedupePackages(allEntries);
	const resources = new Map<string, ResolvedPackageResource>();

	for (const entry of entries) {
		let physicalEntry = entry;
		if (entry.scope === "project" && entry.filter?.autoload === false) {
			const identity = packageIdentity(entry);
			physicalEntry = userEntries.find((candidate) => packageIdentity(candidate) === identity) ?? entry;
		}
		for (const resource of resolveOnePackage(entry, physicalEntry, options.resourceType, options.collectDirectory)) {
			const path = resolve(resource.path);
			const resourceKey = canonicalResourceKey(path);
			if (!resources.has(resourceKey)) {
				resources.set(resourceKey, {
					path,
					scope: entry.scope,
					physicalScope: physicalEntry.scope,
					source: entry.source,
					enabled: resource.enabled,
					version: readPackageVersion(path),
				});
			}
		}
	}
	return [...resources.values()];
}
