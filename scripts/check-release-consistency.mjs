#!/usr/bin/env node
/**
 * 发布一致性检查——把 docs/release-process.md 里需要人眼核对的版本一致性自动化，
 * 供 release preflight 的 release 泳道与单独调用：
 *
 *   node scripts/check-release-consistency.mjs
 *
 * FAIL（退出码 1）项：
 *   1. package-lock.json 根 version 与 packages[""].version 必须等于 package.json；
 *   2. CHANGELOG.md / CHANGELOG.zh-CN.md 最新版本头必须等于 package.json 版本；
 *   3. 两份 CHANGELOG 最新小节的条目数必须一致（中英一致是发版硬约束）；
 *   4. README.md / README.en.md 顶部版本徽章与「最新版本 / Latest」行必须等于 package.json。
 * WARN（不阻断，只提醒）项：版本头仍是 (Unreleased) 或缺日期；README 找不到徽章/版本行
 *   （可能被删或改了格式——徽章按文档是手工更新的，缺失值得人工看一眼）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** shields.io 徽章路径段尾部的颜色词（version-0.7.9-blue 的 blue），剥离后剩余版本号。 */
const BADGE_COLORS = ["brightgreen", "green", "yellowgreen", "yellow", "orange", "red", "blue", "lightgrey", "blueviolet", "ff69b4", "success", "important", "critical", "informational", "inactive", "9cf"];

/**
 * 解析 CHANGELOG 第一个版本头。兼容两种历史格式：
 *   `## v0.7.9 (Unreleased)`（发版准备中）与 `## v0.7.8 - 2026-10-05`（已定稿）。
 * 版本号本身可带 -beta.N 后缀。找不到头返回 null。
 */
export function parseChangelogHead(text) {
	if (typeof text !== "string") return null;
	const match = text.match(/^##\s+(v[0-9][^\s(]*)[ \t]*(?:\(([^)]*)\)|[-—][ \t]*(\S+))?[ \t]*$/m);
	if (!match) return null;
	return { version: match[1], dateLabel: (match[2] ?? match[3] ?? "").trim() };
}

/** 数最新版本小节里 `- **` 开头的条目行（列 0），到下一个 `## v` 版本头为止。 */
export function countChangelogEntries(text) {
	const lines = typeof text === "string" ? text.split(/\r?\n/) : [];
	const isHead = (line) => /^##\s+v[0-9]/.test(line);
	const start = lines.findIndex(isHead);
	if (start === -1) return 0;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (isHead(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).filter((line) => /^- \*\*/.test(line)).length;
}

/**
 * 解析 README 顶部 shields 徽章里的版本号。shields 用 `--` 转义版本号中的 `-`
 * （v0.8.0-beta.1 徽章写成 version-0.8.0--beta.1-blue），这里反解回来。
 */
export function parseVersionBadge(text) {
	const match = typeof text === "string" ? text.match(/img\.shields\.io\/badge\/version-([^\s"')]+)/) : null;
	if (!match) return null;
	let raw = match[1];
	for (const color of BADGE_COLORS) {
		const suffix = `-${color}`;
		if (raw.length > suffix.length && raw.toLowerCase().endsWith(suffix)) {
			raw = raw.slice(0, -suffix.length);
			break;
		}
	}
	return raw.replace(/--/g, "-");
}

/** 解析 README 的「最新版本 vX」/「Latest: vX」行，返回版本号（不带 v）；没有返回 null。 */
export function parseLatestVersionLine(text) {
	if (typeof text !== "string") return null;
	const zh = text.match(/最新版本\s*v([\w.-]+)/);
	if (zh) return zh[1];
	const en = text.match(/Latest:?\s+v([\w.-]+)/i);
	return en ? en[1] : null;
}

/**
 * 纯函数：全部一致性规则。输入各文件的原始文本/版本号，返回 { failures, warnings }，
 * 便于单测用 fixture 断言，不依赖仓库当前状态（发版期的真实状态天天变）。
 */
export function collectIssues({ pkgVersion, lockVersion, lockRootVersion, changelogEn, changelogZh, readmeZh, readmeEn }) {
	const failures = [];
	const warnings = [];
	const expectHead = `v${pkgVersion}`;

	if (lockVersion !== pkgVersion) failures.push(`package-lock.json 根版本 ${lockVersion} ≠ package.json ${pkgVersion}`);
	if (lockRootVersion !== pkgVersion) failures.push(`package-lock.json packages[""].version ${lockRootVersion} ≠ package.json ${pkgVersion}`);

	const heads = [
		["CHANGELOG.md", changelogEn],
		["CHANGELOG.zh-CN.md", changelogZh],
	];
	for (const [label, text] of heads) {
		const head = parseChangelogHead(text);
		if (!head) {
			failures.push(`${label} 找不到版本头（## vX.Y.Z …）`);
			continue;
		}
		if (head.version !== expectHead) failures.push(`${label} 最新版本 ${head.version} ≠ package.json ${expectHead}`);
		if (/^unreleased$/i.test(head.dateLabel)) warnings.push(`${label} 版本头仍是 (Unreleased)——发版前补上日期`);
		else if (head.dateLabel === "") warnings.push(`${label} 版本头没有日期`);
	}
	// 条目数一致是「中英文一致」的可机检代理：逐条比对文案不可自动判定，数量不同必错。
	const enCount = countChangelogEntries(changelogEn);
	const zhCount = countChangelogEntries(changelogZh);
	if (enCount !== zhCount) failures.push(`CHANGELOG 中英条目数不一致：EN ${enCount} vs ZH ${zhCount}`);

	for (const [label, text] of [
		["README.md", readmeZh],
		["README.en.md", readmeEn],
	]) {
		const badge = parseVersionBadge(text);
		if (badge === null) warnings.push(`${label} 未找到版本徽章（img.shields.io/badge/version-…）——按文档徽章需手工更新，确认是否被删`);
		else if (badge !== pkgVersion) failures.push(`${label} 徽章版本 ${badge} ≠ package.json ${pkgVersion}`);
		const latest = parseLatestVersionLine(text);
		if (latest === null) warnings.push(`${label} 未找到「最新版本 / Latest」行`);
		else if (latest !== pkgVersion) failures.push(`${label} 最新版本行 v${latest} ≠ package.json ${pkgVersion}`);
	}
	return { failures, warnings };
}

function main() {
	const read = (p) => readFileSync(join(ROOT, p), "utf8");
	const pkg = JSON.parse(read("package.json"));
	const lock = JSON.parse(read("package-lock.json"));
	const { failures, warnings } = collectIssues({
		pkgVersion: pkg.version,
		lockVersion: lock.version,
		lockRootVersion: lock.packages?.[""]?.version,
		changelogEn: read("CHANGELOG.md"),
		changelogZh: read("CHANGELOG.zh-CN.md"),
		readmeZh: read("README.md"),
		readmeEn: read("README.en.md"),
	});
	console.log(`发布一致性检查（package.json ${pkg.version}）`);
	for (const warning of warnings) console.log(`  ⚠️  ${warning}`);
	for (const failure of failures) console.log(`  ❌ ${failure}`);
	if (!failures.length) {
		console.log(`  ✅ 版本/CHANGELOG/README 全部一致（${warnings.length} 个提醒）`);
		return;
	}
	console.log(`  共 ${failures.length} 项不一致`);
	process.exitCode = 1;
}

// 直接执行时才跑 main；被测试 import 时不产生副作用。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
