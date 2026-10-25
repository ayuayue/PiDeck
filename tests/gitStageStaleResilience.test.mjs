// GitService stage/unstage 竞态容错回归测试。
// 背景 bug：渲染层持有的 status 快照落后于主进程最新状态时（外部工具 stage/删除/
// 改名后未刷新），stageFiles/unstageFiles 抛 "Git resource is stale or outside the
// project" 导致 Git 面板弹错误提示。修复后：项目目录内的未匹配路径视为 stale 静默
// 跳过（无操作），项目目录外的路径仍按安全违规拒绝。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-stage-build-"));
const repositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-stage-"));
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
	// 只编译服务与共享类型，免完整 Electron 构建即可跑真实实现。
	// --rewriteRelativeImportExtensions：GitService 的依赖链（gitRun/gitWsl）本地 import
	// 带 .ts 扩展名（Node type stripping 直跑测试的约定），CLI tsc 需在 emit 时重写为 .js。
	execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "src/main/git/GitService.ts", "src/shared/types.ts", "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--rewriteRelativeImportExtensions", "--outDir", buildDir], {
		cwd: resolve("."),
		stdio: "pipe",
	});
	// GitService 依赖 ../fs/trash（懒加载 electron.shell.trashItem），纯 Node 测试
	// 环境没有 electron，注入 stub 使 require 链可解析（本测试不触达 discard 路径）。
	const stubElectronDir = join(buildDir, "node_modules", "electron");
	mkdirSync(stubElectronDir, { recursive: true });
	writeFileSync(join(stubElectronDir, "package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
	writeFileSync(join(stubElectronDir, "index.js"), `exports.shell = { trashItem: async (p) => { await require("node:fs/promises").rm(p, { recursive: true, force: true }); } };`);
	({ GitService } = require(join(buildDir, "main/git/GitService.js")));

	git("init");
	// Windows 开发机常配 core.autocrlf=true，会把 checkout 内容转成 CRLF；测试仓库强制关闭。
	git("config", "core.autocrlf", "false");
	git("config", "user.name", "PiDeck Test");
	git("config", "user.email", "test@example.com");
});

after(() => {
	rmSync(buildDir, { recursive: true, force: true });
	rmSync(repositoryDir, { recursive: true, force: true });
});

describe("GitService stage/unstage stale resilience", () => {
	test("stale stage path is silently skipped instead of throwing", async () => {
		const service = new GitService();
		write("tracked.txt", "v1");
		git("add", "tracked.txt");
		git("commit", "-m", "init");

		// 工作区修改 → 渲染层快照认为可 stage
		write("tracked.txt", "v2");
		// 外部工具抢先 stage（模拟 status 竞态）
		git("add", "tracked.txt");

		// 用户再点 stage：不应抛错（stale 静默），且不产生副作用
		await service.stageFiles(repositoryDir, [join(repositoryDir, "tracked.txt")]);
		const statusAfter = git("status", "--porcelain");
		assert.equal(statusAfter, "M  tracked.txt");
	});

	test("stale unstage path is silently skipped instead of throwing", async () => {
		const service = new GitService();
		write("unstaged-tracked.txt", "v1");
		git("add", "unstaged-tracked.txt");
		git("commit", "-m", "init");

		write("unstaged-tracked.txt", "v2");
		git("add", "unstaged-tracked.txt");
		// 外部工具抢先 unstage（竞态：渲染层快照仍认为它在 index）
		git("restore", "--staged", "unstaged-tracked.txt");

		await service.unstageFiles(repositoryDir, [join(repositoryDir, "unstaged-tracked.txt")]);
		// 文件已回到工作区修改状态，无副作用。
		// 注意：git() helper 会 trim 输出，porcelain 的 index 列空格被吞，
		// " M file"（index 空 + worktree M）trim 后即为 "M file"。
		assert.equal(git("status", "--porcelain"), "M unstaged-tracked.txt");
	});

	test("partial stale: stages only the still-valid paths", async () => {
		const service = new GitService();
		write("stale-a.txt", "a1");
		write("stale-b.txt", "b1");
		git("add", "stale-a.txt", "stale-b.txt");
		git("commit", "-m", "init");

		write("stale-a.txt", "a2");
		write("stale-b.txt", "b2");
		git("add", "stale-a.txt"); // a 已被外部 stage，b 仍在 workingTree
		await service.stageFiles(repositoryDir, [join(repositoryDir, "stale-a.txt"), join(repositoryDir, "stale-b.txt")]);
		// 尽力语义：两个文件都应处于 staged 状态
		const status = git("status", "--porcelain");
		assert.match(status, /M  stale-a\.txt/);
		assert.match(status, /M  stale-b\.txt/);
	});

	test("path outside the project is still rejected (security boundary)", async () => {
		const service = new GitService();
		const outsideDir = mkdtempSync(join(tmpdir(), "pideck-git-outside-"));
		try {
			const outsidePath = join(outsideDir, "evil.txt");
			writeFileSync(outsidePath, "x");
			await assert.rejects(service.stageFiles(repositoryDir, [outsidePath]), (error) => {
				assert.match(error.message, /outside the project/);
				// 安全违规必须保留明确报错，不得被 stale 容错吞掉
				assert.doesNotMatch(error.message, /stale/);
				return true;
			});
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});
});
