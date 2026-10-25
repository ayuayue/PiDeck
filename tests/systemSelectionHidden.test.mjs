import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("system-wide selection is hidden and disabled by default", () => {
	const types = read("src/shared/types/selectionTool.ts");
	const main = read("src/main/index.ts");
	const normalize = read("src/main/agents/agentProfileNormalize.ts");
	const settings = read("src/renderer/src/components/app/settings/SelectionToolSettingsSection.tsx");
	const shortcuts = read("src/shared/shortcuts.ts");
	const shortcutsTab = read("src/renderer/src/components/app/settings/ShortcutsTab.tsx");
	const tips = read("src/renderer/src/components/session/sessionFeatureTips.ts");

	assert.match(types, /SYSTEM_SELECTION_TOOL_ENABLED\s*=\s*false/);
	assert.match(main, /if\s*\(\s*!SYSTEM_SELECTION_TOOL_ENABLED\s*\)/);
	assert.match(normalize, /DEFAULT_AGENT_MARKET_SETTINGS[^\n]*systemSelectionEnabled:\s*false/);
	// 设置区不再渲染系统级开关/快捷键/冲突提示。
	assert.doesNotMatch(settings, /settings\.selectionTool\.systemEnabled|common-selection-tool-system|settings\.selectionTool\.hotkey/);
	// 快捷键页隐藏该行，避免留下一个永远不注册的入口。
	assert.match(shortcuts, /id:\s*"openSelectionTool"[\s\S]{0,500}?hidden:\s*true/);
	assert.match(shortcutsTab, /def\.hidden/);
	// 功能提示不再承诺跨应用划词。
	assert.doesNotMatch(tips, /openSelectionTool/);
});
