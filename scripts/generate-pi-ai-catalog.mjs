#!/usr/bin/env node
/**
 * 从开发期 @earendil-works/pi-ai 的 provider JSON 提取 PiDeck 所需模型目录。
 *
 * 运行时 PiDeck 只消费模型规格，不能为读取约 648KB catalog 而携带整套 pi-ai
 * SDK 及其 HTTP/provider 依赖。该脚本在构建前生成可随应用分发的静态 artifact：
 *
 *   resources/pi-ai-catalog.json
 *   resources/pi-ai-catalog.manifest.json
 *
 * manifest 不记录生成时间，保证同一输入得到字节级一致输出；它记录来源包版本、
 * 源 JSON 哈希和 artifact 哈希，供 runtime/CI 发现资源损坏或漏更新。
 *
 * 用法：
 *   node scripts/generate-pi-ai-catalog.mjs
 *   node scripts/generate-pi-ai-catalog.mjs --check
 *   node scripts/generate-pi-ai-catalog.mjs --source-dir <pi-ai-dir> --out-dir <resources-dir>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

export const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
export const PI_AI_CATALOG_SCHEMA_VERSION = 1;
export const PI_AI_CATALOG_FILE_NAME = "pi-ai-catalog.json";
export const PI_AI_CATALOG_MANIFEST_FILE_NAME = "pi-ai-catalog.manifest.json";

export const DEFAULT_PI_AI_SOURCE_DIR = join(
	PROJECT_ROOT,
	"node_modules",
	"@earendil-works",
	"pi-ai",
);
export const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, "resources");

function isRecord(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// 与旧 runtime loader 一致：只规范化模型 ID；provider/name/baseUrl 保留上游原值，
// 以免将精确匹配意外变成宽松匹配。
function normalizedModelId(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInt(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 输入模型条目裁剪为 PiDeck 主进程的实际消费字段。 */
export function extractCatalogEntry(model) {
	if (!isRecord(model)) return undefined;
	const id = normalizedModelId(model.id);
	if (!id) return undefined;

	const entry = { id };
	const name = nonEmptyString(model.name);
	const provider = nonEmptyString(model.provider);
	const contextWindow = positiveInt(model.contextWindow);
	const maxTokens = positiveInt(model.maxTokens);
	const api = nonEmptyString(model.api);
	const baseUrl = nonEmptyString(model.baseUrl);
	if (name) entry.name = name;
	if (provider) entry.provider = provider;
	if (api) entry.api = api;
	if (baseUrl) entry.baseUrl = baseUrl;
	if (typeof model.reasoning === "boolean") entry.reasoning = model.reasoning;
	if (Array.isArray(model.input)) {
		const input = model.input.filter((item) => item === "text" || item === "image");
		if (input.length > 0) entry.input = input;
	}
	if (contextWindow !== undefined) entry.contextWindow = contextWindow;
	if (maxTokens !== undefined) entry.maxTokens = maxTokens;
	// 保留原始 JSON 映射；运行时仍由 parseThinkingLevelMap 收窄合法档位和值，
	// 以抵御手工修改或上游未来字段变化。
	if (isRecord(model.thinkingLevelMap)) entry.thinkingLevelMap = model.thinkingLevelMap;
	return entry;
}

/** 输入的字节级 SHA-256：文件名与内容均参与，防止来源文件增删改被掩盖。 */
function sourceDataSha256(files, dataDir) {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file, "utf8");
		hash.update("\0", "utf8");
		hash.update(readFileSync(join(dataDir, file)));
		hash.update("\0", "utf8");
	}
	return hash.digest("hex");
}

export function sha256(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 读取上游 provider data。文件名排序保证跨平台确定性；每个文件内保留上游对象顺序，
 * 避免改变重复 provider/id 的“第一项优先”现有匹配语义。
 */
export function collectPiAiCatalogEntries(dataDir) {
	if (!existsSync(dataDir)) {
		throw new Error(`pi-ai catalog data directory not found: ${dataDir}`);
	}
	const files = readdirSync(dataDir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.sort((left, right) => left.localeCompare(right));
	const entries = [];
	for (const file of files) {
		const path = join(dataDir, file);
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new Error(`failed to parse pi-ai catalog file ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isRecord(parsed)) {
			throw new Error(`invalid pi-ai catalog root in ${file}`);
		}
		for (const group of Object.values(parsed)) {
			if (!isRecord(group)) continue;
			for (const model of Object.values(group)) {
				const entry = extractCatalogEntry(model);
				if (entry) entries.push(entry);
			}
		}
	}
	return {
		entries,
		sourceDataSha256: sourceDataSha256(files, dataDir),
		sourceFileCount: files.length,
	};
}

export function createPiAiCatalogArtifact(entries) {
	return {
		schemaVersion: PI_AI_CATALOG_SCHEMA_VERSION,
		entries,
	};
}

export function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function readSourcePackage(sourceDir) {
	const packagePath = join(sourceDir, "package.json");
	if (!existsSync(packagePath)) throw new Error(`pi-ai package.json not found: ${packagePath}`);
	const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
	if (pkg?.name !== PI_AI_PACKAGE_NAME || typeof pkg.version !== "string" || !pkg.version) {
		throw new Error(`invalid ${PI_AI_PACKAGE_NAME} package metadata at ${packagePath}`);
	}
	return pkg;
}

function writeIfChanged(path, content) {
	if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
	writeFileSync(path, content, "utf8");
	return true;
}

/**
 * 生成或校验 catalog artifact。check 模式不写文件，适合 CI 验证提交资源没有过期。
 */
export function generatePiAiCatalog({
	sourceDir = DEFAULT_PI_AI_SOURCE_DIR,
	outDir = DEFAULT_OUTPUT_DIR,
	check = false,
} = {}) {
	const resolvedSourceDir = resolve(sourceDir);
	const resolvedOutDir = resolve(outDir);
	const sourcePackage = readSourcePackage(resolvedSourceDir);
	const collected = collectPiAiCatalogEntries(join(resolvedSourceDir, "dist", "providers", "data"));
	const catalog = createPiAiCatalogArtifact(collected.entries);
	const catalogText = serializeJson(catalog);
	const manifest = {
		schemaVersion: PI_AI_CATALOG_SCHEMA_VERSION,
		source: {
			packageName: PI_AI_PACKAGE_NAME,
			packageVersion: sourcePackage.version,
			dataSha256: collected.sourceDataSha256,
			fileCount: collected.sourceFileCount,
		},
		catalogSha256: sha256(catalogText),
		entryCount: collected.entries.length,
	};
	const manifestText = serializeJson(manifest);
	const catalogPath = join(resolvedOutDir, PI_AI_CATALOG_FILE_NAME);
	const manifestPath = join(resolvedOutDir, PI_AI_CATALOG_MANIFEST_FILE_NAME);
	const current = existsSync(catalogPath) && existsSync(manifestPath)
		&& readFileSync(catalogPath, "utf8") === catalogText
		&& readFileSync(manifestPath, "utf8") === manifestText;

	if (check) {
		return {
			ok: current,
			changed: false,
			catalogPath,
			manifestPath,
			entryCount: collected.entries.length,
			sourceVersion: sourcePackage.version,
		};
	}

	mkdirSync(resolvedOutDir, { recursive: true });
	// 两个文件都必须尝试写入：短路 OR 会在 catalog 变化时遗漏 manifest 更新。
	const catalogChanged = writeIfChanged(catalogPath, catalogText);
	const manifestChanged = writeIfChanged(manifestPath, manifestText);
	const changed = catalogChanged || manifestChanged;
	return {
		ok: true,
		changed,
		catalogPath,
		manifestPath,
		entryCount: collected.entries.length,
		sourceVersion: sourcePackage.version,
	};
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--check") {
			options.check = true;
			continue;
		}
		if (arg === "--source-dir" || arg === "--out-dir") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${arg} requires a path`);
			if (arg === "--source-dir") options.sourceDir = value;
			else options.outDir = value;
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
		const result = generatePiAiCatalog(parseArgs(process.argv.slice(2)));
		if (!result.ok) {
			console.error(`[pi-ai-catalog] artifact is stale; run npm run generate:pi-ai-catalog (${result.catalogPath})`);
			process.exitCode = 1;
		} else {
			console.log(
				`[pi-ai-catalog] ${result.changed ? "generated" : "up to date"}: ${result.entryCount} entries from ${PI_AI_PACKAGE_NAME}@${result.sourceVersion}`,
			);
		}
	} catch (error) {
		console.error("[pi-ai-catalog] generation failed", error);
		process.exitCode = 1;
	}
}
