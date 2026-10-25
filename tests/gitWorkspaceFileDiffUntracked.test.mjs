import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";

/**
 * 回归测试：GitPanel 的 Changes 组把 untracked 文件与 workingTree 文件合并显示，
 * 但点击 diff 时写死传 group="workingTree"（见 GitResourceTree onOpen），
 * 导致所有未跟踪文件点 diff 都返回 null → toast「无法读取该工作区文件的差异内容」。
 *
 * 修复：GitService 对 workingTree 组请求做跨组容错（找不到时回查 untracked 组），
 * 使 UI 组错配不再产生「文件打不开」。
 */

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-wsdiff-build-"));
const repositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-wsdiff-"));
let GitService;

function git(...args) {
	return execFileSync("git", args, {
		cwd: repositoryDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function write(relativePath, content) {
	const abs = join(repositoryDir, relativePath);
	mkdirSync(resolve(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

before(() => {
	// --rewriteRelativeImportExtensions：GitService 的依赖链（gitRun/gitWsl）本地 import
	// 带 .ts 扩展名（Node type stripping 直跑测试的约定），CLI tsc 需在 emit 时重写为 .js。
	execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "src/main/git/GitService.ts", "src/shared/types.ts", "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--rewriteRelativeImportExtensions", "--outDir", buildDir], {
		cwd: resolve("."),
		stdio: "pipe",
	});
	// GitService 依赖 ../fs/trash（懒加载 electron.shell.trashItem）：stub 掉
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

after(() => {
	// 保留 buildDir/repositoryDir 于系统临时目录，由 OS 清理；避免 after 与并发测试竞争
});

describe("getWorkspaceFileDiff untracked-file group fallback", () => {
	test("untracked file requested via workingTree group (GitPanel mismatch) still opens", async () => {
		const file = join(repositoryDir, "src", "newfile.ts");
		write("src/newfile.ts", "export const fresh = 1;\n");
		const svc = new GitService();
		// GitPanel 的 Changes 组对 untracked 文件实际传 workingTree：
		// 修复前返回 null（打不开），修复后应正常返回（original 为空 + 工作区内容）
		const diff = await svc.getWorkspaceFileDiff(repositoryDir, "workingTree", file, 1024 * 1024);
		assert.ok(diff, "untracked 文件经 workingTree 组请求必须能打开（跨组容错）");
		assert.equal(diff.originalContent, "", "未跟踪文件左侧为空");
		assert.match(diff.modifiedContent, /fresh/);
	});

	test("untracked file requested via its own group still works", async () => {
		const file = join(repositoryDir, "src", "own.ts");
		write("src/own.ts", "export const own = 2;\n");
		const svc = new GitService();
		const diff = await svc.getWorkspaceFileDiff(repositoryDir, "untracked", file, 1024 * 1024);
		assert.ok(diff, "untracked 组正常路径不受影响");
		assert.match(diff.modifiedContent, /own/);
	});

	test("tracked modified file requested via workingTree group keeps working", async () => {
		write("tracked.txt", "v1\n");
		git("add", "tracked.txt");
		git("commit", "-m", "add tracked");
		write("tracked.txt", "v2\n");
		const svc = new GitService();
		const diff = await svc.getWorkspaceFileDiff(repositoryDir, "workingTree", join(repositoryDir, "tracked.txt"), 1024 * 1024);
		assert.ok(diff, "tracked 修改文件正常工作");
		assert.equal(diff.originalContent, "v1\n");
		assert.equal(diff.modifiedContent, "v2\n");
	});
});
