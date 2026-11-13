import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

const mainEntry = mainIpcSource;
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const settingsRoot = readFileSync("src/renderer/src/components/app/SettingsFeatureRoot.tsx", "utf8");
const backgroundWatch = readFileSync("src/renderer/src/hooks/useBackgroundUpdateWatch.ts", "utf8");

test("update installation enters real quit mode and restores it only after a failed handoff", () => {
	// update 装配已迁到 startup/appUpdate.ts：退出标记改经 ctx.setIsQuitting 回填（模块级 let 仍在 index.ts）
	assert.match(mainEntry, /prepareForInstall:\s*\(\)\s*=>\s*\{[\s\S]*?setIsQuitting\(true\)/);
	assert.match(mainEntry, /rollbackInstallPreparation:\s*\(\)\s*=>\s*\{[\s\S]*?setIsQuitting\(false\)/);
});

test("renderer installation requests keep save and discard confirmation at the settings boundary", () => {
	assert.match(settingsModal, /setInstallConfirmOpen\(true\)/);
	assert.match(settingsModal, /<UpdateInstallUnsavedDialog/);
	assert.match(settingsModal, /onInstallUpdate=\{handleInstallUpdate\}/);
	assert.match(settingsRoot, /flushUpdateInstallPreflight\(updateInstallPreflightTasks\.values\(\)\)/);
	// Background notifications may open settings, but may not bypass its unsaved-work guard.
	assert.doesNotMatch(backgroundWatch, /api\.app\.installUpdate\(\)/);
});
