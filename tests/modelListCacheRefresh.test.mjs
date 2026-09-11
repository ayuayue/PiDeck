import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 模型目录缓存（models-store.json）刷新：
 * 1) isModelCatalogStale：mtime 过期判断（不存在/旧 → 需要刷新；新 → 跳过）
 * 2) refreshModelCatalogIfStale：fresh 跳过不碰 CLI；stale 分支走 pi update --models
 * 3) 源码装配断言：index.ts 冷启动挂点 + PiModelCapabilityCache 监视 models-store.json
 *
 * 背景：PiDeck 的 RPC 进程都带 --offline，pi 启动时不自动刷新模型目录
 * （非 offline 时 pi main() 会异步 modelRuntime.refresh 并写 models-store.json），
 * 目录只能靠 TUI 更新 → 长期滞后会让选择器显示「目录有但运行中 Agent 快照没有」
 * 的模型（2026-08 deepseek 官方 provider 新模型选择失败：Agent 01:53 启动 vs
 * 目录 09:39 更新）。修复：冷启动时用 pi update --models 主动刷新，mtime 节流。
 */

const {
  isModelCatalogStale,
  refreshModelCatalogIfStale,
  MODEL_CATALOG_REFRESH_ARGS,
  MODEL_CATALOG_STALE_MS,
} = loadTsCommonJs("src/main/pi/modelListCache.ts");

const HOUR = 60 * 60 * 1000;

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pideck-model-catalog-"));
  await fn(dir);
}

test("isModelCatalogStale: missing config dir or missing file means stale", async () => {
  await withTempDir(async (dir) => {
    // 目录不存在（WSL 路径未挂载等）：按需要刷新处理，刷新无害。
    assert.equal(await isModelCatalogStale(join(dir, "not-a-dir")), true);
    // 文件不存在（从未用 TUI/pi update 刷过目录）：需要刷新。
    assert.equal(await isModelCatalogStale(dir), true);
  });
});

test("isModelCatalogStale: fresh mtime skips refresh", async () => {
  await withTempDir(async (dir) => {
    const store = join(dir, "models-store.json");
    await writeFile(store, "{}");
    const now = Date.now();
    await utimes(store, new Date(now), new Date(now));
    assert.equal(await isModelCatalogStale(dir, 24 * HOUR, () => now), false);
  });
});

test("isModelCatalogStale: old mtime (over maxAgeMs) needs refresh", async () => {
  await withTempDir(async (dir) => {
    const store = join(dir, "models-store.json");
    await writeFile(store, "{}");
    const now = Date.now();
    await utimes(store, new Date(now - 25 * HOUR), new Date(now - 25 * HOUR));
    assert.equal(await isModelCatalogStale(dir, 24 * HOUR, () => now), true);
  });
});

test("isModelCatalogStale: default threshold is 4h (aligned with pi built-in throttle)", () => {
  assert.equal(MODEL_CATALOG_STALE_MS, 4 * 60 * 60 * 1000);
});

test("isModelCatalogStale: default threshold behavior on 4h boundary", async () => {
  await withTempDir(async (dir) => {
    const store = join(dir, "models-store.json");
    await writeFile(store, "{}");
    const now = Date.now();
    // 3h 前更新过：默认阈值（4h）内 → 不需要刷（TUI/上次冷启动刷过，PiDeck 不重复出手）。
    await utimes(store, new Date(now - 3 * HOUR), new Date(now - 3 * HOUR));
    assert.equal(await isModelCatalogStale(dir, undefined, () => now), false);
    // 5h 前更新过：超过默认阈值 → 需要兜底刷一次。
    await utimes(store, new Date(now - 5 * HOUR), new Date(now - 5 * HOUR));
    assert.equal(await isModelCatalogStale(dir, undefined, () => now), true);
  });
});

test("refreshModelCatalogIfStale: fresh catalog is skipped without touching CLI", async () => {
  await withTempDir(async (dir) => {
    const store = join(dir, "models-store.json");
    await writeFile(store, "{}");
    const now = Date.now();
    await utimes(store, new Date(now), new Date(now));
    // PiLocator 任何方法被调用即抛错：fresh 分支必须完全不碰 CLI。
    const piLocator = {
      resolveCommand: () => {
        throw new Error("must not call resolveCommand when fresh");
      },
      createInvocation: () => {
        throw new Error("must not call createInvocation when fresh");
      },
      createProcessEnv: () => {
        throw new Error("must not call createProcessEnv when fresh");
      },
    };
    const settingsStore = { get: () => ({}) };
    const result = await refreshModelCatalogIfStale(piLocator, settingsStore, dir, {
      maxAgeMs: 24 * HOUR,
      now: () => now,
    });
    // 沙箱 realm 的对象原型与测试 realm 不同，deepEqual 会因原型不匹配失败，逐字段断言。
    assert.equal(result.ran, false);
    assert.equal(result.ok, true);
  });
});

test("pi update --models entry: args are array form (spawn safety) and startup wiring", () => {
  const cacheSource = readFileSync("src/main/pi/modelListCache.ts", "utf8");
  // 刷新参数必须数组形式（AGENTS.md 进程安全约束），且只刷目录不更新 pi 自身。
  assert.deepEqual([...MODEL_CATALOG_REFRESH_ARGS], ["update", "--models"]);
  // runPiCliCommand 复用 WSL/customPath 解析与进程环境构建（与 --list-models 同一套）。
  assert.match(cacheSource, /runPiCliCommand/);
  assert.match(cacheSource, /MODEL_CATALOG_REFRESH_ARGS/);
  // 冷启动挂点：syncWslConfig 后、Pi capability hydration 前刷目录，与 watcher 同时生效。
  const indexSource = readFileSync("src/main/index.ts", "utf8");
  assert.match(indexSource, /refreshModelCatalogIfStale\(/);
  assert.match(indexSource, /piModelCapabilityCache\?\.watchConfigDirectory\(\)/);
  const refreshIndex = indexSource.indexOf("await refreshModelCatalogIfStale(");
  const hydrateIndex = indexSource.indexOf("await piModelCapabilityCache?.ensure()", refreshIndex);
  const watcherIndex = indexSource.indexOf("piModelCapabilityCache?.watchConfigDirectory()");
  assert.ok(refreshIndex >= 0 && hydrateIndex > refreshIndex && watcherIndex > hydrateIndex,
    "startup must finish catalog refresh and initial hydration before installing the watcher");
  // watcher 必须把 models-store.json 纳入监视：目录刷新后已发布快照要失效重取。
  const capabilitySource = readFileSync("src/main/pi/PiModelCapabilityCache.ts", "utf8");
  assert.match(capabilitySource, /models-store\.json/);
  assert.match(capabilitySource, /isRelevantConfigFile/);
});

test("manual picker reload (force) refreshes catalog before re-hydration", () => {
  // 选择器“手动刷新”按钮 = listModelsReport(force=true)：先 pi update --models
  // （force 绕过 4h 节流，官方 provider 新模型立刻可见），成功后重新 hydration。
  const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
  assert.match(systemIpc, /refreshModelCatalogStore\(piLocator, settingsStore\)/);
  assert.match(systemIpc, /Model catalog force refresh on manual reload/);
  // 刷新失败不阻塞：目录刷新在 hydration 之前，失败仅记日志，列表仍走读盘刷新。
  const manualReloadStart = systemIpc.indexOf("// 手动刷新（force）");
  // 定长窗口（不依赖具体行尾）：覆盖 refreshModelCatalogStore + refresh 调用本身。
  const refreshCall = systemIpc.slice(manualReloadStart, manualReloadStart + 1400);
  assert.match(refreshCall, /if \(forceArg\)/);
  assert.match(refreshCall, /await refreshModelCatalogStore/);
  // 同一个 force 分支还是「带扩展」慢速档的唯一入口（扩展贡献模型的回补口子，
  // 默认 hydration 走 --no-extensions 快速档）：两件事必须留在同一次调用里，
  // 否则按钮会先刷新目录再用快速档重建，扩展模型永远补不回来。
  assert.match(refreshCall, /modelCapabilityCache\.refresh\(\{ loadExtensions: true \}\)/);
  // 渲染层已有 refreshing 转圈状态（失败也不打断选择器使用）。
  const hook = readFileSync("src/renderer/src/hooks/useBackendModelCatalog.ts", "utf8");
  assert.match(hook, /if \(force\) setRefreshing\(true\)/);
});
