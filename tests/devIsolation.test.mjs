import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DEFAULT_DEV_USER_DATA_NAME, DEFAULT_DEV_VITE_PORT, sanitizeDevBranchSegment, isSharedDevBranch, resolveDevUserDataDirName, resolveDevVitePort, readDevGitBranch } = loadTsCommonJs("src/main/devIsolation.ts");

test("sanitizeDevBranchSegment 把路径分隔符和非法字符收成目录安全段", () => {
	assert.equal(sanitizeDevBranchSegment("feat/dsh-agent-mvp"), "feat-dsh-agent-mvp");
	assert.equal(sanitizeDevBranchSegment("fix/issue-113"), "fix-issue-113");
	assert.equal(sanitizeDevBranchSegment("  Feat/DSH Agent!  "), "feat-dsh-agent");
	assert.equal(sanitizeDevBranchSegment("///"), "detached");
});

test("main/dev/master 继续用历史 pi-desktop-dev 和 5181", () => {
	for (const branch of ["main", "master", "dev", "develop", "Dev", undefined, ""]) {
		assert.equal(isSharedDevBranch(branch), true, String(branch));
		assert.equal(resolveDevUserDataDirName(branch), DEFAULT_DEV_USER_DATA_NAME);
		assert.equal(resolveDevVitePort(branch), DEFAULT_DEV_VITE_PORT);
	}
});

test("功能分支拆开 userData 目录且不用 5181", () => {
	assert.equal(resolveDevUserDataDirName("feat/dsh-agent-mvp"), "pi-desktop-dev-feat-dsh-agent-mvp");
	const port = resolveDevVitePort("feat/dsh-agent-mvp");
	assert.notEqual(port, DEFAULT_DEV_VITE_PORT);
	assert.ok(port >= 5182 && port <= 5281);
	assert.notEqual(resolveDevUserDataDirName("feat/dsh-agent-mvp"), resolveDevUserDataDirName("fix/docs-custom-domain-base"));
});

test("electron-vite renderer 用同一套端口解析，避免和主进程 userData 各算各的", () => {
	const src = readFileSync("electron.vite.config.ts", "utf8");
	assert.match(src, /from "\.\/src\/main\/devIsolation"/);
	assert.match(src, /port:\s*resolveDevVitePort\(readDevGitBranch\(\)\)/);
});

test("主进程未打包时按分支解析 userData；打包态（含 dev 通道安装包）走共用正式目录", () => {
	const src = readFileSync("src/main/index.ts", "utf8");
	assert.match(src, /from "\.\/devIsolation"/);
	assert.match(src, /const isolateDevByGitBranch = !app\.isPackaged/);
	assert.match(src, /resolveDevUserDataDirName\(devGitBranch\)/);
	// 契约：分支目录名只影响未打包调试态；打包态（stable 与 dev 通道安装包）经
	// resolveAppUserDataDir 共用正式目录（见 portableUserData.test.mjs）。
	assert.match(src, /unpackagedDevDir:\s*join\(app\.getPath\("appData"\), devUserDataDirName\)/);
});

test("readDevGitBranch 优先读环境变量，否则走 git", () => {
	assert.equal(readDevGitBranch({ env: { PIDECK_DEV_BRANCH: "feat/from-env" }, execGit: () => "should-not-run" }), "feat/from-env");
	assert.equal(readDevGitBranch({ env: {}, cwd: "/tmp", execGit: (cwd) => (cwd === "/tmp" ? "feat/from-git" : "") }), "feat/from-git");
	assert.equal(readDevGitBranch({ env: {}, execGit: () => "HEAD" }), undefined);
});
