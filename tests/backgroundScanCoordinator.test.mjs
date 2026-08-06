import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// BackgroundScanCoordinator：后台扫描去重/冷却/pending 合并的行为契约。
// 这是「展开项目卡顿」优化的核心安全阀——3 秒轮询触发不演变成并发重扫。

function loadCoordinator() {
  const source = readFileSync("src/main/sessions/BackgroundScanCoordinator.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "BackgroundScanCoordinator.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: () => ({}),
    setTimeout,
    clearTimeout,
    Date,
    Map,
    Set,
  }, { filename: "BackgroundScanCoordinator.ts" });
  return module.exports.BackgroundScanCoordinator;
}

const BackgroundScanCoordinator = loadCoordinator();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("concurrent triggers for the same project collapse into one running scan + one pending rerun", async () => {
  const coordinator = new BackgroundScanCoordinator(0);
  let runs = 0;
  let resolveFirst;
  const firstGate = new Promise((r) => { resolveFirst = r; });
  const task = async () => {
    runs += 1;
    if (runs === 1) await firstGate; // 第一次扫描挂起，模拟慢扫描
  };

  assert.equal(coordinator.schedule("p1", task), true, "first trigger schedules");
  assert.equal(coordinator.schedule("p1", task), false, "second trigger during scan merges as pending");
  assert.equal(coordinator.schedule("p1", task), false, "third trigger also merges (no queue growth)");

  resolveFirst();
  await sleep(20); // 等第一次完成 + pending 补跑
  assert.equal(runs, 2, "pending reruns exactly once");

  coordinator.dispose();
});

test("different projects scan independently", async () => {
  const coordinator = new BackgroundScanCoordinator(0);
  const ran = [];
  const taskFor = (id) => async () => { ran.push(id); };
  coordinator.schedule("p1", taskFor("p1"));
  coordinator.schedule("p2", taskFor("p2"));
  await sleep(20);
  assert.deepEqual(ran.sort(), ["p1", "p2"]);
  coordinator.dispose();
});

test("cooldown delays a rescan that fires too soon after the previous completion", async () => {
  const coordinator = new BackgroundScanCoordinator(60);
  let runs = 0;
  const task = async () => { runs += 1; };

  coordinator.schedule("p1", task);
  await sleep(20); // 第一次完成
  assert.equal(runs, 1);

  coordinator.schedule("p1", task); // 立即再触发 → 应进入冷却延迟
  await sleep(20);
  assert.equal(runs, 1, "still within cooldown: must not have rescanned yet");
  await sleep(80);
  assert.equal(runs, 2, "rescan runs after cooldown elapses");

  coordinator.dispose();
});

test("dispose cancels pending cooldown timers", async () => {
  const coordinator = new BackgroundScanCoordinator(1000);
  let runs = 0;
  coordinator.schedule("p1", async () => { runs += 1; });
  coordinator.dispose();
  await sleep(30);
  assert.equal(runs, 0, "disposed coordinator never fires delayed scans");
});
