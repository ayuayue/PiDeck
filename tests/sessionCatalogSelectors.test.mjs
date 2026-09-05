import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

function compileModule(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => imports[specifier] ?? nodeRequire(specifier),
    Date,
    Set,
  }, { filename: filePath });
  return module.exports;
}

function loadAtoms() {
  const sessions = compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": compileModule(
      "src/renderer/src/utils/agentRuntimeState.ts",
    ),
    "../utils/sessionRecordIdentity": compileModule(
      "src/renderer/src/utils/sessionRecordIdentity.ts",
    ),
    "../utils/liveTextHandoff": compileModule(
      "src/renderer/src/utils/liveTextHandoff.ts",
    ),
    "./outlineRevision": compileModule(
      "src/renderer/src/atoms/outlineRevision.ts",
    ),
    "./outlineProjectionCache": compileModule(
      "src/renderer/src/atoms/outlineProjectionCache.ts",
    ),
  });
  const selectors = compileModule("src/renderer/src/atoms/session-selectors.ts", {
    "./session-atoms": sessions,
    // 展示名拼装与 fork 标记相关，测试不关心文案，直接透传即可。
    "../utils/sessionDisplayName": { sessionDisplayName: (title) => title },
  });
  return { ...sessions, ...selectors };
}

function session(id, projectId, updatedAt = 1) {
  return {
    id,
    projectId,
    title: id,
    source: "pi",
    environment: "native",
    filePath: `C:/sessions/${id}.jsonl`,
    preview: id,
    messageCount: 1,
    status: "active",
    createdAt: 1,
    updatedAt,
  };
}

test("catalog selectors expose read-only project summaries from the single record owner", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  const summaries = store.get(atoms.sessionSummariesByProjectIdAtomFamily("project-a"));
  assert.equal(summaries[0].id, "session-a");
  assert.equal(summaries[0].name, "session-a");
});

test("background Session patches do not update current Timeline/runtime selector values", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-b",
    sessions: [session("session-b", "project-b")],
  });
  store.set(atoms.currentSessionIdAtom, "session-a");
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    messages: [{ id: "m-a", role: "assistant", text: "stable" }],
    source: "disk",
  });

  const messagesBefore = store.get(atoms.currentSessionMessagesAtom);
  const runtimeBefore = store.get(atoms.currentSessionRuntimeAtom);
  let messageNotifications = 0;
  let runtimeNotifications = 0;
  const offMessages = store.sub(atoms.currentSessionMessagesAtom, () => {
    messageNotifications += 1;
  });
  const offRuntime = store.sub(atoms.currentSessionRuntimeAtom, () => {
    runtimeNotifications += 1;
  });

  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-b",
    sessions: [session("session-b", "project-b", 2)],
  });
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-b",
    agentId: "agent-b",
    runtimeGeneration: 1,
    sourceChannel: "agents:state",
    payload: { id: "agent-b", status: "running" },
  });

  assert.equal(store.get(atoms.currentSessionMessagesAtom), messagesBefore);
  assert.equal(store.get(atoms.currentSessionRuntimeAtom), runtimeBefore);
  assert.equal(messageNotifications, 0);
  assert.equal(runtimeNotifications, 0);
  offMessages();
  offRuntime();
});

test("runtime agent binding selects the authoritative Session despite path identity collisions", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const sharedPath = "C:/sessions/shared.jsonl";
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [
      {
        ...session("session-native", "project-a"),
        filePath: sharedPath,
        source: "pi",
        environment: "native",
      },
      {
        ...session("session-wsl", "project-a"),
        filePath: sharedPath,
        source: "codex",
        environment: "wsl",
        wslDistro: "Ubuntu-24.04",
      },
    ],
  });
  store.set(atoms.bindSessionRuntimeAtom, {
    sessionId: "session-native",
    agentId: "agent-bound",
    runtimeGeneration: 3,
  });
  store.set(atoms.bindSessionRuntimeAtom, {
    sessionId: "session-wsl",
    agentId: "agent-bound",
    runtimeGeneration: 4,
  });

  assert.equal(
    store.get(atoms.sessionIdByRuntimeAgentIdAtomFamily("agent-bound")),
    "session-wsl",
  );
  assert.equal(
    store.get(atoms.sessionIdByRuntimeAgentIdAtomFamily("agent-unbound")),
    undefined,
  );
});

test("focus selection is synchronous so rapid targets cannot be overwritten by stale catalog work", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.bindSessionRuntimeAtom, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
  });
  store.set(atoms.bindSessionRuntimeAtom, {
    sessionId: "session-b",
    agentId: "agent-b",
    runtimeGeneration: 1,
  });

  let currentSessionId;
  const focus = (agentId) => {
    currentSessionId = store.get(atoms.sessionIdByRuntimeAgentIdAtomFamily(agentId));
  };
  focus("agent-a");
  focus("agent-b");
  assert.equal(currentSessionId, "session-b");
  focus("agent-external");
  assert.equal(currentSessionId, undefined);

  const focusStart = appSource.indexOf("onFocusTarget: (target: { sessionId: string }) => {");
  const focusEnd = appSource.indexOf("\n    },", focusStart);
  const focusSource = appSource.slice(focusStart, focusEnd);
  assert.match(focusSource, /store\.get\(sessionRecordByIdAtomFamily\(target\.sessionId\)\)/);
  assert.doesNotMatch(focusSource, /sessionIdByRuntimeAgentIdAtomFamily|target\.agentId/);
  assert.doesNotMatch(focusSource, /listCatalog|isSameSessionPath|async|\.then\(/);
});
