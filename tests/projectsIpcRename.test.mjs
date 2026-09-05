import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * projects:rename IPC 边界：入参校验（id/name 必须是字符串）在 handler 第一行，
 * 成功后广播 projects:changed 并返回全量可见项目（LAN Web / 其他窗口同步 name）。
 * 核心守卫（聊天/worktree 拒绝）在 ProjectStore.rename，见 projectRename.test.mjs。
 */
const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");

test("projects:rename 注册并校验 id/name 为字符串", () => {
  assert.match(source, /ipcChannels\.projectsRename/);
  assert.match(source, /typeof id !== "string" \|\| !id/);
  assert.match(source, /typeof name !== "string"/);
  assert.match(source, /projectStore\.rename\(id, name\)/);
});

test("projects:rename 成功后广播 projects:changed 并返回可见列表", () => {
  assert.match(source, /getMainWindow\(\)\?\.webContents\.send\(ipcChannels\.projectsChanged, visible\)/);
  assert.match(source, /return visible;/);
});
