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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
		bundleSha256: typeof bundleSha256 === "string" && SHA256_PATTERN.test(bundleSha256)
			? bundleSha256.toLowerCase()
			: "",
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
 * 读取某目录构成的有效 artifact：清单可解析 **且** 每个声明文件存在、sha256 与 bytes 吻合。
 * 任何一项不符返回 null——覆盖层一旦被外部改动/截断，就自动退回内置版本而不是带病生效。
 */
export function readVerifiedArtifact(dir: string): BuiltInExtensionsManifest | null {
	const manifest = readManifestFromDir(dir);
	if (!manifest) return null;
	try {
		for (const file of manifest.files) {
			const content = readFileSync(join(dir, file.name));
			if (content.byteLength !== file.bytes) return null;
			if (sha256Of(content) !== file.sha256) return null;
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
