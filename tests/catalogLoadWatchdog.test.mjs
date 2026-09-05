import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadWatchdog() {
  const sandbox = { exports: {}, setTimeout, clearTimeout };
  vm.runInNewContext(
    ts.transpileModule(readFileSync("src/renderer/src/utils/catalogLoadWatchdog.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
  );
  return sandbox.exports.createKeyedWatchdog();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("watchdog fires after the delay when not cancelled", async () => {
  const watchdog = loadWatchdog();
  let fired = 0;
  watchdog.schedule("project-a", 30, () => { fired += 1; });
  await sleep(70);
  assert.equal(fired, 1);
});

test("cancelled watchdog never fires", async () => {
  const watchdog = loadWatchdog();
  let fired = 0;
  watchdog.schedule("project-a", 30, () => { fired += 1; });
  watchdog.cancel("project-a");
  await sleep(70);
  assert.equal(fired, 0);
});

test("re-scheduling replaces the previous timer for the same key", async () => {
  const watchdog = loadWatchdog();
  let firstFired = 0;
  let secondFired = 0;
  watchdog.schedule("project-a", 30, () => { firstFired += 1; });
  watchdog.schedule("project-a", 30, () => { secondFired += 1; });
  await sleep(70);
  assert.equal(firstFired, 0);
  assert.equal(secondFired, 1);
});

test("cancelAll clears timers for every key", async () => {
  const watchdog = loadWatchdog();
  let fired = 0;
  watchdog.schedule("project-a", 30, () => { fired += 1; });
  watchdog.schedule("project-b", 30, () => { fired += 1; });
  watchdog.cancelAll();
  await sleep(70);
  assert.equal(fired, 0);
});

test("a key can be re-armed after its timer fired (two-stage retry pattern)", async () => {
  const watchdog = loadWatchdog();
  const stages = [];
  watchdog.schedule("project-a", 30, () => {
    stages.push(1);
    // 二级：同 key 重新武装（模拟 armCatalogLoadWatchdog 一级回调里的行为）
    watchdog.schedule("project-a", 30, () => stages.push(2));
  });
  await sleep(160);
  assert.deepEqual(stages, [1, 2]);
});
