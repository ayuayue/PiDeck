import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);

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
  return compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": compileModule(
      "src/renderer/src/utils/agentRuntimeState.ts",
    ),
    "../utils/sessionRecordIdentity": compileModule(
      "src/renderer/src/utils/sessionRecordIdentity.ts",
    ),
    "../utils/liveTextHandoff": compileModule(
      "src/renderer/src/utils/liveTextHandoff.ts",
    ),
    // session-atoms 现依赖 ./outlineRevision（输出修订），loader 缺此 stub 时
    // 编译后 require 回落到 nodeRequire 解析 .ts 失败，拖垮整组用例。
    "./outlineRevision": compileModule(
      "src/renderer/src/atoms/outlineRevision.ts",
    ),
    "./outlineProjectionCache": compileModule(
      "src/renderer/src/atoms/outlineProjectionCache.ts",
    ),
  });
}

function event(overrides = {}) {
  return {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "request-a",
      method: "confirm",
      title: "Continue?",
    },
    ...overrides,
  };
}

test("Session UI requests and widgets are stored under the generation envelope", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, event());
  store.set(atoms.applySessionRuntimeEventAtom, event({
    payload: {
      agentId: "agent-a",
      requestId: "widget-a",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["Step 1"],
    },
  }));

  const ui = store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"];
  assert.equal(ui.agentId, "agent-a");
  assert.equal(ui.runtimeGeneration, 1);
  assert.equal(ui.requests["request-a"].status, "pending");
  assert.deepEqual(ui.widgets.plan, ["Step 1"]);
});

test("batch Ask Question envelopes retain sanitized tab data in the runtime UI", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, event({
    payload: {
      agentId: "agent-a",
      requestId: "batch-a",
      method: "batch_ask",
      title: "",
      batchReview: true,
      batchQuestions: [
        {
          id: "runtime",
          type: "select",
          question: "Which runtime?",
          options: [
            { label: "Node.js", value: "node", description: "Recommended" },
            "Python",
            { invalid: true },
          ],
          allowOther: true,
        },
        {
          id: "package-manager",
          type: "select",
          question: "Which package manager?",
          options: ["npm"],
          allowOther: false,
        },
      ],
    },
  }));

  const request = store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"].requests["batch-a"].request;
  assert.equal(request.method, "batch_ask");
  assert.equal(request.title, "");
  assert.equal(request.batchReview, true);
  assert.deepEqual(JSON.parse(JSON.stringify(request.batchQuestions)), [{
    id: "runtime",
    type: "select",
    question: "Which runtime?",
    options: [
      { label: "Node.js", value: "node", description: "Recommended" },
      "Python",
    ],
    allowOther: true,
  }, {
    id: "package-manager",
    type: "select",
    question: "Which package manager?",
    options: ["npm"],
    allowOther: false,
  }]);
});

test("renderer claim rejects stale generation and duplicate UI responses", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, event());

  const stale = store.set(atoms.claimSessionRuntimeUiResponseAtom, {
    sessionId: "session-a",
    requestId: "request-a",
    agentId: "agent-a",
    runtimeGeneration: 0,
  });
  const accepted = store.set(atoms.claimSessionRuntimeUiResponseAtom, {
    sessionId: "session-a",
    requestId: "request-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
  });
  const duplicate = store.set(atoms.claimSessionRuntimeUiResponseAtom, {
    sessionId: "session-a",
    requestId: "request-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
  });

  assert.equal(stale, false);
  assert.equal(accepted, true);
  assert.equal(duplicate, false);
});

test("closed runtime state clears all UI and rejects same-generation UI revival", () => {
  const atoms = loadAtoms();

  for (const status of ["closed"]) {
    const store = createStore();
    store.set(atoms.applySessionRuntimeEventAtom, event());
    store.set(atoms.claimSessionRuntimeUiResponseAtom, {
      sessionId: "session-a",
      requestId: "request-a",
      agentId: "agent-a",
      runtimeGeneration: 1,
    });
    store.set(atoms.applySessionRuntimeEventAtom, event({
      payload: {
        agentId: "agent-a",
        requestId: "widget-a",
        method: "setWidget",
        widgetKey: "plan",
        widgetLines: ["Step 1"],
      },
    }));
    store.set(atoms.applySessionRuntimeEventAtom, event({
      payload: {
        agentId: "agent-a",
        requestId: "notice-a",
        method: "notify",
        message: "Waiting",
      },
    }));
    store.set(atoms.applySessionRuntimeEventAtom, event({
      payload: {
        agentId: "agent-a",
        requestId: "editor-a",
        method: "set_editor_text",
        text: "draft",
      },
    }));

    store.set(atoms.applySessionRuntimeEventAtom, event({
      sourceChannel: "agents:state",
      payload: { id: "agent-a", status },
    }));
    store.set(atoms.applySessionRuntimeEventAtom, event({
      payload: {
        agentId: "agent-a",
        requestId: "late-request",
        method: "confirm",
        title: "Too late?",
      },
    }));
    store.set(atoms.applySessionRuntimeEventAtom, event({
      payload: {
        agentId: "agent-a",
        requestId: "late-widget",
        method: "setWidget",
        widgetKey: "late",
        widgetLines: ["stale"],
      },
    }));

    const ui = store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"];
    assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].status, status);
    assert.equal(ui.agentId, "agent-a");
    assert.equal(ui.runtimeGeneration, 1);
    assert.deepEqual({ ...ui.requests }, {});
    assert.deepEqual({ ...ui.widgets }, {});
    assert.equal(ui.notification, undefined);
    assert.equal(ui.editorText, undefined);
  }
});

test("model error keeps same-generation UI requests available for recovery", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, event());
  store.set(atoms.applySessionRuntimeEventAtom, event({
    sourceChannel: "agents:state",
    payload: { id: "agent-a", status: "error" },
  }));
  store.set(atoms.applySessionRuntimeEventAtom, event({
    payload: {
      agentId: "agent-a",
      requestId: "recovery-request",
      method: "confirm",
      title: "Recover from the model error?",
    },
  }));

  const ui = store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"];
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].status, "error");
  assert.equal(ui.requests["request-a"].status, "pending");
  assert.equal(ui.requests["recovery-request"].status, "pending");
});

test("renderer rollback restores only the current responding envelope", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const envelope = {
    sessionId: "session-a",
    requestId: "request-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
  };
  store.set(atoms.applySessionRuntimeEventAtom, event());
  const input = {
    ...envelope,
    request: store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"].requests["request-a"].request,
  };
  assert.equal(store.set(atoms.claimSessionRuntimeUiResponseAtom, input), true);

  assert.equal(store.set(atoms.rollbackSessionRuntimeUiResponseAtom, {
    ...input,
    runtimeGeneration: 0,
  }), false);
  assert.equal(
    store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"].requests["request-a"].status,
    "responding",
  );
  assert.equal(store.set(atoms.rollbackSessionRuntimeUiResponseAtom, input), true);
  assert.equal(
    store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"].requests["request-a"].status,
    "pending",
  );
  assert.equal(store.set(atoms.claimSessionRuntimeUiResponseAtom, input), true);
  assert.equal(store.set(atoms.claimSessionRuntimeUiResponseAtom, input), false);
});

test("late rollback cannot reopen completed or replacement requests", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const envelope = {
    sessionId: "session-a",
    requestId: "request-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
  };
  store.set(atoms.applySessionRuntimeEventAtom, event());
  const originalRequest = store.get(
    atoms.sessionRuntimeUiByIdAtom,
  )["session-a"].requests["request-a"].request;
  const input = { ...envelope, request: originalRequest };
  store.set(atoms.claimSessionRuntimeUiResponseAtom, input);
  store.set(atoms.applySessionRuntimeEventAtom, event({
    payload: { agentId: "agent-a", requestId: "request-a", completed: true },
  }));

  assert.equal(store.set(atoms.rollbackSessionRuntimeUiResponseAtom, input), false);
  assert.equal(
    store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"].requests["request-a"].status,
    "completed",
  );

  store.set(atoms.applySessionRuntimeEventAtom, event({
    payload: {
      agentId: "agent-a",
      requestId: "request-a",
      method: "input",
      title: "Replacement",
    },
  }));
  const replacementRequest = store.get(
    atoms.sessionRuntimeUiByIdAtom,
  )["session-a"].requests["request-a"].request;
  assert.equal(store.set(atoms.claimSessionRuntimeUiResponseAtom, {
    ...envelope,
    request: replacementRequest,
  }), true);
  assert.equal(store.set(atoms.rollbackSessionRuntimeUiResponseAtom, input), false);
  assert.equal(
    store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"].requests["request-a"].status,
    "responding",
  );
});

test("a newer binding clears old requests and ignores late completion", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, event());
  store.set(atoms.applySessionRuntimeEventAtom, event({
    agentId: "agent-b",
    runtimeGeneration: 2,
    sourceChannel: "agents:state",
    payload: { id: "agent-b", status: "idle" },
  }));
  store.set(atoms.applySessionRuntimeEventAtom, event({
    payload: { agentId: "agent-a", requestId: "request-a", completed: true },
  }));

  const ui = store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"];
  assert.equal(ui.agentId, "agent-b");
  assert.equal(ui.runtimeGeneration, 2);
  assert.equal(ui.requests["request-a"], undefined);
  assert.equal(store.set(atoms.rollbackSessionRuntimeUiResponseAtom, {
    sessionId: "session-a",
    requestId: "request-a",
    agentId: "agent-a",
    runtimeGeneration: 1,
  }), false);
});

test("detach envelope clears the agent identity and all runtime UI", () => {
  const atoms = loadAtoms();
  const store = createStore();
  store.set(atoms.applySessionRuntimeEventAtom, event());
  store.set(atoms.applySessionRuntimeEventAtom, event({
    payload: {
      agentId: "agent-a",
      requestId: "widget-a",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["Step 1"],
    },
  }));
  store.set(atoms.applySessionRuntimeEventAtom, event({
    kind: "detach",
    runtimeGeneration: 2,
    sourceChannel: "sessions:runtime-detach",
    payload: null,
  }));

  const runtime = store.get(atoms.sessionRuntimeByIdAtom)["session-a"];
  assert.equal(runtime.status, "detached");
  assert.equal(runtime.agentId, undefined);
  assert.equal(runtime.state, undefined);
  assert.equal(store.get(atoms.sessionRuntimeUiByIdAtom)["session-a"], undefined);
});
