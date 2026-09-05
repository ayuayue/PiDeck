import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync("src/renderer/src/hooks/useOverlayActions.ts", "utf8");

function compileHook(reactStub, i18nStub, desktopApiStub) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "src/renderer/src/hooks/useOverlayActions.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "react") return reactStub;
      if (specifier === "../i18n") return i18nStub;
      if (specifier === "../desktopApi") return desktopApiStub;
      return {};
    },
  }, { filename: "src/renderer/src/hooks/useOverlayActions.ts" });
  return module.exports;
}

function wrapDesktopApi(api) {
  return { desktopApi: api };
}
const SAFE_DESKTOP_API_MODULE = wrapDesktopApi({
  app: {
    openExternal: () => undefined,
    feedbackEnvironment: { appVersion: "1.0.0", platform: "win32", arch: "x64" },
  },
  projects: {
    respondTrustRequest: () => undefined,
  },
});

function createOverlayActionsHarness(i18nStub, desktopApiStub) {
  const states = [];
  const refs = [];
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
    useCallback(fn) {
      cursor++;
      return fn;
    },
    useMemo(factory) {
      cursor++;
      return factory();
    },
    useRef(initial) {
      const index = cursor++;
      refs[index] = refs[index] ?? { current: initial };
      return refs[index];
    },
  };
  const hooks = compileHook(react, i18nStub, desktopApiStub ?? SAFE_DESKTOP_API_MODULE);
  function render(params) {
    cursor = 0;
    return hooks.useOverlayActions(params);
  }
  return { render, states };
}

function mkProject(overrides = {}) {
  return {
    id: "proj-1",
    name: "Test Project",
    path: "/tmp/proj",
    lastOpenedAt: Date.now(),
    ...overrides,
  };
}

function mkAppInfo(overrides = {}) {
  return {
    version: "1.0.0",
    releasesUrl: "https://example.test/releases",
    platform: "win32",
    ...overrides,
  };
}

// ── static source assertions ──

test("useOverlayActions sources track three state atoms and memoizes overlayProps", () => {
  assert.match(source, /export function useOverlayActions/);
  assert.match(source, /useState<ConfirmDialogConfig/);
  assert.match(source, /useState<TrustRequest/);
  assert.match(source, /useState\(false\)/);
  assert.match(source, /const showConfirm = useCallback/);
  assert.match(source, /const clearConfirm = useCallback/);
  assert.match(source, /const overlayProps = useMemo/);
});

// ── runtime logic ──

test("showConfirm sets confirmDialog with full config", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const onConfirm = () => undefined;

  const r = harness.render({
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  r.showConfirm({
    title: "Delete?",
    message: "Are you sure?",
    onConfirm,
    danger: true,
    confirmLabel: "Delete",
  });

  const r2 = harness.render({
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  assert.equal(r2.confirmDialog.title, "Delete?");
  assert.equal(r2.confirmDialog.message, "Are you sure?");
  assert.equal(r2.confirmDialog.onConfirm, onConfirm);
  assert.equal(r2.confirmDialog.danger, true);
  assert.equal(r2.confirmDialog.confirmLabel, "Delete");
});

test("clearConfirm sets confirmDialog to null", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const params = { appInfo: mkAppInfo(), showToast: () => undefined };

  const r = harness.render(params);
  r.showConfirm({ title: "X", message: "Y", onConfirm: () => undefined });
  const r2 = harness.render(params);
  assert.notEqual(r2.confirmDialog, null);

  r2.clearConfirm();
  const r3 = harness.render(params);
  assert.equal(r3.confirmDialog, null);
});

test("feedbackOpen toggles true and false", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const params = { appInfo: mkAppInfo(), showToast: () => undefined };

  const r = harness.render(params);
  assert.equal(r.feedbackOpen, false);

  r.setFeedbackOpen(true);
  const r2 = harness.render(params);
  assert.equal(r2.feedbackOpen, true);

  r2.setFeedbackOpen(false);
  const r3 = harness.render(params);
  assert.equal(r3.feedbackOpen, false);
});

test("trustRequest set and get", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const params = { appInfo: mkAppInfo(), showToast: () => undefined };

  const req = { requestId: "r1", cwd: "/tmp", projectName: "Test" };

  const r = harness.render(params);
  assert.equal(r.trustRequest, null);

  r.setTrustRequest(req);
  const r2 = harness.render(params);
  assert.equal(r2.trustRequest.requestId, "r1");
  assert.equal(r2.trustRequest.cwd, "/tmp");
  assert.equal(r2.trustRequest.projectName, "Test");
});

test("overlayProps.feedback structure with active project", () => {
  const i18n = { t: (key) => key === "app.feedbackCopied" ? "Copied!" : key };
  const harness = createOverlayActionsHarness(i18n);
  const project = mkProject();
  const params = {
    activeProject: project,
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  };

  const r = harness.render(params);
  assert.equal(r.overlayProps.feedback, undefined);

  r.setFeedbackOpen(true);
  const r2 = harness.render(params);
  const f = r2.overlayProps.feedback;
  // hook 已改为 { open, props } 嵌套结构（props 才是 FeedbackDialog 的实参）
  assert.equal(f.open, true);
  assert.equal(f.props.project, project);
  assert.notEqual(f.props.onClose, undefined);
});

test("overlayProps.feedback forwards onToast to showToast", () => {
  const i18n = { t: (key) => key };
  let toastMessage;
  const harness = createOverlayActionsHarness(i18n);

  const r = harness.render({
    activeProject: mkProject(),
    appInfo: mkAppInfo(),
    showToast: (msg) => { toastMessage = msg; },
  });
  r.setFeedbackOpen(true);

  const r2 = harness.render({
    activeProject: mkProject(),
    appInfo: mkAppInfo(),
    showToast: (msg) => { toastMessage = msg; },
  });
  // FeedbackDialog 将具体复制行为及本地化留在组件内，hook 只负责把 toast port 透传。
  r2.overlayProps.feedback.props.onToast("app.feedbackCopied");
  assert.equal(toastMessage, "app.feedbackCopied");
});

test("overlayProps.confirm structure when confirmDialog is set", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const onConfirm = () => undefined;

  const r = harness.render({
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  assert.equal(r.overlayProps.confirm, undefined);

  r.showConfirm({ title: "Delete?", message: "Are you sure?", onConfirm, danger: true, confirmLabel: "Delete" });
  const r2 = harness.render({
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  const c = r2.overlayProps.confirm;
  assert.equal(c.open, true);
  assert.equal(c.props.title, "Delete?");
  assert.equal(c.props.message, "Are you sure?");
  assert.equal(c.props.onConfirm, onConfirm);
  assert.equal(c.props.danger, true);
  assert.equal(c.props.confirmLabel, "Delete");
});

test("overlayProps.confirm onCancel clears confirmDialog", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const params = { appInfo: mkAppInfo(), showToast: () => undefined };

  const r = harness.render(params);
  r.showConfirm({ title: "X", message: "Y", onConfirm: () => undefined });

  const r2 = harness.render(params);
  r2.overlayProps.confirm.props.onCancel();

  const r3 = harness.render(params);
  assert.equal(r3.confirmDialog, null);
  assert.equal(r3.overlayProps.confirm, undefined);
});

test("overlayProps.trust structure when trustRequest is set", () => {
  const i18n = { t: (key) => key };
  let trustChoice;
  const desktopApi = wrapDesktopApi({
    projects: {
      respondTrustRequest: (requestId, choice) => { trustChoice = { requestId, choice }; },
    },
  });
  const harness = createOverlayActionsHarness(i18n, desktopApi);

  const r = harness.render({
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  assert.equal(r.overlayProps.trust, undefined);

  r.setTrustRequest({ requestId: "r1", cwd: "/tmp/proj", projectName: "Test" });
  const r2 = harness.render({
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  const t = r2.overlayProps.trust;
  assert.equal(t.open, true);
  assert.equal(t.requestId, "r1");
  assert.equal(t.cwd, "/tmp/proj");
  assert.equal(t.projectName, "Test");
  assert.equal(typeof t.onChoose, "function");

  // onChoose sends response and clears request
  t.onChoose("trust-remember");
  assert.deepEqual(trustChoice, { requestId: "r1", choice: "trust-remember" });

  const r3 = harness.render({
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  assert.equal(r3.trustRequest, null);
  assert.equal(r3.overlayProps.trust, undefined);
});

test("overlayProps.trust onChoose supports all three trust choices", () => {
  const i18n = { t: (key) => key };
  const choices = [];
  const desktopApi = wrapDesktopApi({
    projects: {
      respondTrustRequest: (requestId, choice) => choices.push(choice),
    },
  });
  const harness = createOverlayActionsHarness(i18n, desktopApi);
  const params = { appInfo: mkAppInfo(), showToast: () => undefined };

  const r = harness.render(params);
  r.setTrustRequest({ requestId: "r1", cwd: "/tmp", projectName: "T" });
  const r2 = harness.render(params);

  r2.overlayProps.trust.onChoose("trust-remember");
  r2.setTrustRequest({ requestId: "r2", cwd: "/tmp", projectName: "T" });
  const r3 = harness.render(params);
  r3.overlayProps.trust.onChoose("trust-session");

  r3.setTrustRequest({ requestId: "r3", cwd: "/tmp", projectName: "T" });
  const r4 = harness.render(params);
  r4.overlayProps.trust.onChoose("deny");

  assert.deepEqual(choices, ["trust-remember", "trust-session", "deny"]);
});

test("overlayProps combines all three overlays simultaneously", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const project = mkProject();

  const r = harness.render({
    activeProject: project,
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });

  // Set all three concurrently
  r.showConfirm({ title: "Delete?", message: "Confirm delete", onConfirm: () => undefined });
  r.setTrustRequest({ requestId: "r1", cwd: "/tmp", projectName: "Test" });
  r.setFeedbackOpen(true);

  const r2 = harness.render({
    activeProject: project,
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });

  const props = r2.overlayProps;
  assert.equal(props.feedback.open, true);
  assert.equal(props.feedback.props.project, project);
  assert.equal(props.confirm.open, true);
  assert.equal(props.confirm.props.title, "Delete?");
  assert.equal(props.trust.open, true);
  assert.equal(props.trust.requestId, "r1");

  // Clear each and verify
  r2.clearConfirm();
  const r3 = harness.render({
    activeProject: project,
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  assert.equal(r3.overlayProps.confirm, undefined);
  assert.equal(r3.overlayProps.feedback.open, true);
  assert.equal(r3.overlayProps.trust.open, true);
});

test("overlayProps.feedback uses activeProject passed from params", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);
  const projectA = mkProject({ id: "proj-a", name: "Alpha" });
  const projectB = mkProject({ id: "proj-b", name: "Beta" });

  const r = harness.render({
    activeProject: projectA,
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  r.setFeedbackOpen(true);

  const r2 = harness.render({
    activeProject: projectB,
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  // useMemo recomputes on dependency change, so project should be Beta
  assert.equal(r2.overlayProps.feedback.props.project.name, "Beta");
});

test("overlayProps.feedback is undefined when feedbackOpen is false", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);

  const r = harness.render({
    activeProject: mkProject(),
    appInfo: mkAppInfo(),
    showToast: () => undefined,
  });
  // feedbackOpen defaults to false
  assert.equal(r.overlayProps.feedback, undefined);
});

test("overlayProps carries correct appInfo", () => {
  const i18n = { t: (key) => key };
  const harness = createOverlayActionsHarness(i18n);

  const r = harness.render({
    appInfo: mkAppInfo({ version: "2.0.0", platform: "darwin" }),
    showToast: () => undefined,
  });
  r.setFeedbackOpen(true);

  const r2 = harness.render({
    appInfo: mkAppInfo({ version: "2.0.0", platform: "darwin" }),
    showToast: () => undefined,
  });
  assert.equal(r2.overlayProps.feedback.props.appInfo.version, "2.0.0");
  assert.equal(r2.overlayProps.feedback.props.appInfo.platform, "darwin");
});
