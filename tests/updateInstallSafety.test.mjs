import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainEntry = readFileSync("src/main/index.ts", "utf8");
const settingsModal = readFileSync(
  "src/renderer/src/components/app/SettingsModal.tsx",
  "utf8",
);
const settingsRoot = readFileSync(
  "src/renderer/src/components/app/SettingsFeatureRoot.tsx",
  "utf8",
);
const backgroundWatch = readFileSync(
  "src/renderer/src/hooks/useBackgroundUpdateWatch.ts",
  "utf8",
);

test("update installation enters real quit mode and restores it only after a failed handoff", () => {
  assert.match(
    mainEntry,
    /prepareForInstall:\s*\(\)\s*=>\s*\{[\s\S]*?isQuitting = true;/,
  );
  assert.match(
    mainEntry,
    /rollbackInstallPreparation:\s*\(\)\s*=>\s*\{[\s\S]*?isQuitting = false;/,
  );
});

test("renderer installation requests keep save and discard confirmation at the settings boundary", () => {
  assert.match(settingsModal, /setInstallConfirmOpen\(true\)/);
  assert.match(settingsModal, /<UpdateInstallUnsavedDialog/);
  assert.match(settingsModal, /onInstallUpdate=\{handleInstallUpdate\}/);
  assert.match(settingsRoot, /flushUpdateInstallPreflight\(updateInstallPreflightTasks\.values\(\)\)/);
  // Background notifications may open settings, but may not bypass its unsaved-work guard.
  assert.doesNotMatch(backgroundWatch, /api\.app\.installUpdate\(\)/);
});
