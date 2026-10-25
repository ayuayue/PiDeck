import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Git 提交日期单位契约（Web 端 58776/7/5 事故回归）。
 *
 * GitService 解析 `git log` 时已把秒级时间戳乘 1000 转成毫秒，因此所有消费方
 * 必须直接 new Date(ms)。Web 抽屉曾再乘一次 1000，把 2026 显示成 58776 年。
 * 类型注释同样要写清毫秒，否则下一次照着注释改又会踩回去。
 */

const gitService = readFileSync("src/main/git/GitService.ts", "utf8");
const sharedGitTypes = readFileSync("src/shared/types/git.ts", "utf8");
const webWorkspaceDrawer = readFileSync("src/renderer/src/web/WebWorkspaceDrawer.tsx", "utf8");
const desktopGitGraph = readFileSync("src/renderer/src/components/app/git/GitGraph.tsx", "utf8");

test("GitService normalizes the git log timestamp to milliseconds exactly once", () => {
	assert.match(gitService, /authorDate:\s*Number\(authorDate\)\s*\*\s*1000/, "GitService must convert git's second-precision timestamp to ms exactly once");
});

test("shared CommitEntry documents authorDate as milliseconds", () => {
	const line = sharedGitTypes.split("\n").find((text) => text.includes("authorDate"));
	assert.ok(line, "CommitEntry must declare authorDate");
	assert.match(line, /ms/, "the field comment must state milliseconds, or consumers will re-multiply by 1000");
	assert.doesNotMatch(line, /\/\/ unix timestamp\s*$/, "a bare 'unix timestamp' comment implies seconds and caused the Web 5-digit-year bug");
});

test("Web workspace drawer renders commit dates without re-multiplying", () => {
	assert.doesNotMatch(webWorkspaceDrawer, /authorDate\s*\*\s*1000/, "authorDate is already ms; multiplying again renders years like 58776");
	assert.match(webWorkspaceDrawer, /new Date\(authorDate\)/, "the drawer must consume authorDate directly");
});

test("Web commit date label tolerates missing or non-finite timestamps", () => {
	// 抽成函数是为了让 0/NaN/undefined 有统一出口：内联三元会让空值渲染成 1970 或 NaN。
	assert.match(webWorkspaceDrawer, /function commitDateLabel\(/, "commit date formatting belongs in a helper with its own guard");
	assert.match(webWorkspaceDrawer, /Number\.isFinite\(authorDate\)/, "non-finite authorDate must not reach new Date()");
});

test("desktop GitGraph agrees with the milliseconds contract", () => {
	assert.doesNotMatch(desktopGitGraph, /authorDate\s*\*\s*1000/, "desktop and Web must use the same unit for authorDate");
	assert.match(desktopGitGraph, /new Date\(ms\)/, "desktop absoluteTime already treats the value as ms");
});
