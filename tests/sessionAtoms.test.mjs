import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Date,
    Set,
  }, { filename: filePath });
  return module.exports;
}

function loadAtoms() {
  const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
  const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
  const sessions = compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": runtimeState,
    "../utils/sessionRecordIdentity": sessionRecordIdentity,
  });
  const composer = compileModule("src/renderer/src/atoms/composer-atoms.ts", {
    "./session-atoms": sessions,
  });
  return { ...sessions, ...composer };
}

function session(id, projectId = "project-1", overrides = {}) {
  return {
    id,
    projectId,
    title: id,
    source: "pi",
    environment: "native",
    preview: "",
    messageCount: 0,
    status: "draft",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("stores catalog records and selection by stable session ID", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-1",
    sessions: [session("session-a"), session("session-b")],
  });
  store.set(atoms.currentSessionIdAtom, "session-b");
  assert.equal(store.get(atoms.currentSessionAtom).id, "session-b");
  assert.equal(store.get(atoms.sessionIdsByProjectAtom)["project-1"].join(","), "session-a,session-b");
});

test("keeps catalog atom identities stable when polling returns equivalent records", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-1",
    sessions: [session("session-a"), session("session-b")],
  });
  const recordsBefore = store.get(atoms.sessionRecordsAtom);
  const idsBefore = store.get(atoms.sessionIdsByProjectAtom);

  // Session scanners allocate fresh objects on every poll; equal values must not redraw the sidebar.
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-1",
    sessions: [session("session-a"), session("session-b")],
  });

  assert.equal(store.get(atoms.sessionRecordsAtom), recordsBefore);
  assert.equal(store.get(atoms.sessionIdsByProjectAtom), idsBefore);

  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-1",
    sessions: [session("session-a"), session("session-b", "project-1", { updatedAt: 2 })],
  });
  assert.notEqual(store.get(atoms.sessionRecordsAtom), recordsBefore);
  assert.notEqual(store.get(atoms.sessionIdsByProjectAtom), idsBefore);
});

test("keeps only the 20 most recently written session message caches", () => {
  const atoms = loadAtoms();
  const store = createStore();
  for (let index = 0; index < 21; index += 1) {
    store.set(atoms.cacheSessionMessagesAtom, {
      sessionId: `session-${index}`,
      messages: [{ id: `message-${index}`, role: "user", text: String(index) }],
      source: "disk",
    });
  }
  const cache = store.get(atoms.sessionMessagesCacheAtom);
  assert.equal(Object.keys(cache).length, 20);
  assert.equal(cache["session-0"], undefined);
  assert.equal(cache["session-20"].messages[0].text, "20");
});

test("does not let a late disk response overwrite newer runtime messages", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    messages: [{ id: "runtime", role: "assistant", text: "live" }],
    source: "runtime",
  });
  const applied = store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    messages: [{ id: "disk", role: "assistant", text: "stale" }],
    source: "disk",
    expectedRevision: 0,
  });
  assert.equal(applied, false);
  assert.equal(
    store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages[0].text,
    "live",
  );
});

test("routes runtime payloads into session-keyed messages and state", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
    sourceChannel: "agents:state",
    payload: { id: "agent-a", status: "running" },
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
    sourceChannel: "agents:message",
    payload: { agentId: "agent-a", messages: [{ id: "m1", role: "user", text: "hello" }] },
  });
  const runtime = store.get(atoms.sessionRuntimeByIdAtom)["session-a"];
  assert.equal(runtime.agentId, "agent-a");
  assert.equal(runtime.status, "running");
  assert.equal(
    store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages[0].text,
    "hello",
  );
});

test("ignores late events from an older runtime generation", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-old",
    runtimeGeneration: 1,
    sourceChannel: "agents:message",
    payload: {
      messages: [{ id: "old", role: "assistant", text: "old runtime" }],
    },
  });
  store.set(atoms.bindSessionRuntimeAtom, {
    sessionId: "session-a",
    agentId: "agent-new",
    runtimeGeneration: 2,
    status: "idle",
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-old",
    runtimeGeneration: 1,
    sourceChannel: "agents:message",
    payload: {
      messages: [{ id: "late", role: "assistant", text: "late old runtime" }],
    },
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-old",
    runtimeGeneration: 2,
    sourceChannel: "agents:state",
    payload: { status: "closed" },
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-new",
    runtimeGeneration: 2,
    sourceChannel: "agents:message",
    payload: {
      messages: [{ id: "new", role: "assistant", text: "new runtime" }],
    },
  });

  const runtime = store.get(atoms.sessionRuntimeByIdAtom)["session-a"];
  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages;
  assert.equal(runtime.agentId, "agent-new");
  assert.equal(runtime.runtimeGeneration, 2);
  assert.equal(runtime.status, "idle");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "new runtime");
});

test("anonymous detach clears its record and rejects a late catalog refresh", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const anonymous = session("anonymous-1", "project-1", {
    noSession: true,
    status: "active",
  });
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-1",
    sessions: [anonymous],
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: anonymous.id,
    agentId: "anonymous-agent",
    runtimeGeneration: 1,
    sourceChannel: "agents:state",
    payload: {
      id: "anonymous-agent",
      projectId: "project-1",
      cwd: "C:/project",
      status: "idle",
      createdAt: 1,
      noSession: true,
    },
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    kind: "detach",
    sessionId: anonymous.id,
    agentId: "anonymous-agent",
    runtimeGeneration: 1,
    sourceChannel: "sessions:runtime-detach",
    payload: null,
  });
  assert.equal(store.get(atoms.sessionRecordsAtom)[anonymous.id], undefined);
  assert.equal(store.get(atoms.discardedTransientSessionIdsAtom).has(anonymous.id), true);

  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-1",
    sessions: [anonymous],
  });
  assert.equal(store.get(atoms.sessionRecordsAtom)[anonymous.id], undefined);
  assert.deepEqual(store.get(atoms.sessionIdsByProjectAtom)["project-1"], []);
});

test("incremental message flush merges tail upserts and discards non-contiguous deltas", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const emit = (payload) =>
    store.set(atoms.applySessionRuntimeEventAtom, {
      sessionId: "session-a",
      agentId: "agent-a",
      runtimeGeneration: 1,
      sourceChannel: "agents:message",
      payload,
    });
  const readMessages = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages;

  // 1) 全量基线（终态校准形态）
  emit({ agentId: "agent-a", messages: [
    { id: "m1", role: "user", text: "q" },
    { id: "m2", role: "assistant", text: "a" },
  ] });
  assert.equal(readMessages().length, 2);

  // 2) 纯 append：upsertFrom == 旧长度 → 尾部追加
  emit({ agentId: "agent-a", upsertFrom: 2, totalLength: 3, messages: [
    { id: "m3", role: "tool", text: "tool" },
  ] });
  // vm realm 数组与字面量数组原型不同，deepStrictEqual 会误判，展开为本 realm 数组再比
  assert.deepEqual([...readMessages().map((m) => m.id)], ["m1", "m2", "m3"]);

  // 3) 尾部替换：upsertFrom < 旧长度 → 从该处起覆盖（流式 delta 形态）
  emit({ agentId: "agent-a", upsertFrom: 2, totalLength: 3, messages: [
    { id: "m3", role: "tool", text: "tool-done" },
  ] });
  assert.equal(readMessages()[2].text, "tool-done");
  assert.equal(readMessages().length, 3);

  // 4) 长度不连续（upsertFrom > 旧长度，漏了事件）→ 丢弃，等终态全量
  emit({ agentId: "agent-a", upsertFrom: 9, totalLength: 10, messages: [
    { id: "m10", role: "assistant", text: "lost" },
  ] });
  assert.equal(readMessages().length, 3, "non-contiguous upsert must be discarded");

  // 5) totalLength 校验失败（本地合并后与主进程不一致）→ 丢弃
  emit({ agentId: "agent-a", upsertFrom: 2, totalLength: 99, messages: [
    { id: "m3", role: "tool", text: "bad" },
  ] });
  assert.equal(readMessages()[2].text, "tool-done", "totalLength mismatch must be discarded");

  // 6) 终态全量校准：一次 full 覆盖所有中间态
  emit({ agentId: "agent-a", messages: [
    { id: "m1", role: "user", text: "q" },
    { id: "m2", role: "assistant", text: "final" },
  ] });
  assert.deepEqual([...readMessages().map((m) => m.text)], ["q", "final"]);
});

test("incremental upsert is ignored while cache holds disk-sourced messages", () => {
  const atoms = loadAtoms();
  const store = createStore();
  // 磁盘分页来源的缓存（激活前磁盘加载）：runtime 增量不可合入，防止错乱
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    messages: [{ id: "d1", role: "user", text: "disk" }],
    source: "disk",
    page: { total: 1, nextBefore: null },
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
    sourceChannel: "agents:message",
    payload: { agentId: "agent-a", upsertFrom: 0, totalLength: 2, messages: [
      { id: "r1", role: "user", text: "runtime" },
      { id: "r2", role: "assistant", text: "runtime-a" },
    ] },
  });
  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
  assert.equal(entry.source, "disk", "disk entry must not be clobbered by runtime upsert");
  assert.equal(entry.messages.length, 1);

  // 随后的全量（激活完成）可以正常接管
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
    sourceChannel: "agents:message",
    payload: { agentId: "agent-a", messages: [
      { id: "r1", role: "user", text: "runtime" },
    ] },
  });
  const next = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
  assert.equal(next.source, "runtime");
  assert.equal(next.messages[0].text, "runtime");
});

test("isolates composer state and only clears the submitted snapshot", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.setSessionDraftAtom, { sessionId: "session-a", value: "first" });
  store.set(atoms.setSessionDraftAtom, { sessionId: "session-b", value: "second" });
  store.set(atoms.currentSessionIdAtom, "session-a");
  assert.equal(store.get(atoms.currentSessionDraftAtom), "first");

  store.set(atoms.setSessionDraftAtom, { sessionId: "session-a", value: "new edit" });
  store.set(atoms.clearSessionComposerSnapshotAtom, {
    sessionId: "session-a",
    draft: "first",
    attachments: [],
  });
  assert.equal(store.get(atoms.sessionDraftByIdAtom)["session-a"], "new edit");
  assert.equal(store.get(atoms.sessionDraftByIdAtom)["session-b"], "second");
});
