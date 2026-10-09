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
 * 构建守卫（2026-09 事故）：build/build:fast 会无条件重生成并覆盖 resources/，
 * 而 --check 只拿「本地已安装版本」与仓库文件比字节。换分支后没跑 npm ci、
 * node_modules 停在旧版 pi-ai 时，一次构建就会把已提交的新目录静默写回旧版本，
 * 本地自检还全绿。因此使用默认来源目录时，来源包版本必须与 package.json 的
 * 精确锁定版本一致，否则生成与校验都直接失败（提示先跑 npm ci）。
 *
 * 用法：
 *   node scripts/generate-pi-ai-catalog.mjs
 *   node scripts/generate-pi-ai-catalog.mjs --check
 *   node scripts/generate-pi-ai-catalog.mjs --source-dir <pi-ai-dir> --out-dir <resources-dir>
 *
 * --source-dir 是逃生通道：显式指定其他来源（本地补丁版、调试、其他 pi-ai 副本）时
 * 不做锁定比对，由调用方自己保证来源可信。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

export const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
/**
 * artifact 格式版本。从 1 开始。
 * v2：取消字段白名单（条目透传官方全部字段，含 `type`），改为紧凑序列化。
 * v1 产物只含 9 个裁剪字段、丢失类型，无法在读取时可靠区分 chat / image /
 * classifier，因此不兼容 —— 旧版本缓存（用户下载的覆盖层）会被校验拒绝并回退到
 * 随包目录，不做迁移器；用户下次点「更新到最新」会自然得到 v2 产物。
 */
export const PI_AI_CATALOG_SCHEMA_VERSION = 2;
export const PI_AI_CATALOG_FILE_NAME = "pi-ai-catalog.json";
export const PI_AI_CATALOG_MANIFEST_FILE_NAME = "pi-ai-catalog.manifest.json";

export const DEFAULT_PI_AI_SOURCE_DIR = join(PROJECT_ROOT, "node_modules", "@earendil-works", "pi-ai");
export const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, "resources");

/** 锁定构建期输入的字段：devDependencies 里的精确版本（不允许 ^/~ 范围）。 */
const PI_AI_DECLARED_VERSION_FIELD = "devDependencies";

function isRecord(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

// 与旧 runtime loader 一致：只规范化模型 ID；provider/name/baseUrl 保留上游原值，
// 以免将精确匹配意外变成宽松匹配。
function normalizedModelId(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 提取一条目录条目：**保留官方原始字段**，只做最小结构校验。
 *
 * 为什么不再按白名单裁剪：旧版只留 9 个字段，把 `type` 一并丢掉，于是 image /
 * classifier 模型混进了聊天能力补全，且要用的价格、inputLimits、output 等字段
 * 一旦需要就得再来改一次生成器。现在直接透传官方对象，上游新增字段无需改脚本。
 *
 * 只做两件事：
 *   1. 无有效 id 的条目丢弃（PiDeck 一切匹配都以 id 为键）；
 *   2. 去掉值为 undefined 的键（JSON.stringify 会直接丢，显式删掉让产物意图清晰）。
 * 注意键顺序必须与来源保持一致，保证同输入得到字节级一致的输出。
 */
export function extractCatalogEntry(model) {
	if (!isRecord(model)) return undefined;
	if (!normalizedModelId(model.id)) return undefined;
	const entry = {};
	for (const [key, value] of Object.entries(model)) {
		if (value === undefined) continue;
		entry[key] = value;
	}
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
	// 紧凑序列化（无缩进）：条目现在透传官方全部字段，2 空格缩进会让产物从 ~0.9MB
	// 膨胀到 ~1.7MB。上游 42 份原始 JSON 本身就是紧凑格式，这样体积只比原件多几千字节。
	return `${JSON.stringify(value)}\n`;
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

/** 精确版本形态（纯数字点分，允许预发布/构建后缀），用于判断声明值能否逐字节比对。 */
function isExactVersion(spec) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

/** 读取 package.json 里 pi-ai 的声明版本（构建期输入的锁定值）。 */
export function readDeclaredPiAiVersion({ packageJsonPath = join(PROJECT_ROOT, "package.json") } = {}) {
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const spec = pkg?.[PI_AI_DECLARED_VERSION_FIELD]?.[PI_AI_PACKAGE_NAME] ?? pkg?.dependencies?.[PI_AI_PACKAGE_NAME];
	return typeof spec === "string" && spec.length > 0 ? spec : undefined;
}

/**
 * 构建守卫：默认来源目录（node_modules）的 pi-ai 版本必须与 package.json 精确锁定一致。
 *
 * 为什么必须挡：build/build:fast 无条件用本地安装覆盖 resources/，陈旧安装会静默
 * 降级已提交的模型目录（0.86.0 → 0.85.1 事故），而 --check 与本地测试都会跟着
 * 变成「自洽的错」，只有 CI 的 npm ci 环境才能发现。这里在写盘前直接失败。
 *
 * 范围声明（^/~）无法逐字节比对，缺失声明同理，均 fail-open 交给
 * tests/piAiCatalogPackaging.test.mjs 的精确锁定断言兜底。
 */
export function assertSourceVersionMatchesPin({ sourceVersion, declaredVersion, sourceDir }) {
	if (!declaredVersion || !isExactVersion(declaredVersion)) return;
	if (declaredVersion === sourceVersion) return;
	throw new Error(`${PI_AI_PACKAGE_NAME} 本地安装版本 ${sourceVersion} 与 package.json 锁定版本 ${declaredVersion} 不一致：` + `继续构建会用旧数据覆盖 resources/ 造成模型目录降级/漂移（来源目录：${sourceDir}）。` + "请先跑 npm ci 同步依赖；确实要从未锁定来源生成时，显式传 --source-dir <pi-ai 目录>。");
}

/**
 * 生成或校验 catalog artifact。check 模式不写文件，适合 CI 验证提交资源没有过期。
 *
 * declaredVersion 仅用于测试注入「与本地安装错位」的场景；默认读取 package.json。
 */
export function generatePiAiCatalog({ sourceDir = DEFAULT_PI_AI_SOURCE_DIR, outDir = DEFAULT_OUTPUT_DIR, check = false, declaredVersion } = {}) {
	const resolvedSourceDir = resolve(sourceDir);
	const resolvedOutDir = resolve(outDir);
	const sourcePackage = readSourcePackage(resolvedSourceDir);
	// 只有默认来源（node_modules）才是「构建期输入」，必须与精确锁定一致；
	// 显式指定 --source-dir 视为调用方有意换源，不做比对。
	if (resolvedSourceDir === resolve(DEFAULT_PI_AI_SOURCE_DIR)) {
		assertSourceVersionMatchesPin({
			sourceVersion: sourcePackage.version,
			declaredVersion: declaredVersion ?? readDeclaredPiAiVersion(),
			sourceDir: resolvedSourceDir,
		});
	}
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
	const current = existsSync(catalogPath) && existsSync(manifestPath) && readFileSync(catalogPath, "utf8") === catalogText && readFileSync(manifestPath, "utf8") === manifestText;

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
			console.log(`[pi-ai-catalog] ${result.changed ? "generated" : "up to date"}: ${result.entryCount} entries from ${PI_AI_PACKAGE_NAME}@${result.sourceVersion}`);
		}
	} catch (error) {
		console.error("[pi-ai-catalog] generation failed", error);
		process.exitCode = 1;
	}
}
