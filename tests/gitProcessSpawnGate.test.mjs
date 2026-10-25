import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * git 子进程收口守卫（AGENTS「Electron 开发规范」硬约束）：
 * git 调用只允许两个入口——src/main/git/gitRun.ts 的 execGit（读）与
 * runGitCommand（写），WSL 仓库统一走 gitWsl.ts（在 gitRun 内分流）。
 * 直连 spawn/exec 在收口外会绕开：超时、错误分类、WSL dubious-ownership
 * 处理与「宿主 git.exe 经 9P 判 dubious ownership」的修复。
 *
 * 白名单（合法例外，各有护栏）：
 * - devIsolation.ts: dev 实例隔离读取应用自身 dev 检出的分支——不是用户仓库
 *   操作，且 execFileSync 带 try/catch + 2s 超时 + 数组参数 + execGit 注入点。
 * - gitExecutable.ts: git 可执行文件发现（where/which 探测），非仓库操作。
 *
 * 本测试扫全 src/main：任何新的直连 git 子进程调用（spawn/exec/execFile/
 * execFileSync，含 "git" 字面量首参）都会在这里红。
 */

function listMainTsFiles() {
	return execFileSync("git", ["ls-files", "src/main"], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"));
}

test("src/main 不存在收口白名单之外的 git 子进程直连", () => {
	const allowlist = new Set([
		// 唯一收口：读类与写类两个入口
		"src/main/git/gitRun.ts",
		// WSL 分流（由 gitRun 调用，自身就是入口实现的一部分）
		"src/main/git/gitWsl.ts",
		// 合法例外：dev 隔离读自身检出分支（带超时+try/catch+注入点）
		"src/main/devIsolation.ts",
		// 合法例外：git 可执行文件发现（where/which 探测，非仓库操作）
		"src/main/git/gitExecutable.ts",
	]);
	const files = listMainTsFiles();
	assert.ok(files.length > 50, "fixture sanity: src/main should list a real file set");
	// 直连形态：spawn*/execFile*/execSync*( "git" / ("git", [...]) —— 与 gitRun 内部实现无关，
	// 只匹配「以 git 为可执行名的直接子进程调用」。
	const directCall = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*(?:await\s+)?["']git["']/;
	const violations = [];
	for (const file of files) {
		if (allowlist.has(file)) continue;
		const source = readFileSync(file, "utf8");
		if (directCall.test(source)) violations.push(file);
	}
	assert.deepEqual(violations, [], `git 子进程必须收口在 gitRun.ts（新增直连要么进收口，要么更新白名单并说明护栏）：\n${violations.join("\n")}`);
});

test("devIsolation 直连保持护栏：超时 + try/catch + 数组参数 + 注入点", () => {
	const source = readFileSync("src/main/devIsolation.ts", "utf8");
	assert.match(source, /execFileSync\("git", \["rev-parse", "--abbrev-ref", "HEAD"\]/);
	assert.match(source, /timeout: 2000/);
	assert.match(source, /function defaultExecGit[\s\S]*?\{[\s\S]*?try \{[\s\S]*?\} catch \{[\s\S]*?return undefined;\s*\}/);
	assert.match(source, /input\.execGit \?\? defaultExecGit/);
});

test("gitRun 收口仍是唯一通用入口：execGit 与 runGitCommand 并存", () => {
	const source = readFileSync("src/main/git/gitRun.ts", "utf8");
	assert.match(source, /export (async )?function execGit/);
	assert.match(source, /export (async )?function runGitCommand/);
});
