#!/usr/bin/env node
/**
 * package.json 结构完整性门禁（确定性、纯本地、<0.1 秒）。
 *
 * 为什么需要（2026-11-15 事故，dev 直推 e6d7eb3ba）：编辑 package.json 删掉了
 * `},` 与 `"dependencies": {` 两行，JSON 仍然合法，但整个 dependencies 段被吞进
 * scripts——所有运行时依赖变成 npm script 的键名。`npm ci` 不报错（只是不装），
 * 于是 15229db5e / 5649d8984 / 906217e77 三笔 CI 连续红在
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'electron-updater'`（caf7b87a8 修）。
 *
 * 判据（任一命中即 rc=1）：
 * 1. 不是合法 JSON；
 * 2. 缺 scripts / dependencies / devDependencies 三个顶层段；
 * 3. scripts 里出现包名样式的键（`@scope/name` 或含 `/`）——依赖被吞进 scripts 的形态；
 * 4. dependencies / devDependencies 的版本值不是非空字符串（被挪成对象或 null）；
 * 5. scripts 的值不是字符串（脚本被别的段覆盖）。
 *
 * 用法：node scripts/check-package-json.mjs [路径]（默认 package.json）
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REQUIRED_SECTIONS = ["scripts", "dependencies", "devDependencies"];

/** @returns {string[]} 问题列表，空数组表示通过。 */
export function validatePackageJson(text) {
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch (error) {
		return [`不是合法 JSON：${error.message}`];
	}
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return ["顶层不是对象"];
	const problems = [];
	const keys = Object.keys(pkg);
	for (const section of REQUIRED_SECTIONS) {
		const value = pkg[section];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			problems.push(`缺 ${section} 段（现有顶层键：${keys.join(", ")}）`);
		}
	}
	const scripts = pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
	const swallowed = Object.keys(scripts).filter((key) => key.startsWith("@") || key.includes("/"));
	if (swallowed.length > 0) {
		problems.push(`scripts 里混进了包名样式的键（${swallowed.slice(0, 5).join(", ")}）：dependencies 段被吞进 scripts 了`);
	}
	const badScripts = Object.entries(scripts).filter(([, value]) => typeof value !== "string");
	if (badScripts.length > 0) {
		problems.push(
			`scripts 有非字符串命令：${badScripts
				.slice(0, 5)
				.map(([key]) => key)
				.join(", ")}`,
		);
	}
	for (const section of ["dependencies", "devDependencies"]) {
		const deps = pkg[section];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
		const bad = Object.entries(deps).filter(([, value]) => typeof value !== "string" || value.length === 0);
		if (bad.length > 0)
			problems.push(
				`${section} 的版本不是非空字符串：${bad
					.slice(0, 5)
					.map(([key]) => key)
					.join(", ")}`,
			);
	}
	return problems;
}

function main(argv) {
	const file = argv[0] ?? "package.json";
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		console.error(`[check-package-json] 读不到 ${file}：${error.message}`);
		process.exit(2);
	}
	const problems = validatePackageJson(text);
	if (problems.length === 0) {
		const pkg = JSON.parse(text);
		console.log(`[check-package-json] ok：${Object.keys(pkg.scripts ?? {}).length} 个脚本 · ${Object.keys(pkg.dependencies ?? {}).length} 个运行时依赖 · ${Object.keys(pkg.devDependencies ?? {}).length} 个开发依赖`);
		return;
	}
	console.error(`[check-package-json] ${file} 结构不完整：`);
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error('  修法：把被吞掉的段头补回来（`},` + `"dependencies": {` + 首个依赖行），别只靠 JSON.parse 通过。');
	process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	main(process.argv.slice(2));
}
