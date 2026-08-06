import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const projectSync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const sessionActions = readFileSync("src/renderer/src/hooks/useSessionActions.ts", "utf8");
const importFlow = readFileSync("src/renderer/src/hooks/useImportFlow.ts", "utf8");
const i18n = [
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
].join("\n");
const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");

function refreshSessionsBlock() {
  const match = projectSync.match(/async function refreshSessions\(projectId = activeProjectId\): Promise<SessionSummary\[]> \{[\s\S]*?\n  \}\n\n  async function runProjectSessionRefresh/);
  assert.ok(match, "refreshSessions implementation should be discoverable");
  return match[0];
}

function refreshProjectSessionsBlock() {
  const match = projectSync.match(/function refreshProjectSessions\(projectId: string, silent = false\): ProjectSessionRefreshPromise \{[\s\S]*?\n  \}\n\n  async function refreshProjectTree/);
  assert.ok(match, "refreshProjectSessions implementation should be discoverable");
  return match[0];
}

function runProjectSessionRefreshBlock() {
  const match = projectSync.match(/async function runProjectSessionRefresh\([\s\S]*?\n  \}\n\n  function startProjectSessionRefresh/);
  assert.ok(match, "runProjectSessionRefresh implementation should be discoverable");
  return match[0];
}

function withTimeoutBlock() {
  const match = projectSync.match(/function withTimeout<T>\([\s\S]*?\n\}\n/);
  assert.ok(match, "withTimeout implementation should be discoverable");
  return match[0];
}

function assertInOrder(source, fragments, message) {
  let previousIndex = -1;
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, previousIndex + 1);
    assert.notEqual(index, -1, `${message}: missing ${fragment}`);
    assert.ok(index > previousIndex, `${message}: ${fragment} is out of order`);
    previousIndex = index;
  }
}

function rendererSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return rendererSourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("keeps one catalog requester and the legacy adapter", () => {
  const adapter = refreshSessionsBlock();
  assert.equal(projectSync.match(/api\.sessions\.listCatalog\(projectId\)/g)?.length ?? 0, 1);
  assertInOrder(
    adapter,
    [
      "if (!projectId) return [];",
      "await refreshProjectSessions(projectId, true)",
      "if (!refreshed) return [];",
      ".filter((session): session is SessionSummary => Boolean(session))",
      ".sort((a, b) => b.updatedAt - a.updatedAt);",
    ],
    "legacy adapter",
  );
  assert.doesNotMatch(adapter, /api\.sessions\.listCatalog|replaceProjectSessions/);
});

test("routes production catalog callers through the canonical command", () => {
  for (const [name, source] of [
    ["App", app],
    ["session actions", sessionActions],
    ["import flow", importFlow],
  ]) {
    assert.doesNotMatch(source, /\brefreshSessions\b/, `${name} still calls the legacy adapter`);
    assert.doesNotMatch(source, /api\.sessions\.listCatalog\(projectId\)/, `${name} bypasses the catalog owner`);
  }
  assert.doesNotMatch(sessionActions, /replaceProjectSessions/);
  assert.doesNotMatch(importFlow, /\bsessionsProjectId\b/);

  const requesters = rendererSourceFiles("src/renderer/src")
    .filter((path) => /\.sessions\.listCatalog\(/.test(readFileSync(path, "utf8")))
    .sort();
  assert.deepEqual(requesters, ["src/renderer/src/hooks/useProjectSync.ts"]);
});

test("shares one deferred completion across initial, collision, and retry cycles", () => {
  const refreshBlock = refreshProjectSessionsBlock();
  assert.match(projectSync, /const sessionRefreshCompletionByProjectRef = useRef<Record<string, ProjectSessionRefreshCompletion \| undefined>>\(\{\}\);/);
  assertInOrder(
    refreshBlock,
    [
      "const current = sessionRefreshCompletionByProjectRef.current[projectId];",
      "if (current)",
      "sessionRefreshPendingRef.current.add(projectId);",
      "return current.promise;",
      "const completion = createProjectSessionRefreshCompletion();",
      "sessionRefreshCompletionByProjectRef.current[projectId] = completion;",
      "startProjectSessionRefresh(projectId, silent, completion)",
      "return completion.promise;",
    ],
    "shared deferred completion",
  );
  assert.doesNotMatch(projectSync, /ProjectSessionRefreshCycle|ProjectSessionRefreshPhase|sessionRefreshPendingRetryRef/);
});

test("bounds catalog requests and retains timeout cleanup", () => {
  const block = runProjectSessionRefreshBlock();
  const timeoutBlock = withTimeoutBlock();
  assert.match(projectSync, /const SESSION_REFRESH_TIMEOUT_MS = 20_000;/);
  assert.match(timeoutBlock, /Promise\.race\(\[promise, timeout\]\)\.finally\(\(\) => \{/);
  assert.match(timeoutBlock, /if \(timer\) clearTimeout\(timer\);/);
  assert.match(
    block,
    /withTimeout\(\s*api\.sessions\.listCatalog\(projectId\),\s*SESSION_REFRESH_TIMEOUT_MS,\s*t\("app\.sessionRefreshTimeout"\),?\s*\)/,
  );
  assert.match(i18n, /"app\.sessionRefreshTimeout"/);
  assert.match(scanner, /private scanTimeoutMs = 18_000;/);
  assert.match(scanner, /new AbortController\(\)/);
  assert.match(scanner, /controller\.abort\(new Error\("Session scan timed out"\)\)/);
  assert.match(scanner, /clearTimeout\(scanTimer\)/);
});

test("preserves request gate, stale records, replace ordering, and canonical sorting", () => {
  const block = runProjectSessionRefreshBlock();
  assertInOrder(
    block,
    [
      "const request = (sessionRequestByProjectRef.current[projectId] ?? 0) + 1;",
      "sessionRequestByProjectRef.current[projectId] = request;",
      "if (sessionRequestByProjectRef.current[projectId] !== request)",
      "result = records;",
      "replaceProjectSessions({ projectId, sessions: records });",
      ".map(sessionRecordToSummary)",
      ".filter((session): session is SessionSummary => Boolean(session))",
      ".sort((a, b) => b.updatedAt - a.updatedAt);",
    ],
    "refresh result pipeline",
  );
});

test("publishes foreground loading before yielding and clears it in finally", () => {
  const block = runProjectSessionRefreshBlock();
  assertInOrder(
    block,
    [
      "if (!silent)",
      "setSessionLoadingByProject(",
      "[projectId]: true",
      'setSessionCatalogLoadState?.({ projectId, state: { status: "loading" } });',
      "await new Promise<void>((r) => setTimeout(r, 0));",
      "} finally {",
      "sessionRefreshRunningRef.current.delete(projectId);",
      "if (!silent) setSessionLoadingByProject(",
      "[projectId]: false",
    ],
    "foreground loading lifecycle",
  );
});

test("publishes canonical ready and request-scoped error states", () => {
  const block = runProjectSessionRefreshBlock();
  assert.match(projectSync, /setSessionCatalogLoadState\?: \(input: \{ projectId: string; state: SessionLoadState \}\) => void;/);
  assertInOrder(
    block,
    [
      'setSessionCatalogLoadState?.({ projectId, state: { status: "ready" } });',
      "} catch (caughtError) {",
      "failed = true;",
      "error = caughtError;",
      "if (sessionRequestByProjectRef.current[projectId] === request)",
      "const message = caughtError instanceof Error ? caughtError.message : String(caughtError);",
      'state: { status: "error", error: message },',
    ],
    "canonical catalog load state",
  );
  assert.match(app, /setSessionCatalogLoadStateAtom/);
  assert.match(app, /const setSessionCatalogLoadState = useSetAtom\(setSessionCatalogLoadStateAtom\);/);
  assert.match(app, /showToast,\s*setSessionCatalogLoadState,\s*t,/);
});

test("defers settlement through silent retries and identity-cleans the shared completion", () => {
  const block = runProjectSessionRefreshBlock();
  assertInOrder(
    block,
    [
      "const isCurrentCompletion = sessionRefreshCompletionByProjectRef.current[projectId] === completion;",
      "if (!isCurrentCompletion)",
      "if (sessionRefreshPendingRef.current.delete(projectId))",
      "startProjectSessionRefresh(projectId, true, completion)",
      "return;",
      "delete sessionRefreshCompletionByProjectRef.current[projectId];",
      "if (failed) completion.reject(error);",
      "else completion.resolve(result);",
    ],
    "shared completion lifecycle",
  );
  assert.doesNotMatch(block, /sessionRefreshPendingRetryRef|ProjectSessionRefreshCycle|ProjectSessionRefreshPhase/);
});

test("retains public signatures without assertion casts", () => {
  // listCatalog 签名扩展：options.scan=false 为纯读缓存路径（后台扫描推送回调专用），
  // onCatalogRefreshed 订阅为可选（缺省退化为纯轮询）
  assert.match(projectSync, /listCatalog: \(projectId: string, options\?: \{ scan\?: boolean \}\) => Promise<SessionRecord\[]>/);
  assert.match(projectSync, /onCatalogRefreshed\?: \(listener: \(input: \{ projectId: string \}\) => void\) => \(\) => void/);
  assert.match(projectSync, /async function refreshSessions\(projectId = activeProjectId\): Promise<SessionSummary\[]> \{/);
  assert.match(projectSync, /function refreshProjectSessions\(projectId: string, silent = false\): ProjectSessionRefreshPromise \{/);
  assert.doesNotMatch(projectSync, /\bas (?:SessionRecord|SessionSummary)\b/);
});
