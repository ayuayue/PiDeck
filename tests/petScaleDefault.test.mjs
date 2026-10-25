import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const petTab = readFileSync("src/renderer/src/components/app/settings/PetTab.tsx", "utf8");
const petIndex = readFileSync("src/main/pet/index.ts", "utf8");
const petMain = readFileSync("src/renderer/src/pet/main.tsx", "utf8");

test("pet scale factory default is 30% (0.3), not 100%", () => {
	assert.match(settingsType, /export const DEFAULT_PET_SCALE = 0\.3;/);
	assert.match(store, /petScale: DEFAULT_PET_SCALE,/);
	// App 首屏默认值已抽到 shared/types/settings.ts 的 createDefaultAppSettings；settings.ts 已在 settingsType 里
	assert.match(settingsType, /petScale: DEFAULT_PET_SCALE,/);
	assert.match(preview, /petScale: DEFAULT_PET_SCALE,/);
	assert.match(petTab, /draft\.petScale \?\? DEFAULT_PET_SCALE/);
	assert.match(petIndex, /s\.petScale \?\? DEFAULT_PET_SCALE/);
	assert.match(petMain, /s\.petScale \?\? DEFAULT_PET_SCALE/);
	// 缺省回退禁止再写字面量 1，避免新用户看到 100% 大宠。
	assert.doesNotMatch(store, /petScale:\s*1\b/);
	assert.doesNotMatch(app, /petScale:\s*1\b/);
	assert.doesNotMatch(preview, /petScale:\s*1\b/);
});
