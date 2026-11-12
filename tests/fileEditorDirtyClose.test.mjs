import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

/**
 * Wave 5 文件域契约：dirty tab 关闭保护 + 保存失败可见化。
 *
 * 背景（docs/ui-commercialization-plan.md Wave 5）：
 * - 关闭路径（Tab X / 内容区关闭钮）此前直通 closeEditorTab，dirty tab 静默丢改动；
 * - 保存失败只写普通 div，无 alert 语义无重试钮，用户不知道失败过。
 *
 * 这里用源码契约锁实现结构（同 editorTabs.test.mjs 的做法）：
 * 行为测试在 Electron 环境（webcontents/IPC）不可行，结构性断言已能拦住
 * 「删掉 gate 直通关闭」「横幅退回普通 div」这两类回归。
 */

const fileDiffViewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
const useFileEditor = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const app = rendererAppSource;
const workbenchContent = readFileSync("src/renderer/src/components/workspace/WorkbenchContent.tsx", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");

test("FileDiffViewer：dirty 翻转上报宿主（只在翻转时回调，不随击键）", () => {
	assert.match(fileDiffViewer, /onDirtyChange\?: \(dirty: boolean\) => void;/);
	assert.match(fileDiffViewer, /const reportDirty = \(next: boolean\) =>/);
	assert.match(fileDiffViewer, /props\.onDirtyChange\?\.\(next\)/);
});

test("FileDiffViewer：保存失败是 role=alert 横幅 + 显式重试，不再是静默 error div", () => {
	assert.match(fileDiffViewer, /const \[saveError, setSaveError\] = useState<string \| null>\(null\);/);
	// 冲突（PROJECT_FILE_CHANGED）与普通失败分开：冲突要求重新加载，不能被当成可重试的普通错误。
	assert.match(fileDiffViewer, /const conflict = e instanceof Error && e\.message\.includes\("PROJECT_FILE_CHANGED"\)/);
	assert.match(fileDiffViewer, /setSaveError\(conflict \? t\("editor\.fileChangedOnDisk"\) : fileLoadErrorMessage\(e\)\)/);
	assert.match(fileDiffViewer, /role="alert"/);
	assert.match(fileDiffViewer, /editor\.saveFailedBanner/);
	// 重试按钮触发的是 saveNow（内容取 contentRef 最新值），不是重新加载
	assert.match(fileDiffViewer, /onClick=\{\(\) => void saveNow\(\)\}/);
});

test("useFileEditor：维护 dirtyEditorTabIds 集合，关闭 tab 时同步摘除", () => {
	assert.match(useFileEditor, /markEditorTabDirty: \(tabId: string, dirty: boolean\) => void;/);
	assert.match(useFileEditor, /isEditorTabDirty: \(tabId: string\) => boolean;/);
	assert.match(useFileEditor, /dirtyEditorTabIdsRef\.current\.has\(tabId\)\) markEditorTabDirty\(tabId, false\)/);
});

test("App：三条关闭路径都过 requestCloseEditorTab gate（dirty → 确认框）", () => {
	assert.match(app, /const requestCloseEditorTab = \(id: string\) =>/);
	assert.match(app, /if \(!isEditorTabDirty\(id\)\)/);
	assert.match(app, /editor\.dirtyCloseTitle/);
	// closeWorkbenchTab（simple X）、onCloseEditorTab（tab 模式 X）、onCloseEditor（内容区关闭钮）
	const closeWorkbench = app.slice(app.indexOf("const closeWorkbenchTab"), app.indexOf("const closeWorkbenchTab") + 400);
	assert.match(closeWorkbench, /requestCloseEditorTab\(id\)/);
	const editorTabClose = app.slice(app.indexOf("onCloseEditorTab="), app.indexOf("onCloseEditorTab=") + 300);
	assert.match(editorTabClose, /requestCloseEditorTab\(tabId\)/);
	const closeEditorBtn = app.slice(app.indexOf("onCloseEditor={() =>"), app.indexOf("onCloseEditor={() =>") + 300);
	assert.match(closeEditorBtn, /requestCloseEditorTab\(activeTab\.id\)/);
});

test("WorkbenchContent：onDirtyChange 透传到每个 FileDiffViewer", () => {
	assert.match(workbenchContent, /onDirtyChange: \(id: string, dirty: boolean\) => void;/);
	assert.match(workbenchContent, /onDirtyChange=\{\(dirty\) => props\.onDirtyChange\(tab\.id, dirty\)\}/);
});

test("词典：关闭确认与保存失败文案三语齐全", () => {
	assert.match(zhCopy, /"editor\.dirtyCloseTitle"/);
	assert.match(zhCopy, /"editor\.dirtyCloseMessage"/);
	assert.match(zhCopy, /"editor\.saveFailedBanner"/);
	assert.match(zhCopy, /"editor\.fileChangedOnDisk"/);
});
