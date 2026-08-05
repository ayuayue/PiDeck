import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
  const source = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: () => ({}),
  });
  return module.exports;
}

function approx(a, b) {
	return Math.abs(a - b) < 1e-9;
}

function assertLayout(got, expected) {
	assert.ok(approx(got.composer, expected.composer), `composer ${got.composer} ≈ ${expected.composer}`);
	assert.ok(approx(got.timeline, expected.timeline), `timeline ${got.timeline} ≈ ${expected.timeline}`);
}

/**
 * 回归：AI 输出内容时 composer 上方出现可变内容（投递通知/widgets），
 * programResize 增高 composer 会从 timeline 扣空间；若 timeline 已到
 * minSize(160px) 下限，库会把 clamp 差额压给 terminal，terminal 被压到
 * 折叠阈值以下即触发 handleTerminalResize 的 px<=35 判定 → 终端被收起。
 * 修复：composer 增高只能占用 timeline 可让出的空间（预算制）。
 */
test("composer growth is capped by the timeline min-size budget", () => {
  const { growComposerWithinTimelineBudget } = loadModule();
  // group 高 800px，timeline minSize=160px → 20% 是保底
  const groupPx = 800;
  const timelineMinPx = 160;
  const layout = { timeline: 40, composer: 20, terminal: 40 };

  // 预算充足：timeline 40% 可让 20% → composer 可长到 30%
  const grown = growComposerWithinTimelineBudget(
    layout,
    20, // composer 当前
    30, // 目标
    groupPx,
    timelineMinPx,
  );
  assertLayout(grown, { composer: 30, timeline: 30 });

  // 预算不足：timeline 只剩 22%（可让 2%），composer 不能长到 30%
  const capped = growComposerWithinTimelineBudget(
    { timeline: 22, composer: 20, terminal: 58 },
    20,
    30,
    groupPx,
    timelineMinPx,
  );
  assertLayout(capped, { composer: 22, timeline: 20 });

  // timeline 已在保底线：composer 完全不能长（预算为 0）
  const atFloor = growComposerWithinTimelineBudget(
    { timeline: 20, composer: 20, terminal: 60 },
    20,
    40,
    groupPx,
    timelineMinPx,
  );
  assertLayout(atFloor, { composer: 20, timeline: 20 });
});

test("timeline budget respects the configured min-size constant", () => {
  const { growComposerWithinTimelineBudget, TIMELINE_MIN_HEIGHT } = loadModule();
  assert.equal(TIMELINE_MIN_HEIGHT, 160);
  // timeline 12% + minSize 12%（=96px/800px 组内），无法让出 → 预算 0
  const capped = growComposerWithinTimelineBudget(
    { timeline: 12, composer: 30, terminal: 58 },
    30,
    40,
    800,
    TIMELINE_MIN_HEIGHT,
  );
  assertLayout(capped, { composer: 30, timeline: 12 });
});

test("session view uses the budget function in programResize (not raw delta)", () => {
  const sessionView = readFileSync(
    "src/renderer/src/components/session/SessionView.tsx",
    "utf8",
  );
  // programResize 必须走预算函数：raw delta 在 timeline 触底时会压扁 terminal
  assert.match(sessionView, /growComposerWithinTimelineBudget/);
  // timeline 面板的 minSize 用同一常量，预算函数与 JSX 约束不漂移
  assert.match(sessionView, /minSize=\{TIMELINE_MIN_HEIGHT\}/);
  // 折叠阈值判定仍保留（用户拖拽到 35px 以下应折叠），但程序化增长不再触发它
  assert.match(sessionView, /px <= 35/);
});
