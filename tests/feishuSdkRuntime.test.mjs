import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tar from "tar";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 飞书 SDK 按需解压的运行时契约（体积优化，2026-10）。
 *
 * 打包态 SDK 不在 app.asar 里，而是 resources/feishu-sdk/*.tar.gz；首次启用飞书时
 * 解压到 <userData>/feishu-sdk/<version>/ 再 require。这里用伪造的小 SDK 覆盖：
 * 解压成功、缓存复用、sha 校验失败、缓存损坏重建、单例只解压一次。
 */

const { loadFeishuSdk: load, loadFeishuSdkOnce, resetFeishuSdkRuntime } = loadTsCommonJs("src/main/feishu/feishuSdkRuntime.ts");

const SDK_NAME = "@larksuiteoapi/node-sdk";
const VERSION = "9.9.9-test";

/** 造一个可 require 的最小 SDK 包（含一个假依赖，验证同级 node_modules 解析）。 */
function makeStagingDir(root) {
	const pkgDir = join(root, "node_modules", SDK_NAME);
	mkdirSync(join(pkgDir, "lib"), { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: SDK_NAME, version: VERSION, main: "lib/index.js" }));
	writeFileSync(join(pkgDir, "lib", "index.js"), 'const helper = require("feishu-test-dep");\nmodule.exports = { Client: function Client() {}, marker: helper };\n');
	const depDir = join(root, "node_modules", "feishu-test-dep");
	mkdirSync(depDir, { recursive: true });
	writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: "feishu-test-dep", version: "1.0.0", main: "index.js" }));
	writeFileSync(join(depDir, "index.js"), 'module.exports = "dep-ok";\n');
}

async function makeArchive(resourcesPath) {
	const staging = mkdtempSync(join(tmpdir(), "feishu-sdk-stage-"));
	makeStagingDir(staging);
	const archivePath = join(resourcesPath, "feishu-sdk", `feishu-sdk-${VERSION}.tar.gz`);
	mkdirSync(join(resourcesPath, "feishu-sdk"), { recursive: true });
	await tar.create({ gzip: { level: 9 }, cwd: staging, file: archivePath, portable: true }, ["node_modules"]);
	const bytes = readFileSync(archivePath);
	const manifest = { version: VERSION, archive: `feishu-sdk-${VERSION}.tar.gz`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, packages: [SDK_NAME, "feishu-test-dep"], files: 4 };
	writeFileSync(join(resourcesPath, "feishu-sdk", "manifest.json"), JSON.stringify(manifest));
	rmSync(staging, { recursive: true, force: true });
	return { archivePath, manifest };
}

function makeWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "feishu-sdk-test-"));
	const resourcesPath = join(root, "resources");
	const cacheRoot = join(root, "userData");
	mkdirSync(resourcesPath, { recursive: true });
	mkdirSync(cacheRoot, { recursive: true });
	return { root, resourcesPath, cacheRoot };
}

test("dev 模式（resourcesPath=null）直接走 node_modules，不写缓存", async () => {
	const { cacheRoot } = makeWorkspace();
	const result = await load({
		resourcesPath: null,
		cacheRoot,
		importFromNodeModules: async () => ({ Client: function Client() {}, marker: "injected" }),
	});
	assert.equal(result.ok, true);
	assert.equal(result.source, "node_modules");
	assert.equal(result.module.marker, "injected");
	assert.equal(existsSync(join(cacheRoot, "feishu-sdk")), false, "dev 模式不应生成解压缓存");
});

test("打包态首次加载：解压到 userData 并 require 成功（同级依赖可解析）", async () => {
	const { resourcesPath, cacheRoot } = makeWorkspace();
	await makeArchive(resourcesPath);
	const result = await load({ resourcesPath, cacheRoot });
	assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.message}`);
	assert.equal(result.source, "archive");
	assert.equal(result.module.marker, "dep-ok", "SDK 内部的同级依赖必须能从解压目录解析");
	assert.equal(typeof result.module.Client, "function");
	assert.ok(existsSync(join(cacheRoot, "feishu-sdk", VERSION, "node_modules", SDK_NAME, "lib", "index.js")));
});

test("第二次加载命中缓存，不重新解压", async () => {
	const { resourcesPath, cacheRoot } = makeWorkspace();
	await makeArchive(resourcesPath);
	const first = await load({ resourcesPath, cacheRoot });
	assert.equal(first.ok, true);
	// 删掉压缩包（保留 manifest）：若仍能加载，说明走的是缓存而不是重新解压。
	rmSync(join(resourcesPath, "feishu-sdk", `feishu-sdk-${VERSION}.tar.gz`), { force: true });
	const second = await load({ resourcesPath, cacheRoot });
	assert.equal(second.ok, true);
	assert.equal(second.source, "cache");
});

test("缓存入口缺失时重建，而不是把半套文件留给调用方", async () => {
	const { resourcesPath, cacheRoot } = makeWorkspace();
	await makeArchive(resourcesPath);
	const first = await load({ resourcesPath, cacheRoot });
	assert.equal(first.ok, true);
	rmSync(join(cacheRoot, "feishu-sdk", VERSION, "node_modules", SDK_NAME, "lib"), { recursive: true, force: true });
	const again = await load({ resourcesPath, cacheRoot });
	assert.equal(again.ok, true);
	assert.equal(again.source, "archive");
});

test("sha256 不匹配时拒绝解压（压缩包是不可信输入）", async () => {
	const { resourcesPath, cacheRoot } = makeWorkspace();
	const { manifest } = await makeArchive(resourcesPath);
	manifest.sha256 = "0".repeat(64);
	writeFileSync(join(resourcesPath, "feishu-sdk", "manifest.json"), JSON.stringify(manifest));
	const result = await load({ resourcesPath, cacheRoot });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "checksum");
	assert.equal(existsSync(join(cacheRoot, "feishu-sdk", VERSION)), false, "校验失败不得留下缓存目录");
});

test("压缩包缺失返回 missing-archive 而非抛裸异常", async () => {
	const { resourcesPath, cacheRoot } = makeWorkspace();
	const result = await load({ resourcesPath, cacheRoot });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "missing-archive");
});

test("loadFeishuSdkOnce 并发调用只解压一次；失败后允许重试", async () => {
	const { resourcesPath, cacheRoot } = makeWorkspace();
	await makeArchive(resourcesPath);
	resetFeishuSdkRuntime();
	const [a, b] = await Promise.all([loadFeishuSdkOnce({ resourcesPath, cacheRoot }), loadFeishuSdkOnce({ resourcesPath, cacheRoot })]);
	assert.equal(a, b, "并发调用必须共享同一个 Promise 结果对象");
	assert.equal(a.ok, true);

	// 失败场景：缺失压缩包 → 结果 ok=false，且单例被清空，下次可重试。
	const broken = makeWorkspace();
	resetFeishuSdkRuntime();
	const failed = await loadFeishuSdkOnce({ resourcesPath: broken.resourcesPath, cacheRoot: broken.cacheRoot });
	assert.equal(failed.ok, false);
	await makeArchive(broken.resourcesPath);
	const retried = await loadFeishuSdkOnce({ resourcesPath: broken.resourcesPath, cacheRoot: broken.cacheRoot });
	assert.equal(retried.ok, true, "失败一次后应允许重试（否则用户永远启不了飞书）");
	resetFeishuSdkRuntime();
});
