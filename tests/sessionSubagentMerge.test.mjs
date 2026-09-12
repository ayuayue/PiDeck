/**
 * useSessionSubagents.mergeSubagentEntries 三源合并行为测试：
 * - record 为底座，桥接运行中覆写
 * - 桥接 0 默认值不得覆盖 record 真实 toolUses/tokens
 * - record 终态不被桥接倒覆
 * - 桥接独有条目保留
 * - applyAsyncSnapshotEntries：async widget 快照叠加，同 id 补充 description
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { mergeSubagentEntries, applyAsyncSnapshotEntries } = loadTsCommonJs(
  "src/renderer/src/hooks/useSessionSubagents.ts",
  {
    stubs: {
      jotai: { useAtomValue: () => undefined },
      react: {
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useState: (initial) => [initial, () => {}],
      },
      "../desktopApi": {
        desktopApi: { sessions: { listSessionSubagents: async () => [] } },
      },
      "../atoms": { sessionRuntimeUiBySessionIdAtomFamily: () => undefined },
    },
  },
);

function record(overrides) {
  return {
    id: "a1",
    type: "Explore",
    description: "d",
    status: "completed",
    source: "record",
    toolUses: 5,
    tokens: 300,
    startedAt: 1700000000000,
    ...overrides,
  };
}

function bridgeLine(agents) {
  return [
    JSON.stringify({ v: 1, kind: "snapshot", pluginActive: true, agents }),
  ];
}

test("merge: bridge 0 defaults do not clobber record toolUses/tokens", () => {
  const { merged } = mergeSubagentEntries(
    [record({ status: "running" })],
    bridgeLine([{ id: "a1", type: "Explore", description: "d", status: "running", toolUses: 0, tokens: 0 }]),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].toolUses, 5);
  assert.equal(merged[0].tokens, 300);
  assert.equal(merged[0].status, "running");
});

test("merge: bridge positive counts update record while running", () => {
  const { merged } = mergeSubagentEntries(
    [record({ status: "running", toolUses: 2 })],
    bridgeLine([{ id: "a1", type: "Explore", description: "d", status: "running", toolUses: 7, tokens: 80 }]),
  );
  assert.equal(merged[0].toolUses, 7);
  assert.equal(merged[0].tokens, 80);
});

test("merge: terminal record status is never overwritten by bridge", () => {
  const { merged } = mergeSubagentEntries(
    [record({ status: "completed", toolUses: 5 })],
    bridgeLine([{ id: "a1", type: "Explore", description: "d", status: "running", toolUses: 9 }]),
  );
  assert.equal(merged[0].status, "completed");
  assert.equal(merged[0].toolUses, 5);
});

test("merge: no bridge snapshot → pluginActive undefined (three-state)", () => {
  const { merged, pluginActive } = mergeSubagentEntries(
    [record({ id: "a1" })],
    undefined,
  );
  // 无桥接快照（历史会话/扩展未推送）≠ 插件不在位：UI 应显示中性空态而非“未检测到插件”
  assert.equal(merged.length, 1);
  assert.equal(pluginActive, undefined);
});

test("merge: bridge snapshot with pluginActive false stays false", () => {
  const { merged, pluginActive } = mergeSubagentEntries(
    [],
    [JSON.stringify({ v: 1, kind: "snapshot", pluginActive: false, agents: [] })],
  );
  assert.equal(merged.length, 0);
  assert.equal(pluginActive, false);
});

test("merge: bridge-only entries are kept (not yet persisted)", () => {
  const { merged, pluginActive } = mergeSubagentEntries(
    [],
    bridgeLine([{ id: "b2", type: "code", description: "new", status: "running", toolUses: 1 }]),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "b2");
  assert.equal(merged[0].source, "bridge");
  assert.equal(pluginActive, true);
});

test("merge: active entries sort before terminal entries", () => {
  const { merged } = mergeSubagentEntries(
    [record({ id: "done", status: "completed", startedAt: 1700000005000 })],
    bridgeLine([{ id: "live", type: "code", description: "d", status: "running", startedAt: 1700000001000 }]),
  );
  assert.equal(merged[0].id, "live");
  assert.equal(merged[1].id, "done");
});

/* ------------------------------------------------------------------ */
/* applyAsyncSnapshotEntries：nicobailon subagent-async widget 叠加      */
/* ------------------------------------------------------------------ */

/** 主进程派发回执推导的条目：id=asyncId，携带 args.task 描述 */
function derivedAsync(overrides) {
  return {
    id: "fde17407-e9ba-4c52-b183-bec15a8a2ea6",
    type: "worker",
    description: "测试 shell 防线是否对子代理生效",
    status: "running",
    source: "toolcall",
    via: "pi-subagents-tool",
    startedAt: 1700000000000,
    ...overrides,
  };
}

/** widget 快照条目：无 task 文本（description 为空） */
function widgetAsync(overrides) {
  return {
    id: "fde17407-e9ba-4c52-b183-bec15a8a2ea6",
    type: "worker",
    description: "",
    status: "running",
    source: "bridge",
    via: "pi-subagents-tool",
    startedAt: 1700000000000,
    ...overrides,
  };
}

test("applyAsyncSnapshot: 快照条目补充同 id 推导条目的 description", () => {
  const merged = applyAsyncSnapshotEntries(
    [derivedAsync()],
    [widgetAsync()],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].description, "测试 shell 防线是否对子代理生效");
  // 状态以快照为准（运行态实时真源）
  assert.equal(merged[0].status, "running");
  assert.equal(merged[0].source, "bridge");
});

test("applyAsyncSnapshot: 快照状态更新覆盖推导条目，description 仍保留", () => {
  const merged = applyAsyncSnapshotEntries(
    [derivedAsync({ status: "running" })],
    [widgetAsync({ status: "completed", completedAt: 1700000100000 })],
  );
  assert.equal(merged[0].status, "completed");
  assert.equal(merged[0].completedAt, 1700000100000);
  assert.equal(merged[0].description, "测试 shell 防线是否对子代理生效");
});

test("applyAsyncSnapshot: 快照自带 description 时不被推导条目覆盖", () => {
  const merged = applyAsyncSnapshotEntries(
    [derivedAsync({ description: "推导文本" })],
    [widgetAsync({ description: "快照文本" })],
  );
  assert.equal(merged[0].description, "快照文本");
});

test("applyAsyncSnapshot: 空快照原样返回；纯快照条目保留；无描述补充时保持空", () => {
  const existing = [derivedAsync()];
  assert.equal(applyAsyncSnapshotEntries(existing, []), existing);

  // 快照独有条目（推导侧还没拉到/无对应派发）：原样保留
  const merged = applyAsyncSnapshotEntries([], [widgetAsync({ id: "run-only" })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "run-only");
  assert.equal(merged[0].description, "");

  // 同 id 但推导条目也无描述：保持空，不造 undefined
  const noDesc = applyAsyncSnapshotEntries(
    [derivedAsync({ description: "" })],
    [widgetAsync()],
  );
  assert.equal(noDesc[0].description, "");
});
