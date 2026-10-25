import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const root = readFileSync("src/renderer/src/components/app/SettingsFeatureRoot.tsx", "utf8");
const sidebar = readFileSync("src/renderer/src/components/sidebar/AppSidebar.tsx", "utf8");
const sessionRuntime = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
const piUpdate = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
const gitPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

// Opening Settings must not subscribe or write local overlay state in App.
test("Settings overlay visibility belongs to feature consumers", () => {
	assert.doesNotMatch(app, /\[settingsOpen,\s*setSettingsOpen\]/);
	assert.doesNotMatch(app, /<SettingsModal/);
	assert.match(app, /<SettingsFeatureRoot/);
	assert.match(root, /useAtomValue\(settingsOpenAtom\)/);
	assert.match(root, /useSetAtom\(settingsOpenAtom\)/);
	assert.match(sidebar, /useSetAtom\(settingsOpenAtom\)/);
	assert.match(sessionRuntime, /useAtomValue\(settingsOpenAtom\)/);
	assert.match(piUpdate, /useSetAtom\(settingsOpenAtom\)/);
	// Git「去设置」走带焦点的 openSettingsAtom，避免只开弹窗却停在上次 tab
	assert.match(gitPanel, /useSetAtom\(openSettingsAtom\)/);
	assert.match(root, /settingsFocusAtom/);
});

// AppSettings remains canonical in App; the modal root only consumes it.
test("Settings feature does not create an AppSettings mirror", () => {
	assert.doesNotMatch(root, /useState\s*<\s*AppSettings/);
	// 稳定 props 走字段级 useMemo：settings 仍来自 App 传入的 props.settings，不镜像
	assert.match(root, /settings: props\.settings/);
	assert.match(root, /onChange: props\.onChange/);
});
