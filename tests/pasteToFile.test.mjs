import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 粘贴大文本 → 自动转文件 的回归测试（输入框大文本卡顿优化的端到端接线）：
 * 1) 阈值常量：仅超大粘贴（≥5000 字符）触发转文件，短文本粘贴行为不变；
 * 2) onPaste / 右键粘贴：大文本走 pasteTextToFile 落盘，不再插入 ProseMirror；
 * 3) 发送折叠：项目内文件 → @"path" 引用；匿名会话 → 原样文本内联；
 * 4) 主进程受管目录 + 路径校验：只允许写/删受管根内的文件；
 * 5) preload / atoms / UI chip / i18n 全套接线。
 */

const rendererUtils = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
const controller = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);
const pasteFilesIpc = readFileSync("src/main/ipc/pasteFilesIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const atoms = readFileSync("src/renderer/src/atoms/composer-atoms.ts", "utf8");
const panels = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("粘贴转文件阈值存在且为 5000 字符（仅超大文本触发）", () => {
  assert.match(rendererUtils, /PASTE_TO_FILE_MIN_CHARS = 5000/);
});

test("onPaste：大段纯文本（≥阈值）preventDefault 并转文件，不进编辑器", () => {
  // 分支顺序：位图检查（步骤 3）之后、普通文本放行（步骤 5）之前
  const imageBranch = controller.indexOf("getClipboardImageFiles(event.clipboardData)");
  const plainTextBranch = controller.indexOf(
    'event.clipboardData.getData("text/plain")',
  );
  const thresholdBranch = controller.indexOf("plainText.length >= PASTE_TO_FILE_MIN_CHARS");
  const pasteTextToFileBranch = controller.indexOf("void pasteTextToFile(plainText)");
  assert.ok(imageBranch >= 0, "位图分支应存在");
  assert.ok(
    plainTextBranch >= 0 && thresholdBranch >= 0 && pasteTextToFileBranch >= 0,
    "大文本转文件分支应存在（getData → 阈值判断 → pasteTextToFile）",
  );
  assert.ok(
    plainTextBranch > imageBranch,
    "大文本判断应在位图分支之后（位图优先语义不变）",
  );
});

test("右键粘贴：大段文本同样转文件并返回 true（不再交给编辑器原样插入）", () => {
  assert.match(controller, /desktopApi\.clipboard\.readText\(\)/);
  assert.match(
    controller,
    /text\.length >= PASTE_TO_FILE_MIN_CHARS/,
    "右键粘贴菜单（无 ClipboardEvent）也应有阈值分支",
  );
  assert.match(controller, /void pasteTextToFile\(text\)/);
});

test("pasteTextToFile：项目内写 .pideck-paste、chip 元数据含 inProject", () => {
  assert.match(controller, /desktopApi\.pasteFiles\.write\(/);
  // 项目根经 projectId 反查项目清单，不依赖可能缺失的 record.projectPath
  // （catalog 会话 record 的 projectPath 字段经常缺省，旧逻辑会把有项目会话
  // 误当匿名会话，导致粘贴大文本发送后被展开成普通文本）。
  assert.match(controller, /projectPath: composerProject\?\.path \?\? ""/);
  assert.match(controller, /projectByIdAtomFamily/);
  assert.match(controller, /inProject: result\.inProject/);
  assert.match(controller, /formatBytes\(result\.bytes\)/, "chip 应展示可读文件大小");
  // 写盘失败回退原样插入，粘贴内容不丢
  assert.match(controller, /insertPlainTextAtCursor\(text\)/);
});

test("发送折叠：项目内文件 → @path 引用；匿名会话 → 原样文本内联", () => {
  assert.match(controller, /file\.inProject/);
  assert.match(controller, /refs\.push\(formatFilePathRef\(file\.path\)\)/);
  assert.match(controller, /desktopApi\.files\.readContent\(file\.path\)/);
  assert.match(controller, /setPasteFiles\(\[\]\)/, "折叠后应移除 chip");
});

test("主进程：粘贴文件只写/删受管根（项目 .pideck-paste 或 userData paste-files）", () => {
  assert.match(pasteFilesIpc, /PROJECT_PASTE_DIR = "\.pideck-paste"/);
  assert.match(pasteFilesIpc, /USER_PASTE_DIR = "paste-files"/);
  assert.match(pasteFilesIpc, /isInsideManagedPasteRoot/);
  assert.match(pasteFilesIpc, /projectStore\.list\(\)\.some/);
  assert.match(pasteFilesIpc, /PASTE_FILE_RETENTION_MS/, "应有过期清理保留期");
  assert.match(pasteFilesIpc, /generatePasteFileName/, "文件名应带时间戳防冲突");
});

test("preload 暴露 pasteFiles 域（write/delete/cleanup）", () => {
  assert.match(preload, /pasteFiles: \{/);
  assert.match(preload, /pasteFilesWrite/);
  assert.match(preload, /pasteFilesDelete/);
  assert.match(preload, /pasteFilesCleanup/);
});

test("atoms：sessionPasteFilesByIdAtom + setSessionPasteFilesAtom 与附件同生命周期", () => {
  assert.match(atoms, /sessionPasteFilesByIdAtom = atom<Record<string, PastedTextFile\[\]>>/);
  assert.match(atoms, /setSessionPasteFilesAtom/);
  assert.match(atoms, /promoteSessionComposerStateAtom/, "promote 应搬迁粘贴文件");
  assert.match(atoms, /removeSessionComposerStateAtom/, "remove 应清理粘贴文件");
});

test("UI：附件栏渲染粘贴文件 chip（文件名 + 大小 + 移除），与图片同栏", () => {
  assert.match(panels, /paste-file-chip/);
  assert.match(panels, /FileText size=\{14\}/);
  assert.match(panels, /formatBytes\(file\.bytes\)/);
  assert.match(panels, /onRemovePasteFile\?\.\(index\)/);
  assert.match(composerArea, /composer\.pasteFiles\.files/);
  assert.match(composerArea, /onRemovePasteFile=\{composer\.pasteFiles\.remove\}/);
});

test("i18n：zh-CN / en-US 均含转文件提示与移除文案", () => {
  assert.match(zhCN, /"app\.pasteConvertedToFile"/);
  assert.match(zhCN, /"app\.pasteConvertFailed"/);
  assert.match(zhCN, /"app\.pasteFileRemove"/);
  assert.match(enUS, /"app\.pasteConvertedToFile"/);
  assert.match(enUS, /"app\.pasteConvertFailed"/);
  assert.match(enUS, /"app\.pasteFileRemove"/);
});
