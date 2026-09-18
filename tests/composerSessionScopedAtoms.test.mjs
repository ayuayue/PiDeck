import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// composer-atoms.ts 唯一的跨文件值依赖是 currentSessionIdAtom（本测试不触达
// 写侧 current* 派生 atom），stub 掉以免拖入 session-atoms → desktopApi 整张图。
const composerAtoms = loadTsCommonJs("src/renderer/src/atoms/composer-atoms.ts", {
  stubs: {
    "./session-atoms": { currentSessionIdAtom: { debugLabel: "currentSessionIdAtom" } },
  },
});

test("sessionDraftBySessionIdAtomFamily：写别的会话不通知本会话订阅者", () => {
  const store = createStore();
  let notifyCount = 0;
  const draftA = composerAtoms.sessionDraftBySessionIdAtomFamily("session-a");
  store.sub(draftA, () => { notifyCount += 1; });

  store.set(composerAtoms.setSessionDraftAtom, { sessionId: "session-b", value: "hello" });
  assert.equal(notifyCount, 0, "B 栏打字不得通知 A 栏订阅者");

  store.set(composerAtoms.setSessionDraftAtom, { sessionId: "session-a", value: "typing" });
  assert.equal(notifyCount, 1);
  assert.equal(store.get(draftA), "typing");
});

test("attachments/pasteFiles 默认值稳定：未写过的会话跨写不重发通知", () => {
  const store = createStore();
  const attachmentsA = composerAtoms.sessionAttachmentsBySessionIdAtomFamily("session-a");
  let attachmentsNotify = 0;
  store.sub(attachmentsA, () => { attachmentsNotify += 1; });
  // JSON 往返剥离 VM 沙箱 realm 原型，与 piRuntimeThinkingAtoms.test.mjs 同手法
  assert.deepEqual(JSON.parse(JSON.stringify(store.get(attachmentsA))), []);

  // 给 B 写一个新数组：A 的 select 重算必须返回同一个 EMPTY 常量（Object.is 相等）
  store.set(composerAtoms.setSessionAttachmentsAtom, { sessionId: "session-b", value: [{}] });
  assert.equal(attachmentsNotify, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(store.get(attachmentsA))), []);

  const pasteFilesB = composerAtoms.sessionPasteFilesBySessionIdAtomFamily("session-b");
  assert.deepEqual(JSON.parse(JSON.stringify(store.get(pasteFilesB))), []);
});

test("sendState/mode/quotes family：默认值与缺省读取", () => {
  const store = createStore();
  const sendStateA = composerAtoms.sessionSendStateBySessionIdAtomFamily("session-a");
  assert.deepEqual(JSON.parse(JSON.stringify(store.get(sendStateA))), { status: "idle" });

  const modeA = composerAtoms.sessionComposerModeBySessionIdAtomFamily("session-a");
  assert.equal(store.get(modeA), undefined);

  const quotesA = composerAtoms.sessionQuotesBySessionIdAtomFamily("session-a");
  assert.equal(store.get(quotesA), undefined);
  let quotesNotify = 0;
  store.sub(quotesA, () => { quotesNotify += 1; });
  store.set(composerAtoms.setSessionQuotesAtom, { sessionId: "session-b", value: {} });
  assert.equal(quotesNotify, 0);
});

test("idleSessionSendState 常量导出且跨读相等（供 runtime 控制器复用）", () => {
  assert.equal(composerAtoms.idleSessionSendState, composerAtoms.idleSessionSendState);
  assert.deepEqual(JSON.parse(JSON.stringify(composerAtoms.idleSessionSendState)), { status: "idle" });
});
