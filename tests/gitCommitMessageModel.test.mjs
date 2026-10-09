import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const settingsTypes = readFileSync("src/shared/types/settings.ts", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const gitTab = readFileSync("src/renderer/src/components/app/settings/GitTab.tsx", "utf8");
const gitPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const gitAtoms = readFileSync("src/renderer/src/atoms/git-atoms.ts", "utf8");
const settingsAtoms = readFileSync("src/renderer/src/atoms/app-ui-atoms.ts", "utf8");
const settingsFocusHook = readFileSync("src/renderer/src/components/app/settings/useSettingsFocus.ts", "utf8");
const gitModelsHook = readFileSync("src/renderer/src/components/app/settings/gitModels.ts", "utf8");
const fileSortControl = readFileSync("src/renderer/src/components/session/FileSortControl.tsx", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const modelThinkingChip = readFileSync("src/renderer/src/components/session/ModelThinkingChip.tsx", "utf8");
const projectEmptyState = readFileSync("src/renderer/src/components/session/ProjectEmptyState.tsx", "utf8");
const commandPicker = readFileSync("src/renderer/src/components/ui-shadcn/command-picker.tsx", "utf8");
const i18n = [readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"), readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"), readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8")].join("\n");

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
	for (const flag of ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--thinking"]) {
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
	// 折叠策略已抽为纯函数：分组展开态经 resolveGroupExpanded（defaultExpandedIds +
	// 用户 toggle 的 selection 合成），批量展开/收起走 applyPickerGroupAction。
	assert.match(commandPicker, /resolveGroupExpanded\(\{/);
	assert.match(commandPicker, /action: \{ kind: "expandAll" \}/);
	// 折叠状态 = 派生状态 + 用户覆盖：resolveGroupExpanded 统一收口，用户切换走 toggleGroup
	assert.match(commandPicker, /resolveGroupExpanded\(\{\s*selection,/);
	assert.match(commandPicker, /toggleGroup\(props\.id\)/);
	assert.match(commandPicker, /aria-expanded=\{expanded\}/);
	assert.match(composerComponents, /value=\{currentModelKey\}/);
	assert.match(composerComponents, /value: props\.composerAgentMode/);
	// 思考级别就地下拉（1ab977969）后受控值移至 ModelThinkingChip，模型选择器仍单行受控
	assert.match(modelThinkingChip, /DropdownMenuRadioGroup value=\{props\.current\}/);
	assert.match(commandPicker, /search\.trim\(\) \? <CommandEmpty/);
	assert.match(commandPicker, /scrollIntoView\(\{ block: \"center\" \}\)/);
	// 启动配置选择统一由输入框底栏（ComposerArea/ComposerBottomBar）承担：
	// 空态页不得再出现第二套模型/思考级别选择器（防止双实现回归）
	assert.doesNotMatch(projectEmptyState, /<ModelPicker/);
	assert.doesNotMatch(projectEmptyState, /<ThinkingPicker/);
});

test("Git summary generation keeps a sticky progress toast and reports success or failure", () => {
	assert.match(gitPanel, /Number\.POSITIVE_INFINITY/);
	assert.match(gitPanel, /git\.generateCommitMessageProgress/);
	assert.match(gitPanel, /git\.generateCommitMessageDone/);
	assert.match(gitPanel, /git\.generateCommitMessageEmpty/);
	assert.match(gitPanel, /commitGenNoticeText/);
	assert.match(gitPanel, /<Progress/);
	assert.match(gitPanel, /COMMIT_GEN_TIMEOUT_MS/);
	assert.doesNotMatch(gitPanel, /showNotice\(\s*t\("git\.generateCommitMessageProgress"\),\s*0\s*\)/);
	assert.equal(i18n.match(/"git\.generateCommitMessageDone":/g)?.length, 2);
	assert.equal(i18n.match(/"git\.generateCommitMessageEmpty":/g)?.length, 2);
});

test("Git summary generation survives leaving and returning to the project", () => {
	assert.match(gitAtoms, /export const gitCommitComposerByScopeAtom/);
	assert.match(gitAtoms, /export function gitCommitScopeKey/);
	assert.match(gitAtoms, /export function patchGitCommitComposer/);
	assert.match(gitAtoms, /export function getGitCommitComposer/);
	assert.match(gitPanel, /gitCommitComposerByScopeAtom/);
	assert.match(gitPanel, /inflightCommitGenScopes/);
	assert.match(gitPanel, /finishCommitGen\(scopeKey, \{ message \}\)/);
	assert.match(gitPanel, /composer\.startedAt/);
	// 切项目只清 status，不能清 composer / 生成锁 / 进度 toast，否则切回来动画和摘要都没了
	assert.doesNotMatch(gitPanel, /setCommitMessage\(""\)[\s\S]*setCommitGenLoading\(false\)/);
	assert.doesNotMatch(gitPanel, /if \(projectId !== projectIdRef\.current\) return;[\s\S]*setCommitMessage\(message\)/);
});

test("missing Git summary model opens Git settings tab at the Git section", () => {
	assert.match(gitPanel, /openSettings\(\{ tab: "git", section: "git" \}\)/);
	assert.match(settingsAtoms, /export const openSettingsAtom/);
	assert.match(settingsAtoms, /settingsFocusAtom/);
	assert.match(gitTab, /id="settings-section-git"/);
	assert.match(settingsModal, /useSettingsFocus/);
	assert.match(settingsModal, /getDefaultStore\(\)\.get\(settingsFocusAtom\)\?\.tab/);
	assert.match(settingsFocusHook, /settings-section-\$\{section\}/);
	assert.match(settingsFocusHook, /scrollIntoView/);
	assert.match(settingsFocusHook, /setFocusTarget\(null\)/);
});

test("Git summary settings expose the shared command model picker", () => {
	// Git 分区与模型选择器位于独立 Git 设置 tab（GitTab）；数据源 hook 独立成文件（gitModels.ts，
	// 以便 GitTab lazy 加载）——listModels 调用在 hook 里（经 listModelsReport 带缓存报告语义）
	// 链式调用可能被格式化拆行（desktopApi.projects 与 .listModelsReport 分行）。
	assert.match(gitModelsHook, /desktopApi\s*\.?\s*projects\s*\.?\s*listModelsReport\(/);
	assert.match(gitTab, /ModelPicker/);
	assert.match(gitTab, /gitModelPickerOpen/);
	assert.doesNotMatch(gitTab, /<datalist/);
	assert.doesNotMatch(gitTab, /git-commit-message-providers/);
	assert.doesNotMatch(gitTab, /git-commit-message-models/);
	assert.match(gitTab, /gitCommitMessageProvider/);
	assert.match(gitTab, /gitCommitMessageModel/);
	assert.equal(i18n.match(/"settings\.gitCommitMessageModel":/g)?.length, 2);
	assert.equal(i18n.match(/"settings\.gitCommitMessageModelUnset":/g)?.length, 2);
	assert.match(i18n, /git\.commitMessageModelRequired/);
});

test("Git IPC receives the localized settings guidance from the main process", () => {
	assert.match(gitIpc, /mainCopy: \(key: string/);
	assert.match(mainIndex, /registerGitIpc\(\{[\s\S]*mainCopy: mainCopy/);
});
