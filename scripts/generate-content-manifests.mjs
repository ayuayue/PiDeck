#!/usr/bin/env node
/**
 * 生成内置内容包清单：提示词商店官方模板（resources/prompts）与内置技能（resources/skills）。
 *
 * 与 generate-extensions-manifest.mjs 同一套约定：
 * 1. 不记录生成时间，同一输入字节级一致输出；
 * 2. `--check` 只校验不写盘，CI 用它挡住「改了内容但忘了更新 manifest」；
 * 3. 版本号是包级版本（--set-version 显式 bump，否则沿用现有值），
 *    客户端以逐文件 sha256 判定更新，bump 滞后不丢更新。
 *
 * prompts 域额外做「基线资源生成」：把 docs/pi-prompt-templates/*.md（唯一编辑入口，
 * 跳过 README）复制为 resources/prompts/*.md，供客户端内置基线 + 远端热更新对照。
 * skills 域资源目录（resources/skills/<name>/SKILL.md）已是仓库内容，只算清单。
 *
 * 用法：
 *   node scripts/generate-content-manifests.mjs --domain prompts
 *   node scripts/generate-content-manifests.mjs --domain skills --check
 *   node scripts/generate-content-manifests.mjs --domain prompts --set-version 2026.09.12
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

export const CONTENT_MANIFEST_SCHEMA_VERSION = 1;
export const INITIAL_CONTENT_BUNDLE_VERSION = "1.0.0";
const VERSION_PATTERN = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/;
const MANIFEST_FILE_NAME = "content-manifest.json";

/** 各域的资源配置：源目录（生成基线用，null=直接用现有目录）、仓库相对目录、清单文件名。 */
const DOMAINS = {
	prompts: {
		/** 官方模板唯一编辑入口（docs 下），脚本显式跳过 README。 */
		sourceDir: join(PROJECT_ROOT, "docs", "pi-prompt-templates"),
		contentDir: join(PROJECT_ROOT, "resources", "prompts"),
		repoDir: "resources/prompts",
		manifestFileName: "prompts-manifest.json",
		copyPattern: /\.md$/,
	},
	skills: {
		/** 技能资源直接存在于 resources/skills（含 SKILL.md），无需生成。 */
		sourceDir: null,
		contentDir: join(PROJECT_ROOT, "resources", "skills"),
		repoDir: "resources/skills",
		manifestFileName: "skills-manifest.json",
		copyPattern: null,
	},
};

export function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 行尾归一：Windows 工作树是 CRLF，CI 检出是 LF，两份内容相同、字节不同。
 * 哈希落在字节上，同一个 commit 在两边就会得出不同结论——这条已经让 CI 红过三次。
 * 判据要的是「内容有没有变」，不是「工作树用哪种行尾」，所以先归一再算。
 * 含 NUL 字节的按二进制处理，原样参与哈希。
 */
export function normalizeEol(buf) {
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	if (bytes.includes(0)) return bytes;
	const CRLF = String.fromCharCode(13, 10);
	const LF = String.fromCharCode(10);
	return Buffer.from(bytes.toString("utf8").split(CRLF).join(LF), "utf8");
}
export function sha256(content) {
	return createHash("sha256").update(normalizeEol(content)).digest("hex");
}

/**
 * 递归列出参与分发的内容文件（相对路径，正斜杠），忽略点开头文件。
 * 排序保证跨平台确定性（与扩展清单同一约定）。
 */
export function listContentFiles(contentDir) {
	if (!existsSync(contentDir)) {
		throw new Error(`content directory not found: ${contentDir}`);
	}
	const result = [];
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full, rel);
			else result.push(rel);
		}
	};
	walk(contentDir, "");
	return result;
}

/** 整包哈希：文件名与内容都参与（增删改任一都被检出）。 */
export function computeBundleSha256(files, contentDir) {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file, "utf8");
		hash.update("\0", "utf8");
		hash.update(normalizeEol(readFileSync(join(contentDir, file))));
		hash.update("\0", "utf8");
	}
	return hash.digest("hex");
}

/** 读取现有 manifest 的版本号（生成时沿用）；缺失/非法返回 null。 */
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

export function buildContentManifest(files, contentDir, version) {
	return {
		schemaVersion: CONTENT_MANIFEST_SCHEMA_VERSION,
		version,
		bundleSha256: computeBundleSha256(files, contentDir),
		fileCount: files.length,
		files: files.map((name) => {
			const content = readFileSync(join(contentDir, name));
			return { name, sha256: sha256(content), bytes: content.byteLength };
		}),
	};
}

/**
 * 生成（或校验）指定域的清单。check 模式（`--check`）不写盘：
 * 返回 ok=false 表示已提交的清单已过期。
 * prompts 域非 check 模式会先做基线资源生成（docs → resources/prompts 同步复制）。
 */
export function generateContentManifest({ domain = null, check = false, setVersion = null } = {}) {
	// 缺失与未知分开报错：parseArgs 允许 domain:null 透传（裸跑脚本），
	// "unknown domain: null" 会误导排查方向；缺失时直接告诉用户要补什么参数。
	if (domain === null) throw new Error("missing required --domain (prompts|skills)");
	const config = DOMAINS[domain];
	if (!config) throw new Error(`unknown domain: ${domain} (expected prompts|skills)`);

	if (setVersion !== null && !VERSION_PATTERN.test(setVersion)) {
		throw new Error(`invalid --set-version value: ${setVersion}`);
	}

	// prompts 域：基线资源生成（docs 是唯一编辑入口；check 模式不写盘，跳过复制）
	// 为什么由清单脚本负责复制：要求 resources/prompts 与 docs 逐字节一致，
	// 放在同一脚本里才能用同一轮文件清单做 --check 校验，防止两处漂移。
	if (domain === "prompts" && !check) {
		mkdirSync(config.contentDir, { recursive: true });
		const sources = readdirSync(config.sourceDir)
			.filter((name) => config.copyPattern.test(name) && name !== "README.md")
			.sort((a, b) => a.localeCompare(b));
		if (!sources.length) throw new Error(`no template sources found in ${config.sourceDir}`);
		for (const name of sources) {
			cpSync(join(config.sourceDir, name), join(config.contentDir, name));
		}
	}

	const manifestPath = join(config.contentDir, config.manifestFileName);
	// 清单文件自身不能参与打包：它包含自己的 hash，写盘后清单内容变化会反过来使自身 hash 失配，
	// 产生「生成后立即可检出的 stale」，且远端分发时客户端的 bundleSha256 也永远对不上。
	const files = listContentFiles(config.contentDir).filter((name) => name !== config.manifestFileName);
	const version = check ? (readExistingVersion(manifestPath) ?? INITIAL_CONTENT_BUNDLE_VERSION) : (setVersion ?? readExistingVersion(manifestPath) ?? INITIAL_CONTENT_BUNDLE_VERSION);

	const manifest = buildContentManifest(files, config.contentDir, version);
	const manifestText = serializeJson(manifest);
	const current = existsSync(manifestPath) && readFileSync(manifestPath, "utf8") === manifestText;

	if (check) {
		return { ok: current, changed: false, manifestPath, version, fileCount: files.length, domain, files, contentDir: config.contentDir };
	}

	let changed = false;
	if (!current) {
		writeFileSync(manifestPath, manifestText, "utf8");
		changed = true;
	}
	return { ok: true, changed, manifestPath, version, fileCount: files.length, domain };
}

// 行尾诊断：工作树字节与仓库索引字节只差 CR 的文件。
// 为什么要有：2026-11-15 实测，在 Windows 工作树（CRLF）上生成清单，本地 --check 绿，
// CI（checkout 出 LF）必红，报的是「artifact is stale」——那句话把人引向「忘了重生成」，
// 而重生成一千遍也没用：哈希落在 CRLF 字节上。判据的报错要指向能修的那一侧。
function eolMismatchFiles({ files, contentDir }) {
	const out = [];
	if (!Array.isArray(files) || !contentDir) return out;
	const norm = (b) => b.toString("utf8").split("\r\n").join("\n").split("\r").join("\n");
	for (const name of files) {
		const abs = join(contentDir, name);
		let work;
		try {
			work = readFileSync(abs);
		} catch {
			continue;
		}
		let repo;
		try {
			repo = execFileSync("git", ["show", ":" + relative(PROJECT_ROOT, abs).split(path.sep).join("/")], {
				cwd: PROJECT_ROOT,
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch {
			continue;
		}
		if (work.equals(repo)) continue;
		if (norm(repo) === norm(work)) out.push(relative(PROJECT_ROOT, abs).split(path.sep).join("/"));
	}
	return out;
}

function parseArgs(argv) {
	const options = { domain: null };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--check") {
			options.check = true;
			continue;
		}
		if (arg === "--set-version" || arg === "--domain") {
			const value = argv[index + 1];
			if (!value) throw new Error(`${arg} requires a value`);
			if (arg === "--set-version") options.setVersion = value;
			else options.domain = value;
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
		const result = generateContentManifest(parseArgs(process.argv.slice(2)));
		if (!result.ok) {
			console.error(`[content-manifest:${result.domain ?? "?"}] artifact is stale; run npm run generate:prompts-manifest / generate:skills-manifest (${result.manifestPath})`);
			const eol = eolMismatchFiles(result);
			if (eol.length) {
				console.error("[content-manifest] 行尾不一致：工作树里这些文件是 CRLF，仓库索引里是 LF。");
				console.error("  CI 用仓库字节算哈希，所以本地怎么重生成，CI 都会报 stale。");
				console.error("  修：在 LF 内容里生成再拷回 —— git archive <rev> | tar -x -C /tmp/x && cd /tmp/x && node scripts/generate-content-manifests.mjs --domain " + (result.domain ?? "?") + "，把生成的 manifest 拷回工作树提交。");
				for (const f of eol.slice(0, 5)) console.error("  CRLF " + f);
			}
			process.exitCode = 1;
		} else {
			console.log(`[content-manifest:${result.domain ?? "?"}] ${result.changed ? "generated" : "up to date"}: ${result.fileCount} files @ v${result.version}`);
		}
	} catch (error) {
		console.error("[content-manifest] generation failed", error);
		process.exitCode = 1;
	}
}
