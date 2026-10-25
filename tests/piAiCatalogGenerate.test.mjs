/**
 * pi-ai 目录运行时生成（piAiCatalogGenerate）单测。
 *
 * 核心契约：运行时从 @earendil-works/pi-ai 来源文件生成的 catalog/manifest
 * 必须与构建脚本 scripts/generate-pi-ai-catalog.mjs 生成的 resources/* 逐字节一致，
 * 否则「更新到最新」会产出与内置版不一致的 artifacts，同一版本会被误判为有更新。
 * 本测试用真实本地 pi-ai 包数据生成并断言与 resources/* 完全相同。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { generatePiAiCatalogFromFiles, compareSemver } = loadTsCommonJs("src/main/pi/piAiCatalogGenerate.ts");

const PI_AI_SOURCE_DIR = join(process.cwd(), "node_modules", "@earendil-works", "pi-ai");
const DATA_DIR = join(PI_AI_SOURCE_DIR, "dist", "providers", "data");

function loadSourceFiles() {
	const files = readdirSync(DATA_DIR)
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.map((name) => ({
			name,
			content: readFileSync(join(DATA_DIR, name), "utf8"),
		}));
	return files;
}

function tryReadSourceFiles() {
	try {
		if (!statSync(DATA_DIR).isDirectory()) return null;
		return loadSourceFiles();
	} catch {
		return null;
	}
}

function packageVersion() {
	const pkg = JSON.parse(readFileSync(join(PI_AI_SOURCE_DIR, "package.json"), "utf8"));
	return pkg.version;
}

test("运行时生成与构建期 resources 逐字节一致（同一 pi-ai 版本）", () => {
	const files = tryReadSourceFiles();
	// 无本地 pi-ai 包时跳过（CI 不含 dev deps 的场景），不把环境缺失当失败。
	if (!files || files.length === 0) {
		return;
	}
	const version = packageVersion();
	const generated = generatePiAiCatalogFromFiles(files, version);
	const catalogText = readFileSync(join(process.cwd(), "resources", "pi-ai-catalog.json"), "utf8");
	const manifestText = readFileSync(join(process.cwd(), "resources", "pi-ai-catalog.manifest.json"), "utf8");
	assert.equal(generated.catalogText, catalogText, "catalog 应与构建脚本输出逐字节一致");
	assert.equal(generated.manifestText, manifestText, "manifest 应与构建脚本输出逐字节一致");
	assert.equal(generated.entryCount, JSON.parse(catalogText).entries.length);
});

test("生成结果可被内置校验器 parsePiAiCatalogArtifact 接受", () => {
	const files = tryReadSourceFiles();
	if (!files || files.length === 0) {
		return;
	}
	const version = packageVersion();
	const generated = generatePiAiCatalogFromFiles(files, version);
	const { parsePiAiCatalogArtifact } = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");
	const entries = parsePiAiCatalogArtifact(generated.catalogText, generated.manifestText);
	assert.ok(entries.length > 0, "生成的 artifact 应通过内置校验");
	assert.equal(entries.length, generated.entryCount);
});

test("compareSemver：远程更新判断与防降级", () => {
	// 低 → 高
	assert.ok(compareSemver("0.85.0", "0.85.1") < 0);
	assert.ok(compareSemver("0.85.1", "1.0.0") < 0);
	assert.ok(compareSemver("1.2.3", "1.2.4") < 0);
	assert.ok(compareSemver("1.2.3-remote", "1.2.4-remote") < 0);
	assert.ok(compareSemver("2.0.0-remote", "9.9.9-remote") < 0);
	// 相同
	assert.equal(compareSemver("0.85.1", "0.85.1"), 0);
	assert.equal(compareSemver("1.2.3-remote", "1.2.3-remote"), 0);
	// 远程低于本地（防降级场景：main 的 0.85.0 相对本地 0.85.1）
	assert.ok(compareSemver("0.85.0", "0.85.1") < 0);
	assert.ok(compareSemver("0.85.1", "0.85.2") < 0);
	// 预发布低于对应正式版：0.85.1 > 0.85.1-beta
	assert.ok(compareSemver("0.85.1", "0.85.1-beta.1") > 0);
	assert.ok(compareSemver("0.85.1-beta.1", "0.85.1") < 0);
	// 非数字解析失败：视为最低
	assert.ok(compareSemver("", "0.85.1") < 0);
	assert.ok(compareSemver("garbage", "0.85.1") < 0);
});
