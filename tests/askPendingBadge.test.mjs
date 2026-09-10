import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPendingAskRequest, countPendingAsksForSessions, hasPendingAskForSession } from "../src/renderer/src/utils/askUi.ts";

test("isPendingAskRequest correctly identifies pending asks vs non-ask / completed requests", () => {
  // pending select
  assert.equal(
    isPendingAskRequest({
      status: "pending",
      request: { id: "1", method: "select", question: "Choose one?" },
    }),
    true,
  );

  // pending confirm
  assert.equal(
    isPendingAskRequest({
      status: "pending",
      request: { id: "2", method: "confirm", question: "Confirm?" },
    }),
    true,
  );

  // responding batch_ask
  assert.equal(
    isPendingAskRequest({
      status: "responding",
      request: { id: "3", method: "batch_ask", questions: [] },
    }),
    true,
  );

  // completed or dismissed is not pending
  assert.equal(
    isPendingAskRequest({
      status: "completed",
      request: { id: "4", method: "input", question: "Enter name" },
    }),
    false,
  );
  assert.equal(
    isPendingAskRequest({
      status: "dismissed",
      request: { id: "5", method: "editor", question: "Edit code" },
    }),
    false,
  );

  // non-ask method (e.g. notification / custom) is not pending ask
  assert.equal(
    isPendingAskRequest({
      status: "pending",
      request: { id: "6", method: "alert", question: "Warning" },
    }),
    false,
  );

  // empty or invalid
  assert.equal(isPendingAskRequest(undefined), false);
  assert.equal(isPendingAskRequest({ status: "pending" }), false);
});

test("countPendingAsksForSessions counts total pending asks for given session IDs", () => {
  const runtimeMap = {
    "session-1": {
      requests: {
        "req-1": {
          status: "pending",
          request: { id: "req-1", method: "select", question: "Pick option" },
        },
      },
    },
    "session-2": {
      requests: {
        "req-2": {
          status: "completed",
          request: { id: "req-2", method: "confirm", question: "Done?" },
        },
      },
    },
    "session-3": {
      requests: {
        "req-3": {
          status: "responding",
          request: { id: "req-3", method: "input", question: "Your name" },
        },
      },
    },
    "session-other": {
      requests: {
        "req-4": {
          status: "pending",
          request: { id: "req-4", method: "editor", question: "Content" },
        },
      },
    },
  };

  // session-1 (pending) + session-2 (completed) -> 1
  assert.equal(countPendingAsksForSessions(["session-1", "session-2"], runtimeMap), 1);

  // session-1 (pending) + session-3 (responding) -> 2
  assert.equal(countPendingAsksForSessions(["session-1", "session-3"], runtimeMap), 2);

  // empty or no match
  assert.equal(countPendingAsksForSessions(["session-empty"], runtimeMap), 0);
  assert.equal(countPendingAsksForSessions([], runtimeMap), 0);
});

test("hasPendingAskForSession is the per-session counterpart used by the active-sessions list", () => {
  const runtimeMap = {
    "session-1": {
      requests: {
        "req-1": { status: "pending", request: { id: "req-1", method: "select", question: "Pick" } },
      },
    },
    "session-2": {
      requests: {
        "req-2": { status: "completed", request: { id: "req-2", method: "confirm", question: "Done?" } },
      },
    },
  };

  assert.equal(hasPendingAskForSession("session-1", runtimeMap), true);
  assert.equal(hasPendingAskForSession("session-2", runtimeMap), false);
  // 未加载 runtime / 无往返记录 / 未绑定会话：一律不标记，避免活动页整列误点亮
  assert.equal(hasPendingAskForSession("session-unknown", runtimeMap), false);
  assert.equal(hasPendingAskForSession(undefined, runtimeMap), false);
  assert.equal(hasPendingAskForSession("session-1", undefined), false);
});

test("SessionTree marks pending asks per session row, not only on the project header", () => {
  const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");

  // 消费 per-session 判定：同一项目下多个会话各自在等回答时，
  // 只挂项目/标题栏汇总徽章会分不清是哪个会话（用户反馈 #201 同期）。
  assert.match(sessionTree, /hasPendingAskForSession/);
  assert.match(sessionTree, /useAtomValue\(sessionRuntimeUiByIdAtom\)/);

  // 三类会话行都要标记：运行中 Agent 行、历史会话行、草稿行。
  const agentRow = /hasPendingAskForSession\(agentSession\?\.id, sessionRuntimeUiById\)/;
  const historyRow = /hasPendingAskForSession\(child\.session\.id, sessionRuntimeUiById\)/;
  const draftRow = /hasPendingAskForSession\(session\.id, sessionRuntimeUiById\)/;
  assert.match(sessionTree, agentRow, "运行中 Agent 行必须有会话级待确认标记");
  assert.match(sessionTree, historyRow, "历史会话行必须有会话级待确认标记");
  assert.match(sessionTree, draftRow, "草稿会话行必须有会话级待确认标记");

  // 与 ActiveSessionsTree / 项目行共用同一徽章组件，视觉与无障碍语义不得分叉。
  assert.match(sessionTree, /<PendingAskBadge count=\{1\} \/>/);
});
