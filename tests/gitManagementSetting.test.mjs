import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const app = [
  readFileSync("src/renderer/src/App.tsx", "utf8"),
  readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8"),
  readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8"),
].join("\n");
const appParts = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
const gitTab = readFileSync("src/renderer/src/components/app/settings/GitTab.tsx", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const sharedTypes = [
  readFileSync("src/shared/types.ts", "utf8"),
  readFileSync("src/shared/types/settings.ts", "utf8"),
].join("\n");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const i18n = [
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
].join("\n");
const styles = readRendererStyles();

describe("optional Git management entry", () => {
  test("persists an upgrade-safe enabled-by-default setting", () => {
    assert.match(sharedTypes, /enableGitManagement:\s*boolean/);
    assert.match(settingsStore, /enableGitManagement:\s*true/);
    assert.match(previewApi, /enableGitManagement:\s*true/);
    assert.match(app, /enableGitManagement:\s*true/);
  });

  test("exposes a localized settings switch", () => {
    // 开关位于独立 Git 设置 tab（GitTab，自常用设置拆分）
    assert.match(gitTab, /title=\{t\("settings\.gitManagement"\)\}/);
    assert.match(gitTab, /description=\{t\("settings\.gitManagementDesc"\)\}/);
    assert.match(gitTab, /updateDraft\(\{ enableGitManagement: checked \}\)/);
    assert.equal(i18n.match(/"settings\.gitManagement":/g)?.length, 2);
    assert.equal(i18n.match(/"settings\.gitManagementDesc":/g)?.length, 2);
  });

  test("Git entry lives in the drawer rail, not the floating conversation tools", () => {
    // 悬浮栏（outline）不再暴露 git 入口；git 收进抽屉活动栏，受同一开关门控
    // 悬浮栏已移除 files/git/browser action props；这些入口由抽屉活动栏统一承载
    assert.doesNotMatch(appParts, /\b(?:filesAction|gitAction|browserAction)\b/);
    assert.doesNotMatch(app, /(?:filesAction|gitAction|browserAction)=/);
    assert.match(app, /\.\.\.\(settings\.enableGitManagement && activeProjectId \? \[\{[\s\S]*?id: "git"[\s\S]*?icon: <GitBranch\s+size=\{16\}/);
    // 抽屉活动栏按钮与 outline 共用同一套切换语义（handleToolDrawerAction）
    assert.match(app, /onClick: \(\) => handleToolDrawerAction\("git"\)/);
  });

  test("removes the old header button and guards the drawer", () => {
    assert.doesNotMatch(app, /title="Git History & Compare"/);
    assert.match(app, /if \(panel === "git" && !settings\.enableGitManagement\) return/);
    assert.match(app, /enableGitManagement && drawer === "git"/);
    assert.match(app, /current === "git" \? null : current/);
    assert.match(app, /filter\(\(\[, panel\]\) => panel !== "git"\)/);
  });
});
