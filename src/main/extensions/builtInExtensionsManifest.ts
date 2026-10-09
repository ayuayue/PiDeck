/**
 * 内置扩展清单（extensions-manifest.json）的解析、校验与本机读取。
 *
 * 清单由 scripts/generate-extensions-manifest.mjs 生成并提交到仓库（main 分支），
 * 客户端从 AtomGit / GitHub 拉取后据此判定「哪些扩展文件需要更新」。
 *
 * 清单来自网络，属**不可信输入**：文件名必须是无路径分隔符的 `.ts`、sha256 必须是
 * 64 位十六进制、bytes 必须是正整数。任一不符就整份丢弃——宁可当作「没有更新」，
 * 也不能把可疑数据写进 pi 的 `-e` 注入路径。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXTENSIONS_MANIFEST_SCHEMA_VERSION = 1;
export const EXTENSIONS_MANIFEST_FILE_NAME = "extensions-manifest.json";
/** 覆盖层目录名（位于 userData 下）——生效的内置扩展快照。 */
export const BUILT_IN_EXTENSIONS_OVERLAY_DIR_NAME = "builtin-extensions";
/** 上一个覆盖版的备份目录名（同级，供「恢复上一个覆盖版」）。 */
export const BUILT_IN_EXTENSIONS_OVERLAY_BACKUP_DIR_NAME = "builtin-extensions.bak";

/** 文件名白名单形态：单段、以 .ts 结尾，不含路径分隔符（防目录穿越）。 */
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.ts$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
/** 版本号形态与生成脚本保持一致，宽松到「数字点分 + 可选预发布后缀」。 */
const VERSION_PATTERN = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/;

export type BuiltInExtensionsManifestFile = {
	name: string;
	sha256: string;
	bytes: number;
};

export type BuiltInExtensionsManifest = {
	schemaVersion: number;
	version: string;
	bundleSha256: string;
	fileCount: number;
	files: BuiltInExtensionsManifestFile[];
};

export function sha256Of(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析并严格校验清单文本。任何结构/取值异常返回 null（调用方视为「本次拿不到有效清单」，
 * 保持当前生效版本不变，而不是把半可信数据落盘）。
 */
export function parseBuiltInExtensionsManifest(raw: string): BuiltInExtensionsManifest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed.schemaVersion !== EXTENSIONS_MANIFEST_SCHEMA_VERSION) return null;

	const version = parsed.version;
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return null;

	const rawFiles = parsed.files;
	if (!Array.isArray(rawFiles) || rawFiles.length === 0) return null;

	const files: BuiltInExtensionsManifestFile[] = [];
	const seen = new Set<string>();
	for (const entry of rawFiles) {
		if (!isRecord(entry)) return null;
		const name = entry.name;
		const sha256 = entry.sha256;
		const bytes = entry.bytes;
		if (typeof name !== "string" || !FILE_NAME_PATTERN.test(name)) return null;
		if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
		if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
		// 同名重复会让「以文件名为键」的比对产生歧义，直接判非法
		if (seen.has(name)) return null;
		seen.add(name);
		files.push({ name, sha256: sha256.toLowerCase(), bytes });
	}

	const bundleSha256 = parsed.bundleSha256;
	return {
		schemaVersion: EXTENSIONS_MANIFEST_SCHEMA_VERSION,
		version,
		bundleSha256: typeof bundleSha256 === "string" && SHA256_PATTERN.test(bundleSha256) ? bundleSha256.toLowerCase() : "",
		// fileCount 由 files 长度推出，不信任清单里的自报值
		fileCount: files.length,
		files,
	};
}

/** 读目录下的清单文件并解析；缺失/非法返回 null。 */
export function readManifestFromDir(dir: string): BuiltInExtensionsManifest | null {
	try {
		const manifestPath = join(dir, EXTENSIONS_MANIFEST_FILE_NAME);
		if (!existsSync(manifestPath)) return null;
		return parseBuiltInExtensionsManifest(readFileSync(manifestPath, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 逐文件 sha256 记忆化（按解析后的绝对路径索引）。
 *
 * 为什么需要：内置扩展目录会被反复整份校验——热更新面板 getStatus() 对 builtin 与 overlay
 * 各来一次，loadList 又经 readEffectiveBuiltInExtensionsVersion 每次走一遍。十几个文件的
 * readFileSync + sha256 全是同步 IO，会把主进程事件循环堵住，表现为「打开扩展页整页都慢」。
 *
 * 判据取 stat 的 (size, mtimeMs)：内容变化必然改写 size 或 mtime（等字节数覆写也会动 mtime），
 * 因此不会把过期哈希当成有效结果固化；覆盖层写盘/还原后由
 * invalidateVerifiedArtifactFileHashCache 显式清空兜底。
 */
const verifiedArtifactFileHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

/**
 * 清单解析结果记忆化：manifest 文件自身的 (size, mtimeMs) 未变则复用上次解析产物，
 * 省掉每次校验都重读 + JSON.parse 那一遍。与逐文件哈希共用同一失效入口。
 */
const verifiedArtifactManifestCache = new Map<string, { size: number; mtimeMs: number; manifest: BuiltInExtensionsManifest | null }>();

/**
 * 文件系统时间戳粒度保护窗口（毫秒）。
 *
 * 刚写入文件的 mtime 可能仍停在同一个时钟刻度内（Windows 默认约 15.6ms、Linux 常见 1-4ms），
 * 「同刻度 + 等字节数」的覆写用 stat 判据分辨不出来。因此 mtime 落在该窗口内的文件一律不信任
 * 缓存、重算一次哈希，且**本次结果也不写入缓存**——否则窗口过期后同刻度等字节覆写仍会命中
 * 那条用旧内容算出来的条目。代价仅一次读盘，换来不固化可能的过期结果。常态下内置扩展文件的
 * mtime 来自安装/更新时刻，远老于该窗口，缓存照常命中。
 */
const FRESH_FILE_MTIME_GUARD_MS = 50;

/** mtime 是否仍处在「刚写入」窗口内（此时 stat 判据不足以证明内容未变）。 */
function isFreshFileMtime(mtimeMs: number): boolean {
	return Date.now() - mtimeMs < FRESH_FILE_MTIME_GUARD_MS;
}

/** 清空逐文件哈希与清单解析记忆化（覆盖层写盘/还原后调用，测试亦用于隔离）。 */
export function invalidateVerifiedArtifactFileHashCache(): void {
	verifiedArtifactFileHashCache.clear();
	verifiedArtifactManifestCache.clear();
}

/** 当前记忆化的逐文件哈希条目数（仅供测试观测缓存行为）。 */
export function getVerifiedArtifactFileHashCacheSize(): number {
	return verifiedArtifactFileHashCache.size;
}

/** 读目录清单：manifest 文件 stat 未变则复用解析结果，否则重读；新鲜 mtime 的结果不写入缓存。 */
function memoizedManifestFromDir(dir: string): BuiltInExtensionsManifest | null {
	const manifestPath = resolve(join(dir, EXTENSIONS_MANIFEST_FILE_NAME));
	let stats;
	try {
		stats = statSync(manifestPath);
	} catch {
		// 清单缺失（覆盖层尚未建立/刚被删）与旧行为一致：当作没有清单，而不是抛出
		return null;
	}
	const cached = verifiedArtifactManifestCache.get(manifestPath);
	if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && !isFreshFileMtime(stats.mtimeMs)) {
		return cached.manifest;
	}
	const manifest = readManifestFromDir(dir);
	// 刚写入的条目不进缓存：见 FRESH_FILE_MTIME_GUARD_MS。等 mtime 走出 50ms 窗口后
	// 的下一次校验会自然把它写入，期间只多付一次读盘。
	if (!isFreshFileMtime(stats.mtimeMs)) {
		verifiedArtifactManifestCache.set(manifestPath, { size: stats.size, mtimeMs: stats.mtimeMs, manifest });
	}
	return manifest;
}

/** 取文件大小与 sha256：stat 判据命中则复用缓存，否则读盘计算；新鲜 mtime 的结果不写入缓存。 */
function memoizedFileSha256(filePath: string): { size: number; sha256: string } {
	const stats = statSync(filePath);
	const cached = verifiedArtifactFileHashCache.get(filePath);
	if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && !isFreshFileMtime(stats.mtimeMs)) {
		return { size: stats.size, sha256: cached.sha256 };
	}
	const sha256 = sha256Of(readFileSync(filePath));
	// 与 manifest 一致：新鲜 mtime 的结果不落缓存，避免窗口内同刻度等字节覆写被旧条目命中
	if (!isFreshFileMtime(stats.mtimeMs)) {
		verifiedArtifactFileHashCache.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, sha256 });
	}
	return { size: stats.size, sha256 };
}

/**
 * 读取某目录构成的有效 artifact：清单可解析 **且** 每个声明文件存在、sha256 与 bytes 吻合。
 * 任何一项不符返回 null——覆盖层一旦被外部改动/截断，就自动退回内置版本而不是带病生效。
 *
 * 逐文件哈希走模块级 memo（见 verifiedArtifactFileHashCache）：重复校验同一目录时不再
 * 重新读盘+哈希，只付一次 stat；内容变化经 size/mtime 判据被发现后重算。
 */
export function readVerifiedArtifact(dir: string): BuiltInExtensionsManifest | null {
	const manifest = memoizedManifestFromDir(dir);
	if (!manifest) return null;
	try {
		for (const file of manifest.files) {
			const { size, sha256 } = memoizedFileSha256(resolve(join(dir, file.name)));
			if (size !== file.bytes) return null;
			if (sha256 !== file.sha256) return null;
		}
	} catch {
		return null;
	}
	return manifest;
}

/**
 * 列目录下的分发文件（.ts，忽略点开头，名字排序保证跨平台确定）。
 * 仅在清单缺失（旧版本安装包没有内置清单）时作为兜底清单使用。
 */
export function listExtensionFileNames(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.startsWith("."))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}
