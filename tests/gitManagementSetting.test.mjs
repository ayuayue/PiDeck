import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const appParts = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const sharedTypes = readFileSync("src/shared/types.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const i18n = readFileSync("src/renderer/src/i18n.ts", "utf8");
const styles = readFileSync("src/renderer/src/styles.css", "utf8");

describe("optional Git management entry", () => {
  test("persists an upgrade-safe enabled-by-default setting", () => {
    assert.match(sharedTypes, /enableGitManagement:\s*boolean/);
    assert.match(settingsStore, /enableGitManagement:\s*true/);
    assert.match(previewApi, /enableGitManagement:\s*true/);
    assert.match(app, /enableGitManagement:\s*true/);
  });

  test("exposes a localized settings switch", () => {
    assert.match(settingsModal, /title=\{t\("settings\.gitManagement"\)\}/);
    assert.match(settingsModal, /description=\{t\("settings\.gitManagementDesc"\)\}/);
    assert.match(settingsModal, /props\.onChange\(\{ enableGitManagement: checked \}\)/);
    assert.equal(i18n.match(/"settings\.gitManagement":/g)?.length, 2);
    assert.equal(i18n.match(/"settings\.gitManagementDesc":/g)?.length, 2);
  });

  test("places Git beside Files in the floating conversation tools", () => {
    assert.match(appParts, /filesAction\?: EntryAction;\s*gitAction\?: EntryAction;/);
    assert.match(appParts, /props\.filesAction[\s\S]*?props\.gitAction[\s\S]*?props\.editorsAction/);
    assert.match(app, /gitAction=\{settings\.enableGitManagement && activeProjectId && !isChatProject\(activeProject\) \?/);
    assert.match(app, /GIT_LOGO_URL = new URL\("\.\/assets\/git-logo\.svg"/);
    assert.match(app, /icon: <img className="git-entry-logo" src=\{GIT_LOGO_URL\}/);
    assert.match(styles, /\.git-entry\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px/);
  });

  test("removes the old header button and guards the drawer", () => {
    assert.doesNotMatch(app, /title="Git History & Compare"/);
    assert.match(app, /if \(panel === "git" && !settings\.enableGitManagement\) return/);
    assert.match(app, /settings\.enableGitManagement && drawerContentPanel === "git"/);
    assert.match(app, /current === "git" \? null : current/);
    assert.match(app, /filter\(\(\[, panel\]\) => panel !== "git"\)/);
  });
});
