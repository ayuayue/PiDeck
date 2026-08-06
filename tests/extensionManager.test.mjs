import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

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
      if (specifier === "./builtInExtensions") {
        return nodeRequire("../src/main/extensions/builtInExtensions.ts");
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
