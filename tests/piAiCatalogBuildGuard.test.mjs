/**
 * pi-ai catalog 构建守卫单测。
 *
 * 背景（2026-09 事故）：`npm run build` / `build:fast` 会无条件从本地
 * node_modules 重生成 catalog 并覆盖 resources/，而 `--check` 只拿「本地已安装版本」
 * 与仓库文件比字节、不校验 package.json 的精确锁定。于是换分支后没跑 `npm ci`、
 * node_modules 停在旧版 pi-ai 时，一次构建就把已提交的新目录静默写回旧版本，
 * 本地自检还全绿（只有 CI 的 npm ci 环境拦得住）。
 *
 * 本测试锁定修复后的契约：默认来源目录（node_modules）的 pi-ai 版本必须与
 * package.json 锁定版本一致，否则生成与校验都直接失败；显式 --source-dir
 * 指定其他来源时不做该比对（调试 / 本地补丁版的逃生通道）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSourceVersionMatchesPin, generatePiAiCatalog, PI_AI_CATALOG_FILE_NAME, PI_AI_CATALOG_MANIFEST_FILE_NAME, readDeclaredPiAiVersion } from "../scripts/generate-pi-ai-catalog.mjs";

const RESOURCES_DIR = join(process.cwd(), "resources");
const INSTALLED_PI_AI_DIR = join(process.cwd(), "node_modules", "@earendil-works", "pi-ai");

/** 最小可用来源包：一个 provider data 文件 + package.json（版本可指定）。 */
function createPiAiFixture(root, version) {
	const sourceDir = join(root, `pi-ai-${version}`);
	const dataDir = join(sourceDir, "dist", "providers", "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version }));
	writeFileSync(
		join(dataDir, "demo.json"),
		JSON.stringify({
			"openai-completions": {
				alpha: { id: "alpha", provider: "demo", contextWindow: 128000, maxTokens: 8192, reasoning: true },
			},
		}),
	);
	return sourceDir;
}

function readResources() {
	return {
		catalog: readFileSync(join(RESOURCES_DIR, PI_AI_CATALOG_FILE_NAME), "utf8"),
		manifest: readFileSync(join(RESOURCES_DIR, PI_AI_CATALOG_MANIFEST_FILE_NAME), "utf8"),
	};
}

function installedPiAiVersion() {
	try {
		const pkg = JSON.parse(readFileSync(join(INSTALLED_PI_AI_DIR, "package.json"), "utf8"));
		return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
	} catch {
		return null;
	}
}

test("assertSourceVersionMatchesPin：锁定版本与来源版本一致时放行", () => {
	assertSourceVersionMatchesPin({ sourceVersion: "0.86.1", declaredVersion: "0.86.1", sourceDir: "/tmp/pi-ai" });
	// 预发布后缀同样按逐字节精确比对
	assertSourceVersionMatchesPin({ sourceVersion: "0.86.1-beta.1", declaredVersion: "0.86.1-beta.1", sourceDir: "/tmp/pi-ai" });
});

test("assertSourceVersionMatchesPin：不一致时报错并给出 npm ci 与 --source-dir 指引", () => {
	assert.throws(
		() => assertSourceVersionMatchesPin({ sourceVersion: "0.85.1", declaredVersion: "0.86.1", sourceDir: "/tmp/pi-ai" }),
		(error) => {
			assert.match(error.message, /0\.85\.1/);
			assert.match(error.message, /0\.86\.1/);
			assert.match(error.message, /npm ci/);
			assert.match(error.message, /--source-dir/);
			return true;
		},
	);
});

test("assertSourceVersionMatchesPin：范围声明与缺失声明不误报（无法逐字节比对）", () => {
	// ^/~ 是范围，锁定比对无意义；缺失声明交给 packaging 测试兜底
	for (const declaredVersion of ["^0.86.1", "~0.86.1", ">=0.86.0 <0.87.0", "", undefined]) {
		assertSourceVersionMatchesPin({ sourceVersion: "0.85.1", declaredVersion, sourceDir: "/tmp/pi-ai" });
	}
});

test("默认来源（node_modules）与锁定版本错位时：校验与生成都失败且不写 resources", () => {
	const before = readResources();
	// 注入一个不可能与本地安装相等的锁定版本，模拟「换分支后没跑 npm ci」的陈旧安装
	assert.throws(() => generatePiAiCatalog({ check: true, declaredVersion: "0.0.0-stale" }), /不一致/);
	assert.throws(() => generatePiAiCatalog({ declaredVersion: "0.0.0-stale" }), /不一致/);
	assert.deepEqual(readResources(), before, "守卫必须在写盘前失败，resources 不得被改动");
});

test("显式 --source-dir 指定其他来源时跳过锁定比对（逃生通道）", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ai-catalog-guard-"));
	try {
		const sourceDir = createPiAiFixture(root, "9.9.9-test");
		const result = generatePiAiCatalog({ sourceDir, outDir: join(root, "resources"), declaredVersion: "0.0.0-stale" });
		assert.equal(result.ok, true);
		assert.equal(result.sourceVersion, "9.9.9-test");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("仓库当前状态：package.json 锁定版本与本地安装一致", () => {
	const declaredVersion = readDeclaredPiAiVersion();
	const installed = installedPiAiVersion();
	// 无本地 pi-ai 包时跳过（不含 dev deps 的场景），不把环境缺失当失败
	if (!installed || !declaredVersion) return;
	assert.equal(declaredVersion, installed, `本地 node_modules 的 pi-ai 为 ${installed}，package.json 锁定 ${declaredVersion}：先跑 npm ci，否则构建会把 catalog 静默降级`);
	assert.equal(existsSync(join(RESOURCES_DIR, PI_AI_CATALOG_FILE_NAME)), true);
	assert.equal(generatePiAiCatalog({ check: true }).ok, true, "锁定一致时校验必须通过（守卫不得误报）");
});

/**
 * 复刻事故现场：把脚本放进一个假仓库，锁定 0.86.1 但 node_modules 里是 0.85.1，
 * resources/ 已是 0.86.1 产物。跑真实 CLI，验证构建会在写盘前停住。
 */
function createStaleRepoFixture(root) {
	const scriptDir = join(root, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(join(process.cwd(), "scripts", "generate-pi-ai-catalog.mjs"), join(scriptDir, "generate-pi-ai-catalog.mjs"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@earendil-works/pi-ai": "0.86.1" } }));
	// 陈旧安装：node_modules 里是上一版
	const sourceDir = join(root, "node_modules", "@earendil-works", "pi-ai");
	const dataDir = join(sourceDir, "dist", "providers", "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1" }));
	writeFileSync(join(dataDir, "demo.json"), JSON.stringify({ "openai-completions": { old: { id: "old", provider: "demo", contextWindow: 1000, maxTokens: 100 } } }));
	// 已提交的新产物：守卫失败时必须原样保留
	const resourcesDir = join(root, "resources");
	mkdirSync(resourcesDir, { recursive: true });
	const committedCatalog = `${JSON.stringify({ schemaVersion: 1, entries: [{ id: "new" }] }, null, 2)}\n`;
	const committedManifest = `${JSON.stringify({ schemaVersion: 1, source: { packageVersion: "0.86.1" }, entryCount: 1 }, null, 2)}\n`;
	writeFileSync(join(resourcesDir, PI_AI_CATALOG_FILE_NAME), committedCatalog);
	writeFileSync(join(resourcesDir, PI_AI_CATALOG_MANIFEST_FILE_NAME), committedManifest);
	// 逃生通道用的「其他来源」：刻意放在默认目录之外（同路径显式传参仍算默认来源）
	const patchedDir = join(root, "patched-pi-ai");
	const patchedDataDir = join(patchedDir, "dist", "providers", "data");
	mkdirSync(patchedDataDir, { recursive: true });
	writeFileSync(join(patchedDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1" }));
	writeFileSync(join(patchedDataDir, "demo.json"), JSON.stringify({ "openai-completions": { patched: { id: "patched", provider: "demo", contextWindow: 1000, maxTokens: 100 } } }));
	return { scriptPath: join(scriptDir, "generate-pi-ai-catalog.mjs"), resourcesDir, committedCatalog, committedManifest, patchedDir };
}

test("CLI 端到端：陈旧 node_modules 下构建直接失败，已提交产物不被覆盖", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ai-catalog-stale-"));
	try {
		const fixture = createStaleRepoFixture(root);
		const result = spawnSync(process.execPath, [fixture.scriptPath], { encoding: "utf8" });
		assert.notEqual(result.status, 0, "陈旧安装必须让构建失败，而不是静默降级目录");
		assert.match(`${result.stdout}${result.stderr}`, /npm ci/);
		assert.equal(readFileSync(join(fixture.resourcesDir, PI_AI_CATALOG_FILE_NAME), "utf8"), fixture.committedCatalog);
		assert.equal(readFileSync(join(fixture.resourcesDir, PI_AI_CATALOG_MANIFEST_FILE_NAME), "utf8"), fixture.committedManifest);
		// --check 同样必须失败（CI 兜底路径）
		const checked = spawnSync(process.execPath, [fixture.scriptPath, "--check"], { encoding: "utf8" });
		assert.notEqual(checked.status, 0);
		// 显式换源（逃生通道）仍然可写：只有指向默认目录之外才算换源
		const escaped = spawnSync(process.execPath, [fixture.scriptPath, "--source-dir", fixture.patchedDir], { encoding: "utf8" });
		assert.equal(escaped.status, 0, escaped.stderr);
		const escapedManifest = JSON.parse(readFileSync(join(fixture.resourcesDir, PI_AI_CATALOG_MANIFEST_FILE_NAME), "utf8"));
		assert.equal(escapedManifest.source.packageVersion, "0.85.1");
		assert.deepEqual(
			JSON.parse(readFileSync(join(fixture.resourcesDir, PI_AI_CATALOG_FILE_NAME), "utf8")).entries.map((entry) => entry.id),
			["patched"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
