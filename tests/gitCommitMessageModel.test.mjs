import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const settingsTypes = readFileSync("src/shared/types/settings.ts", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const fileSortControl = readFileSync("src/renderer/src/components/session/FileSortControl.tsx", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const projectEmptyState = readFileSync("src/renderer/src/components/session/ProjectEmptyState.tsx", "utf8");
const commandPicker = readFileSync("src/renderer/src/components/ui-shadcn/command-picker.tsx", "utf8");
const i18n = [
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
  readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8"),
].join("\n");

test("Git summary stores an explicit provider and model without a legacy fallback", () => {
  assert.match(settingsTypes, /gitCommitMessageProvider:\s*string/);
  assert.match(settingsTypes, /gitCommitMessageModel:\s*string/);
  assert.match(settingsStore, /gitCommitMessageProvider:\s*""/);
  assert.match(settingsStore, /gitCommitMessageModel:\s*""/);
  assert.match(gitIpc, /gitCommitMessageProvider\.trim\(\)/);
  assert.match(gitIpc, /gitCommitMessageModel\.trim\(\)/);
  assert.match(gitIpc, /git\.commitMessageModelRequired/);
});

test("Git summary selects the configured model while retaining the lightweight RPC flags", () => {
  assert.match(gitIpc, /type:\s*"set_model"[\s\S]*provider: model\.provider[\s\S]*modelId: model\.modelId/);
  for (const flag of [
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--thinking",
  ]) {
    assert.match(gitIpc, new RegExp(`"${flag}"`));
  }
  assert.match(gitIpc, /"--thinking",\s*"off"/);
  assert.match(gitIpc, /provider\/model 变化时必须重启轻量进程/);
  assert.match(gitIpc, /if \(genProcess === childProcess\) stopGenProcess\(\)/);
});

test("File sorting leaves hover state to Radix DropdownMenu", () => {
  assert.match(fileSortControl, /<DropdownMenu open=\{open\} onOpenChange=\{setOpen\}>/);
  assert.doesNotMatch(fileSortControl, /onMouseEnter|onMouseLeave|closeTimerRef/);
});

test("Shared model picker keeps one model line and supports collapse and selected-item positioning", () => {
  assert.match(composerComponents, /<CommandPickerGroup id=\"favorites\"/);
  assert.doesNotMatch(composerComponents, /picker-palette-label.*model\.name/);
  assert.match(commandPicker, /showGroupActions/);
  assert.match(commandPicker, /search\.trim\(\) \? <CommandEmpty/);
  assert.match(commandPicker, /scrollIntoView\(\{ block: \"center\" \}\)/);
  assert.match(projectEmptyState, /<CommandPickerPanel/);
  assert.match(projectEmptyState, /showGroupActions/);
});


test("Git summary settings expose the shared command model picker", () => {
  assert.match(settingsModal, /projects\.listModels\(\)/);
  assert.match(settingsModal, /ModelPicker/);
  assert.match(settingsModal, /gitModelPickerOpen/);
  assert.doesNotMatch(settingsModal, /<datalist/);
  assert.doesNotMatch(settingsModal, /git-commit-message-providers/);
  assert.doesNotMatch(settingsModal, /git-commit-message-models/);
  assert.match(settingsModal, /gitCommitMessageProvider/);
  assert.match(settingsModal, /gitCommitMessageModel/);
  assert.equal(i18n.match(/"settings\.gitCommitMessageModel":/g)?.length, 2);
  assert.equal(i18n.match(/"settings\.gitCommitMessageModelUnset":/g)?.length, 2);
  assert.match(i18n, /git\.commitMessageModelRequired/);
});

test("Git IPC receives the localized settings guidance from the main process", () => {
  assert.match(gitIpc, /mainCopy: \(key: string/);
  assert.match(mainIndex, /registerGitIpc\(\{[\s\S]*mainCopy: mainCopy/);
});
