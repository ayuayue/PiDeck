import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const windowing = compile("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

function runs(...ids) {
  return ids.map((id) => ({ kind: "agent-run", id, items: [] }));
}

test("sliceLastAgentRuns keeps only the trailing maxTurns agent-runs", () => {
  const items = [
    { kind: "message", id: "sys" },
    ...runs("r1", "r2", "r3", "r4", "r5"),
  ];
  const sliced = windowing.sliceLastAgentRuns(items, 3);
  assert.deepEqual(
    sliced.map((item) => item.id),
    ["r3", "r4", "r5"],
  );
});

test("sliceLastAgentRuns preserves trailing non-run items after the cut", () => {
  const items = [
    ...runs("r1", "r2", "r3"),
    { kind: "message", id: "diag" },
  ];
  const sliced = windowing.sliceLastAgentRuns(items, 2);
  assert.deepEqual(
    sliced.map((item) => item.id ?? item.kind),
    ["r2", "r3", "diag"],
  );
});

test("sliceLastAgentRuns returns same reference when under the limit", () => {
  const items = runs("r1", "r2");
  assert.equal(windowing.sliceLastAgentRuns(items, 10), items);
});

test("selectTimelineTurnWindow slices past the window turns regardless of following", () => {
  const items = runs("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
  assert.equal(windowing.countAgentRunItems(items), 11);
  assert.equal(windowing.shouldWindowTimelineTurns(11, 10), true);
  assert.equal(windowing.shouldWindowTimelineTurns(11, 15), false);
  // 2026-08 治理：非贴底（上滚看历史）同样裁剪，只是窗口更大

  const scrolled = windowing.selectTimelineTurnWindow(items, 10);
  assert.equal(scrolled.length, 10);
  assert.equal(scrolled[0].id, "b");
  assert.equal(scrolled.at(-1).id, "k");
});

test("selectTimelineTurnWindow returns same reference when under the window", () => {
  const items = runs("a", "b", "c");
  assert.equal(windowing.selectTimelineTurnWindow(items, 15), items);
});

test("timeline wires the turn mount window helper", () => {
  const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
  assert.match(source, /selectTimelineTurnWindow/);
  assert.match(source, /TIMELINE_MOUNTED_TURN_LIMIT/);
  assert.doesNotMatch(source, /TIMELINE_SCROLLED_MAX_ITEMS/, "item budget removed in turn-centric protocol");
  // 跟随、恢复与普通历史浏览都必须走同一 tail-window 参数，不能在恢复时
  // 临时全量挂载后再收缩，否则已恢复的 scrollTop 会因高度缩小被截断。
  assert.match(source, /selectTimelineTurnWindow\(reconciledRuns, turnWindowTurns\)/);
  assert.doesNotMatch(source, /Number\.MAX_SAFE_INTEGER/);
  assert.match(source, /displayRuns\.map/);
});

test("scrolled window starts small and expands by one cohort (2026-12 progressive window)", () => {
  // 方案 C：上滚初始窗口与贴底同为 3 轮；历史轮由「滚动接近窗口顶部自动扩窗口」渐进挂载。
  // DOM 3 / atom 9 / main 12 模型：扩窗与翻页共用同一 3 轮 cohort，避免数据页 +3、窗口却 +10。
  assert.equal(windowing.TIMELINE_SCROLLED_TURN_LIMIT, 3);
  assert.equal(windowing.TIMELINE_WINDOW_EXPAND_STEP, 3);
  // 小窗口裁剪行为仍正确：11 轮数据、窗口 3 轮 → 只保留尾部 3 轮
  const items = runs("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
  assert.equal(windowing.shouldWindowTimelineTurns(11, 3), true);
  const scrolled = windowing.selectTimelineTurnWindow(items, 3);
  assert.deepEqual(scrolled.map((item) => item.id), ["i", "j", "k"]);
  // 3 轮 cohort 扩展：窗口 6 轮 → 保留尾部 6 轮
  const six = windowing.selectTimelineTurnWindow(items, 6);
  assert.deepEqual(six.map((item) => item.id), ["f", "g", "h", "i", "j", "k"]);
});

test("resolveAutoExpandThreshold scales with viewport but floors at 120px", () => {
  // 纯函数文件无依赖，直接编译即可
  const threshold = compile(
    "src/renderer/src/hooks/timeline/autoExpandThreshold.ts",
  );
  // 小视口：下限 120px 兜底，不过早触发
  assert.equal(threshold.resolveAutoExpandThreshold(200), 120);
  // 常规视口（约 800px）：0.4 比例 ≈ 320px，比固定 120px 提前 2.7 倍
  assert.equal(threshold.resolveAutoExpandThreshold(800), 320);
  // 大视口（分屏/全屏）：提前量随视口继续放大
  assert.equal(threshold.resolveAutoExpandThreshold(1600), 640);
});

test("auto-expand wiring: controller exposes windowExpandableRef and listens near top", () => {
  const controllerSource = readFileSync(
    "src/renderer/src/hooks/useSessionTimelineController.ts",
    "utf8",
  );
  // 滚动监听进入「接近顶部」区间（scrollTop ≤ 视口比例阈值，下限 120px）且窗口仍可
  // 扩展时先扩窗口：触顶也优先消费 atom 已加载的 cohort，不因一把拉到顶而跳过本地扩窗。
  assert.match(controllerSource, /TURN_WINDOW_AUTO_EXPAND_THRESHOLD/);
  assert.match(controllerSource, /timeline\.scrollTop <= expandThreshold &&[\s\S]*?windowExpandableRef\.current/);
  assert.match(controllerSource, /resolveAutoExpandThreshold\(timeline\.clientHeight\)/);
  assert.match(controllerSource, /windowExpandableRef/);
  // 滚动触发的扩展走分批（每帧小批挂载），按钮/跳转走原子扩展
  assert.match(controllerSource, /expandWindowBatched\(growth\)/);
  assert.match(controllerSource, /requestAnimationFrame\(consumeExpandBatch\)/);
  // 只在真实上滚时预取；滚动与按钮加载统一锚定当前视口。
  assert.match(controllerSource, /scrollingUp/);
  assert.match(controllerSource, /loadMoreMessages\("scroll"\)/);
  assert.match(controllerSource, /preserveAtTop/);
  // 渲染层把 turnWindowActive 同步进 controller（窗口可扩判定）
  const timelineSource = readFileSync(
    "src/renderer/src/components/session/SessionMessageTimeline.tsx",
    "utf8",
  );
  assert.match(timelineSource, /windowExpandableRef\.current = turnWindowActive/);
});

test("countUserTurns merges consecutive user messages into one turn (speaker-hold semantics)", () => {
  // 连发 3 条 user 无回复 = 1 轮；assistant 回复后下一条 user 才开新轮。
  assert.equal(
    windowing.countUserTurns([
      { role: "user" }, { role: "user" }, { role: "user" },
      { role: "assistant" },
      { role: "user" }, { role: "assistant" },
    ]),
    2,
  );
  // system 诊断卡夹在连发 user 之间不拆轮。
  assert.equal(
    windowing.countUserTurns([
      { role: "user" }, { role: "system" }, { role: "user" }, { role: "assistant" },
    ]),
    1,
  );
  // 纯连发无任何回复：整段 1 轮（发言权未交还）。
  assert.equal(
    windowing.countUserTurns([{ role: "user" }, { role: "user" }, { role: "user" }]),
    1,
  );
});
