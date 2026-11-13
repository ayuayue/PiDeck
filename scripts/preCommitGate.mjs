#!/usr/bin/env node
/**
 * 本地提交前守卫（`.githooks/pre-commit` 的唯一实现，sh 只负责找 node 与仓库根）。
 *
 * 挡三件「几秒内能判、且一旦进主干就要再开一个 PR 才能修」的事：
 *   1. `scripts/check-file-size.mjs`  存量巨文件行数只准降；新文件 >600 行要先写拆分计划
 *   2. `scripts/check-test-shape.mjs` 禁止新增「只读源码字符串、零运行时验证」的测试
 *   3. biome format —— **只查本次暂存的源文件**，不查别人工作区里还没提交的改动
 *
 * 不挡（留给 CI，单机跑太慢或需要构建）：全量 typecheck、单测、check:ipc-wiring、e2e。
 *
 * 跳过：`PI_DECK_SKIP_PRECOMMIT=1 git commit ...`（确有正当理由时用，CI 仍会再挡一次）。
 *
 * 已知取舍：1 与 2 是全仓扫描（几十毫秒到 1 秒），因为它们守的是「仓库整体不变量」，
 * 按暂存文件算会漏掉「本次没改但那行数已经顶过基线」的情况。
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 只有这些扩展名交给 biome；`.md`/`.yml` 等不在 `npm run check:format` 的检查范围里。 */
const FORMATTABLE = /\.(ts|tsx|mjs|cjs|js|json|css)$/;

/**
 * 从 `git diff --cached --name-only` 的输出里挑出「本次暂存 + 仍存在于工作区」的可格式化文件。
 * 纯函数，便于单测：删除文件（D）已被 git 排除，这里再挡一道 existsSync 兜底。
 */
export function pickFormattableStagedFiles(paths) {
	return paths.filter((path) => FORMATTABLE.test(path) && existsSync(path));
}

function run(label, command, args) {
	try {
		execFileSync(command, args, { stdio: "inherit" });
		return { label, ok: true };
	} catch {
		return { label, ok: false };
	}
}

function main() {
	if (process.env.PI_DECK_SKIP_PRECOMMIT === "1") {
		console.log("[preCommitGate] PI_DECK_SKIP_PRECOMMIT=1，跳过本地守卫");
		return;
	}

	const failures = [];

	const fileSize = run("check:file-size", process.execPath, ["scripts/check-file-size.mjs"]);
	if (!fileSize.ok) failures.push({ ...fileSize, hint: "存量巨文件不能净增长；新文件 >600 行先写拆分计划（docs/mega-file-split-plan.md）" });

	const testShape = run("check:test-shape", process.execPath, ["scripts/check-test-shape.mjs"]);
	if (!testShape.ok) failures.push({ ...testShape, hint: "新增测试要有运行时验证；确实只能读源码就把理由写进 PR 并跑 --update" });

	// 直接走包内 JS 入口：`node_modules/.bin/biome` 在 Windows 是 sh 包装脚本，execFileSync 起不来。
	const biome = "node_modules/@biomejs/biome/bin/biome";
	if (existsSync(biome)) {
		const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" }).split("\n").filter(Boolean);
		const targets = pickFormattableStagedFiles(staged);
		if (targets.length > 0) {
			const format = run("format(staged)", process.execPath, [biome, "format", "--no-errors-on-unmatched", ...targets]);
			if (!format.ok) failures.push({ ...format, hint: "跑 `npm run format`（或对这几个文件跑 node_modules/.bin/biome format --write）" });
		}
	} else {
		console.warn(`[preCommitGate] 未找到 ${biome}，跳过格式检查（先 npm ci）`);
	}

	if (failures.length === 0) {
		console.log("[preCommitGate] ok");
		return;
	}

	console.error(`\n[preCommitGate] ${failures.length} 项没过：`);
	for (const failure of failures) console.error(`  - ${failure.label}：${failure.hint}`);
	console.error("\n修完再提交；确有正当理由时可用 `PI_DECK_SKIP_PRECOMMIT=1 git commit ...` 跳过（CI 仍会再挡一次）。");
	process.exit(1);
}

// 只有被直接执行时才跑检查；被测试 import 时只暴露纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
