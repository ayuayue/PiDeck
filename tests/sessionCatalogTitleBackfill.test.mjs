import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * SessionCatalog 占位标题回填测试（fetchTitle 注入链路）。
 *
 * 背景：侧栏轻量扫描（listPathSummary）不带 name，未打开过的 pi 会话标题落成
 * Untitled。mergeScanned 通过注入的 SessionTitleFetcher 对占位标题做有界读头部补名：
 * 只读「标题仍是占位符」的文件，已有真实标题的条目不触发读盘。
 */

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

/** 轻量扫描形态的 summary：name 缺失（listPathSummary 只 stat，不读正文）。 */
function lightSummary(overrides = {}) {
  return {
    id: "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl",
    filePath: "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl",
    name: undefined,
    preview: "",
    messageCount: 0,
    updatedAt: 1000,
    source: "pi",
    environment: "native",
    ...overrides,
  };
}

test("placeholder titles get backfilled from the injected fetcher on first scan", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-backfill-"));
  try {
    // 只对本测试的文件返回标题；其他文件返回空对象模拟「读不到正文」。
    const fetcher = async (filePath) =>
      filePath === "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl"
        ? { name: "修复侧栏标题：未打开的会话显示首条消息" }
        : {};
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();
    const [record] = await catalog.mergeScanned("project-1", [lightSummary()]);
    // 新条目不再落成 Untitled：头部补名提供真实标题。
    assert.equal(record.title, "修复侧栏标题：未打开的会话显示首条消息");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing Untitled entry is upgraded once the fetcher can infer a title", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-upgrade-"));
  try {
    // 第一次合并不注入 fetcher：条目创建成占位标题（旧行为）。
    const plain = new SessionCatalog(join(dir, "sessions.json"));
    await plain.load();
    const [first] = await plain.mergeScanned("project-1", [lightSummary()]);
    assert.equal(first.title, "Untitled");

    // 第二次合并注入 fetcher：占位标题应被升级为真实标题。
    const fetcher = async (filePath) =>
      filePath === "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl"
        ? { name: "升级后的标题" } : {};
    const upgraded = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await upgraded.load();
    const [record] = await upgraded.mergeScanned("project-1", [lightSummary()]);
    assert.equal(record.title, "升级后的标题");
    // 升级结果应落盘：重启后仍是真实标题。
    const onDisk = JSON.parse(await nodeRequire("node:fs/promises").readFile(join(dir, "sessions.json"), "utf8"));
    assert.equal(onDisk.sessions[0].title, "升级后的标题");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unchanged files with real titles do not trigger pointless title reads", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-no-call-"));
  try {
    let fetcherCalls = 0;
    const fetcher = async () => { fetcherCalls += 1; return { name: "不该被调用" }; };
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();
    // summary 自带真实名称（readSummary 全量路径的场景）：不触发补名。
    await catalog.mergeScanned("project-1", [lightSummary({ name: "已有真实标题" })]);
    assert.equal(fetcherCalls, 0);
    // 文件版本未变化时保留 catalog 标题，不为周期扫描重复读盘。
    await catalog.mergeScanned("project-1", [lightSummary()]);
    assert.equal(fetcherCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an externally appended pi session_info refreshes an existing real catalog title", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-external-rename-"));
  try {
    let currentTitle = "pi-tui 重命名后的标题";
    let fetcherCalls = 0;
    const fetcher = async () => {
      fetcherCalls += 1;
      return { name: currentTitle, valid: true };
    };
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();

    const [initial] = await catalog.mergeScanned("project-1", [
      lightSummary({ name: "PiDeck 旧标题", updatedAt: 1000 }),
    ]);
    assert.equal(initial.title, "PiDeck 旧标题");
    assert.equal(fetcherCalls, 0);

    // pi-tui /name 会在 JSONL 末尾追加 session_info，同时改变 mtime/size；轻量扫描
    // 虽不带 name，也必须回读标题并覆盖 catalog 中已有的真实标题。
    const [renamed] = await catalog.mergeScanned("project-1", [
      lightSummary({ updatedAt: 2000 }),
    ]);
    assert.equal(renamed.title, "pi-tui 重命名后的标题");
    assert.equal(fetcherCalls, 1);

    currentTitle = "不应在未变化时重复读取";
    const [unchanged] = await catalog.mergeScanned("project-1", [
      lightSummary({ updatedAt: 2000 }),
    ]);
    assert.equal(unchanged.title, "pi-tui 重命名后的标题");
    assert.equal(fetcherCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without an injected fetcher the placeholder behavior stays intact", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-default-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const [record] = await catalog.mergeScanned("project-1", [lightSummary()]);
    // 未注入 fetcher（例如单元测试/无扫描器的安装点）：保持 Untitled 兜底，不回退。
    assert.equal(record.title, "Untitled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 回归：第二轮对话把 session_info 挤出头/尾窗口盲区后，扫描器只能回退到首条消息文本；
// 这种弱信号不得覆盖 catalog 已有真实标题（用户现场：自动生成标题变成消息原文）。
test("a non-authoritative first-message fallback must not overwrite an existing real catalog title", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-weak-fallback-"));
  try {
    let fetcherCalls = 0;
    // 模拟窗口盲区：fetcher 命中首条消息回退（nameFromSessionInfo=false / 旧版 fetcher 不标记）。
    const fetcher = async () => {
      fetcherCalls += 1;
      return { name: "{ \"providers\": { \"ai88\": { \"enab…", valid: true, nameFromSessionInfo: false };
    };
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();

    // 第一次合并：新条目带真实标题（自动生成，写盘）。
    const [initial] = await catalog.mergeScanned("project-1", [
      lightSummary({ name: "Add usage probe config", updatedAt: 1000 }),
    ]);
    assert.equal(initial.title, "Add usage probe config");
    assert.equal(fetcherCalls, 0);

    // 第二轮：文件版本变化触发补名回读，但回读结果是弱回退（没命中 session_info）。
    const [afterSecondRound] = await catalog.mergeScanned("project-1", [
      lightSummary({ updatedAt: 2000 }),
    ]);
    assert.equal(afterSecondRound.title, "Add usage probe config", "weak fallback must not clobber the real title");
    assert.equal(fetcherCalls, 1);

    // 权威来源（命中 session_info，pi-tui 外部改名）仍应覆盖。
    let authoritative = true;
    const authoritativeFetcher = async () => ({ name: "pi-tui 重命名后的标题", valid: true, nameFromSessionInfo: true });
    void authoritative;
    const catalog2 = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, authoritativeFetcher);
    await catalog2.load();
    const [renamed] = await catalog2.mergeScanned("project-1", [
      lightSummary({ updatedAt: 3000 }),
    ]);
    assert.equal(renamed.title, "pi-tui 重命名后的标题");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
// 不是有效 Pi 会话。fetcher 校验会话头时返回 valid:false，mergeScanned 必须拒绝索引该文件。
// 存量 subagent-artifacts 目录内的脏条目由路径清洗（已有「drops legacy subagent-artifacts
// entries」测试覆盖）；此处覆盖更一般的情况——产物落在目录过滤够不到的位置时，
// 会话头校验仍能把它挡在 catalog 之外。
test("rejects files whose header fails session validation", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-transcript-reject-"));
  try {
    const realPath = "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl";
    const transcriptPath = "C:/sessions/abc_worker_0_transcript.jsonl";
    // fetcher 对真实会话返回 name（valid 缺省），对 transcript 返回 valid:false。
    const fetcher = async (filePath) =>
      filePath === transcriptPath
        ? { valid: false }
        : filePath === realPath
          ? { name: "真实会话", valid: true }
          : {};
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();
    const records = await catalog.mergeScanned("project-1", [
      lightSummary({ id: realPath, filePath: realPath }),
      lightSummary({ id: transcriptPath, filePath: transcriptPath }),
    ]);
    assert.equal(
      records.some((record) => record.filePath === transcriptPath),
      false,
      "transcript without a valid session header must not be indexed",
    );
    assert.equal(
      records.some((record) => record.filePath === realPath && record.title === "真实会话"),
      true,
      "valid session must stay indexed with its inferred title",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
// 平铺子代理（@tintinweb/pi-subagents 形态）首次落库：轻量扫描 summary 不带
// parentSessionPath，但在标题回填的同一次读头中探测到父（<agent>#<8hex> 名 +
// parentSession header），新条目必须直接带上 parentSessionPath，而不是孤儿平铺。
test("new tintinweb flat subagent entries carry parentSessionPath from the title fetcher", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-tintinweb-new-"));
  try {
    const parentPath = "C:/sessions/2026-08-22T04-22-29-162Z_parent.jsonl";
    const childPath = "C:/sessions/2026-08-22T04-23-00-162Z_child.jsonl";
    // fetcher 模拟 SessionScanner.inferSessionNameAndValidity：tintinweb 会话返回父路径。
    const fetcher = async (filePath) =>
      filePath === childPath
        ? { name: "Explore#a1b2c3d4", valid: true, parentSessionPath: parentPath }
        : filePath === parentPath
          ? { name: "Parent", valid: true }
          : {};
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();
    const records = await catalog.mergeScanned("project-1", [
      lightSummary({ id: childPath, filePath: childPath }),
      lightSummary({ id: parentPath, filePath: parentPath }),
    ]);
    const child = records.find((record) => record.filePath === childPath);
    assert.ok(child, "tintinweb child must be indexed");
    assert.equal(child.parentSessionPath, parentPath, "child must link to its parent, not orphan at top level");
    // 父会话本身不应带父。
    const parent = records.find((record) => record.filePath === parentPath);
    assert.equal(parent.parentSessionPath, undefined);
    // 持久化：重启后父关系仍在。
    const reloaded = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await reloaded.load();
    const [survived] = await reloaded.mergeScanned("project-1", [
      lightSummary({ id: childPath, filePath: childPath }),
    ]);
    assert.equal(survived.parentSessionPath, parentPath, "parentSessionPath must survive reload");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 存量孤儿升级：旧版 catalog 已经索引了 tintinweb 子代理（标题是 <agent>#<8hex>，
// 但 parentSessionPath 为空）。collectScannedTitles 的嫌疑名回检要重新读头，
// 把父关系补上并落盘——否则重启后仍以孤儿平铺在历史列表。
test("legacy tintinweb orphans get parentSessionPath backfilled and persisted", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-tintinweb-orphan-"));
  try {
    const childPath = "C:/sessions/2026-08-22T04-23-00-162Z_child.jsonl";
    const parentPath = "C:/sessions/2026-08-22T04-22-29-162Z_parent.jsonl";
    // 无 fetcher 首次合并：孤儿条目落库（无父关系，旧版行为）。
    const plain = new SessionCatalog(join(dir, "sessions.json"));
    await plain.load();
    const [orphan] = await plain.mergeScanned("project-1", [lightSummary({ id: childPath, filePath: childPath })]);
    assert.equal(orphan.parentSessionPath, undefined, "legacy index has no parent link yet");

    // 升级后的 fetcher（会探测到父）：嫌疑名回检应重新读头并补父关系。
    const fetcher = async (filePath) =>
      filePath === childPath
        ? { name: "Explore#a1b2c3d4", valid: true, parentSessionPath: parentPath }
        : { name: "Parent" };
    const upgraded = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await upgraded.load();
    const [repaired] = await upgraded.mergeScanned("project-1", [lightSummary({ id: childPath, filePath: childPath })]);
    assert.equal(repaired.parentSessionPath, parentPath, "orphan parent link must be backfilled");
    // 落入磁盘：下次扫描无需再探测读盘。
    const onDisk = JSON.parse(await nodeRequire("node:fs/promises").readFile(join(dir, "sessions.json"), "utf8"));
    const persisted = onDisk.sessions?.find((entry) => entry.filePath === childPath);
    assert.equal(persisted?.parentSessionPath, parentPath, "backfilled parent link must persist to disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
