import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync("src/renderer/src/hooks/useRename.ts", "utf8");

function compileHook(reactStub, i18nStub) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "src/renderer/src/hooks/useRename.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "react") return reactStub;
      if (specifier === "../i18n") return i18nStub;
      if (specifier === "../rendererUtils") {
        // 项目重命名预填当前展示名；测试里直接用 name 即可
        return { displayProjectDirectoryName: (project) => project.name };
      }
      return {};
    },
  }, { filename: "src/renderer/src/hooks/useRename.ts" });
  return module.exports;
}

function createRenameHarness(i18nStub) {
  const states = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      states[index] ??= typeof initial === "function" ? initial() : initial;
      const setter = (next) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setter];
    },
  };
  const hooks = compileHook(react, i18nStub);
  function render(api) {
    cursor = 0;
    return hooks.useRename(api);
  }
  return { render, states };
}

function createDefaultApi(overrides = {}) {
  return {
    renameAgent: async () => ({ id: "agent-1", projectId: "proj-a", title: "Renamed", createdAt: Date.now(), cwd: "/tmp", status: "idle" }),
    renameSession: async () => undefined,
    renameProject: async (id, name) => [{ id, name, path: "/tmp", lastOpenedAt: Date.now() }],
    showToast: () => undefined,
    upsertAgent: () => undefined,
    refreshProjectSessions: async () => undefined,
    closeAgentMenu: undefined,
    ...overrides,
  };
}

function agentTab(overrides = {}) {
  return {
    id: "agent-1",
    projectId: "proj-a",
    cwd: "/tmp",
    title: "Original Agent",
    status: "idle",
    createdAt: Date.now(),
    ...overrides,
  };
}

function sessionSummary(overrides = {}) {
  return {
    id: "session-1",
    filePath: "/tmp/session.json",
    preview: "",
    updatedAt: Date.now(),
    messageCount: 0,
    name: "Original Session",
    ...overrides,
  };
}

// ── static source assertions ──

test("useRename sources track four state atoms and export a flat hook", () => {
  assert.match(source, /export function useRename/);
  assert.match(source, /useState<AgentTab/);
  assert.match(source, /useState<\{[\s\S]*?projectId: string;[\s\S]*?session: SessionSummary/);
  assert.match(source, /useState\(""\)/);
  assert.match(source, /useState\(false\)/);
  assert.match(source, /function openAgentRename/);
  assert.match(source, /function openSessionRename/);
  assert.match(source, /async function submitAgentRename/);
  assert.match(source, /async function submitSessionRename/);
});

// ── runtime logic ──

test("openAgentRename sets agentRenameTarget and agentRenameValue, clears session target", () => {
  const i18n = { t: (key) => key };
  const api = createDefaultApi();
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  const tab = agentTab({ title: "My Agent" });

  r.openAgentRename(tab);

  const r2 = harness.render(api);
  assert.equal(r2.agentRenameTarget?.id, "agent-1");
  assert.equal(r2.agentRenameValue, "My Agent");
  assert.equal(r2.sessionRenameTarget, null);
});

test("openAgentRename invokes closeAgentMenu before setting rename state", () => {
  const i18n = { t: (key) => key };
  let menuClosed = false;
  const api = createDefaultApi({ closeAgentMenu: () => { menuClosed = true; } });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openAgentRename(agentTab());

  assert.equal(menuClosed, true);
});

test("openSessionRename sets sessionRenameTarget with projectId and session, clears agent target", () => {
  const i18n = { t: (key) => key === "common.untitled" ? "Untitled" : key };
  const api = createDefaultApi();
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openSessionRename("proj-a", sessionSummary({ name: "My Session" }));

  const r2 = harness.render(api);
  assert.equal(r2.agentRenameTarget, null);
  assert.equal(r2.sessionRenameTarget?.projectId, "proj-a");
  assert.equal(r2.sessionRenameTarget?.session.id, "session-1");
  assert.equal(r2.agentRenameValue, "My Session");
});

test("openSessionRename falls back to common.untitled when session name is missing", () => {
  const i18n = { t: (key) => key === "common.untitled" ? "Untitled" : key };
  const api = createDefaultApi();
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openSessionRename("proj-a", sessionSummary({ name: undefined }));

  const r2 = harness.render(api);
  assert.equal(r2.agentRenameValue, "Untitled");
});

test("submitAgentRename updates the Session record, shows a toast, and refreshes sessions", async () => {
  const i18n = { t: (key) => key === "app.sessionRenamed" ? "Renamed!" : key };
  const calls = [];
  const api = createDefaultApi({
    renameAgent: async (id, name) => { calls.push(`renameAgent:${id}:${name}`); return agentTab({ id: "agent-1", title: name }); },
    upsertAgent: (tab) => { calls.push(`upsertAgent:${tab.title}`); },
    showToast: (msg) => { calls.push(`toast:${msg}`); },
    refreshProjectSessions: async (pid) => { calls.push(`refresh:${pid}`); },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openAgentRename(agentTab({ title: "Old Name" }));
  // re-render to get new closures that see the updated state
  const rBefore = harness.render(api);
  await rBefore.submitAgentRename();

  const r2 = harness.render(api);
  assert.equal(r2.agentRenameTarget, null);
  assert.equal(r2.sessionRenameTarget, null);
  assert.equal(r2.agentRenameValue, "");
  assert.deepEqual(calls, [
    "renameAgent:agent-1:Old Name",
    "toast:Renamed!",
    "refresh:proj-a",
  ]);
});

test("submitAgentRename trims whitespace and normalises internal spaces", async () => {
  const i18n = { t: (key) => key === "app.sessionRenamed" ? "Renamed!" : key };
  let submittedName;
  const api = createDefaultApi({
    renameAgent: async (id, name) => { submittedName = name; return agentTab({ id: "agent-1", title: name }); },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openAgentRename(agentTab({ title: "old" }));
  // Re-render, then use renameModalsProps to simulate typing whitespace
  const r2 = harness.render(api);
  r2.renameModalsProps.rename?.onValueChange("   new   name   ");

  // Re-render again so submitAgentRename closure sees the new agentRenameValue
  const r3 = harness.render(api);
  await r3.submitAgentRename();
  // .replace(/\s+/g, " ").trim() converts "   new   name   " → "new name"
  assert.equal(submittedName, "new name");
});

test("submitAgentRename shows validation toast when empty name", async () => {
  const i18n = { t: (key) => key === "app.sessionNameRequired" ? "Required!" : key };
  let toastMessage;
  const api = createDefaultApi({
    showToast: (msg) => { toastMessage = msg; },
    renameAgent: async () => { throw new Error("must not be called"); },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openAgentRename(agentTab({ title: "ok" }));
  const r2 = harness.render(api);
  r2.renameModalsProps.rename?.onValueChange("");

  // Re-render so submit see the empty value
  const r3 = harness.render(api);
  await r3.submitAgentRename();
  assert.equal(toastMessage, "Required!");
  // agentRenameTarget should still be set (not cleared on validation failure)
  const r4 = harness.render(api);
  assert.notEqual(r4.agentRenameTarget, null);
});

test("submitAgentRename shows error toast on API failure", async () => {
  const i18n = { t: (key, params) => key === "app.sessionRenameFailed" ? `Failed(${params.error})` : key };
  let toastMessage;
  const api = createDefaultApi({
    renameAgent: async () => { throw new Error("network error"); },
    showToast: (msg) => { toastMessage = msg; },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openAgentRename(agentTab({ title: "ok" }));
  const rBefore = harness.render(api);
  await rBefore.submitAgentRename();

  // error.message should appear somewhere in the toast
  assert.ok(toastMessage.includes("network error"), `expected toast to include error, got: ${toastMessage}`);
  // agentRenaming should be false after failure
  const r2 = harness.render(api);
  assert.equal(r2.agentRenaming, false);
});

test("submitSessionRename calls renameSession API, showToast, and refreshProjectSessions", async () => {
  const i18n = { t: (key) => key === "app.sessionRenamed" ? "Renamed!" : key };
  const calls = [];
  const api = createDefaultApi({
    renameSession: async (id, name) => { calls.push(`renameSession:${id}:${name}`); },
    showToast: (msg) => { calls.push(`toast:${msg}`); },
    refreshProjectSessions: async (pid) => { calls.push(`refresh:${pid}`); },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openSessionRename("proj-a", sessionSummary({ name: "My Session" }));
  const rBefore = harness.render(api);
  await rBefore.submitSessionRename();

  const r2 = harness.render(api);
  assert.equal(r2.sessionRenameTarget, null);
  assert.equal(r2.agentRenameValue, "");
  assert.deepEqual(calls, [
    "renameSession:session-1:My Session",
    "refresh:proj-a",
    "toast:Renamed!",
  ]);
});

test("submitSessionRename shows validation toast when empty name", async () => {
  const i18n = { t: (key) => key === "app.sessionNameRequired" ? "Required!" : key };
  let toastMessage;
  const api = createDefaultApi({
    showToast: (msg) => { toastMessage = msg; },
    renameSession: async () => { throw new Error("must not be called"); },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openSessionRename("proj-a", sessionSummary({ name: "ok" }));
  const r2 = harness.render(api);
  r2.renameModalsProps.rename?.onValueChange("");

  const r3 = harness.render(api);
  await r3.submitSessionRename();
  assert.equal(toastMessage, "Required!");
});

test("submitSessionRename shows error toast on API failure", async () => {
  const i18n = { t: (key, params) => key === "app.sessionRenameFailed" ? `Failed(${params.error})` : key };
  let toastMessage;
  const api = createDefaultApi({
    renameSession: async () => { throw new Error("timeout"); },
    showToast: (msg) => { toastMessage = msg; },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openSessionRename("proj-a", sessionSummary({ name: "ok" }));
  const rBefore = harness.render(api);
  await rBefore.submitSessionRename();

  assert.ok(toastMessage.includes("timeout"), `expected toast to include timeout, got: ${toastMessage}`);
  const r2 = harness.render(api);
  assert.equal(r2.agentRenaming, false);
});

test("agentRenaming is true during submit and false after completion", async () => {
  const i18n = { t: (key) => key };
  let resolveRename;
  const api = createDefaultApi({
    renameAgent: async () => new Promise((resolve) => { resolveRename = resolve; }),
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openAgentRename(agentTab({ title: "ok" }));
  const rBefore = harness.render(api);

  const submitPromise = rBefore.submitAgentRename();
  // agentRenaming should now be true — re-render to read updated state
  const rDuring = harness.render(api);
  assert.equal(rDuring.agentRenaming, true);

  resolveRename(agentTab({ title: "ok" }));
  await submitPromise;

  const rAfter = harness.render(api);
  assert.equal(rAfter.agentRenaming, false);
});

test("submitAgentRename returns early when agentRenameTarget is null", async () => {
  const i18n = { t: (key) => key };
  let renameCallCount = 0;
  const api = createDefaultApi({
    renameAgent: async () => { renameCallCount += 1; return agentTab({ title: "ok" }); },
  });
  const harness = createRenameHarness(i18n);

  // No rename target set → submit should return early without calling API
  const r = harness.render(api);
  await r.submitAgentRename();
  assert.equal(renameCallCount, 0);

  // After submit completes, agentRenameTarget is cleared; duplicate submit returns early
  r.openAgentRename(agentTab({ title: "ok" }));
  const rBefore = harness.render(api);
  await rBefore.submitAgentRename();
  assert.equal(renameCallCount, 1);

  // Try again — target was cleared by successful submit
  const rAfter = harness.render(api);
  await rAfter.submitAgentRename();
  assert.equal(renameCallCount, 1); // no additional call
});

test("renameModalsProps.rename is present when renaming agent", () => {
  const i18n = { t: (key) => key };
  const harness = createRenameHarness(i18n);

  // No rename target -> no modal props
  const r = harness.render(createDefaultApi());
  assert.equal(r.renameModalsProps.rename, undefined);

  // Agent rename target -> modal props with isAgent: true
  r.openAgentRename(agentTab({ title: "Agent" }));
  const r2 = harness.render(createDefaultApi());
  const agentProps = r2.renameModalsProps.rename;
  assert.equal(agentProps.kind, "agent");
  assert.equal(agentProps.value, "Agent");
  assert.equal(agentProps.saving, false);
  assert.equal(typeof agentProps.onValueChange, "function");
  assert.equal(typeof agentProps.onClose, "function");
  assert.equal(typeof agentProps.onSubmit, "function");
});

test("renameModalsProps.rename is present when renaming session", () => {
  const i18n = { t: (key) => key };
  const harness = createRenameHarness(i18n);

  const r = harness.render(createDefaultApi());
  r.openSessionRename("proj-a", sessionSummary({ name: "Session" }));
  const r2 = harness.render(createDefaultApi());
  const props = r2.renameModalsProps.rename;
  assert.equal(props.kind, "session");
  assert.equal(props.value, "Session");
  assert.equal(props.saving, false);
});

test("renameModalsProps.rename.onSubmit dispatches to correct submitter", async () => {
  const i18n = { t: (key) => key === "app.sessionRenamed" ? "Renamed!" : key };
  let agentRenameCalled = false;
  let sessionRenameCalled = false;
  const api = createDefaultApi({
    renameAgent: async () => { agentRenameCalled = true; return agentTab({ title: "ok" }); },
    renameSession: async () => { sessionRenameCalled = true; },
  });
  const harness = createRenameHarness(i18n);

  // Agent rename
  const r1 = harness.render(api);
  r1.openAgentRename(agentTab({ title: "Agent" }));
  const r1b = harness.render(api);
  await r1b.renameModalsProps.rename?.onSubmit();
  assert.equal(agentRenameCalled, true);
  assert.equal(sessionRenameCalled, false);

  // Session rename
  agentRenameCalled = false;
  const r2 = harness.render(api);
  r2.openSessionRename("proj-a", sessionSummary({ name: "Session" }));
  const r2b = harness.render(api);
  await r2b.renameModalsProps.rename?.onSubmit();
  assert.equal(agentRenameCalled, false);
  assert.equal(sessionRenameCalled, true);
});

test("renameModalsProps.rename.onClose clears both targets", () => {
  const i18n = { t: (key) => key };
  const harness = createRenameHarness(i18n);

  const r = harness.render(createDefaultApi());
  r.openAgentRename(agentTab());
  r.openSessionRename("proj-a", sessionSummary()); // second call replaces first
  const r2 = harness.render(createDefaultApi());
  r2.renameModalsProps.rename?.onClose();

  const r3 = harness.render(createDefaultApi());
  assert.equal(r3.agentRenameTarget, null);
  assert.equal(r3.sessionRenameTarget, null);
});

test("renameModalsProps.rename.saving reflects agentRenaming state", async () => {
  const i18n = { t: (key) => key };
  let resolveRename;
  const api = createDefaultApi({
    renameAgent: async () => new Promise((resolve) => { resolveRename = resolve; }),
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openAgentRename(agentTab({ title: "ok" }));
  const rBefore = harness.render(api);
  assert.equal(rBefore.renameModalsProps.rename?.saving, false);

  const submitPromise = rBefore.submitAgentRename();
  const rDuring = harness.render(api);
  assert.equal(rDuring.renameModalsProps.rename?.saving, true);

  resolveRename(agentTab({ title: "ok" }));
  await submitPromise;

  const rAfter = harness.render(api);
  assert.equal(rAfter.renameModalsProps.rename, undefined); // cleared after success
});

// ── 项目重命名（显示名别名，不动磁盘目录）──

function projectRow(overrides = {}) {
  return {
    id: "proj-a",
    name: "alpha",
    path: "C:\\work\\alpha",
    lastOpenedAt: Date.now(),
    environment: "windows",
    ...overrides,
  };
}

test("openProjectRename 预填当前展示名并清空其他重命名目标", () => {
  const i18n = { t: (key) => key };
  const harness = createRenameHarness(i18n);

  const r = harness.render(createDefaultApi());
  r.openAgentRename(agentTab());
  r.openProjectRename(projectRow({ name: "内部平台" }));

  const r2 = harness.render(createDefaultApi());
  assert.equal(r2.projectRenameTarget?.id, "proj-a");
  assert.equal(r2.agentRenameTarget, null);
  assert.equal(r2.sessionRenameTarget, null);
  assert.equal(r2.agentRenameValue, "内部平台");
  // 弹窗槽位为 project kind
  assert.equal(r2.renameModalsProps.rename?.kind, "project");
});

test("submitProjectRename 调用 renameProject、回写列表并 toast", async () => {
  const i18n = { t: (key) => key === "app.projectRenamed" ? "Renamed!" : key };
  const calls = [];
  const api = createDefaultApi({
    renameProject: async (id, name) => { calls.push(`renameProject:${id}:${name}`); return [{ id, name, path: "/tmp", lastOpenedAt: Date.now() }]; },
    applyRenamedProjects: (projects) => { calls.push(`applied:${projects[0].name}`); },
    showToast: (msg) => { calls.push(`toast:${msg}`); },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openProjectRename(projectRow({ name: "alpha" }));
  const rBefore = harness.render(api);
  rBefore.renameModalsProps.rename?.onValueChange("  内部 平台  ");
  const rSubmit = harness.render(api);
  await rSubmit.submitProjectRename();

  const r2 = harness.render(api);
  assert.equal(r2.projectRenameTarget, null);
  assert.equal(r2.agentRenameValue, "");
  // 空白折叠后提交
  assert.deepEqual(calls, [
    "renameProject:proj-a:内部 平台",
    "applied:内部 平台",
    "toast:Renamed!",
  ]);
});

test("submitProjectRename 空名提示且不调用 API", async () => {
  const i18n = { t: (key) => key === "app.projectNameRequired" ? "Required!" : key };
  let toastMessage;
  let apiCalls = 0;
  const api = createDefaultApi({
    renameProject: async () => { apiCalls += 1; return []; },
    showToast: (msg) => { toastMessage = msg; },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openProjectRename(projectRow());
  const r2 = harness.render(api);
  r2.renameModalsProps.rename?.onValueChange("   ");
  const r3 = harness.render(api);
  await r3.submitProjectRename();

  assert.equal(toastMessage, "Required!");
  assert.equal(apiCalls, 0);
  // 校验失败不清目标，用户还能改完再提交
  const r4 = harness.render(api);
  assert.notEqual(r4.projectRenameTarget, null);
});

test("submitProjectRename 失败 toast 带错误信息", async () => {
  const i18n = { t: (key, params) => key === "app.projectRenameFailed" ? `Failed(${params.error})` : key };
  let toastMessage;
  const api = createDefaultApi({
    renameProject: async () => { throw new Error("PROJECT_RENAME_NOT_ALLOWED"); },
    showToast: (msg) => { toastMessage = msg; },
  });
  const harness = createRenameHarness(i18n);

  const r = harness.render(api);
  r.openProjectRename(projectRow());
  const rBefore = harness.render(api);
  await rBefore.submitProjectRename();

  assert.ok(toastMessage.includes("PROJECT_RENAME_NOT_ALLOWED"), `got: ${toastMessage}`);
  const r2 = harness.render(api);
  assert.equal(r2.agentRenaming, false);
});
