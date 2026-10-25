import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";

/**
 * 回归测试：一次暂存大量文件（生成物 / lockfile / 整目录）时 `git diff --staged` 会超过
 * execGit 的 10MB 输出上限，旧实现让整个「AI 生成提交摘要」失败并提示
 * `stdout maxBuffer length exceeded`（issue #391 评论）。
 *
 * 修复：输出溢出时改用已被截断的 stdout（提示词本来就只取前 8000 字符），仍按 maxBytes 截断 +
 * 追加 "diff truncated" 标记；其它失败（超时 / 仓库损坏）继续抛出，不能被当成空暂存区。
 */

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-staged-diff-build-"));
const repositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-staged-diff-"));
let GitService;

function git(...args) {
	return execFileSync("git", args, {
		cwd: repositoryDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function write(relativePath, content) {
	writeFileSync(join(repositoryDir, relativePath), content);
}

before(() => {
	// 与 gitWorkspaceFileDiffUntracked.test.mjs 同一套构建方式：GitService 依赖链里的本地 import
	// 带 .ts 扩展名（Node type stripping 约定），CLI tsc 需在 emit 时重写为 .js。
	execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "src/main/git/GitService.ts", "src/shared/types.ts", "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--rewriteRelativeImportExtensions", "--outDir", buildDir], {
		cwd: resolve("."),
		stdio: "pipe",
	});
	// GitService → ../fs/trash 懒加载 electron.shell.trashItem：stub 掉
	const stubElectronDir = join(buildDir, "node_modules", "electron");
	mkdirSync(stubElectronDir, { recursive: true });
	writeFileSync(join(stubElectronDir, "package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
	writeFileSync(join(stubElectronDir, "index.js"), `exports.shell = { trashItem: async () => {} };`);
	({ GitService } = require(join(buildDir, "main/git/GitService.js")));

	git("init");
	git("config", "core.autocrlf", "false");
	git("config", "user.name", "PiDeck Test");
	git("config", "user.email", "test@example.com");
});

describe("getStagedDiff output overflow", () => {
	test("staged diff larger than maxBuffer degrades to the truncated head instead of failing", async () => {
		// 逐行不同内容（无 NUL）：git 按文本处理，diff 体积略大于文件体积（每行加 "+" 前缀）
		const lines = Array.from({ length: 250_000 }, (_, index) => `line ${index} ${"x".repeat(32)}`);
		write("huge.txt", lines.join("\n") + "\n");
		git("add", "huge.txt");

		const svc = new GitService();
		const diff = await svc.getStagedDiff(repositoryDir, 200);

		assert.match(diff, /^diff --git a\/huge\.txt b\/huge\.txt/, "溢出时仍要拿到 diff 头部，模型才能看出改了哪些文件");
		assert.ok(diff.endsWith("\n\n... (diff truncated)"), "截断必须带标记（与 maxBytes 截断同一约定）");
		assert.equal(diff.length, 200 + "\n\n... (diff truncated)".length, "返回体积仍受 maxBytes 约束：溢出降级不能把 10MB 直接透给 IPC");
	});

	test("small staged diff keeps returning the full patch", async () => {
		// 独立仓库：不依赖上一条用例遗留的暂存区状态
		const repo = mkdtempSync(join(tmpdir(), "pideck-git-staged-small-"));
		const run = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		run("init");
		run("config", "core.autocrlf", "false");
		run("config", "user.name", "PiDeck Test");
		run("config", "user.email", "test@example.com");
		writeFileSync(join(repo, "small.txt"), "hello\n");
		run("add", "small.txt");

		const svc = new GitService();
		const diff = await svc.getStagedDiff(repo, 100 * 1024);

		assert.match(diff, /\+hello/, "未溢出时行为不变");
		assert.doesNotMatch(diff, /diff truncated/);
	});
});
