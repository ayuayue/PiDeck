import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 与 sessionComposer.test.mjs 相同的 TSX 编译替身模式：只测公开 helper 与源码结构，
// 不挂载真实 React / jotai。
function compile(filePath, stubs = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => stubs[specifier] ?? {};
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  }, { filename: filePath });
  return module.exports;
}

const chipsPath = "src/renderer/src/components/session/SessionWidgetChips.tsx";
const chipsSource = () => readFileSync(chipsPath, "utf8");

function loadChipsHelpers() {
  return compile(chipsPath, {
    react: {},
    jotai: {},
    "./ComposerRuntimeIntegrations": {},
    "./ComposerComponents": {},
  });
}

test("widgetProgress counts checkmarks and ignores section headers", () => {
  const { widgetProgress } = loadChipsHelpers();
  // vm 跨 realm 对象的 Object.prototype 不同，不能用 deepEqual，按字段断言
  const progressOf = (lines) => {
    const result = widgetProgress(lines);
    return `${result.done}/${result.total}`;
  };
  assert.equal(progressOf([
    "── 待办 ──",
    "☐ #1 修复登录页样式",
    "☑ #2 更新依赖文档",
    "── 已完成 ──",
    "☑ #3 审查 PR",
  ]), "2/3");
  // plan 扩展行格式（步骤号 + 文本）同样按 ☑/☐ 计数
  assert.equal(progressOf([
    "计划进度 1/3",
    "☑ 1. 设计 schema",
    "☐ 2. 实现迁移",
    "☐ 3. 补测试",
  ]), "1/3");
  // 无勾选标记（如 todo 折叠态只回 "2/4" 一行）时 total 为 0，由 UI 退化为首行摘要
  assert.equal(progressOf(["2/4"]), "0/0");
  assert.equal(progressOf([]), "0/0");
});

test("widget dismissal is permanent across restarts and revives only on new content", () => {
  const { isWidgetDismissed, widgetDismissalId, widgetLinesSignature } = loadChipsHelpers();
  const lines = ["── 待办 ──", "☐ #1 修复登录页样式"];
  // 用户在 generation 1 时手动关闭 → 记录当时的内容指纹
  const dismissed = {
    [widgetDismissalId("session-a", "pi-deck-todo")]: widgetLinesSignature(lines),
  };
  // 重启后扩展重建同一列表（可能是 generation 2/3/…）：指纹相同 → 永久保持隐藏
  assert.equal(isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", [...lines]), true);
  // 工具再次调用追加新待办：内容变化 → 自动复活
  assert.equal(
    isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", [...lines, "☐ #2 补测试"]),
    false,
  );
  // 工具 toggle 完成态同样算内容变化 → 复活
  assert.equal(
    isWidgetDismissed(dismissed, "session-a", "pi-deck-todo", ["── 待办 ──", "☑ #1 修复登录页样式"]),
    false,
  );
  // dismiss 按 session 隔离：其他会话不受影响
  assert.equal(isWidgetDismissed(dismissed, "session-b", "pi-deck-todo", [...lines]), false);
  // 按 widgetKey 隔离：todo 的关闭不影响 plan
  assert.equal(isWidgetDismissed(dismissed, "session-a", "pi-deck-plan-todos", [...lines]), false);
});

test("widgetLinesSignature is stable and order/content sensitive", () => {
  const { widgetLinesSignature } = loadChipsHelpers();
  const a = ["☐ #1 任务一", "☐ #2 任务二"];
  assert.equal(widgetLinesSignature(a), widgetLinesSignature([...a]));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature([...a].reverse()));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature([...a, "☐ #3 任务三"]));
  assert.notEqual(widgetLinesSignature(a), widgetLinesSignature(["☐ #1 任务一改"]));
});

test("widget chips render in the chat header left slot, not the composer", () => {
  // chips 容器带 mr-auto：在 justify-end 的 chat-header-actions 里钉在左端
  assert.match(chipsSource(), /mr-auto flex min-w-0 items-center/);
  // 详情用 shadcn Popover 承载，常驻只显示摘要 chip
  assert.match(chipsSource(), /PopoverTrigger/);
  assert.match(chipsSource(), /PopoverContent/);
  // 只接受当前 runtime 代数一致的 widget，重启后旧快照不复活
  assert.match(chipsSource(), /isCoherentComposerRuntimeUi/);

  const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
  // 头部提供左侧槽位，且渲染在状态/操作按钮之前（视觉最左）
  assert.match(header, /widgetChips\?: ReactNode/);
  assert.ok(header.indexOf("{props.widgetChips}") < header.indexOf("<SessionStatus"));

  const view = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
  assert.match(view, /widgetChips=\{<SessionWidgetChips sessionId=\{sessionId\} \/>\}/);

  // composer 不再渲染 widget：槽位类型与渲染点都已移除
  const runtime = readFileSync("src/renderer/src/components/session/ComposerRuntimeIntegrations.tsx", "utf8");
  assert.doesNotMatch(runtime, /ExtensionWidgetCard/);
  assert.doesNotMatch(runtime, /widgets: ReactNode/);
  const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
  assert.doesNotMatch(area, /\{widgets\}/);
});
