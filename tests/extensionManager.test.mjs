import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

let builtInExtensionsModule = null;

/**
 * builtInExtensions.ts 依赖 ./builtInExtensionsManifest（覆盖层清单校验），
 * nodeRequire 解析不了无扩展名的 .ts 相对导入，统一交给 loadTsCommonJs。
 * 模块级缓存保证实例唯一：覆盖层可用性缓存住在模块内部。
 */
function loadBuiltInExtensionsModule() {
  if (!builtInExtensionsModule) {
    builtInExtensionsModule = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");
  }
  return builtInExtensionsModule;
}

function loadExtensionManagerModule() {
  const source = readFileSync("src/main/extensions/ExtensionManager.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "ExtensionManager.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "../wsl/WslPaths") {
        return { toWindowsHostPath: (path) => path };
      }
      // 25fd516 起 ExtensionManager 依赖内置扩展清单模块；按真实模块透传（纯数据 + 纯函数）
      if (specifier === "./extensionDiscovery") {
        return nodeRequire("../src/main/extensions/extensionDiscovery.ts");
      }
      if (specifier === "./builtInExtensions") {
        return loadBuiltInExtensionsModule();
      }
      // 删除走系统回收站统一入口；测试环境没有回收站，模拟为真实删除（rm 已在测试 import 中）。
      if (specifier === "../fs/trash") {
        return { trashPath: async (p) => { await rm(p, { recursive: true, force: true }); } };
      }
      // 共享日志器：测试环境未注册实例，返回 null 让调用方静默跳过
      if (specifier === "../logging/sharedLogger") {
        return { getAppLogger: () => null };
      }
      if (specifier === "./extensionVersionGate") {
        return nodeRequire("../src/main/extensions/extensionVersionGate.ts");
      }
      // ExtensionManager 依赖 ../utils/versionCompare 的 compareVersions；.ts 经 node 类型剥离可 require。
      if (specifier === "../utils/versionCompare") {
        return nodeRequire("../src/main/utils/versionCompare.ts");
      }
      return nodeRequire(specifier);
    },
    Promise,
    Set,
    Map,
    JSON,
    Error,
  }, { filename: "ExtensionManager.ts" });
  return module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("a stale lightweight extension scan cannot overwrite a newer force refresh", async () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const manager = new ExtensionManager({}, () => ({}));
  const lightweight = deferred();
  const forced = deferred();

  // Isolate cache ordering from pi/npm IO. The production method is private in TypeScript,
  // but remains a normal method at runtime and is intentionally replaced only for this test.
  manager.loadList = (includeVersionInfo) => (
    includeVersionInfo ? forced.promise : lightweight.promise
  );

  const lightweightResult = manager.list(false);
  const forceResult = manager.list(true);
  const fresh = { extensions: [{ id: "fresh", source: "npm:fresh" }], raw: "fresh" };
  const stale = { extensions: [{ id: "stale", source: "npm:stale" }], raw: "stale" };

  forced.resolve(fresh);
  assert.equal(await forceResult, fresh);

  lightweight.resolve(stale);
  assert.equal(await lightweightResult, fresh);
  assert.equal(await manager.list(false), fresh);
  assert.equal(await manager.list(true), fresh);
});

test("parseListOutput strips the pi list (filtered) suffix so uninstall/update use a clean source", () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const manager = new ExtensionManager({}, () => ({}));

  const raw = [
    "User packages:",
    "  npm:pi-web-access",
    "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\pi-web-access",
    "  npm:@adrianapan/pikit (filtered)",
    "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\@adrianapan\\pikit",
  ].join("\n");

  const parsed = manager.parseListOutput(raw);
  const pikit = parsed.find((ext) => ext.source.includes("pikit"));

  // source 必须是干净的 npm source：卸载（pi remove）与更新（pi update / npm view）都依赖它
  assert.equal(pikit.source, "npm:@adrianapan/pikit");
  assert.equal(pikit.filtered, true);
  assert.equal(pikit.id, "user:npm:@adrianapan/pikit");
  // 路径行照常解析，不受后缀影响
  assert.equal(
    pikit.path,
    "C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\@adrianapan\\pikit",
  );
});

test("parseListOutput leaves plain package sources untouched", () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const manager = new ExtensionManager({}, () => ({}));

  const raw = [
    "User packages:",
    "  npm:pi-web-access",
    "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\pi-web-access",
  ].join("\n");

  const parsed = manager.parseListOutput(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].source, "npm:pi-web-access");
  assert.equal(parsed[0].filtered, undefined);
});

test("list discovers local js, index.js, and package-manifest extensions once per root", async () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const home = await mkdtemp(join(tmpdir(), "pideck-extension-discovery-"));
  try {
    const extensionsDir = join(home, ".pi", "agent", "extensions");
    await mkdir(join(extensionsDir, "index-package"), { recursive: true });
    await mkdir(join(extensionsDir, "manifest-package", "dist"), { recursive: true });
    await mkdir(join(extensionsDir, "fallback-package"), { recursive: true });
    await mkdir(join(extensionsDir, "ignored-directory"), { recursive: true });
    await writeFile(join(extensionsDir, "plain.js"), "module.exports = {};", "utf8");
    await writeFile(join(extensionsDir, "index-package", "index.js"), "module.exports = {};", "utf8");
    await writeFile(
      join(extensionsDir, "manifest-package", "package.json"),
      JSON.stringify({ pi: { extensions: ["dist/first.js", "dist/second.ts"] } }),
      "utf8",
    );
    await writeFile(join(extensionsDir, "manifest-package", "dist", "first.js"), "module.exports = {};", "utf8");
    await writeFile(join(extensionsDir, "manifest-package", "dist", "second.ts"), "export default {};", "utf8");
    await writeFile(
      join(extensionsDir, "fallback-package", "package.json"),
      JSON.stringify({ pi: { extensions: ["missing.js"] } }),
      "utf8",
    );
    await writeFile(join(extensionsDir, "fallback-package", "index.js"), "module.exports = {};", "utf8");
    await writeFile(join(extensionsDir, "ignored-directory", "README.md"), "not an extension", "utf8");

    const manager = new ExtensionManager({}, () => ({}));
    manager.configureWsl({ windowsHome: home });
    manager.runPi = async () => "User packages:\n";
    const result = await manager.list(false);
    const local = result.extensions.filter((extension) => extension.id.startsWith("local:"));
    const bySource = new Map(local.map((extension) => [extension.source, extension]));

    assert.equal(bySource.get("plain.js")?.path, join(extensionsDir, "plain.js"));
    assert.equal(bySource.get("index-package")?.path, join(extensionsDir, "index-package"));
    assert.equal(bySource.get("manifest-package")?.path, join(extensionsDir, "manifest-package"));
    assert.equal(bySource.get("fallback-package")?.path, join(extensionsDir, "fallback-package"));
    assert.equal(local.filter((extension) => extension.source === "manifest-package").length, 1);
    assert.equal(bySource.has("ignored-directory"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstall removes a local extension and clears its stale disable entry", async () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const home = await mkdtemp(join(tmpdir(), "pideck-extension-manager-"));
  try {
    const extensionsDir = join(home, ".pi", "agent", "extensions");
    const settingsPath = join(home, ".pi", "agent", "settings.json");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, "local-tool.ts"), "export default {};", "utf8");
    await writeFile(settingsPath, JSON.stringify({ disabledExtensions: ["local-tool.ts", "other.ts"] }), "utf8");

    // 拆分后构造签名：(locator, getSettings, getPiDeckSettings, patchPiDeckSettings, translate)
    const manager = new ExtensionManager(
      {},
      () => ({}),
      () => ({}),
      async () => ({}),
      (key) => key === "mainExtension.invalidPath" ? "Invalid extension path." : key,
    );
    manager.wslEnvironment = { windowsHome: home };
    await manager.uninstall("local-tool.ts");

    await assert.rejects(readFile(join(extensionsDir, "local-tool.ts"), "utf8"), { code: "ENOENT" });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(settings.disabledExtensions, ["other.ts"]);
    await assert.rejects(manager.uninstall("../outside.ts"), /Invalid extension path/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
