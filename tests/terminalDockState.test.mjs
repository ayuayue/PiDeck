import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (id) => imports[id] ?? {},
  });
  return module.exports;
}

function loadTerminalDockStateModule() {
  return compile("src/renderer/src/terminalDockState.ts");
}

function assertMotion(state, expected) {
  assert.equal(state.mounted, expected.mounted);
  assert.equal(state.closing, expected.closing);
  assert.equal(state.agentId, expected.agentId);
}

function loadDockMotion() {
  return compile("src/renderer/src/components/session/SessionRuntimeDock.tsx", {
    react: {},
    "react/jsx-runtime": { jsx: () => null },
    "../terminal/TerminalDock": {},
  });
}

test("remembers collapsed terminal dock state for each agent", () => {
  const { setTerminalDockCollapsed } = loadTerminalDockStateModule();
  const current = {
    agentA: { open: true, collapsed: false },
    agentB: { open: true, collapsed: false },
  };
  const next = setTerminalDockCollapsed(current, "agentA", true);
  assert.equal(next.agentA.collapsed, true);
  assert.equal(next.agentA.open, true);
  assert.equal(next.agentB.collapsed, false);
});

test("preserves collapsed state when toggling terminal open state", () => {
  const { setTerminalDockOpen } = loadTerminalDockStateModule();
  const closed = setTerminalDockOpen({ agentA: { open: true, collapsed: true } }, "agentA", false);
  const reopened = setTerminalDockOpen(closed, "agentA", true);
  assert.equal(closed.agentA.open, false);
  assert.equal(reopened.agentA.collapsed, true);
});

test("prunes agent and project keys against their own live sets", () => {
  const { pruneTerminalDockState, terminalOwnerKey } = loadTerminalDockStateModule();
  const agentA = terminalOwnerKey({ kind: "agent", id: "agentA" });
  const agentB = terminalOwnerKey({ kind: "agent", id: "agentB" });
  const projectP = terminalOwnerKey({ kind: "project", id: "projP" });
  const current = {
    [agentA]: { open: true, collapsed: true },
    [agentB]: { open: true, collapsed: false },
    [projectP]: { open: true, collapsed: false },
  };

  // 关键回归：不能用 agent 集合误删 project 键
  const next = pruneTerminalDockState(
    current,
    new Set(["agentB"]),
    new Set(["projP"]),
  );

  assert.equal(next[agentA], undefined);
  assert.equal(next[agentB].open, true);
  assert.equal(next[projectP].open, true);
});

test("streaming prune preserves canonical agent state without allocating a new state object", () => {
  const { pruneTerminalDockState, terminalOwnerKey } = loadTerminalDockStateModule();
  const agentId = "streaming-agent";
  const ownerKey = terminalOwnerKey({ kind: "agent", id: agentId });
  const current = { [ownerKey]: { open: true, collapsed: false } };

  // 流式 runtime-state 更新会反复触发 prune；存活 agent 的终端不能被清掉，
  // 且不应创建新对象触发额外 React 更新。
  const next = pruneTerminalDockState(current, new Set([agentId]), new Set());
  assert.strictEqual(next, current);
  assert.equal(next[ownerKey].open, true);

  // 兼容已运行实例：旧 hook 曾把 agentId 直接当 key 写入；流式 prune 时应迁移，
  // 不能把当前已打开的终端直接删掉。
  const legacy = { [agentId]: { open: true, collapsed: false } };
  const migrated = pruneTerminalDockState(legacy, new Set([agentId]), new Set());
  assert.notStrictEqual(migrated, legacy);
  assert.equal(migrated[agentId], undefined);
  assert.equal(migrated[ownerKey].open, true);

  // 如果热更新期间两种 key 同时存在，已写入的新 canonical 状态优先。
  const duplicate = {
    [agentId]: { open: false, collapsed: true },
    [ownerKey]: { open: true, collapsed: false },
  };
  const normalized = pruneTerminalDockState(duplicate, new Set([agentId]), new Set());
  assert.equal(normalized[agentId], undefined);
  assert.equal(normalized[ownerKey].open, true);
  assert.equal(normalized[ownerKey].collapsed, false);
});

test("terminal dock hook converts agent IDs into canonical owner keys", () => {
  const hookSource = readFileSync(
    "src/renderer/src/hooks/useTerminalDock.ts",
    "utf8",
  );

  // 终端状态 helper 的 prune 契约只识别 agent:<id>/project:<id>；hook 不能存裸 agentId。
  assert.match(hookSource, /terminalOwnerKey\(\{ kind: "agent", id: activeAgentId \}\)/);
  assert.match(hookSource, /terminalDockStateByOwner\[activeOwnerKey\]/);
  assert.match(hookSource, /setTerminalDockOpen\(current, terminalOwnerKey\(\{ kind: "agent", id: agentId \}\), open\)/);
  assert.match(hookSource, /setTerminalDockCollapsed\(current, terminalOwnerKey\(\{ kind: "agent", id: agentId \}\), collapsed\)/);
});

test("rapid reopen cancels the closing state without a second timer owner", () => {
  const { transitionSessionRuntimeDock } = loadDockMotion();
  const open = transitionSessionRuntimeDock({ mounted: false, closing: false }, { agentId: "A", open: true });
  const closing = transitionSessionRuntimeDock(open, { agentId: "A", open: false });
  const reopened = transitionSessionRuntimeDock(closing, { agentId: "A", open: true });
  assertMotion(closing, { mounted: true, closing: true, agentId: "A" });
  assertMotion(reopened, { mounted: true, closing: false, agentId: "A" });
});

test("runtime replacement mounts B directly and close completion cannot retain stale A", () => {
  const { transitionSessionRuntimeDock, finishSessionRuntimeDockClose, disposeSessionRuntimeDock } = loadDockMotion();
  const agentB = transitionSessionRuntimeDock(
    { mounted: true, closing: false, agentId: "A" }, { agentId: "B", open: true },
  );
  const closed = finishSessionRuntimeDockClose(
    transitionSessionRuntimeDock(agentB, { agentId: undefined, open: false }),
  );
  assertMotion(agentB, { mounted: true, closing: false, agentId: "B" });
  assertMotion(closed, { mounted: false, closing: false, agentId: undefined });
  assertMotion(disposeSessionRuntimeDock(), { mounted: false, closing: false, agentId: undefined });
});
