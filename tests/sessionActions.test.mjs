import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/renderer/src/hooks/useSessionActions.ts",
  "utf8",
);
const drawerSource = readFileSync(
  "src/renderer/src/components/workspace/DrawerSurface.tsx",
  "utf8",
);

function functionBlock(name, nextName) {
  const start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf(`  async function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} implementation should be discoverable`);
  assert.notEqual(end, -1, `${nextName} boundary should be discoverable`);
  return source.slice(start, end);
}

function syncFunctionBlock(name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const syncEnd = source.indexOf(`  function ${nextName}(`, start + 1);
  const asyncEnd = source.indexOf(`  async function ${nextName}(`, start + 1);
  const end =
    syncEnd === -1
      ? asyncEnd
      : asyncEnd === -1
        ? syncEnd
        : Math.min(syncEnd, asyncEnd);
  assert.notEqual(start, -1, `${name} implementation should be discoverable`);
  assert.notEqual(end, -1, `${nextName} boundary should be discoverable`);
  return source.slice(start, end);
}

function assertInOrder(subject, fragments, message) {
  let previousIndex = -1;
  for (const fragment of fragments) {
    const index = subject.indexOf(fragment, previousIndex + 1);
    assert.notEqual(index, -1, `${message}: missing ${fragment}`);
    assert.ok(index > previousIndex, `${message}: ${fragment} is out of order`);
    previousIndex = index;
  }
}

const commitSelection = () =>
  syncFunctionBlock("commitSessionSelection", "selectProject");
const selectProject = () =>
  syncFunctionBlock("selectProject", "selectSession");
const selectSession = () =>
  syncFunctionBlock("selectSession", "copySession");
const openBySummary = () =>
  functionBlock("openSidebarSession", "openSidebarSessionById");
const openById = () =>
  functionBlock("openSidebarSessionById", "copySidebarSession");
const createDraft = () => {
  const start = source.indexOf("  async function createSessionDraft(");
  const end = source.indexOf("\n  return {", start + 1);
  assert.notEqual(start, -1, "createSessionDraft implementation should be discoverable");
  assert.notEqual(end, -1, "useSessionActions return boundary should be discoverable");
  return source.slice(start, end);
};

test("accepts a cached session only when it belongs to the requested project", () => {
  const block = openBySummary();

  assert.equal(
    block.match(/getSessionRecord\(session\.id\)/g)?.length,
    1,
    "the cached record should be read once",
  );
  assertInOrder(
    block,
    [
      "const cachedRecord = getSessionRecord(session.id);",
      "cachedRecord?.projectId === projectId",
      "? cachedRecord",
      ": getProjectSessionRecords(projectId).find(",
      "if (!record)",
      "await refreshProjectSessions(projectId, true)",
    ],
    "project identity fallback",
  );
});

test("keeps request sequencing and stale-result gates around catalog fallback", () => {
  const block = openBySummary();

  assertInOrder(
    block,
    [
      "const requestSequence = ++openSessionRequestRef.current;",
      "const cachedRecord = getSessionRecord(session.id);",
      "await refreshProjectSessions(projectId, true);",
      "if (requestSequence !== openSessionRequestRef.current) return undefined;",
      "record = getProjectSessionRecords(projectId).find(",
    ],
    "catalog stale gate",
  );
  assert.match(
    block,
    /catch \(error\) \{\s*if \(requestSequence !== openSessionRequestRef\.current\) return undefined;\s*showToast/,
  );
  assert.match(
    block,
    /if \(!record \|\| requestSequence !== openSessionRequestRef\.current\) return undefined;\s*commitSessionSelection/,
  );
});

test("keeps by-ID fallback project-scoped after canonical refresh", () => {
  const block = openById();

  assertInOrder(
    block,
    [
      "const requestSequence = ++openSessionRequestRef.current;",
      "let record: SessionRecord | undefined = getSessionRecord(sessionId);",
      "if (!record || record.projectId !== projectId)",
      "await refreshProjectSessions(projectId, true);",
      "if (requestSequence !== openSessionRequestRef.current) return undefined;",
      "record = getProjectSessionRecords(projectId).find(",
      "(candidate) => candidate.id === sessionId",
      "if (!record || requestSequence !== openSessionRequestRef.current) return undefined;",
      "commitSessionSelection(projectId, record.id, true);",
    ],
    "by-ID catalog fallback",
  );
  assert.match(
    block,
    /catch \(error\) \{\s*if \(requestSequence !== openSessionRequestRef\.current\) return undefined;\s*showToast/,
  );
});

test("matches both project and catalog paths with each candidate environment", () => {
  const block = openBySummary();
  const environmentMatches = block.match(
    /isSameSessionPath\(\s*candidate\.filePath,\s*session\.filePath,\s*candidate\.environment,?\s*\)/g,
  );

  assert.equal(
    environmentMatches?.length,
    2,
    "project and catalog fallbacks must preserve WSL path semantics",
  );
});

test("selectProject invalidates requests before replacing the active selection", () => {
  assertInOrder(
    selectProject(),
    [
      "++openSessionRequestRef.current;",
      "commitSessionSelection(projectId, undefined, false);",
    ],
    "project selection command",
  );
  assertInOrder(
    commitSelection(),
    [
      "setActiveProjectId(projectId);",
      "setCurrentSessionId(sessionId);",
    ],
    "project selection commit",
  );
});

test("selectSession invalidates requests and can preserve the current scroll setting", () => {
  assertInOrder(
    selectSession(),
    [
      "++openSessionRequestRef.current;",
      "commitSessionSelection(projectId, sessionId, scrollToEnd);",
    ],
    "session selection command",
  );
  assert.match(
    commitSelection(),
    /scrollToEnd/,
  );
  // scrollToEnd is delegated to useSessionTimelineController; the legacy auto-scroll
  // ports (setAutoScroll / autoScrollRef) must not appear anywhere in this file.
  assert.doesNotMatch(
    source,
    /\bsetAutoScroll\b|\bautoScrollRef\b/,
    "legacy auto-scroll ports must not leak into useSessionActions",
  );
});

test("open paths commit after the stale gate without invalidating again", () => {
  for (const [name, block] of [
    ["openSidebarSession", openBySummary()],
    ["openSidebarSessionById", openById()],
  ]) {
    assertInOrder(
      block,
      [
        "if (!record || requestSequence !== openSessionRequestRef.current) return undefined;",
        "commitSessionSelection(projectId, record.id, true);",
      ],
      `${name} stale gate and selection`,
    );
    assert.equal(
      block.match(/\+\+openSessionRequestRef\.current/g)?.length,
      1,
      `${name} should invalidate only when opening starts`,
    );
  }
});

test("focuses the composer after publishing a new draft selection", () => {
  const block = createDraft();

  assertInOrder(
    block,
    [
      "upsertSession(session);",
      "commitSessionSelection(projectId, session.id, true);",
            "creatingSessionDraftRef.current.delete(projectId);",
    ],
    "draft selection and focus",
  );
});

test("uses only the canonical project refresh port", () => {
  assert.match(
    source,
    /export type RefreshProjectSessions = \(\s*projectId: string,\s*silent\?: boolean,?\s*\) => Promise<SessionSummary\[\] \| SessionRecord\[\] \| undefined>;/,
  );
  assert.match(source, /refreshProjectSessions: RefreshProjectSessions;/);
  assert.doesNotMatch(source, /\bRefreshSessions\b|\brefreshSessions\b/);
  assert.doesNotMatch(source, /sessions\.listCatalog|replaceProjectSessions/);
  assert.doesNotMatch(source, /\bnoCache\b/);
  assert.doesNotMatch(
    source,
    /\b(?:setProjectMenu|setSessionHistoryLoading|setSessionLoadingByProject)\b/,
  );

  const copy = functionBlock("copySession", "exportHistorySession");
  const remove = functionBlock("deleteHistorySession", "archiveHistorySession");
  const archive = functionBlock("archiveHistorySession", "unarchiveHistorySession");
  const unarchive = functionBlock("unarchiveHistorySession", "listArchivedSessions");
  // 每个会话操作（复制/删除/归档/恢复）都只经 canonical 刷新端口触发一次列表刷新
  assert.equal(copy.match(/refreshProjectSessions\(/g)?.length, 1);
  assert.equal(remove.match(/refreshProjectSessions\(/g)?.length, 1);
  assert.equal(archive.match(/refreshProjectSessions\(/g)?.length, 1);
  assert.equal(unarchive.match(/refreshProjectSessions\(/g)?.length, 1);
});

test("DSH delete toast no longer claims host data stays mapped", () => {
  const remove = functionBlock("deleteHistorySession", "archiveHistorySession");
  assert.doesNotMatch(remove, /session\.deletedDshKeepData/);
  assert.match(remove, /app\.sessionDeleted/);
});

test("archive toast points users at the restore location by backend", () => {
  assert.match(source, /export function archivedSessionToastMessage/);
  assert.match(source, /app\.sessionArchivedDsh/);
  assert.match(source, /app\.sessionArchived/);
  const archive = functionBlock("archiveHistorySession", "unarchiveHistorySession");
  assert.match(archive, /archivedSessionToastMessage\(session\)/);
  assert.match(archive, /ARCHIVED_SESSION_TOAST_MS/);
  assert.doesNotMatch(archive, /t\("app\.sessionArchived"\)/);
});

test("copy and export address the Catalog by stable Session ID", () => {
  const copy = functionBlock("copySession", "exportHistorySession");
  const historyExport = functionBlock("exportHistorySession", "deleteHistorySession");
  const sidebarCopy = functionBlock("copySidebarSession", "exportSidebarSession");
  const sidebarExport = functionBlock("exportSidebarSession", "createSessionDraft");
  assert.match(copy, /api\.sessions\.copyRecord\(sessionId\)/);
  assert.match(historyExport, /api\.sessions\.exportRecordHtml\(session\.id\)/);
  assert.match(sidebarCopy, /copySession\(session\.id, projectId\)/);
  assert.match(sidebarExport, /api\.sessions\.exportRecordHtml\(session\.id\)/);
  assert.doesNotMatch(source, /api\.sessions\.(?:copy|exportHtml|readMessages)\(/);
  assert.doesNotMatch(source, /resolveSessionRefs/);
});

test("history drawer copies the Catalog record by stable Session ID", () => {
  assert.match(
    drawerSource,
    /runCopySession\(\s*session\.id,\s*files\.sessionsProjectId/,
  );
  assert.doesNotMatch(
    drawerSource,
    /runCopySession\(\s*session\.filePath/,
  );
});

// 归档/删除必须先关 Tab（closeTab 依赖 currentSessionId 仍指向被归档会话才能切到邻居），
// 再清 session/composer；并且要把 parentSessionPath / sibling-dir 子会话一起清掉。
// 否则聚焦会话被 removeSessionState 置空后只剩 ProjectEmptyState 的残留聊天框，
// 子 agent 还会以孤儿顶层行重新打开。
test("archive and delete dismiss the session tree and close tabs before dropping state", () => {
  assert.match(source, /closeTabs: \(sessionIds: string\[\]\) => void/);
  assert.match(source, /collectSessionSubtreeIds/);
  assert.match(source, /dismissSessionTree/);

  const dismiss = syncFunctionBlock("dismissSessionTree", "deleteHistorySession");
  assertInOrder(
    dismiss,
    [
      "closeTabs(ids)",
      "removeSessionState",
      "removeSessionComposerState",
    ],
    "dismissSessionTree must close tabs before dropping session state",
  );

  const remove = functionBlock("deleteHistorySession", "archiveHistorySession");
  const archive = functionBlock("archiveHistorySession", "unarchiveHistorySession");
  for (const [name, block] of [["delete", remove], ["archive", archive]]) {
    assert.match(block, /dismissSessionTree\(/, `${name} should dismiss the whole session tree`);
  }
});
