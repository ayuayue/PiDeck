import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
const read = (path) => readFileSync(path, "utf8");

function rendererSourceFiles(directory = "src/renderer/src") {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return rendererSourceFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

function staticTranslationKeys(filePath) {
	const source = ts.createSourceFile(
		filePath,
		read(filePath),
		ts.ScriptTarget.Latest,
		true,
	);
	const keys = new Set();
	function visit(node) {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "t" &&
			ts.isStringLiteral(node.arguments[0])
		) {
			keys.add(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	}
	ts.forEachChild(source, visit);
	return keys;
}

test("renderer locale dictionaries expose the same translation keys", () => {
  assert.deepEqual(Object.keys(enUS).sort(), Object.keys(zhCN).sort());
});

test("every static renderer translation key exists in both locale dictionaries", () => {
	const usedKeys = new Set(
		rendererSourceFiles().flatMap((filePath) => [...staticTranslationKeys(filePath)]),
	);
	for (const key of usedKeys) {
		assert.ok(Object.hasOwn(zhCN, key), `zh-CN is missing ${key}`);
		assert.ok(Object.hasOwn(enUS, key), `en-US is missing ${key}`);
	}
});

test("settings error and unsaved-change copy matches the dev baseline", () => {
	assert.equal(zhCN["settings.sectionRuntime"], "\u8fd0\u884c");
	assert.equal(zhCN["settings.loadFailed"], "\u8bbe\u7f6e\u52a0\u8f7d\u5931\u8d25");
	assert.equal(zhCN["settings.renderCrashed"], "\u8bbe\u7f6e\u9875\u9762\u6e32\u67d3\u5f02\u5e38");
	assert.equal(zhCN["settings.renderCrashedHelp"], "\u53ef\u4ee5\u5148\u5173\u95ed\u8bbe\u7f6e\u5f39\u6846\u7ee7\u7eed\u4f7f\u7528\u3002\u8bf7\u628a\u63a7\u5236\u53f0\u9519\u8bef\u53cd\u9988\u7ed9\u6211\u4eec\uff0c\u4fbf\u4e8e\u5b9a\u4f4d\u3002");
	assert.equal(zhCN["settings.unsavedTitle"], "\u672a\u4fdd\u5b58\u7684\u66f4\u6539");
	assert.equal(zhCN["settings.unsavedMessage"], "\u60a8\u6709\u672a\u4fdd\u5b58\u7684\u66f4\u6539\uff0c\u662f\u5426\u5728\u5173\u95ed\u524d\u4fdd\u5b58\uff1f");
	assert.match(zhCN["settings.unsavedMessageDetail"], /\{tab\}/);
	assert.match(zhCN["settings.unsavedMessageDetail"], /\{item\}/);
	assert.match(zhCN["settings.unsavedMessageMore"], /\{count\}/);
	assert.equal(zhCN["settings.saveAndClose"], "\u4fdd\u5b58\u5e76\u5173\u95ed");
	assert.equal(zhCN["settings.discardChanges"], "\u653e\u5f03\u66f4\u6539");
	assert.equal(zhCN["settings.dirtyTooltip"], "\u6b64\u9879\u5df2\u4fee\u6539\uff0c\u5c1a\u672a\u4fdd\u5b58");

	assert.equal(enUS["settings.sectionRuntime"], "Runtime");
	assert.equal(enUS["settings.loadFailed"], "Settings failed to load");
	assert.equal(enUS["settings.renderCrashed"], "Settings page render error");
	assert.equal(enUS["settings.renderCrashedHelp"], "You can close this dialog and continue. Please share the console error so we can fix it.");
	assert.equal(enUS["settings.unsavedTitle"], "Unsaved Changes");
	assert.equal(enUS["settings.unsavedMessage"], "You have unsaved changes. Do you want to save before closing?");
	assert.match(enUS["settings.unsavedMessageDetail"], /\{tab\}/);
	assert.match(enUS["settings.unsavedMessageDetail"], /\{item\}/);
	assert.match(enUS["settings.unsavedMessageMore"], /\{count\}/);
	assert.equal(enUS["settings.saveAndClose"], "Save & Close");
	assert.equal(enUS["settings.discardChanges"], "Discard Changes");
	assert.equal(enUS["settings.dirtyTooltip"], "This field has been modified, not saved yet");
});

const fileDiffViewer = read("src/renderer/src/components/app/FileDiffViewer.tsx");
const timeline = read("src/renderer/src/components/session/SessionMessageTimeline.tsx");
const settings = read("src/renderer/src/components/app/SettingsModal.tsx");
const devTab = read("src/renderer/src/components/app/settings/DevTab.tsx");
const settingRows = read("src/renderer/src/components/app/settings/SettingRows.tsx");
const settingsStorage = read("src/renderer/src/components/app/settings/SettingsStorageTab.tsx");
const drawer = read("src/renderer/src/components/workspace/DrawerSurface.tsx");
const surface = [
	read("src/renderer/src/components/session/SurfaceComponents.tsx"),
	read("src/renderer/src/components/session/turn/ProcessSummaryToggle.tsx"),
	read("src/renderer/src/components/session/FormulaCopyLayer.tsx"),
	read("src/renderer/src/components/session/ComposerOverlayComponents.tsx"),
	read("src/renderer/src/components/session/ToolCallComponents.tsx"),
	read("src/renderer/src/components/session/TimelineEventCards.tsx"),
	read("src/renderer/src/components/session/MessageShareModal.tsx"),
].join("\n");
const skillStore = read("src/renderer/src/config/SkillStoreTab.tsx");
const yaoStore = read("src/renderer/src/config/YaoPromptTab.tsx");
const skillHub = read("src/renderer/src/config/SkillHubStorePanel.tsx");
const promptStore = read("src/renderer/src/config/PromptStoreTab.tsx");
const extensions = read("src/renderer/src/config/ExtensionsTab.tsx")
	+ "\n" + read("src/renderer/src/config/extensionsRecommendedPackages.tsx");
const configShared = read("src/renderer/src/config/ConfigShared.tsx");
const providerHeaders = read("src/renderer/src/config/providerHeaders.ts");
const queuedPrompt = read("src/renderer/src/hooks/useQueuedPrompt.ts");

test("remaining renderer product copy is available in Chinese and English", () => {
	i18n.setI18nLocale("zh-CN");
	assert.equal(i18n.t("settings.tabs.common"), "\u5e38\u7528\u8bbe\u7f6e");
	assert.equal(i18n.t("settings.tabs.appearance"), "\u5916\u89c2\u8bbe\u7f6e");
	assert.equal(i18n.t("settings.sectionRuntime"), "\u8fd0\u884c");
	assert.equal(i18n.t("settings.unsavedTitle"), "\u672a\u4fdd\u5b58\u7684\u66f4\u6539");
	assert.equal(i18n.t("settings.unsavedMessage"), "\u60a8\u6709\u672a\u4fdd\u5b58\u7684\u66f4\u6539\uff0c\u662f\u5426\u5728\u5173\u95ed\u524d\u4fdd\u5b58\uff1f");
	assert.equal(i18n.t("settings.saveAndClose"), "\u4fdd\u5b58\u5e76\u5173\u95ed");
	assert.equal(i18n.t("settings.discardChanges"), "\u653e\u5f03\u66f4\u6539");
	assert.equal(i18n.t("settings.dirtyTooltip"), "\u6b64\u9879\u5df2\u4fee\u6539\uff0c\u5c1a\u672a\u4fdd\u5b58");
	assert.equal(i18n.t("editor.unsavedMarker"), " · 未保存");
	assert.equal(i18n.t("timeline.loadMoreHistory", { count: 12 }), "加载更多历史消息 (12 条)");
	assert.equal(i18n.t("settings.wsl.apiUnavailable"), "WSL API 未就绪，请重启应用后再试");
	assert.match(i18n.t("settings.wsl.piNotInstalled"), /@earendil-works\/pi-coding-agent/);
	assert.equal(i18n.t("config.skillStoreImportAs"), "导入为 Skill");
	assert.equal(i18n.t("config.yaoNoMatches"), "未匹配到提示词");
	assert.equal(i18n.t("config.skillHubCopyInstallCommand"), "复制安装命令");
	assert.equal(i18n.t("app.queuedDeliveryUnknown"), "消息可能未送达");
	assert.equal(i18n.t("mermaid.renderFailed"), "Mermaid 图表渲染失败");

	i18n.setI18nLocale("en-US");
	assert.equal(i18n.t("settings.tabs.common"), "General");
	assert.equal(i18n.t("settings.tabs.appearance"), "Appearance");
	assert.equal(i18n.t("settings.sectionRuntime"), "Runtime");
	assert.equal(i18n.t("settings.unsavedTitle"), "Unsaved Changes");
	assert.equal(i18n.t("settings.unsavedMessage"), "You have unsaved changes. Do you want to save before closing?");
	assert.equal(i18n.t("settings.saveAndClose"), "Save & Close");
	assert.equal(i18n.t("settings.discardChanges"), "Discard Changes");
	assert.equal(i18n.t("settings.dirtyTooltip"), "This field has been modified, not saved yet");
	assert.equal(i18n.t("editor.unsavedMarker"), " · Unsaved");
	assert.equal(i18n.t("timeline.loadMoreHistory", { count: 12 }), "Load more history messages (12)");
	assert.equal(i18n.t("settings.wsl.apiUnavailable"), "The WSL API is not ready. Restart PiDeck and try again.");
	assert.match(i18n.t("settings.wsl.piNotInstalled"), /@earendil-works\/pi-coding-agent/);
	assert.equal(i18n.t("config.skillStoreImportAs"), "Import as Skill");
	assert.equal(i18n.t("config.yaoNoMatches"), "No matching prompts");
	assert.equal(i18n.t("config.skillHubCopyInstallCommand"), "Copy install command");
	assert.equal(i18n.t("app.queuedDeliveryUnknown"), "The message may not have been delivered");
	assert.equal(i18n.t("mermaid.renderFailed"), "Failed to render Mermaid diagram");
});

test("reachable renderer surfaces use i18n without changing their UI structure", () => {
	assert.match(fileDiffViewer, /\{dirty && t\("editor\.unsavedMarker"\)\}/);
	assert.match(timeline, /t\("timeline\.loadMoreTurns"\)/);
	assert.match(drawer, /className="drawer-content-frame[^"]*"[\s\S]*?\{t\("drawer\.lazyLoading"\)\}/);
	// StorageTab 自 SettingsModal 拆分为 lazy 加载（tab 级按需下载 chunk）
	assert.match(settings, /const StorageTab = lazy\(\(\) => import\("\.\/settings\/SettingsStorageTab"\)/);
	// DirtyMarker 已迁入 SettingRows 共享原语；运行分区位于 DevTab（自 SettingsModal 拆分）
	assert.match(settingRows, /t\("settings\.dirtyTooltip"\)/);
	assert.match(devTab, /t\("settings\.sectionRuntime"\)/);
	assert.match(settings, /t\("settings\.unsavedTitle"\)/);
	assert.match(settings, /formatSettingsUnsavedMessage/);
	assert.match(settings, /t\("settings\.discardChanges"\)/);
	assert.match(settings, /t\("settings\.saveAndClose"\)/);
	assert.match(settingsStorage, /t\("settings\.storage\.clearConfirm"/);
	assert.match(surface, /t\("activity\.executionSummary", \{ summary:/);
	assert.match(skillStore, /className="prompt-store-tab"[\s\S]*?t\("config\.skillStoreSearchPlaceholder"\)/);
	assert.match(yaoStore, /className="store-sub-tab"[\s\S]*?t\("config\.yaoSearchPlaceholder"\)/);
	assert.match(skillHub, /className="skillhub-installed-badge"[\s\S]*?t\("config\.installed"\)/);
  assert.match(promptStore, /value: "yao", label: t\("config\.promptStoreChinesePicks"\)/);
	assert.match(extensions, /className="extensions-recommended-desc">[\s\S]*?t\(pkg\.descriptionKey\)/);
	assert.match(configShared, /getApiTypeDescription\(option\)/);
	assert.match(providerHeaders, /label: t\("config\.userAgentBrowser"\)/);
	assert.match(queuedPrompt, /unknownDeliveryMessage = t\("app\.queuedDeliveryUnknown"\)/);

	for (const source of [fileDiffViewer, timeline, drawer, settingsStorage, surface, skillStore, yaoStore, skillHub, promptStore, extensions, providerHeaders, queuedPrompt]) {
		assert.doesNotMatch(source, /" · 未保存"|"加载中\.\.\."|`加载更多历史消息|"复制安装命令"|"消息可能未送达"|>中文精选</);
	}
});

test("renderer async failures log diagnostics and expose stable localized copy", () => {
	// WSL 验证逻辑位于开发设置 tab（DevTab，自 SettingsModal 拆分）
	assert.match(devTab, /console\.error\("\[Settings\] WSL validation failed", err\)/);
	assert.match(devTab, /error: t\("settings\.wsl\.validationFailed"\)/);

	assert.match(skillStore, /console\.error\("\[SkillStore\] Search failed", err\)/);
	assert.match(skillStore, /setError\(t\("config\.skillStoreImportError"\)\)/);
	assert.doesNotMatch(skillStore, /setError\(err instanceof Error/);

	assert.match(yaoStore, /console\.error\("\[YaoPrompts\] Preview failed", err\)/);
	assert.match(yaoStore, /setError\(t\("config\.yaoImportError"\)\)/);
	assert.doesNotMatch(yaoStore, /setError\(err instanceof Error/);

	assert.match(skillHub, /console\.error\("\[SkillHub\] Search failed", err\)/);
	// 安装失败 toast 带主进程返回的真实错误（npx 输出/网络/权限原因），不再只给通用文案
	assert.match(skillHub, /showNotice\(t\("config\.skillHubInstallError", \{ error: result\.error \}\), 5000, "error"\)/);
	assert.match(skillHub, /t\("config\.skillHubInstallError", \{ error: err instanceof Error \? err\.message : String\(err\) \}\)/);

	assert.match(promptStore, /console\.error\("\[PromptStore\] Import failed", err\)/);
	assert.match(promptStore, /setError\(t\("config\.promptStoreImportError"\)\)/);
	assert.doesNotMatch(promptStore, /setError\(err instanceof Error/);

	assert.match(extensions, /showNotice\([\s\S]*config\.extensionOperationFailed[\s\S]*formatExtensionError\(e\)/);
	assert.doesNotMatch(extensions, /\balert\(/);

	// mermaid 渲染已交给 @streamdown/mermaid 插件（errorComponent 兜底），
	// 项目代码不再直接渲染图表；错误文案键仍保留供插件错误组件使用
	assert.doesNotMatch(surface, /\[Mermaid\] Render failed/);
	assert.doesNotMatch(surface, /mermaid-error-message/);
	assert.doesNotMatch(surface, /Mermaid render failed: \{props\.error\}/);
});
