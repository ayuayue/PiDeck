import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    setTimeout,
    clearTimeout,
  }, { filename: filePath });
  return module.exports;
}

function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
  const identity = compileModule("src/shared/sessionIdentity.ts");
  const fsRetry = compileModule("src/main/utils/fsRetry.ts", {
    "node:fs/promises": fsPromises,
  });
  return compileModule("src/main/sessions/SessionCatalog.ts", {
    "../../shared/sessionIdentity": identity,
    "../utils/fsRetry": fsRetry,
    "../logging/sharedLogger": { getAppLogger: () => null },
    "node:fs/promises": fsPromises,
  });
}

function summary(overrides = {}) {
  return {
    id: "C:/sessions/fork.jsonl",
    filePath: "C:/sessions/fork.jsonl",
    name: "Forked topic",
    preview: "hello",
    updatedAt: 100,
    messageCount: 1,
    source: "pi",
    ...overrides,
  };
}

/** 模拟 SessionScanner.inferSessionNameAndValidity 的头部探测：fork 文件 → forked:true。 */
function forkFetchTitle() {
  return async () => ({ name: "Forked topic", nameFromSessionInfo: true, forked: true });
}

test("mergeScanned marks a newly discovered fork file without folding it under its parent", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, forkFetchTitle());
    await catalog.load();
    // 轻量扫描（listPathSummary）不带 name：新文件因此进入头部探测（wanted）路径
    const [record] = await catalog.mergeScanned("project-1", [summary({ name: undefined })]);
    // fork 标记独立于 parentSessionPath：顶层展示的 fork 身份元数据（(fork) 标题后缀
    // 已物理写入会话名，见 sessionForkTitle.ts）
    assert.equal(record.forked, true);
    assert.equal(record.parentSessionPath, undefined);
    // 跨重启持久化：重载后标记仍在（不依赖每次扫描重新探测）
    const reloaded = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, forkFetchTitle());
    await reloaded.load();
    const [restored] = await reloaded.mergeScanned("project-1", [summary()]);
    assert.equal(restored.forked, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folded subagent sessions never get the fork marker even when the header probe matches", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-subagent-"));
  try {
    // 子代理形态：summary 带 parentSessionPath（列表折叠到父行），头部探测即便误报 forked
    // 也必须在 catalog 层被压制——fork 与子代理是两种形态。
    const catalog = new SessionCatalog(
      join(dir, "sessions.json"),
      {},
      undefined,
      async () => ({ name: "agent#12345678", nameFromSessionInfo: true, forked: true }),
    );
    await catalog.load();
    // 轻量扫描同样不带 name：头部探测命中（forked:true）但 summary 已折叠为子代理
    const [record] = await catalog.mergeScanned("project-1", [summary({
      name: undefined,
      parentSessionPath: "C:/sessions/parent.jsonl",
    })]);
    assert.equal(record.forked, undefined);
    assert.equal(record.parentSessionPath, "C:/sessions/parent.jsonl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureRuntimeTarget registers a fork with the marker and keeps it across reload", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-target-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const target = await catalog.ensureRuntimeTarget({
      projectId: "project-1",
      // fork 身份通过物理标题后缀表达；forked 只是 catalog 的辅助元数据。
      title: "Forked topic (fork)",
      source: "pi",
      environment: "native",
      filePath: "C:/sessions/fork.jsonl",
      forked: true,
    });
    assert.equal(target.forked, true);
    assert.equal(target.title, "Forked topic (fork)");
    const reloaded = new SessionCatalog(join(dir, "sessions.json"));
    await reloaded.load();
    assert.equal(reloaded.get(target.id)?.forked, true);
    assert.equal(reloaded.get(target.id)?.title, "Forked topic (fork)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update only sets the fork marker when the patch explicitly requests it", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-update-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const target = await catalog.ensureRuntimeTarget({
      projectId: "project-1",
      title: "Plain session",
      source: "pi",
      environment: "native",
      filePath: "C:/sessions/plain.jsonl",
    });
    await catalog.update(target.id, { forked: true });
    assert.equal(catalog.getRecord(target.id)?.forked, true);
    // false/null 不得反向清除已持久化的标记（轻量扫描/普通探测后置回填的默认行为）
    await catalog.update(target.id, { forked: false });
    assert.equal(catalog.getRecord(target.id)?.forked, true);
    await catalog.update(target.id, { forked: null });
    assert.equal(catalog.getRecord(target.id)?.forked, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
