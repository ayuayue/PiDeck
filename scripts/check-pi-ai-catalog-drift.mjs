#!/usr/bin/env node
/**
 * pi-ai 模型目录版本漂移体检：仓库预生成件 ↔ 锁定依赖 ↔ npm 最新发布。
 *
 * 背景（2026-10 用户反馈「更新失败但老提示有更新」）：运行时目录更新有两条源——
 * 仓库分支预生成件（主源）与 npm latest 生成源（回退）。两者版本必须能互相兑现，
 * 但它们的「更新时机」完全不同：
 *
 *   resources/pi-ai-catalog.manifest.json  ← 跟着 devDependencies 的 pi-ai 版本走，
 *                                            只在有人跑 generate:pi-ai-catalog 并提交时前进
 *   npm latest                            ← 上游一发布就变
 *
 * 于是会出现「发行分支上的预生成件停在 1.3.0，npm 已是 1.4.0」这种长期两条线：
 * 检测侧（走 npm 回退）报「有更新」，写入侧却一直拿分支件比对，用户看到的就是
 * 反复提示可更新。 `--check` 只能发现「本地 node_modules 与仓库文件不一致」，
 * 发现不了「仓库文件与 npm 发布不一致」——本脚本补的就是这一环。
 *
 * 退出码：
 *   0  一致或仓库件更新（npm 落后，属正常：上游尚未发布）
 *   1  仓库预生成件落后于 npm 最新发布（应更新 devDependencies 并重生成 resources/）
 *   2  无法判定（网络/文件缺失）—— 体检失败不等于数据有问题，别让 CI 误报
 *
 * 用法：
 *   node scripts/check-pi-ai-catalog-drift.mjs
 *   node scripts/check-pi-ai-catalog-drift.mjs --json
 *   node scripts/check-pi-ai-catalog-drift.mjs --allow-unknown   # CI：网络不可达不算红灯
 *   node scripts/check-pi-ai-catalog-drift.mjs --registry https://registry.npmjs.org
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

export const PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
export const CATALOG_MANIFEST_FILE_NAME = "pi-ai-catalog.manifest.json";
/** 与运行时 PiAiCatalogUpdater 使用同一组 registry 镜像（国内优先）。 */
export const NPM_LATEST_URLS = [`https://registry.npmmirror.com/${PI_AI_PACKAGE_NAME}/latest`, `https://registry.npmjs.org/${PI_AI_PACKAGE_NAME}/latest`];

function isRecord(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 从 manifest 文本取来源包版本（不依赖生成器，脚本可独立体检任何历史产物）。 */
export function parseArtifactPackageVersion(manifestText) {
	let parsed;
	try {
		parsed = JSON.parse(manifestText);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !isRecord(parsed.source)) return null;
	const version = parsed.source.packageVersion;
	return typeof version === "string" && version.trim() ? version.trim() : null;
}

/** 从 package.json 取锁定的 pi-ai 版本（devDependencies 里的精确版本）。 */
export function parseDeclaredVersion(packageJsonText) {
	let parsed;
	try {
		parsed = JSON.parse(packageJsonText);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !isRecord(parsed.devDependencies)) return null;
	const declared = parsed.devDependencies[PI_AI_PACKAGE_NAME];
	if (typeof declared !== "string") return null;
	const trimmed = declared.trim();
	// 只认精确版本：范围说明锁没生效，本身就是漂移风险
	return /^\d+\.\d+\.\d+/.test(trimmed) ? trimmed.replace(/^[^\d]*/, "") : null;
}

/**
 * 语义版本比较（够用即可：数字段逐段比，`-xxx` 预发布低于同号正式版）。
 * 运行时的 compareSemver 在 TS 侧，脚本不引构建链，故这里自带一份并单测。
 */
export function compareVersions(a, b) {
	const split = (value) => {
		const text = String(value ?? "").trim();
		const [core, ...rest] = text.split("-");
		const nums = core.split(".").map((part) => {
			const n = Number.parseInt(part, 10);
			return Number.isFinite(n) ? n : 0;
		});
		return { nums, prerelease: rest.join("-") };
	};
	const left = split(a);
	const right = split(b);
	const length = Math.max(left.nums.length, right.nums.length);
	for (let i = 0; i < length; i += 1) {
		const l = left.nums[i] ?? 0;
		const r = right.nums[i] ?? 0;
		if (l !== r) return l > r ? 1 : -1;
	}
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease > right.prerelease ? 1 : -1;
}

/**
 * 判定漂移状态。
 * - artifact-behind：仓库预生成件落后于 npm 最新发布（= 用户反馈的那类「提示可更新但写不进去」）
 * - ok：仓库件不旧于 npm 最新发布（相等或上游尚未发布，正常）
 * - declared-mismatch：package.json 锁定的版本与仓库产物不一致（构建守卫会拦，但值得报出来）
 */
export function decideDrift({ artifactVersion, declaredVersion, npmLatest }) {
	if (!artifactVersion) return { status: "unknown", reason: "artifact-missing" };
	if (!npmLatest) return { status: "unknown", reason: "npm-unreachable" };
	const artifactVsNpm = compareVersions(artifactVersion, npmLatest);
	const declaredVsArtifact = declaredVersion ? compareVersions(declaredVersion, artifactVersion) : 0;
	return {
		status: artifactVsNpm < 0 ? "artifact-behind" : "ok",
		artifactVersion,
		declaredVersion: declaredVersion ?? null,
		npmLatest,
		artifactVsNpm,
		declaredVsArtifact,
	};
}

/** 拉 npm latest 版本；两个镜像都失败返回 null（体检失败，不当作漂移）。 */
export async function fetchNpmLatestVersion({ fetchImpl = globalThis.fetch, registry, timeoutMs = 15000 } = {}) {
	const urls = registry ? [`${registry.replace(/\/$/, "")}/${PI_AI_PACKAGE_NAME}/latest`] : NPM_LATEST_URLS;
	for (const url of urls) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchImpl(url, { signal: controller.signal });
			if (!response?.ok) continue;
			const text = await response.text();
			const parsed = JSON.parse(text);
			if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
		} catch {
			// 换下一个镜像
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}

async function main(argv = process.argv.slice(2)) {
	const json = argv.includes("--json");
	// CI 用：registry 不可达时退出码 0（体检没做成不等于数据有漂移，别让网络抖动卡合入）
	const allowUnknown = argv.includes("--allow-unknown");
	const registryFlag = argv.indexOf("--registry");
	const registry = registryFlag >= 0 ? argv[registryFlag + 1] : undefined;

	let manifestText = "";
	let packageJsonText = "";
	try {
		manifestText = readFileSync(join(PROJECT_ROOT, "resources", CATALOG_MANIFEST_FILE_NAME), "utf8");
		packageJsonText = readFileSync(join(PROJECT_ROOT, "package.json"), "utf8");
	} catch (error) {
		const message = `读取 resources/${CATALOG_MANIFEST_FILE_NAME} 或 package.json 失败：${error instanceof Error ? error.message : String(error)}`;
		if (json) process.stdout.write(`${JSON.stringify({ status: "unknown", reason: "files-missing", message })}\n`);
		else process.stderr.write(`${message}\n`);
		return 2;
	}

	const artifactVersion = parseArtifactPackageVersion(manifestText);
	const declaredVersion = parseDeclaredVersion(packageJsonText);
	const npmLatest = await fetchNpmLatestVersion({ registry });
	const verdict = decideDrift({ artifactVersion, declaredVersion, npmLatest });

	if (json) {
		process.stdout.write(`${JSON.stringify(verdict)}\n`);
	} else {
		process.stdout.write(`pi-ai 目录版本体检\n  仓库预生成件：${artifactVersion ?? "（读不出来）"}\n  package.json 锁定：${declaredVersion ?? "（无精确版本）"}\n  npm 最新发布：${npmLatest ?? "（两个镜像都不可达）"}\n`);
		if (verdict.status === "artifact-behind") {
			process.stdout.write(`  → 仓库预生成件落后：先升 devDependencies 的 ${PI_AI_PACKAGE_NAME}，再跑 npm run generate:pi-ai-catalog 并提交 resources/\n`);
		} else if (verdict.status === "ok") {
			process.stdout.write("  → 无漂移：仓库件不旧于 npm 最新发布\n");
		} else {
			process.stdout.write(`  → 无法判定：${verdict.reason}\n`);
		}
	}

	if (verdict.status === "unknown") {
		if (!json) process.stdout.write(`  → 体检未完成${allowUnknown ? "，按 --allow-unknown 放行" : ""}\n`);
		return allowUnknown ? 0 : 2;
	}
	return verdict.status === "artifact-behind" ? 1 : 0;
}

// 仅在被直接执行时跑主流程（测试导入不应触网）。
// 用 exitCode 而非 process.exit()：未关闭的 socket 与强制退出在 Windows 上会触发 libuv 断言。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().then((code) => {
		process.exitCode = code;
	});
}
