import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 项目显示名解析（displayProjectDirectoryName）：
 * 重命名后（name 与目录名不同）优先展示自定义别名，否则回退目录名。
 * 侧栏项目行、会话标题面包屑、搜索共用此函数，保证改名处处一致。
 */
const { displayProjectDirectoryName } = loadTsCommonJs(
  "src/renderer/src/rendererUtils.ts",
);

function project(overrides = {}) {
  const path = overrides.path ?? "C:\\work\\alpha";
  const dirName = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "alpha";
  return {
    id: "p1",
    // 与 ProjectStore.add 一致：默认 name 就是目录名；重命名时才与目录名不同
    name: dirName,
    path,
    lastOpenedAt: 1,
    environment: "windows",
    ...overrides,
  };
}

test("未重命名：展示目录名（与旧版一致）", () => {
  assert.equal(displayProjectDirectoryName(project()), "alpha");
  // WSL 路径同样取末段
  assert.equal(
    displayProjectDirectoryName(project({ path: "/home/user/repo" })),
    "repo",
  );
});

test("重命名后：展示自定义别名", () => {
  assert.equal(
    displayProjectDirectoryName(project({ name: "内部平台" })),
    "内部平台",
  );
  // WSL 路径 + 别名
  assert.equal(
    displayProjectDirectoryName(project({ path: "/home/user/repo", name: "平台" })),
    "平台",
  );
});

test("聊天项目固定展示 Chat", () => {
  assert.equal(
    displayProjectDirectoryName(project({ kind: "chat", name: "Chat" })),
    "Chat",
  );
});

test("目录名与别名相同：展示目录名（幂等，不会因重命名为原名而闪烁）", () => {
  assert.equal(displayProjectDirectoryName(project({ name: "alpha" })), "alpha");
});
