import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 增量 flush 协议（2026-08 渲染卡顿优化）：流式节流 flush 只发尾部增量，
// 终态 flush 全量校准。本测试锁定 payload 构造的分支与边界。

function loadAgentUtils() {
  const source = readFileSync("src/main/pi/agentUtils.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "agentUtils.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: () => ({}),
  }, { filename: "agentUtils.ts" });
  return module.exports;
}

const { buildMessageFlushPayload } = loadAgentUtils();

const msg = (id) => ({ id, role: "assistant", text: `text-${id}` });

test("dirtyFrom marks a valid tail: sends only the tail slice with upsert coordinates", () => {
  const all = [msg("a"), msg("b"), msg("c"), msg("d")];
  const payload = buildMessageFlushPayload("agent-1", all, 2);
  assert.equal(payload.upsertFrom, 2);
  assert.equal(payload.totalLength, 4);
  assert.deepEqual(payload.messages.map((m) => m.id), ["c", "d"]);
});

test("dirtyFrom at last index sends only the streaming tail message", () => {
  // 流式典型场景：533 条消息只有尾部 assistant 在变 → 载荷从全量降到 1 条
  const all = Array.from({ length: 533 }, (_, i) => msg(`m${i}`));
  const payload = buildMessageFlushPayload("agent-1", all, 532);
  assert.equal(payload.upsertFrom, 532);
  assert.equal(payload.totalLength, 533);
  assert.equal(payload.messages.length, 1);
});

test("dirtyFrom undefined falls back to full payload (unmarked paths: edit/delete/reload)", () => {
  const all = [msg("a"), msg("b")];
  const payload = buildMessageFlushPayload("agent-1", all, undefined);
  assert.equal(payload.upsertFrom, undefined);
  assert.equal(payload.totalLength, undefined);
  assert.equal(payload.messages.length, 2);
});

test("out-of-range dirtyFrom falls back to full payload", () => {
  const all = [msg("a"), msg("b")];
  for (const dirtyFrom of [-1, 2, 99]) {
    const payload = buildMessageFlushPayload("agent-1", all, dirtyFrom);
    assert.equal(payload.upsertFrom, undefined, `dirtyFrom=${dirtyFrom} must be full`);
    assert.equal(payload.messages.length, 2);
  }
});

test("dirtyFrom 0 emits a full replacement in incremental form (renderer merges as full overwrite)", () => {
  const all = [msg("a"), msg("b")];
  const payload = buildMessageFlushPayload("agent-1", all, 0);
  assert.equal(payload.upsertFrom, 0);
  assert.equal(payload.totalLength, 2);
  assert.equal(payload.messages.length, 2);
});

test("empty message list always falls back to full payload", () => {
  const payload = buildMessageFlushPayload("agent-1", [], 0);
  assert.equal(payload.upsertFrom, undefined);
  assert.equal(payload.messages.length, 0);
});
