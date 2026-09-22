import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tab = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
const panel = readFileSync("src/renderer/src/config/ModelsExportPanel.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("provider batch management copy is localized in both dictionaries", () => {
	assert.match(zh, /"common\.batchManage":\s*"批量管理"/);
	assert.match(en, /"common\.batchManage":\s*"Batch Manage"/);
	assert.match(zh, /"config\.models\.batchActionLabel":\s*"请选择操作"/);
	assert.match(en, /"config\.models\.batchActionLabel":\s*"Select an action"/);
	assert.match(zh, /"config\.models\.batchAction\.delete":\s*"批量删除"/);
	assert.match(en, /"config\.models\.batchAction\.delete":\s*"Batch Delete"/);
	assert.match(zh, /"config\.models\.batchAction\.export":\s*"批量导出"/);
	assert.match(en, /"config\.models\.batchAction\.export":\s*"Batch Export"/);
	assert.match(zh, /"config\.models\.batchExecute":\s*"批量执行"/);
	assert.match(en, /"config\.models\.batchExecute":\s*"Execute"/);
	assert.match(zh, /"config\.models\.transfer\.exportToClipboard":\s*"导出到剪贴板"/);
	assert.match(en, /"config\.models\.transfer\.exportToClipboard":\s*"Export to Clipboard"/);
	assert.match(zh, /"config\.models\.transfer\.exportToFile":\s*"导出到文件"/);
	assert.match(en, /"config\.models\.transfer\.exportToFile":\s*"Export to File"/);
});

test("provider batch toolbar uses neutral manage entry, action dropdown and single execute", () => {
	// 入口中性化：改用 batchManage；common.deleteBatch 仍被模型级批量使用（~L635-644），不作全局缺失断言
	assert.match(tab, /common\.batchManage/);
	// 批量模式隐藏 添加/导入/指南
	assert.match(tab, /\{!batchMode &&[\s\S]{0,600}?onStartAddProvider/);
	assert.match(tab, /\{!batchMode &&[\s\S]{0,600}?kind: "import"/);
	assert.match(tab, /\{!batchMode &&[\s\S]{0,600}?setShowGuide/);
	// 动作下拉：无默认值，两选项
	assert.match(tab, /useState<"delete" \| "export" \| null>\(null\)/);
	assert.match(tab, /<Select value=\{batchAction \?\? undefined\}[\s\S]{0,600}?batchActionLabel/);
	assert.match(tab, /<SelectItem value="delete">[\s\S]{0,80}?batchAction\.delete/);
	assert.match(tab, /<SelectItem value="export">[\s\S]{0,80}?batchAction\.export/);
	// 批量执行：未选动作或零勾选 disabled
	assert.match(tab, /disabled=\{!batchAction \|\| selectedProviders\.size === 0\}/);
	assert.match(tab, /config\.models\.batchExecute/);
	// 执行后退出：exitBatchMode 统一清空三态
	assert.match(tab, /const exitBatchMode = \(\) => \{[\s\S]{0,260}?setBatchMode\(false\);[\s\S]{0,80}?setSelectedProviders\(new Set\(\)\);[\s\S]{0,80}?setBatchAction\(null\);/);
	// 删除走既有 onDeleteProviders，导出开面板
	assert.match(tab, /const handleBatchExecute = \(\) => \{[\s\S]{0,400}?onDeleteProviders\(\[\.\.\.selectedProviders\]\);[\s\S]{0,200}?kind: "export", ids: \[\.\.\.selectedProviders\]\s*\}\)/);
	// 旧的「删除选中 / 导出选中」按钮移除（common.deleteBatch / deleteSelected 仍被模型级批量使用于 ~L635-644，不作全局缺失断言）
	assert.doesNotMatch(tab, /transfer\.exportSelected/);
});

test("export panel exports directly to clipboard or file without a generate phase", () => {
	assert.match(panel, /const exportToClipboard = async \(\) => \{[\s\S]{0,400}?copyTextWithCopiedNotice/);
	assert.match(panel, /const exportToFile = async \(\) => \{[\s\S]{0,600}?revokeObjectURL/);
	assert.match(panel, /transfer\.exportToClipboard/);
	assert.match(panel, /transfer\.exportToFile/);
	// 两段式生成阶段移除
	assert.doesNotMatch(panel, /transfer\.exportButton/);
	assert.doesNotMatch(panel, /const \[payload, setPayload\]/);
	// 无密码安全提示保留
	assert.match(panel, /noEncryptHint/);
});

test("batch toolbars offer select all, invert and clear selection at both levels", () => {
	// 供应商级：取消按钮之后、动作下拉之前的三个 ghost 按钮，作用于 visibleProviderNames
	assert.match(tab, /common\.cancel[\s\S]{0,400}?common\.selectAll[\s\S]{0,400}?common\.invertSelection[\s\S]{0,400}?common\.clearSelection[\s\S]{0,1000}?config\.models\.batchExecute/);
	assert.match(tab, /setSelectedProviders\(new Set\(visibleProviderNames\)\)/);
	assert.match(tab, /visibleProviderNames\.filter\(\(?[^)]*\)?\s*=>\s*!selectedProviders\.has\(/);
	// 清除不退出批量模式：只清空 Set
	assert.match(tab, /\{batchMode &&[\s\S]{0,700}?onClick=\{\(\) => setSelectedProviders\(new Set\(\)\)\}/);
	// 模型级：同一组三按钮，走 modelBatchSelection 纯函数
	assert.match(tab, /selectAllModelIndexes\(provider\.models\.length\)/);
	assert.match(tab, /invertModelIndexes\(selectedModelIndexes, provider\.models\.length\)/);
	assert.match(tab, /\{isModelBatchMode &&[\s\S]{0,900}?onClick=\{\(\) => setSelectedModelIndexes\(new Set\(\)\)\}/);
});

test("retired provider batch copy keys are removed from both dictionaries", () => {
	const retired = ["config.models.transfer.exportSelected", "config.models.transfer.exportButton", "config.models.transfer.copyBase64", "config.models.transfer.saveFile"];
	for (const key of retired) {
		assert.ok(!zh.includes(`"${key}":`), `zh-CN still has ${key}`);
		assert.ok(!en.includes(`"${key}":`), `en-US still has ${key}`);
	}
	// 相邻 key 不受牵连
	assert.match(zh, /"common\.deleteBatchConfirm":/);
	assert.match(zh, /"rpc\.saveFile":/);
});
