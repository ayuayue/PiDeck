import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 保存 models 后的验证链路（2026-09 性能重构）：
 * 1) 保存 handler 即时反馈 = modelsFromPiConfig 解析刚写入的配置（纯函数，0 fork）
 * 2) fork 真实 pi 的完整验证移到后台 verifyModelsAfterSave，走 retryOnEmpty:false
 *    ——刚保存完环境是热的，CLI 空表是真实信号，重试只会多 fork 一次（本机 ~17s/次）
 * 3) 默认行为不变：启动早期选择器路径仍保留空表重试一次（pi 冷启动可能返回空表头）
 *
 * execFile 通过 loadTsCommonJs stubs 打桩（编译后的 import("node:child_process") 走
 * localRequire → stubs 命中），不真 fork pi。
 */

/** 生成 execFile 打桩：记录调用次数与参数，异步回吐指定 stdout。 */
function makeExecFileStub(stdoutProvider) {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args });
    const stdout = typeof stdoutProvider === "function" ? stdoutProvider(args) : stdoutProvider;
    setImmediate(() => callback(null, stdout, ""));
  };
  return { execFile, calls };
}

const CLI_TABLE = [
  "provider  model  context  max-out  thinking  images",
  "openai    gpt-5   200K     64K      yes       yes",
].join("\n");

function makeDeps() {
  return {
    piLocator: {
      resolveCommand: () => "pi",
      createInvocation: (command, args) => ({
        command,
        args,
        shell: false,
        pathPrefix: "",
        wsl: null,
        windowsVerbatimArguments: false,
      }),
      createProcessEnv: () => ({}),
      check: async () => ({ installed: true, version: "0.85.1", command: "pi", error: null }),
    },
    settingsStore: { get: () => ({}) },
    // 本地 models.json 兜底数据：CLI 空表时回退读它（foo/m-local）。
    configSource: {
      getModelsConfig: async () => ({
        parsed: { providers: { foo: { models: [{ id: "m-local" }] } } },
      }),
    },
  };
}

test("instant save verification: modelsFromPiConfig counts saved models without any fork", () => {
  const { modelsFromPiConfig } = loadTsCommonJs("src/main/pi/modelListCache.ts");
  const saved = {
    providers: {
      a: { models: [{ id: "m1", name: "M1" }] },
      b: { models: [{ id: "m2" }, { id: "m3" }] },
    },
  };
  assert.equal(modelsFromPiConfig(saved).length, 3);
  // 空配置 → modelLoadOk=false（handler 返回 reason "empty" 的依据）
  assert.equal(modelsFromPiConfig({ providers: {} }).length, 0);
  assert.equal(modelsFromPiConfig(null).length, 0);
});

test("save verification (retryOnEmpty:false) forks pi exactly once even when CLI returns empty", async () => {
  const { execFile, calls } = makeExecFileStub("");
  const { resolveModelListReport } = loadTsCommonJs("src/main/pi/modelListCache.ts", {
    stubs: { "node:child_process": { execFile } },
  });
  const deps = makeDeps();
  const report = await resolveModelListReport(
    deps.piLocator,
    deps.settingsStore,
    deps.configSource,
    true,
    { retryOnEmpty: false },
  );
  // 关键断言：空表不再触发第二次 fork（旧实现 500ms 后重试，保存路径白白翻倍）。
  assert.equal(calls.length, 1);
  // CLI 空 → 本地 models.json 兜底成功；verifyModelsAfterSave 会把
  // source=config-fallback 判为「未通过」，不会给假绿灯。
  assert.equal(report.ok, true);
  assert.equal(report.source, "config-fallback");
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0].id, "m-local");
});

test("retryOnEmpty:false with valid CLI output resolves from cli in a single fork", async () => {
  const { execFile, calls } = makeExecFileStub(CLI_TABLE);
  const { resolveModelListReport } = loadTsCommonJs("src/main/pi/modelListCache.ts", {
    stubs: { "node:child_process": { execFile } },
  });
  const deps = makeDeps();
  const report = await resolveModelListReport(
    deps.piLocator,
    deps.settingsStore,
    deps.configSource,
    true,
    { retryOnEmpty: false },
  );
  assert.equal(calls.length, 1);
  assert.equal(report.ok, true);
  assert.equal(report.source, "cli");
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0].id, "gpt-5");
  assert.equal(report.models[0].contextWindow, 200 * 1000);
});

test("default behavior still retries once on empty (startup cold-start protection kept)", async () => {
  const { execFile, calls } = makeExecFileStub("");
  const { resolveModelListReport } = loadTsCommonJs("src/main/pi/modelListCache.ts", {
    stubs: { "node:child_process": { execFile } },
  });
  const deps = makeDeps();
  const report = await resolveModelListReport(
    deps.piLocator,
    deps.settingsStore,
    deps.configSource,
    true,
  );
  // 选择器/启动路径保持旧行为：空表 500ms 后重试一次（共 2 次 fork），防 pi 冷启动空表头。
  assert.equal(calls.length, 2);
  assert.equal(report.source, "config-fallback");
});
