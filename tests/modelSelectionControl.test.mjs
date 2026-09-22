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
