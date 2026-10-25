import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingRows = readFileSync("src/renderer/src/components/app/settings/SettingRows.tsx", "utf8");
const gitTab = readFileSync("src/renderer/src/components/app/settings/GitTab.tsx", "utf8");
const visionTab = readFileSync("src/renderer/src/components/app/settings/VisionBridgeSettingsTab.tsx", "utf8");

test("settings model selection uses one clearable right-side control", () => {
	assert.match(settingRows, /export function SettingsModelPickerControl/);
	assert.match(settingRows, /<ChevronsUpDown/);
	assert.match(settingRows, /t\("common\.clear"\)/);
	assert.match(settingRows, /onMouseDown=\{/);

	for (const source of [gitTab, visionTab]) {
		assert.match(source, /<SettingsModelPickerControl/);
		assert.match(source, /onClear=\{\(\) =>/);
		assert.doesNotMatch(source, /<ModelPicker[\s\S]*onClear=/);
	}
});

// 设置页四个模型选择器（提示词增强/输入预测、视觉桥接、微信优先级链、git 提交信息）都要显示收藏：
// 前三者走 hooks/useFavoriteModels（打开前重读 + 切换落盘），git 页走 SettingsModal 草稿。
const wechatSection = readFileSync("src/renderer/src/components/app/settings/WeChatSection.tsx", "utf8");
const fixedRows = readFileSync("src/renderer/src/components/app/settings/FixedModelSettingRows.tsx", "utf8");

test("settings model pickers show the real favorites instead of a dead star", () => {
	for (const source of [fixedRows, visionTab, wechatSection]) {
		assert.doesNotMatch(source, /favoriteModels=\{\[\]\}/, "不得再传空收藏（星标永远空心且点了没反应）");
		assert.match(source, /\{ favoriteModels, refreshFavoriteModels, toggleFavorite \} = useFavoriteModels\(\)/);
		assert.match(source, /favoriteModels=\{favoriteModels\}/);
		assert.match(source, /onToggleFavorite=\{toggleFavorite\}/);
		assert.match(source, /await refreshFavoriteModels\(\)/, "打开选择器前要以磁盘为准重读收藏");
	}
	assert.match(gitTab, /favoriteModels=\{draft\.favoriteModels \?\? \[\]\}/);
	assert.match(gitTab, /onToggleFavorite=\{props\.onToggleGitModelFavorite\}/);
});
