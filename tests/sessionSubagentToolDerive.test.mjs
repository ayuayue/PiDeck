/**
 * subagent 工具链（nicobailon pi-subagents）兼容验证：
 * - 前台派发（agent+task、无 action/async）→ running，配对 toolResult → completed/error
 *   且 result 携带报告全文
 * - 异步派发回执（含 "The async run is detached"，覆盖 asyncByDefault/
 *   forceTopLevelAsync 运行时强制后台、args 不带 async:true 的场景）→ 重键为回执
 *   中的 asyncId 并保持 running（与 subagent-async widget 同 id 空间，渲染层去重）
 * - action 管理查询 / 工作流脚本派发不推导
 * - parseSubagentAsyncSnapshot：PI_SUBAGENT_ASYNC_JSON 快照 → 条目（state 映射、
 *   非 acp/非快照载荷 fail-soft）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { deriveSubagentToolEntries, deriveToolSubagentEntries } = loadTsCommonJs(
  "src/main/pi/derivedSubagents.ts",
);
const { parseSubagentAsyncSnapshot } = loadTsCommonJs(
  "src/renderer/src/hooks/useSessionSubagents.ts",
  {
    stubs: {
      jotai: { useAtomValue: () => undefined },
      react: { useEffect: () => {}, useMemo: (fn) => fn(), useState: (i) => [i, () => {}] },
      "../desktopApi": { desktopApi: { sessions: { listSessionSubagents: async () => [] } } },
      "../atoms": { sessionRuntimeUiBySessionIdAtomFamily: () => undefined },
    },
  },
);

let seq = 0;
function entryId() {
  seq += 1;
  return `e${seq}`;
}

function toolCallEntry({ toolCallId, args, timestamp, name = "subagent" }) {
  return {
    type: "message",
    id: entryId(),
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    },
  };
}

function toolResultEntry({ toolCallId, text, timestamp, isError, toolName = "subagent" }) {
  return {
    type: "message",
    id: entryId(),
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: isError === true,
      content: [{ type: "text", text }],
    },
  };
}

const T0 = "2026-08-02T11:46:21.399Z";
const T1 = "2026-08-02T11:47:46.554Z";
const CALL_ID = "call_5809c5095c764e339f6b90e1";
const REPORT = "# Research: DeepSeek 最新 AI 模型信息\n\n## 摘要\n……";

test("derive: 前台派发 + 配对结果 → completed 且 result 携带报告全文", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({
      toolCallId: CALL_ID,
      args: { agent: "researcher", task: "查询 DeepSeek 最新模型信息" },
      timestamp: T0,
    }),
    toolResultEntry({ toolCallId: CALL_ID, text: REPORT, timestamp: T1 }),
  ]);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.id, CALL_ID);
  assert.equal(entry.type, "researcher");
  assert.equal(entry.description, "查询 DeepSeek 最新模型信息");
  assert.equal(entry.status, "completed");
  assert.equal(entry.result, REPORT);
  assert.equal(entry.startedAt, Date.parse(T0));
  assert.equal(entry.completedAt, Date.parse(T1));
  assert.equal(entry.source, "toolcall");
  assert.equal(entry.via, "pi-subagents-tool");
});

test("derive: isError 结果 → error", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "worker", task: "T" }, timestamp: T0 }),
    toolResultEntry({ toolCallId: CALL_ID, text: "boom", timestamp: T1, isError: true }),
  ]);
  assert.equal(entries[0].status, "error");
  assert.equal(entries[0].result, "boom");
});

test("derive: 未配对结果的派发保持 running（运行中/被杀由活性降级处理）", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "worker", task: "T" }, timestamp: T0 }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "running");
});

test("derive: action 查询 / 工作流派发不推导；显式后台派发推导为 running", () => {
  const entries = deriveSubagentToolEntries([
    // action 管理查询（list/status 等）
    toolCallEntry({ toolCallId: "call_list", args: { action: "list" }, timestamp: T0 }),
    // 带 agent 但同时带 action（agent 管理动作）
    toolCallEntry({ toolCallId: "call_act", args: { action: "stop", agent: "worker", runId: "r1" }, timestamp: T0 }),
    // 工作流脚本派发
    toolCallEntry({ toolCallId: "call_wf", args: { agent: "worker", task: "T", workflowScript: "return 1" }, timestamp: T0 }),
  ]);
  // VM realm 数组原型不同，deepEqual 不可用
  assert.equal(entries.length, 0);

  // 显式 async:true 派发也推导（回执到达后重键 asyncId，见下方回执测试）；
  // 无回执时保持 toolCallId 键 running，历史侧由活性降级处理
  const asyncDispatch = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: "call_async", args: { agent: "worker", task: "后台任务", async: true }, timestamp: T0 }),
  ]);
  assert.equal(asyncDispatch.length, 1);
  assert.equal(asyncDispatch[0].id, "call_async");
  assert.equal(asyncDispatch[0].status, "running");
  assert.equal(asyncDispatch[0].description, "后台任务");
});

/* ------------------------------------------------------------------ */
/* 异步派发回执（真实样本格式，见 nicobailon pi-subagents formatAsyncStartedMessage） */
/* ------------------------------------------------------------------ */

const ASYNC_ID = "fde17407-e9ba-4c52-b183-bec15a8a2ea6";

function asyncReceipt({ agent = "worker", id = ASYNC_ID, fanout = false, interactive = true } = {}) {
  const head = (fanout ? "Run fan-out: 1/64 used, 63 remaining\n" : "") + `Async: ${agent} [${id}]\n\n`;
  const guidance = interactive
    ? "The async run is detached and running in the background.\nYou are in an interactive session. Return control to the user now."
    : "The async run is detached. Do not run sleep timers or polling loops just to wait for it.";
  return head + guidance;
}

test("derive: 强制后台派发（args 无 async）+ 回执 → 重键 asyncId 保持 running，不误标 completed", () => {
  // forceTopLevelAsync/asyncByDefault 运行时强制后台：模型 args 不带 async:true，
  // 回执到达前旧逻辑会把它误标 completed 并把回执文本当 result
  const entries = deriveSubagentToolEntries([
    toolCallEntry({
      toolCallId: CALL_ID,
      args: { agent: "worker", task: "测试 shell 防线是否对子代理生效" },
      timestamp: T0,
    }),
    toolResultEntry({ toolCallId: CALL_ID, text: asyncReceipt({ fanout: true }), timestamp: T1 }),
  ]);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.id, ASYNC_ID);
  assert.equal(entry.type, "worker");
  assert.equal(entry.description, "测试 shell 防线是否对子代理生效");
  assert.equal(entry.status, "running");
  assert.equal(entry.result, undefined);
  assert.equal(entry.completedAt, undefined);
});

test("derive: 显式 async:true 派发 + 回执 → 同样重键 asyncId", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: "call_async", args: { agent: "scout", task: "T", async: true }, timestamp: T0 }),
    toolResultEntry({ toolCallId: "call_async", text: asyncReceipt({ agent: "scout", id: "run-2" }), timestamp: T1 }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "run-2");
  assert.equal(entries[0].status, "running");
  assert.equal(entries[0].description, "T");
});

test("derive: 非交互回执（The async run is detached.）同样识别", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "worker", task: "T" }, timestamp: T0 }),
    toolResultEntry({ toolCallId: CALL_ID, text: asyncReceipt({ interactive: false }), timestamp: T1 }),
  ]);
  assert.equal(entries[0].id, ASYNC_ID);
  assert.equal(entries[0].status, "running");
});

test("derive: 无 asyncId 的回执（如 external-job follow-up）保持 toolCallId 键 running", () => {
  const receipt = "Started external-job follow-up for run-1.\nFollow-up run: run-2\nAsync dir: /tmp/x\n\nThe async run is detached and running in the background.";
  const entries = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "worker", task: "T" }, timestamp: T0 }),
    toolResultEntry({ toolCallId: CALL_ID, text: receipt, timestamp: T1 }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, CALL_ID);
  assert.equal(entries[0].status, "running");
});

test("derive: 工作流回执（Async workflow [id]）重键 asyncId；重复回执幂等", () => {
  const wfReceipt = "Async workflow [wf-9]\n\nThe async run is detached and running in the background.";
  // 工作流派发（workflowScript）不推导——回执无对应条目时被忽略，不产生孤立行
  const orphan = deriveSubagentToolEntries([
    toolResultEntry({ toolCallId: "call_wf_x", text: wfReceipt, timestamp: T1 }),
  ]);
  assert.equal(orphan.length, 0);

  // 前台中途转后台（detach）的派发：同回执格式，重键生效
  const detached = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "worker", task: "T" }, timestamp: T0 }),
    toolResultEntry({ toolCallId: CALL_ID, text: wfReceipt, timestamp: T1 }),
    // 同一回执重放（fork 重放等）：幂等，不产生第二条
    toolResultEntry({ toolCallId: CALL_ID, text: wfReceipt, timestamp: T1 }),
  ]);
  assert.equal(detached.length, 1);
  assert.equal(detached[0].id, "wf-9");
  assert.equal(detached[0].status, "running");
});

test("deriveToolSubagentEntries: acp 与 subagent 两条链并存拼接", () => {
  const entries = deriveToolSubagentEntries([
    toolCallEntry({
      toolCallId: "acp_delegate_1", name: "acp_delegate",
      args: { agent: "worker", task: "acp task" }, timestamp: T0,
    }),
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "researcher", task: "sub task" }, timestamp: T0 }),
  ]);
  const ids = entries.map((e) => e.id).sort().join(",");
  assert.equal(ids, ["acp_delegate_1", CALL_ID].sort().join(","));
  const vias = entries.map((e) => e.via).sort().join(",");
  assert.equal(vias, ["acp-delegate", "pi-subagents-tool"].sort().join(","));
});

test("parseSubagentAsyncSnapshot: 快照行映射为条目（state → status）", () => {
  const snapshot = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1700000000000,
    runs: [
      { id: "async-1", kind: "async-job", label: "worker", state: "running", startedAt: 1700000001000 },
      { id: "async-2", kind: "async-job", label: "reviewer", state: "complete", startedAt: 1700000002000, endedAt: 1700000102000 },
      { id: "async-3", kind: "async-job", label: "scout", state: "failed" },
      { id: "async-4", kind: "async-job", label: "delegate", state: "partial" },
      { id: "async-5", kind: "async-job", label: "planner", state: "stopped" },
      { id: "async-6", kind: "async-job", state: "running" }, // 无 label
    ],
  };
  const entries = parseSubagentAsyncSnapshot([
    "其他无关行",
    `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`,
  ]);
  assert.equal(entries.length, 6);
  assert.equal(entries[0].status, "running");
  assert.equal(entries[1].status, "completed");
  assert.equal(entries[1].completedAt, 1700000102000);
  assert.equal(entries[2].status, "error");
  // partial（部分失败）按失败类呈现
  assert.equal(entries[3].status, "error");
  assert.equal(entries[4].status, "stopped");
  // 无 label 回退 "subagent"
  assert.equal(entries[5].type, "subagent");
  for (const entry of entries) {
    assert.equal(entry.source, "bridge");
    assert.equal(entry.via, "pi-subagents-tool");
  }
});

test("parseSubagentAsyncSnapshot: 非快照载荷/损坏 JSON/空输入 fail-soft", () => {
  // VM realm 数组原型不同，deepEqual 不可用
  assert.equal(parseSubagentAsyncSnapshot(undefined).length, 0);
  assert.equal(parseSubagentAsyncSnapshot([]).length, 0);
  assert.equal(parseSubagentAsyncSnapshot(["PI_SUBAGENT_ASYNC_JSON:not-json{"]).length, 0);
  assert.equal(parseSubagentAsyncSnapshot([
    `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: "other" })}`,
  ]).length, 0);
});
