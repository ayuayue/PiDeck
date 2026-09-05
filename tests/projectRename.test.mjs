import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 项目重命名（显示名别名，不动磁盘目录）。
 *
 * 背景：建立项目后没有重命名入口（2026-02 反馈）。新增「重命名项目」：
 * - 只改 Project.name 展示 label，不 rename 磁盘目录（改目录会连带破坏会话路径/
 *   git/运行中 Agent/WSL 路径）；
 * - 聊天项目与 worktree 子项目禁止重命名（worktree 子项目 name 承载 git 分支名，
 *   删除 worktree 时按 name 定位分支，改名会错乱）；
 * - 空名 / 超长名拒绝。
 */

const {
  sanitizeProjectDisplayName,
  PROJECT_DISPLAY_NAME_MAX_LENGTH,
} = loadTsCommonJs("src/main/projects/projectPathPolicy.ts");

test("sanitizeProjectDisplayName 折叠空白并 trim", () => {
  assert.equal(sanitizeProjectDisplayName("  我的 项目  "), "我的 项目");
  assert.equal(sanitizeProjectDisplayName("  a\n\t b  "), "a b");
  assert.equal(sanitizeProjectDisplayName("稳定版"), "稳定版");
});

test("sanitizeProjectDisplayName 空名拒绝", () => {
  assert.throws(() => sanitizeProjectDisplayName("   "), /PROJECT_NAME_REQUIRED/);
  assert.throws(() => sanitizeProjectDisplayName(""), /PROJECT_NAME_REQUIRED/);
  assert.throws(() => sanitizeProjectDisplayName("\t\n"), /PROJECT_NAME_REQUIRED/);
});

test("sanitizeProjectDisplayName 超长拒绝", () => {
  assert.throws(
    () => sanitizeProjectDisplayName("x".repeat(PROJECT_DISPLAY_NAME_MAX_LENGTH + 1)),
    /PROJECT_NAME_TOO_LONG:/,
  );
  assert.equal(
    sanitizeProjectDisplayName("x".repeat(PROJECT_DISPLAY_NAME_MAX_LENGTH)).length,
    PROJECT_DISPLAY_NAME_MAX_LENGTH,
  );
});

// ── ProjectStore.rename：聊天/worktree 守卫 + 持久化 ──
// ProjectStore 构造/保存依赖 electron app.getPath，用 stub 指向临时目录，不触碰真实 userData。

async function makeProjectStore() {
  const dir = mkdtempSync(join(tmpdir(), "pideck-rename-"));
  const electronStub = {
    app: {
      getPath: () => dir,
    },
    dialog: {},
  };
  const { ProjectStore } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
    stubs: { electron: electronStub },
  });
  const store = new ProjectStore();
  // load() 确保内置聊天项目存在（ensureChatProject），聊天守卫测试依赖它
  await store.load();
  return { store, dir };
}

test("rename 更新普通项目显示名并持久化", async () => {
  const { store, dir } = await makeProjectStore();
  try {
    const added = await store.add("C:\\repo\\alpha");
    const renamed = await store.rename(added.id, "  内部平台  ");
    assert.equal(renamed?.name, "内部平台");
    assert.equal(store.get(added.id)?.name, "内部平台");
    // 写入 projects.json，重启可恢复
    const saved = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"));
    const savedProject = saved.find((p) => p.id === added.id);
    assert.equal(savedProject.name, "内部平台");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename 聊天项目拒绝", async () => {
  const { store, dir } = await makeProjectStore();
  try {
    await assert.rejects(
      () => store.rename("builtin-chat", "随便改"),
      /PROJECT_RENAME_NOT_ALLOWED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename worktree 子项目拒绝（name 承载 git 分支名）", async () => {
  const { store, dir } = await makeProjectStore();
  try {
    const parent = await store.add("C:\\repo\\parent");
    const child = await store.add("C:\\repo\\parent\\wt-feature", parent.id, "windows");
    assert.equal(child.worktreeParentId, parent.id);
    await assert.rejects(
      () => store.rename(child.id, "新名字"),
      /PROJECT_RENAME_NOT_ALLOWED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename 未知 id 返回 null 且不抛错", async () => {
  const { store, dir } = await makeProjectStore();
  try {
    assert.equal(await store.rename("no-such-id", "名字"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
