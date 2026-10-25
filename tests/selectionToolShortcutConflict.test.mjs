import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

// 系统级划词暂时隐藏（SYSTEM_SELECTION_TOOL_ENABLED=false），设置页不再展示快捷键冲突警告；
// 但「登记冲突 -> 去重发通知 -> focus 重试」的管道必须留在原地，恢复开关后即可用。
test("system selection shortcut conflict plumbing survives while the feature is hidden", () => {
	const main = read("src/main/index.ts");
	const service = read("src/main/selection/SelectionToolService.ts");
	const shared = read("src/shared/types/selectionTool.ts");
	const settings = read("src/renderer/src/components/app/settings/SelectionToolSettingsSection.tsx");
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");

	// 登记冲突 -> emitAgentsNotice（同一 accelerator 去重），窗口 focus 重试补发。
	assert.match(main, /notifySelectionShortcutConflict\(\s*accelerator\s*\)/);
	assert.match(main, /i18nKey:\s*"selectionTool\.shortcutConflict"/);
	assert.match(main, /browser-window-focus/);
	assert.match(main, /flushSelectionShortcutConflictNotice/);
	assert.match(main, /clearSelectionShortcutConflict\(\s*\)/);

	// 开关关闭时既不注册也不发通知：早退分支先清空登记，避免旧冲突提示残留。
	assert.match(main, /if \(!SYSTEM_SELECTION_TOOL_ENABLED\) \{[\s\S]{0,300}?clearSelectionShortcutConflict\(\);/);

	// 状态查询仍带注册结果，供恢复开关后的设置页判定（当前 UI 不渲染）。
	assert.match(shared, /shortcutRegistered\?:\s*boolean/);
	assert.match(shared, /shortcut\?:\s*string\s*\|\s*null/);
	assert.match(service, /shortcutRegistered:\s*this\.accelerator !== null/);

	// 设置页已移除冲突警告与状态查询（系统级入口整体隐藏）。
	assert.doesNotMatch(settings, /shortcutRegistered\s*===\s*false/);
	assert.doesNotMatch(settings, /settings\.selectionTool\.shortcutConflict/);
	assert.doesNotMatch(settings, /desktopApi\.selectionTool\s*\.getState\(\)/);

	// 中英文案保留（主进程通知与恢复后的 UI 都要用）；zh-TW 由生成器负责。
	for (const source of [zh, en]) {
		assert.match(source, /"selectionTool\.shortcutConflict":/);
		assert.match(source, /"settings\.selectionTool\.shortcutConflict":/);
	}
});
