import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";

/**
 * 回归测试：未暂存（workingTree 组）diff 的左侧来自 git 对象（git show :path，
 * 按仓库存储原样输出，通常 LF），右侧直接读工作区文件（Windows 上常为 CRLF——
 * autocrlf 检出转换或编辑器写入）。git 自身 diff 比较前会对工作区内容做 clean
 * 转换，行尾不体现为差异；PiDeck 拿两侧原始字符串直接比对，未归一化时 CRLF/LF
 * 差异令每一行都被判为不同 → 「只改了一句的文件在 diff 视图显示成全量红绿」。
 * staged（index 组）两侧都读 git 对象、天然同空间而幸免，用户感知为
 * 「不点暂存时 diff 完全无效」。
 *
 * 修复：getWorkspaceFileDiff 返回前对两侧做展示层行尾归一化（\r\n → \n），
 * 与 VS Code（Monaco TextModel 内部归一化）行为对齐；两个混合方向都要覆盖：
 * blob LF + 工作区 CRLF，以及反向 blob CRLF + 工作区 LF。
 */

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-eol-build-"));
const repositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-eol-"));
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
	// autocrlf=true 是 Windows 常见配置：检出时 LF→CRLF，构成「blob LF + 工作区 CRLF」混合
	git("config", "core.autocrlf", "true");
	git("config", "user.name", "PiDeck Test");
	git("config", "user.email", "test@example.com");
});

after(() => {
	// 保留 buildDir/repositoryDir 于系统临时目录，由 OS 清理；避免 after 与并发测试竞争
});

describe("getWorkspaceFileDiff line-ending normalization", () => {
	test("unstaged CRLF edit over LF blob yields one-line diff after normalization", async () => {
		// 仓库以 LF 提交（Linux/CI 产出的常态）
		write("mixed.txt", "line1\nline2\nline3\n");
		git("add", "mixed.txt");
		git("commit", "-m", "lf commit");
		// Windows 编辑器改一行后整文件保存为 CRLF
		write("mixed.txt", "line1\r\nline2 changed\r\nline3\r\n");
		const svc = new GitService();
		const diff = await svc.getWorkspaceFileDiff(repositoryDir, "workingTree", join(repositoryDir, "mixed.txt"), 1024 * 1024);
		assert.ok(diff, "未暂存修改必须能取到 diff");
		// 修复前：左侧 "line1\nline2\nline3\n"、右侧 "line1\r\nline2 changed\r\nline3\r\n"，
		// 行级 diff 引擎把每一行都判为不同（全量红绿）。修复后两侧都归一化为 LF，
		// 唯一差异就是真正改掉的那一行。
		assert.equal(diff.originalContent, "line1\nline2\nline3\n");
		assert.equal(diff.modifiedContent, "line1\nline2 changed\nline3\n");
	});

	test("reverse mixing (CRLF blob + LF worktree) is normalized too", async () => {
		// 关掉转换，把 CRLF 原样提交进仓库（Windows 上无 autocrlf 的仓库常态）
		git("config", "core.autocrlf", "false");
		write("reverse.txt", "alpha\r\nbeta\r\n");
		git("add", "reverse.txt");
		git("commit", "-m", "crlf commit");
		// 编辑器/格式化工具把工作区文件改存为 LF 并修改一行
		write("reverse.txt", "alpha\nbeta edited\n");
		const svc = new GitService();
		const diff = await svc.getWorkspaceFileDiff(repositoryDir, "workingTree", join(repositoryDir, "reverse.txt"), 1024 * 1024);
		assert.ok(diff, "反向混合场景必须能取到 diff");
		assert.equal(diff.originalContent, "alpha\nbeta\n");
		assert.equal(diff.modifiedContent, "alpha\nbeta edited\n");
	});
});
