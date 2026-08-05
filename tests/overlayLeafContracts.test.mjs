import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const root = "src/renderer/src";
const read = (file) => readFileSync(`${root}/${file}`, "utf8");

function compile(file, imports = {}, context = {}) {
  const filePath = `${root}/${file}`;
  const output = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => imports[specifier] ?? {},
    ...context,
  }, { filename: filePath });
  return module.exports;
}

test("overlay roots expose narrow contracts and never subscribe to raw UI requests", () => {
  const runtime = read("components/overlays/SessionRuntimeUiOverlay.tsx");
  assert.match(runtime, /readBinding/);
  assert.match(runtime, /runtimeGeneration/);
  assert.match(runtime, /sameBinding/);
  assert.match(runtime, /cancelled:\s*true/);
  assert.doesNotMatch(runtime, /onUiRequest/);
  assert.match(read("components/overlays/ImportOverlayHost.tsx"), /kind: "codex"/);
  assert.match(read("components/overlays/EnvironmentOverlay.tsx"), /EnvironmentDialog/);
  assert.match(read("components/overlays/ScratchPadOverlay.tsx"), /scratch-pad-overlay/);
});

// DialogClose / ESC / 遮罩关闭都依赖 onOpenChange(false) 真正调用 onClose；
// 写成 `!next && onClose` 只会返回函数引用，不会关弹层。
test("dialog onOpenChange handlers invoke onClose instead of returning the callback", () => {
  const files = [
    "components/overlays/SessionActionOverlays.tsx",
    "components/overlays/OverlayComponents.tsx",
    "components/app/ImportModals.tsx",
    "components/app/ProjectResourcesModal.tsx",
    "components/session/WorkspaceSurface.tsx",
  ];
  for (const file of files) {
    const source = read(file);
    // 禁止 `!next && onClose` / `!next && props.onClose` 这种未调用写法
    assert.doesNotMatch(
      source,
      /!next\s*&&\s*(?:props\.)?onClose(?!\s*\()/,
      `${file} must call onClose() in onOpenChange`,
    );
    assert.match(
      source,
      /onOpenChange=\{\(next\)\s*=>\s*!next\s*&&\s*(?:props\.)?onClose\(\)\}/,
      `${file} must wire onOpenChange to onClose()`,
    );
  }
});

test("async leaf controllers contain cancellation and stale-result guards", () => {
  const imports = read("hooks/useImportController.ts");
  const updates = read("hooks/useAppUpdateController.ts");
  assert.match(imports, /mounted\.current = true/);
  assert.match(imports, /mounted\.current = false/);
  assert.match(imports, /requestSequence/);
  assert.match(imports, /sequence\.current \+= 1/);
  assert.match(updates, /downloadGate/);
  assert.match(updates, /acceptsProgress/);
  assert.match(updates, /downloadGate\.current\.settle/);
});

test("ScratchPad root preserves shortcut, closing, and timer cleanup", () => {
  const scratch = read("components/overlays/ScratchPadOverlay.tsx");
  assert.match(scratch, /ctrlKey.*shiftKey/);
  assert.match(scratch, /event\.key === "Escape"/);
  assert.match(scratch, /isClosing/);
});

function loadResponder() {
  return compile("components/overlays/SessionRuntimeUiOverlay.tsx", {
    react: {},
    "lucide-react": { MessageCircle: () => null, X: () => null },
    "../../i18n": { t: (key) => key },
    "../../utils/askUi": askUiMock,
  });
}

// 与 src/renderer/src/utils/askUi.ts 行为一致的轻量替身（vm 沙箱不解析相对链）
const askUiMock = {
  pickActiveAskRequest: (entries) => {
    const list = Object.values(entries ?? {});
    const active = list.filter((entry) => entry.status === "pending" || entry.status === "responding");
    return active[active.length - 1]?.request;
  },
  buildAskResponse: (method, value, options) => (
    options?.cancelled
      ? { cancelled: true }
      : method === "confirm"
        ? { confirmed: Boolean(value), value: Boolean(value) }
        : { value: value ?? "" }
  ),
  serializeBatchAnswers: () => "{}",
};

test("runtime responder rejects old generation and sends cancelled response with binding", async () => {
  const { createSessionRuntimeUiResponder } = loadResponder();
  const binding = { sessionId: "s1", agentId: "a1", runtimeGeneration: 4 };
  let current = { ...binding };
  const claims = [];
  const sent = [];
  const responder = createSessionRuntimeUiResponder({
    binding,
    readBinding: () => current,
    claim: (input) => { claims.push(input); return true; },
    rollback: () => true,
    send: async (input) => { sent.push(input); },
  });
  const request = { agentId: "a1", requestId: "r1", method: "confirm", title: "Continue" };
  assert.equal(await responder.respond(request, { cancelled: true }), true);
  assert.equal(JSON.stringify(sent[0]), JSON.stringify({ ...binding, requestId: "r1", response: { cancelled: true } }));
  assert.equal(claims[0].request, request);
  current = { ...binding, runtimeGeneration: 3 };
  assert.equal(await responder.respond(request, { confirmed: true }), false);
  assert.equal(sent.length, 1);
});

test("runtime responder rolls back when binding changes after claim", async () => {
  const { createSessionRuntimeUiResponder } = loadResponder();
  const binding = { sessionId: "s1", agentId: "a1", runtimeGeneration: 2 };
  let current = { ...binding };
  let rolledBack = 0;
  const responder = createSessionRuntimeUiResponder({
    binding,
    readBinding: () => { const next = { ...current }; current = { ...current, runtimeGeneration: 3 }; return next; },
    claim: () => true,
    rollback: () => { rolledBack += 1; return true; },
    send: async () => { throw new Error("must not send"); },
  });
  assert.equal(await responder.respond({ agentId: "a1", requestId: "r2", method: "input", title: "Input" }, { value: "x" }), false);
  assert.equal(rolledBack, 1);
});

function createHookHarness() {
  const refs = [];
  const states = [];
  let cursor = 0;
  let effects = [];
  let result;
  const react = {
    useRef(initial) {
      const index = cursor++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useState(initial) {
      const index = cursor++;
      states[index] ??= typeof initial === "function" ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) { cursor++; effects.push(fn); },
  };
  const hooks = compile("hooks/useImportController.ts", { react });
  return {
    render(options) {
      cursor = 0;
      effects = [];
      result = hooks.useImportController(options);
      return { result, effects };
    },
    state: states,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

async function flushAsync() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

test("import controller effect replay restores mounted state and rejects a deferred result after project null", async () => {
  const scans = [];
  const harness = createHookHarness();
  const options = (projectId) => ({
    projectId,
    scan: async (id) => { const item = deferred(); scans.push({ id, ...item }); return item.promise; },
    importSelected: async () => ({ ok: true }),
  });
  const first = harness.render(options("project-a"));
  const firstCleanups = first.effects.map((setup) => setup()).filter(Boolean);
  assert.equal(scans.length, 1);
  firstCleanups.forEach((cleanup) => cleanup());
  first.effects.forEach((setup) => setup());
  assert.equal(scans.length, 2);
  scans[0].resolve([{ sourcePath: "stale-a" }]);
  scans[1].resolve([{ sourcePath: "fresh-a" }]);
  await flushAsync();
  assert.deepEqual(harness.render(options("project-a")).result.sessions, [{ sourcePath: "fresh-a" }]);

  const old = harness.render(options("project-a"));
  const oldCleanups = old.effects.map((setup) => setup()).filter(Boolean);
  assert.equal(scans.length, 3);
  oldCleanups.forEach((cleanup) => cleanup());
  const closed = harness.render(options(null));
  closed.effects.forEach((setup) => setup());
  scans[2].resolve([{ sourcePath: "must-not-appear" }]);
  await flushAsync();
  assert.equal(harness.render(options(null)).result.sessions.length, 0);
});

test("update gate blocks B after A clear and rejects A progress until A settles", () => {
  const { createAppUpdateDownloadGate } = compile("hooks/useAppUpdateController.ts", { react: {} });
  const gate = createAppUpdateDownloadGate();
  const a = gate.begin();
  assert.equal(gate.acceptsProgress(), true);
  gate.invalidate();
  assert.equal(gate.acceptsProgress(), false);
  assert.equal(gate.begin(), null);
  gate.settle(a);
  const b = gate.begin();
  assert.notEqual(b, null);
  assert.equal(gate.acceptsProgress(), true);
  gate.settle(b);
  assert.equal(gate.isInFlight(), false);
});

function createUpdateHookHarness() {
  const refs = [];
  const states = [];
  let cursor = 0;
  let effects = [];
  const react = {
    useRef(initial) {
      const index = cursor++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useState(initial) {
      const index = cursor++;
      states[index] ??= typeof initial === "function" ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) { cursor++; effects.push(fn); },
  };
  const hooks = compile("hooks/useAppUpdateController.ts", { react });
  return {
    render(api) {
      cursor = 0;
      effects = [];
      const result = hooks.useAppUpdateController(api, false);
      return { result, effects };
    },
  };
}

test("update check and download resolve into completed progress and a downloaded path", async () => {
  let onProgress;
  let resolveDownload;
  const updateInfo = {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    hasUpdate: true,
    releaseName: "1.1.0",
    releaseNotes: "notes",
    releaseUrl: "https://example.test/release",
    assets: [{ name: "PiDeck.exe", url: "https://example.test/PiDeck.exe", size: 10 }],
    recommendedAsset: { name: "PiDeck.exe", url: "https://example.test/PiDeck.exe", size: 10 },
  };
  const api = {
    checkUpdate: async () => updateInfo,
    downloadUpdate: async () => new Promise((resolve) => { resolveDownload = resolve; }),
    installUpdate: async () => undefined,
    onUpdateProgress: (callback) => { onProgress = callback; return () => { onProgress = undefined; }; },
  };
  const harness = createUpdateHookHarness();
  const initial = harness.render(api);
  initial.effects.map((setup) => setup()).filter(Boolean);
  assert.equal(await initial.result.check("manual"), updateInfo);
  const afterCheck = harness.render(api).result;
  assert.equal(afterCheck.info.recommendedAsset.name, "PiDeck.exe");

  const downloadPromise = afterCheck.download();
  onProgress({ assetName: "PiDeck.exe", receivedBytes: 5, totalBytes: 10, percent: 50, state: "downloading" });
  assert.equal(harness.render(api).result.progress.percent, 50);
  resolveDownload({ filePath: "C:/tmp/PiDeck.exe", assetName: "PiDeck.exe" });
  assert.equal(await downloadPromise, "C:/tmp/PiDeck.exe");

  const completed = harness.render(api).result;
  assert.equal(completed.downloadedPath, "C:/tmp/PiDeck.exe");
  assert.equal(completed.progress.state, "completed");
  assert.equal(completed.progress.percent, 100);
  assert.equal(completed.progress.filePath, "C:/tmp/PiDeck.exe");
  assert.equal(completed.downloading, false);
});

test("Import error renders as a fixed high-z-index alert and disappears when cleared", () => {
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const { renderImportError } = compile("components/overlays/ImportOverlayHost.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "../app/ImportModals": {},
  });
  const rendered = renderImportError("Import failed");
  assert.equal(rendered.type, "div");
  assert.equal(rendered.props.role, "alert");
  assert.equal(rendered.props["aria-live"], "assertive");
  assert.equal(rendered.props.className, "import-overlay-error-surface");
  assert.equal(rendered.props.style.position, "fixed");
  assert.ok(rendered.props.style.zIndex > 100);
  assert.equal(rendered.props.style.padding, "10px 16px");
  assert.equal(rendered.props.style.background, "var(--color-danger-soft)");
  assert.equal(rendered.props.style.pointerEvents, "auto");
  assert.equal(rendered.props.children.props.children, "Import failed");
  assert.equal(renderImportError(null), null);
});

test("overlay roots keep controller/import/runtime error visible", () => {
  const update = read("components/overlays/AppUpdateOverlay.tsx");
  const imports = read("components/overlays/ImportOverlayHost.tsx");
  assert.match(update, /props\.error/);
  assert.match(update, /role="alert"/);
  assert.match(update, /controller\.error/);
  // 发布说明和浏览器下载必须绕过内置浏览器，避免 webview 拦截安装包跳转。
  assert.match(update, /onBrowserDownload=\{\(\) => void openExternal\([^)]*, true\)\}/);
  assert.match(update, /onOpenRelease=\{\(\) => void openExternal\(info\.releaseUrl, true\)\}/);
  assert.match(imports, /controller\.error/);
  assert.match(imports, /renderImportError/);
});

test("allowOther renders a custom input and sends its value through the responder envelope", async () => {
  const hookStates = [];
  let cursor = 0;
  const sent = [];
  const react = {
    useMemo: (factory) => factory(),
    useState: (initial) => {
      const index = cursor++;
      hookStates[index] ??= typeof initial === "function" ? initial() : initial;
      return [hookStates[index], (next) => { hookStates[index] = typeof next === "function" ? next(hookStates[index]) : next; }];
    },
    useEffect: () => { cursor += 1; },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const runtime = compile("components/overlays/SessionRuntimeUiOverlay.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "lucide-react": { Info: () => null },
    "../../i18n": { t: (key) => key },
    "../../utils/askUi": askUiMock,
  });
  const request = { agentId: "a1", requestId: "r-custom", method: "select", title: "Pick", options: ["one"], allowOther: true };
  const props = {
    sessionId: "s1",
    runtime: { agentId: "a1", runtimeGeneration: 7, status: "idle", thinking: "", updatedAt: 1 },
    ui: { agentId: "a1", runtimeGeneration: 7, requests: { [request.requestId]: { request, status: "pending" } }, widgets: {}, revision: 1 },
    responder: { respond: async (nextRequest, response) => { sent.push({ nextRequest, response }); return true; } },
  };
  const walk = (node, predicate, found = []) => {
    if (!node || typeof node !== "object") return found;
    if (predicate(node)) found.push(node);
    for (const child of Object.values(node.props ?? {})) {
      if (Array.isArray(child)) child.forEach((item) => walk(item, predicate, found));
      else walk(child, predicate, found);
    }
    return found;
  };
  cursor = 0;
  const firstTree = runtime.SessionRuntimeUiOverlay(props);
  // 按行为特征定位自定义输入框（受控 value + onChange），不断言具体尺寸 class，
  // 避免紧凑布局调整行高（h-9→h-8）时产生假失败。
  const input = walk(firstTree, (node) => typeof node.props?.value === "string" && typeof node.props?.onChange === "function")[0];
  assert.ok(input, "allowOther custom field must render");
  input.props.onChange({ target: { value: "custom answer" } });
  cursor = 0;
  const secondTree = runtime.SessionRuntimeUiOverlay(props);
  const submit = walk(secondTree, (node) => node.props?.variant === "default" && node.props?.disabled !== undefined)[0];
  assert.ok(submit, "allowOther submit button must render");
  assert.equal(typeof submit.props.onClick, "function");
  await submit.props.onClick();
  await flushAsync();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].nextRequest.requestId, "r-custom");
  assert.equal(JSON.stringify(sent[0].response), JSON.stringify({ value: "custom answer" }));
});
