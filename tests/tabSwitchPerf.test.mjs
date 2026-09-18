import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const historyReaderSource = readFileSync(
  "src/main/pi/SessionHistoryReader.ts",
  "utf8",
);
const fileServiceSource = readFileSync(
  "src/main/fs/FileSystemService.ts",
  "utf8",
);
const filesIpcSource = readFileSync("src/main/ipc/filesIpc.ts", "utf8");
const composerSource = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);

test("tab switch does not refresh the project file tree or git branches", () => {
  // 切会话只改 currentSessionId / displayAgents.length；把它们绑进 files.list
  // 会让空白新 tab 也整棵扫盘 + 巨大 IPC，两边切都会假死。
  const effectStart = appSource.indexOf(
    "setExpandedDirs(new Set());\n    void api.files",
  );
  assert.equal(
    effectStart,
    -1,
    "files.list effect must not clear expandedDirs (that belongs to project switch only)",
  );
  // 文件抽屉走 loadProjectFileTree（根层 maxDepth 0）；切会话不得把 currentSessionId 绑进扫盘。
  assert.match(appSource, /loadProjectFileTree\(/);
  assert.match(
    appSource,
    /api\.files\s*\.list\(\s*projectId,\s*\{\s*maxDepth: 0\s*\}\s*\)/,
  );
  assert.match(appSource, /api\.git\.branches\(activeProjectId\)/);
  assert.match(appSource, /\}, \[activeProjectId\]\);/);
  assert.doesNotMatch(
    appSource,
    /api\.git\.branches\(activeProjectId\)[\s\S]{0,400}\}, \[activeProjectId, currentSessionId/,
  );
});

test("solo ChatSessionPane is reused across tab switches", () => {
  // 分屏栏仍按 sessionId 挂独立实例；单栏禁止 key=currentSessionId 整栏销毁。
  const soloBlock = appSource.slice(
    appSource.indexOf("solo={"),
    appSource.indexOf("soloSessionId="),
  );
  assert.match(soloBlock, /<ChatSessionPane/);
  assert.doesNotMatch(soloBlock, /key=\{currentSessionId\}/);
  assert.match(
    appSource,
    /renderSession=\{\(sessionId\) => \(\s*<ChatSessionPane\s+key=\{sessionId\}/,
  );
});

test("file tree list is shallow by default in the drawer and accepts a scoped directory", () => {
  assert.match(fileServiceSource, /hasChildren/);
  assert.match(filesIpcSource, /maxDepth/);
  assert.match(filesIpcSource, /directory/);
  assert.match(appSource, /maxDepth:\s*0/);
  // composer @ 引用跟文件抽屉同一套懒加载，只跟项目（effectiveProjectId），不跟 sessionId
  // （@ 引用取数已从 ComposerArea 迁入 useSessionComposerController）
  assert.match(composerSource, /maxDepth:\s*0/);
  assert.match(
    composerSource,
    /desktopApi\.files\s*\.list\(\s*effectiveProjectId,\s*\{\s*maxDepth: 0\s*\}\s*\)/,
  );
  assert.match(composerSource, /\}, \[effectiveProjectId\]\);/);
});

test("session display index yields during a full rebuild", () => {
  // 2026-09 流式化：让出事件循环的实现搬进 jsonlLineStream.scanJsonlLines
  // （按 yieldEveryLines 节流），SessionHistoryReader 只负责传节拍常量。
  const jsonlLineStreamSource = readFileSync(
    "src/main/sessions/jsonlLineStream.ts",
    "utf8",
  );
  assert.match(historyReaderSource, /INDEX_PARSE_YIELD_EVERY/);
  assert.match(
    historyReaderSource,
    /yieldEveryLines: SessionHistoryReader\.INDEX_PARSE_YIELD_EVERY/,
  );
  assert.match(jsonlLineStreamSource, /setImmediate/);
  assert.match(historyReaderSource, /getSessionDisplayIndex/);
  // 不要再退回整文件读成字符串（V8 单字符串上限 / 主进程 384MB 堆上限，见 jsonlLineStream 注释）
  assert.doesNotMatch(historyReaderSource, /readFile\(/);
});
