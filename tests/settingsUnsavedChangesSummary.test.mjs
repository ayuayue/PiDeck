import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { summarizeSettingsUnsavedChanges, formatSettingsUnsavedMessage } = loadTsCommonJs("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");

test("关闭确认列出全部变更项（按设置页顺序），不再只点第一条", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: ["gitCommitMessageModel", "theme", "gitCommitMessageProvider"],
	});
	assert.equal(summary.totalCount, 2);
	// Git 模型相关字段合成一项；目录顺序「外观 → Git」：主题在前。
	// 模块经 VM 加载，对象跨 realm，比较时先映射成 [tabKey, itemKey] 原生数组。
	assert.deepEqual(JSON.parse(JSON.stringify(summary.items.map((i) => [i.tabKey, i.itemKey]))), [
		["settings.tabs.appearance", "settings.theme"],
		["settings.tabs.git", "settings.gitCommitMessageModel"],
	]);
});

test("单项变更时 items 只含一项，tabKey/itemKey 指向该项", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: ["gitCommitMessageModel", "gitCommitMessageProvider"],
	});
	assert.equal(summary.totalCount, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(summary.items.map((i) => [i.tabKey, i.itemKey]))), [["settings.tabs.git", "settings.gitCommitMessageModel"]]);
});

test("视觉桥脏标记挂到视觉桥 tab，而不是当成未知 AppSettings 字段", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: [],
		visionDirty: true,
	});
	assert.equal(summary.totalCount, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(summary.items.map((i) => [i.tabKey, i.itemKey]))), [["settings.tabs.vision", "settings.vision.section"]]);
});

test("webServiceRequiresAuth 变更指向 Web 设置 tab 的访问令牌项", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: ["webServiceRequiresAuth"],
	});
	assert.equal(summary.totalCount, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(summary.items.map((i) => [i.tabKey, i.itemKey]))), [["settings.tabs.web", "settings.webUseTokenAuth"]]);
});

test("未建目录的内部字段合成「其他选项」，不按 Set 插入顺序抢第一条", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: ["sidebarExpandedProjectIds", "language"],
	});
	assert.equal(summary.totalCount, 2);
	assert.deepEqual(JSON.parse(JSON.stringify(summary.items.map((i) => [i.tabKey, i.itemKey]))), [
		["settings.tabs.common", "settings.language"],
		["settings.tabs.common", "settings.unsavedUnknownItem"],
	]);
});

test("无任何脏来源时返回 null（关闭时不弹确认）", () => {
	assert.equal(summarizeSettingsUnsavedChanges({ dirtyFields: [], visionDirty: false, imageGenDirty: false }), null);
});

test("中文关闭文案带 tab 和项名；多项只展开第一条并带总数（单行兜底文案）", () => {
	i18n.setI18nLocale("zh-CN");
	const one = formatSettingsUnsavedMessage(summarizeSettingsUnsavedChanges({ dirtyFields: ["theme"] }), i18n.t);
	assert.equal(one, "「外观设置」的「主题」尚未保存，是否在关闭前保存？");

	const more = formatSettingsUnsavedMessage(summarizeSettingsUnsavedChanges({ dirtyFields: ["theme", "language"] }), i18n.t);
	assert.equal(more, "「常用设置」的「语言」等共 2 项尚未保存，是否在关闭前保存？");
});

test("SettingsModal 关闭确认渲染完整变更列表（intro + 两区分区 items 合并）", () => {
	assert.match(settingsModal, /formatSettingsUnsavedMessage/);
	assert.match(settingsModal, /summarizeSettingsUnsavedChanges/);
	assert.match(settingsModal, /settings\.unsavedListIntro/);
	// 合并列表：系统设置 + 配置管理两区未保存项统一渲染（不允许回退到只显示单条）
	assert.match(settingsModal, /mergedUnsavedItems\.map/);
	assert.match(settingsModal, /computeDirtyFields/);
	// 旧的「只显示单条 + totalCount」描述不再作为列表唯一来源
	assert.doesNotMatch(settingsModal, /AlertDialogDescription>\{unsavedCloseMessage\}/);
});
