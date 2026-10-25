/**
 * 打包飞书 SDK 为按需解压的 tar.gz（体积优化，2026-10）。
 *
 * 为什么存在：`@larksuiteoapi/node-sdk` 的 CJS 入口是单文件 5MB，加上它独占的
 * 传递依赖（protobufjs、axios、lodash 系列、form-data 链）在 app.asar 里约占 7.2MB；
 * 而飞书是可选集成（需要用户自己填 appId/appSecret）。把这条链打成压缩包随包分发，
 * 首次启用飞书时解压到 userData，安装包可少约 5.5MB，且不引入网络依赖。
 *
 * 依赖闭包从 package-lock.json 计算（不联网、不依赖 npm 解析）：从
 * `@larksuiteoapi/node-sdk` 沿 dependencies 递归，得到与 `npm i --omit=dev` 一致的 48 个包。
 *
 * 产物：
 *   resources/feishu-sdk/feishu-sdk-<version>.tar.gz
 *   resources/feishu-sdk/manifest.json   { version, sha256, bytes, packages, files }
 *
 * 用法：node scripts/pack-feishu-sdk.mjs [--check]
 *   --check 只校验现有产物与当前 node_modules 一致（CI 用），不重写。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_NAME = "@larksuiteoapi/node-sdk";
const OUT_DIR = join(ROOT, "resources", "feishu-sdk");

/** 非运行时文件：类型声明、sourcemap、文档、测试、ESM 副本。 */
const EXCLUDED_SEGMENTS = new Set(["es", "types", "docs", "doc", "test", "tests", "__tests__", "coverage", "example", "examples"]);
const EXCLUDED_FILE = /(?:\.d\.(?:ts|mts|cts)|\.map|\.md|\.markdown)$/i;
const KEPT_DOCS = /(?:^|\/)(?:LICENSE|LICENCE|NOTICE)(?:\.[a-z]+)?$/i;

/** 从 package-lock.json 计算 SDK 的运行时依赖闭包（48 个包，与 npm 的 hoist 结果对齐）。 */
export function collectSdkClosure(lock) {
	const packages = lock.packages ?? {};
	const byName = new Map();
	for (const [key, entry] of Object.entries(packages)) {
		if (!key.includes("node_modules/")) continue;
		const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
		if (!name || name.includes("node_modules/")) continue;
		// 嵌套安装的同名包优先取更短路径（hoisted 版本）；同名多版本时取第一个即可——
		// 飞书链没有多版本冲突（npm ls 已验证 deduped）。
		if (!byName.has(name)) byName.set(name, entry);
	}
	const seen = new Set();
	const walk = (name) => {
		if (seen.has(name)) return;
		const entry = byName.get(name);
		if (!entry) throw new Error(`package-lock.json 缺少依赖：${name}`);
		seen.add(name);
		for (const dep of Object.keys(entry.dependencies ?? {})) walk(dep);
	};
	walk(SDK_NAME);
	return [...seen].sort();
}

function shouldInclude(relativePath) {
	const segments = relativePath.split("/");
	if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
		// 包根下的 docs 目录整段跳过；但 SKILL 里的 LICENSE 例外由 KEPT_DOCS 单独判断
		return KEPT_DOCS.test(relativePath);
	}
	if (EXCLUDED_FILE.test(relativePath) && !KEPT_DOCS.test(relativePath)) return false;
	return true;
}

export async function packFeishuSdk({ checkOnly = false, outDir = OUT_DIR } = {}) {
	const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
	const packages = collectSdkClosure(lock);
	const sdkVersion = lock.packages[`node_modules/${SDK_NAME}`]?.version;
	if (!sdkVersion) throw new Error(`package-lock.json 里找不到 ${SDK_NAME}`);

	const archiveName = `feishu-sdk-${sdkVersion}.tar.gz`;
	const archivePath = join(outDir, archiveName);
	const manifestPath = join(outDir, "manifest.json");

	if (checkOnly) {
		if (!existsSync(archivePath) || !existsSync(manifestPath)) throw new Error(`缺少飞书 SDK 产物：${archivePath}`);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.version !== sdkVersion) throw new Error(`飞书 SDK 产物版本 ${manifest.version} ≠ 依赖版本 ${sdkVersion}，请重跑 npm run build:feishu-sdk`);
		const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
		if (digest !== manifest.sha256) throw new Error("飞书 SDK 产物 sha256 与 manifest 不一致");
		return { archivePath, manifest, checked: true };
	}

	await mkdir(outDir, { recursive: true });
	await rm(archivePath, { force: true });

	// 包目录本身（按 install 布局：node_modules/<name>），只保留运行时文件。
	const entries = packages.map((name) => `node_modules/${name}`);
	let files = 0;
	await tar.create(
		{
			gzip: { level: 9 },
			cwd: ROOT,
			file: archivePath,
			// portable 只对目录条目置 noMtime，文件条目仍会嵌 stat.mtime → 换机器/重跑
			// npm ci 后 sha256 变一次，产物不可复现。配合 gzip 的 MTIME 归零才能稳定。
			noMtime: true,
			portable: true,
			prefix: "",
			filter: (path) => {
				const relative = path.replace(/\\/g, "/");
				if (!relative.startsWith("node_modules/")) return false;
				if (!shouldInclude(relative)) return false;
				files += 1;
				return true;
			},
		},
		entries,
	);

	if (!existsSync(archivePath)) throw new Error("tar.create 未产出文件");
	const bytes = statSync(archivePath).size;
	const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
	const manifest = { version: sdkVersion, archive: archiveName, sha256, bytes, packages, files };
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return { archivePath, manifest };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const checkOnly = process.argv.includes("--check");
	const result = await packFeishuSdk({ checkOnly });
	const m = result.manifest;
	console.log(`${checkOnly ? "校验通过" : "已生成"} ${m.archive}: ${(m.bytes / 1048576).toFixed(2)} MB, ${m.files} 文件, ${m.packages.length} 个包, sdk ${m.version}`);
}
