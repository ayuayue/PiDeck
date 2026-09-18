import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-truncate-build-"));
const repositoryDir = mkdtempSync(join(tmpdir(), "pideck-git-truncate-"));
let GitService;

function git(...args) {
  return execFileSync("git", args, {
    cwd: repositoryDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

before(() => {
  // 与 tests/gitCommitFileDiff.integration.test.mjs 同款编译：tsc 编译 GitService
  // 及 shared 类型到临时目录，stub electron（../fs/trash 懒加载 electron.shell.trashItem）
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "src/main/git/GitService.ts",
      "src/shared/types.ts",
      "--module",
      "commonjs",
      "--target",
      "es2022",
      "--moduleResolution",
      "node",
      "--esModuleInterop",
      "--skipLibCheck",
      "--outDir",
      buildDir,
    ],
    { cwd: resolve("."), stdio: "pipe" },
  );
  const stubElectronDir = join(buildDir, "node_modules", "electron");
  mkdirSync(stubElectronDir, { recursive: true });
  writeFileSync(join(stubElectronDir, "package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
  writeFileSync(
    join(stubElectronDir, "index.js"),
    "module.exports = { shell: { trashItem: async () => {} } };",
  );
  ({ GitService } = require(join(buildDir, "main/git/GitService.js")));

  // git for Windows 的默认分支名因版本而异，显式 --initial-branch=main。
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repositoryDir, "big.txt"), "x".repeat(200_000));
  git("add", "big.txt");
  git("commit", "-m", "base");
  writeFileSync(join(repositoryDir, "big.txt"), "y".repeat(200_000));
  git("add", "big.txt");
  git("commit", "-m", "grow");
});

after(() => {
  // tmpdir 由 OS 清理；无需显式 rm（与既有 integration 测试一致）
});

describe("diffFileBetweenRefs 截断（M4）", () => {
  test("超限 diff 被截断并带内联标记", async () => {
    const service = new GitService();
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const out = await service.diffFileBetweenRefs(
      repositoryDir, base, head, "big.txt", 64 * 1024,
    );
    assert.ok(out.endsWith("... (diff truncated)"), "截断结果必须以内联标记结尾");
    assert.ok(out.length < 70 * 1024, `截断后长度必须贴近上限，实际 ${out.length}`);
  });

  test("未超限 diff 原样返回，无标记", async () => {
    const service = new GitService();
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const out = await service.diffFileBetweenRefs(
      repositoryDir, base, head, "big.txt", 10 * 1024 * 1024,
    );
    assert.ok(out.length > 300_000, "完整 diff 应约为两倍文件体量");
    assert.ok(!out.includes("... (diff truncated)"));
  });

  test("IPC 契约：gitDiffFileBetween handler 传 maxEditorFileSizeMB 上限", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
    // 抓块沿用仓库既有契约测试惯例（见 skillsRenameIpc.test.mjs）：search 定位起点 +
    // indexOf("});") 截到块尾，避免脆弱的行尾正则（handler 均以 `\t\t},` 收尾）。
    const start = src.search(/ipcMain\.handle\(\s*ipcChannels\.gitDiffFileBetween/);
    const handler = start >= 0 ? src.slice(start, src.indexOf("});", start) + 3) : "";
    assert.ok(handler.length > 0, "找不到 gitDiffFileBetween handler");
    assert.match(handler, /maxEditorFileSizeMB/);
    assert.match(handler, /diffFileBetweenRefs\([\s\S]*maxBytes/);
  });
});
