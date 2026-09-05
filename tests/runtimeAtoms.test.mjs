import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

function session(id, projectId, title = id) {
  return {
    id,
    projectId,
    title,
    environment: "native",
    source: "pi",
    createdAt: 1,
    updatedAt: 1,
  };
}

function runtime(sessionId, agentId, projectId, generation = 1, status = "idle") {
  return {
    sessionId,
    agentId,
    runtimeGeneration: generation,
    projectId,
    cwd: `C:/${projectId}`,
    status,
    createdAt: generation,
  };
}

function runtimeEvent(sessionId, agentId, generation, sourceChannel, payload, kind = "event") {
  return {
    kind,
    sessionId,
    agentId,
    runtimeGeneration: generation,
    sourceChannel,
    payload,
  };
}

test("agent inventory is a read-only projection of canonical Session runtimes", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a", "Stable title")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
  ]);

  assert.equal(store.get(atoms.agentByIdAtomFamily("agent-a")).title, "Stable title");
  assert.equal(
    store.get(atoms.agentsByProjectIdAtomFamily("project-a")).map((agent) => agent.id).join(","),
    "agent-a",
  );
  assert.equal(atoms.replaceAgentInventoryAtom, undefined);
  assert.equal(atoms.upsertAgentInventoryAtom, undefined);
});

test("agent inventory keeps the same array when runtime identity is unchanged", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a", "Stable title")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
  ]);
  const first = store.get(atoms.agentInventoryAtom);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:state",
    {
      id: "agent-a",
      projectId: "project-a",
      cwd: "C:/project-a",
      title: "Stable title",
      status: "idle",
      createdAt: 1,
    },
  ));
  const second = store.get(atoms.agentInventoryAtom);
  // 无实质字段变化时不得换新数组：App 的 useEffect([agents]) / displayAgents
  // 会跟着每帧 setState，把设置弹层和关窗点死。
  assert.equal(second, first);
});

test("runtime capabilities merge in the canonical Session runtime without message data", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
  ]);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { modelName: "Model A", isStreaming: true } },
  ));
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { isExecutingTool: true } },
  ));

  const capability = store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-a"));
  assert.equal(capability.modelName, "Model A");
  assert.equal(capability.isStreaming, true);
  assert.equal(capability.isExecutingTool, true);
  assert.equal("messages" in capability, false);
  assert.equal(atoms.applyRuntimeCapabilityAtom, undefined);
});

test("project capability selectors ignore unrelated canonical Session updates", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-b",
    sessions: [session("session-b", "project-b")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
    runtime("session-b", "agent-b", "project-b"),
  ]);
  for (const [sessionId, agentId, modelName] of [
    ["session-a", "agent-a", "Model A"],
    ["session-b", "agent-b", "Model B"],
  ]) {
    store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
      sessionId,
      agentId,
      1,
      "agents:runtime-state",
      { agentId, state: { modelName } },
    ));
  }

  const projectAAtom = atoms.runtimeCapabilitiesByProjectIdAtomFamily("project-a");
  const before = store.get(projectAAtom);
  let notifications = 0;
  const unsubscribe = store.sub(projectAAtom, () => { notifications += 1; });

  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-b",
    "agent-b",
    1,
    "agents:runtime-state",
    { agentId: "agent-b", state: { isStreaming: true } },
  ));
  assert.equal(store.get(projectAAtom), before);
  assert.equal(notifications, 0);

  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { isStreaming: true } },
  ));
  assert.notEqual(store.get(projectAAtom), before);
  assert.equal(notifications, 1);
  unsubscribe();
});

test("replacement binding clears stale runtime state before new events arrive", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  // 旧绑定 agent-a（generation 1）带旧模型 state
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a", 1),
  ]);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { modelName: "Old Model", provider: "old" } },
  ));
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "Old Model");

  // 新绑定 agent-b（generation 2）attach：只推 agents:state（tab 无 state 字段），
  // 模拟懒启动后 applyPreferences 的 runtime-state 事件尚未到达的窗口期。
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    2,
    "agents:state",
    {
      id: "agent-b",
      projectId: "project-a",
      cwd: "C:/project-a",
      title: "replacement",
      status: "idle",
      createdAt: 2,
    },
  ));
  // bindingChanged 必须清空残留 state：底栏 state?.modelName 回退到 record，而不是旧模型。
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].agentId, "agent-b");
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state, undefined);

  // 新绑定收到 runtime-state 事件后 state 正常填充
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    2,
    "agents:runtime-state",
    { agentId: "agent-b", state: { modelName: "New Model", provider: "new" } },
  ));
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "New Model");
});

test("late events from runtime A cannot revive its inventory or capabilities after replacement B", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a", 2),
  ]);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    3,
    "agents:state",
    {
      id: "agent-b",
      projectId: "project-a",
      cwd: "C:/project-a",
      title: "replacement",
      status: "idle",
      createdAt: 3,
    },
  ));
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    3,
    "agents:runtime-state",
    { agentId: "agent-b", state: { modelName: "B", isStreaming: true } },
  ));

  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    2,
    "agents:state",
    { id: "agent-a", projectId: "project-a", cwd: "C:/project-a", title: "old", status: "closed", createdAt: 1 },
  ));
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    2,
    "agents:detach",
    undefined,
    "detach",
  ));

  assert.equal(store.get(atoms.agentInventoryAtom).map((agent) => agent.id).join(","), "agent-b");
  assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-a")), undefined);
  assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-b")).modelName, "B");
});

test("terminal status (error/closed) drops runtime state and rejects late runtime-state refills", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a", 1, "running"),
  ]);
  // 先填入运行时状态，模拟 agent 运行期 goal/todos/model 已就绪
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a", "agent-a", 1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { modelName: "Model A", isStreaming: true } },
  ));
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "Model A");

  // 进入终态：error。终态后 state 应被清空（仅保留 status 等轻量身份字段）。
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a", "agent-a", 1,
    "agents:state",
    { id: "agent-a", projectId: "project-a", cwd: "C:/project-a", title: "t", status: "error", createdAt: 1 },
  ));
  const terminal = store.get(atoms.sessionRuntimeByIdAtom)["session-a"];
  assert.equal(terminal.status, "error");
  assert.equal(terminal.state, undefined, "terminal status must drop runtime state");

  // 同绑定迟到的 runtime-state 事件不得把 state 填回（否则回收失效）。
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a", "agent-a", 1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { modelName: "Late Model" } },
  ));
  assert.equal(
    store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state,
    undefined,
    "late runtime-state must not revive state after terminal status",
  );
});

test("fork replacement detaches the origin session and binds the fork record to the same agent", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [
      session("session-origin", "project-a", "Origin"),
      session("session-fork", "project-a", "Fork"),
    ],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-origin", "agent-a", "project-a", 1, "running"),
  ]);
  // 主进程 fork 广播顺序：detach 旧绑定 → attach 新绑定（runtimeGeneration 递增）
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-origin", "agent-a", 1, "sessions:runtime-detach", null, "detach",
  ));
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-fork", "agent-a", 2, "agents:state",
    { id: "agent-a", projectId: "project-a", cwd: "C:/project-a", title: "Fork", status: "idle", createdAt: 2 },
  ));
  // 旧会话不再持有 live runtime（侧栏按历史行展示，不再显示运行中）；
  // detached 条目按设计丢弃 agentId（不保留可反查的活 agent 身份）
  const origin = store.get(atoms.sessionRuntimeByIdAtom)["session-origin"];
  assert.equal(origin.status, "detached");
  assert.equal(origin.agentId, undefined);
  // 同一 agent 换绑到 fork 记录
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-fork"].agentId, "agent-a");
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-fork"].status, "idle");
  // agent 清单只保留 fork 记录，且不会把旧会话视为 live
  const agents = store.get(atoms.agentInventoryAtom);
  assert.equal(agents.some((agent) => agent.id === "agent-a" && agent.sessionId === "session-origin"), false);
  assert.equal(agents.some((agent) => agent.id === "agent-a"), true);
});
