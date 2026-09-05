import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  loadProjectFileTree,
  shouldApplyFileTreeResult,
} = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

function file(name, path) {
  return { name, path, relativePath: name, type: "file" };
}

test("shouldApplyFileTreeResult rejects a stale project or generation", () => {
  assert.equal(shouldApplyFileTreeResult("a", "a", 2, 2), true);
  // 项目已切走：旧 listing 即使代次碰巧相同也不能写入。
  assert.equal(shouldApplyFileTreeResult("a", "b", 2, 2), false);
  // 同项目但已发起更新的请求：旧代次必须丢弃。
  assert.equal(shouldApplyFileTreeResult("a", "a", 1, 2), false);
});

test("loadProjectFileTree returns null when the request is superseded mid-flight", async () => {
  let current = "A";
  let resolveA;
  const pendingA = new Promise((resolve) => {
    resolveA = resolve;
  });

  const stale = loadProjectFileTree(
    async () => pendingA,
    [],
    () => current === "A",
  );

  // 模拟用户在 A 的 IPC 返回前切到 B。
  current = "B";
  resolveA([file("from-a.txt", "/a/from-a.txt")]);

  assert.equal(await stale, null);
});

test("project file tree refresh and expand drop stale listings", () => {
  const sync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");

  // #159：切项目后旧 files:list 仍可能很晚返回，必须按代次/当前项目丢弃。
  assert.match(sync, /loadProjectFileTree/);
  assert.match(sync, /fileTreeGenerationRef/);
  assert.match(sync, /beginFileTreeRequest/);
  assert.match(app, /setFiles\(\(current\) => \(current\.length === 0 \? current : \[\]\)\)/);
  assert.match(app, /beginFileTreeRequest\(\)/);
  assert.match(app, /isFileTreeRequestCurrent\(generation, projectId\)/);
});

test("missing project directories clear stale files and refresh project presence", () => {
  const sync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const i18n = [
    readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
    readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
  ].join("\n");

  assert.match(sync, /message\.includes\("PROJECT_DIRECTORY_MISSING"\)/);
  assert.match(sync, /setFiles\(\[\]\);/);
  assert.match(sync, /void refreshProjects\(\)\.catch\(\(\) => undefined\);/);
  assert.match(app, /projectDirectoryMissing[\s\S]*?refreshProjects\(\)\.catch/);
  assert.match(i18n, /"app\.projectDirectoryMissing"/);
});

test("file deletion failures are shown to the user instead of only logged", () => {
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const deleteBlock = app.match(/await api\.files\.delete\(node\.path, true\);[\s\S]*?\n\s*}\n\s*},/);
  assert.ok(deleteBlock, "file drawer delete handler should be discoverable");
  assert.match(deleteBlock[0], /showToast\(t\("app\.fileDeleteFailed"/);
  assert.match(deleteBlock[0], /5000, "error"/);
  assert.doesNotMatch(deleteBlock[0], /console\.error/);
});

test("project file tree effect does not retrigger on an unstable toast helper", () => {
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  // 文件树 effect 只应跟当前项目走。showToast 若是每次 render 新建的函数
  // 又写进 deps，会每帧 setFiles([]) 把 React 更新深度打满——点击会话后
  // 设置/关窗点不动，正是 applog 里 Maximum update depth 的根因。
  const effectStart = app.indexOf("先立刻清空旧树");
  assert.notEqual(effectStart, -1, "file-tree switch effect should still exist");
  const deps = app.slice(effectStart, effectStart + 2500).match(/\}, \[activeProjectId[^\]]*\]\)/);
  assert.ok(deps, "file-tree effect should keep an explicit dependency list");
  assert.doesNotMatch(deps[0], /showToast|refreshProjects/);
  assert.match(app, /const showToast = useCallback\(/);
});
