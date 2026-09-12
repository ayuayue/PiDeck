#!/usr/bin/env node
/**
 * 生成 PiDeck 内置扩展清单：resources/extensions/extensions-manifest.json。
 *
 * 为什么需要：内置扩展（resources/extensions/*.ts）随应用分发，RPC 启动时经
 * `-e <绝对路径>` 注入 pi。打包态 resources 目录不可写，扩展出了 bug 只能等下一次
 * 应用发版；本 manifest 会被提交到仓库（main 分支），客户端可随时从 AtomGit/GitHub
 * 拉取比对，把新版本写进 userData 覆盖层实现热更新（与 pi-ai-catalog 同机制）。
 *
 * 与 generate-pi-ai-catalog.mjs 保持两条约定：
 * 1. **不记录生成时间**，同一输入得到字节级一致输出（避免构建产生无意义 diff）；
 * 2. `--check` 只校验不写盘，供 CI 挡住「改了扩展文件但忘了更新 manifest」。
 *
 * 版本号 `version` 是给人看的包级版本（`--set-version` 显式 bump，否则沿用现有值）。
 * 客户端判定「有没有更新」以每个文件的 sha256 为准，因此改了文件却忘记 bump
 * 也不会漏掉更新，只会让展示的版本号暂时滞后。
 *
 * 用法：
 *   node scripts/generate-extensions-manifest.mjs
 *   node scripts/generate-extensions-manifest.mjs --check
 *   node scripts/generate-extensions-manifest.mjs --set-version 2026.09.12
 *   node scripts/generate-extensions-manifest.mjs --extensions-dir <dir>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

export const EXTENSIONS_MANIFEST_SCHEMA_VERSION = 1;
export const EXTENSIONS_MANIFEST_FILE_NAME = "extensions-manifest.json";
/** 内置扩展目录（清单与被清单描述的 .ts 文件同目录，便于两端路径拼接一致）。 */
export const DEFAULT_EXTENSIONS_DIR = join(PROJECT_ROOT, "resources", "extensions");
/** 首次生成时的初始版本；之后由 --set-version 或人工 bump 演进。 */
export const INITIAL_EXTENSIONS_BUNDLE_VERSION = "1.0.0";

/** 版本号形态：数字点分（允许预发布后缀），与客户端 compareSemver 的输入兼容。 */
const VERSION_PATTERN = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/;

export function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * 列出目录下参与分发的扩展文件（.ts，忽略点开头）。
 * 排序保证跨平台确定性；**包含被扩展 import 的辅助模块**（如 pi-deck-todo-state.ts），
 * 否则覆盖层会缺少依赖、pi 加载时报模块找不到。
 */
export function listExtensionFileNames(extensionsDir) {
	if (!existsSync(extensionsDir)) {
		throw new Error(`built-in extensions directory not found: ${extensionsDir}`);
	}
	return readdirSync(extensionsDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

/** 整包哈希：文件名与内容都参与（增删改任一都会被检出），与 catalog 的 dataSha256 同构。 */
export function computeBundleSha256(files, extensionsDir) {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file, "utf8");
		hash.update("\0", "utf8");
		hash.update(readFileSync(join(extensionsDir, file)));
		hash.update("\0", "utf8");
	}
	return hash.digest("hex");
}

/** 读取现有 manifest 的版本号（用于生成时沿用）；缺失/非法返回 null。 */
export function readExistingVersion(manifestPath) {
	if (!existsSync(manifestPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
		const version = parsed?.version;
		return typeof version === "string" && VERSION_PATTERN.test(version) ? version : null;
	} catch {
		return null;
	}
}

export function buildExtensionsManifest(files, extensionsDir, version) {
	return {
		schemaVersion: EXTENSIONS_MANIFEST_SCHEMA_VERSION,
		version,
		bundleSha256: computeBundleSha256(files, extensionsDir),
		fileCount: files.length,
		files: files.map((name) => {
			const content = readFileSync(join(extensionsDir, name));
			return { name, sha256: sha256(content), bytes: content.byteLength };
		}),
	};
}

/**
 * 生成或校验内置扩展清单。check 模式不写盘，返回 ok=false 表示提交的清单已过期。
 * check 模式忽略 setVersion：它校验的是「当前提交的内容与清单是否一致」。
 */
export function generateExtensionsManifest({
	extensionsDir = DEFAULT_EXTENSIONS_DIR,
	check = false,
	setVersion = null,
} = {}) {
	const resolvedDir = resolve(extensionsDir);
	const manifestPath = join(resolvedDir, EXTENSIONS_MANIFEST_FILE_NAME);
	const files = listExtensionFileNames(resolvedDir);

	if (setVersion !== null && !VERSION_PATTERN.test(setVersion)) {
		throw new Error(`invalid --set-version value: ${setVersion}`);
	}
	// check 模式沿用已提交的版本号，避免「只是校验」被 --set-version 改变比较基准
	const version = check
		? readExistingVersion(manifestPath) ?? INITIAL_EXTENSIONS_BUNDLE_VERSION
		: setVersion ?? readExistingVersion(manifestPath) ?? INITIAL_EXTENSIONS_BUNDLE_VERSION;

	const manifest = buildExtensionsManifest(files, resolvedDir, version);
	const manifestText = serializeJson(manifest);
	const current = existsSync(manifestPath) && readFileSync(manifestPath, "utf8") === manifestText;

	if (check) {
		return { ok: current, changed: false, manifestPath, version, fileCount: files.length };
	}

	mkdirSync(resolvedDir, { recursive: true });
	let changed = false;
	if (!current) {
		writeFileSync(manifestPath, manifestText, "utf8");
		changed = true;
	}
	return { ok: true, changed, manifestPath, version, fileCount: files.length };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--check") {
			options.check = true;
			continue;
		}
		if (arg === "--set-version" || arg === "--extensions-dir") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${arg} requires a value`);
			if (arg === "--set-version") options.setVersion = value;
			else options.extensionsDir = value;
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

function isMainModule() {
	return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
	try {
		const result = generateExtensionsManifest(parseArgs(process.argv.slice(2)));
		if (!result.ok) {
			console.error(
				`[extensions-manifest] artifact is stale; run npm run generate:extensions-manifest (${result.manifestPath})`,
			);
			process.exitCode = 1;
		} else {
			console.log(
				`[extensions-manifest] ${result.changed ? "generated" : "up to date"}: ${result.fileCount} files @ v${result.version}`,
			);
		}
	} catch (error) {
		console.error("[extensions-manifest] generation failed", error);
		process.exitCode = 1;
	}
}
