/**
 * 供应商页（新增/编辑）的模型设置约定：**页面里改，点保存才生效；取消就全丢。**
 *
 * 页内三份副本都按 modelId 建键（逐模型 UA / 每模型默认思考档位 / 隐藏集合），页内改 ID 时一起搬；
 * 确认时交给宿主按最终名字**替换式**落盘（页内删掉的模型不会留下设置 = 设置跟着模型走）。
 * 「读当前状态」的入口由宿主提供，缺失 = 该功能没有入口（settings 未加载 / 不提供隐藏列表）。
 *
 * 与卡片的差别只有生效时机：卡片没有保存按钮，所以卡片里点眼睛/档位是即时生效。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const dialog = readFileSync("src/renderer/src/config/AddProviderDialog.tsx", "utf8");
const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const table = readFileSync("src/renderer/src/config/ModelsTable.tsx", "utf8");
const sourceFiles = ["src/renderer/src/ConfigModal.tsx", "src/renderer/src/config/AddProviderDialog.tsx", "src/renderer/src/config/ModelsTab.tsx", "src/renderer/src/config/addProviderDraft.ts"].map((path) => readFileSync(path, "utf8")).join("\n");

test("弹窗：三份页内副本按宿主当前状态预填，改 ID 时一起搬", () => {
	// 读入口（宿主侧已保存 provider / 已加载 settings）
	assert.match(dialog, /hiddenModels\?: string\[\];/);
	assert.match(dialog, /getModelThinkingLevelDefault\?: \(providerName: string, modelId: string\) => string;/);
	assert.match(dialog, /function readProviderThinkingDefaults\(initial: ProviderDialogInitial \| undefined, read: \(\(providerName: string, modelId: string\) => string\) \| undefined\): Record<string, string> \{/);
	// 预填：UA 读 provider，隐藏读 AppSettings，默认档位读 settings.json
	assert.match(dialog, /setModelOverrides\(readModelOverrides\(initial\?\.modelOverrides\) \?\? \{\}\)/);
	assert.match(dialog, /setHiddenModelIds\(pickProviderHiddenIds\(props\.hiddenModels, initial\?\.name \?\? ""\)\)/);
	assert.match(dialog, /setThinkingDefaults\(readProviderThinkingDefaults\(initial, props\.getModelThinkingLevelDefault\)\)/);
	// 页内改 ID = 重命名同一行：三份副本跟着搬（否则保存后设置挂在旧 ID 上）
	assert.match(dialog, /const renameRowSettings = \(index: number, value: unknown\) => \{/);
	assert.match(dialog, /if \(field === "id"\) renameRowSettings\(index, value\);/);
	const renameBody = dialog.slice(dialog.indexOf("const renameRowSettings = "), dialog.indexOf("\n\t};", dialog.indexOf("const renameRowSettings = ")));
	for (const setter of ["setModelOverrides", "setThinkingDefaults", "setHiddenModelIds"]) {
		assert.ok(renameBody.includes(`${setter}((`), `renameRowSettings 必须一起搬 ${setter}`);
	}
});

test("弹窗：页面里怎么改都只改页内草稿（编辑页不再即时写宿主）", () => {
	// 旧的两套分支（编辑即时 / 新增缓冲）与其宿主回调整体下线
	assert.doesNotMatch(dialog, /props\.onToggleHiddenModel/);
	assert.doesNotMatch(dialog, /props\.isModelHidden/);
	assert.doesNotMatch(dialog, /props\.onUpdateModelThinkingLevelDefault/);
	for (const handler of ["toggleModelHidden", "updateModelThinkingDefault"]) {
		const start = dialog.indexOf(`const ${handler} = `);
		assert.ok(start > 0, `${handler} 必须存在`);
		const body = dialog.slice(start, dialog.indexOf("\n\t};", start));
		assert.doesNotMatch(body, /props\./, `${handler}: 只改页内 state，不碰宿主`);
	}
	// 回显读的都是页内副本
	assert.match(dialog, /return Boolean\(modelId\) && hiddenModelIds\.includes\(modelId\);/);
	assert.match(dialog, /return modelId \? \(thinkingDefaults\[modelId\] \?\? ""\) : "";/);
	// 行内入口按「读入口是否存在」渲染（没有读入口 = 该功能没有入口）
	assert.match(dialog, /onHideModel=\{props\.hiddenModels \? toggleModelHidden : undefined\}/);
	assert.match(dialog, /getModelHidden=\{props\.hiddenModels \? readModelHidden : undefined\}/);
	assert.match(dialog, /onUpdateModelThinkingLevelDefault=\{props\.getModelThinkingLevelDefault \? updateModelThinkingDefault : undefined\}/);
});

test("弹窗：确认时把三份草稿交给宿主，缺读入口的项不带（不带 = 别动宿主状态）", () => {
	assert.match(dialog, /^\s*modelOverrides,$/m);
	assert.match(dialog, /\.\.\.\(props\.getModelThinkingLevelDefault \? \{ modelThinkingLevelDefaults: thinkingDefaults \} : \{\}\),/);
	assert.match(dialog, /\.\.\.\(props\.hiddenModels \? \{ hiddenModelIds \} : \{\}\),/);
});

test("ConfigModal：供应商页确认按最终名字替换式落盘（无需单独的改名迁移）", () => {
	const start = modal.indexOf("const applyProviderPageModelSettings = ");
	assert.ok(start > 0);
	const body = modal.slice(start, modal.indexOf("\n\t};", start));
	assert.match(body, /replaceModelThinkingLevels\(settingsData, savedName, finalName, draft\.modelThinkingLevelDefaults\)/);
	assert.match(body, /markDirty\("config:settings"\)/);
	assert.match(body, /replaceProviderHiddenIds\(hiddenModels, savedName, finalName, draft\.hiddenModelIds\)/);
	assert.match(body, /api\.settings\.update\(\{ hiddenModels: nextHidden \}\)/);
	// 新增（没有旧名字）与编辑（旧名 → 新名）都走同一个入口
	assert.match(modal, /applyProviderPageModelSettings\(draft, "", providerName\);/);
	assert.match(modal, /applyProviderPageModelSettings\(draft, oldName, newName\);/);
	// 改名迁移模块已被替换写入取代，不留第二套机制
	assert.equal(existsSync("src/renderer/src/config/providerRenameMigration.ts"), false);
	assert.doesNotMatch(sourceFiles, /renameProviderThinkingLevels|renameHiddenModelEntries|providerRenameMigration/);
});

test("孤儿清理：保存/写盘前按模型列表对齐三个 store（设置跟着模型走）", () => {
	// models.json：逐模型 UA 覆盖的孤儿键（正则空白容忍：格式化可能换行）
	assert.match(modal, /pruneModelOverrides\(\s*current,\s*provider\.models\.map\(\(model\) => model\.id\),?\s*\)/);
	// pi settings.json：两个写入口都先清孤儿档位键，并把清理结果同步回 UI 草稿
	assert.match(modal, /const pruneProviderThinkingLevelOrphans = \(\): Record<string, unknown> => \{/);
	assert.match(modal, /pruneModelThinkingLevelOrphans\(settingsData, modelIdIndex\(modelsData\.providers\)\)/);
	const pruneSettingsCalls = modal.match(/const pruned = pruneProviderThinkingLevelOrphans\(\);/g) ?? [];
	assert.equal(pruneSettingsCalls.length, 2, "handleSaveSettings 与 saveSettingsDraftOnly 都要清孤儿");
	assert.match(modal, /baselineSettingsRef\.current = deepClone\(pruned\)/);
	// AppSettings.hiddenModels：保存时清理 + 眼睛按钮写盘前顺手清理
	assert.match(modal, /pruneHiddenModelOrphans\(hiddenModels, modelIdIndex\(prunedProviders\)\)/);
	assert.match(modal, /pruneHiddenModelOrphans\(toggleHiddenModelKey\(prev, provider, modelId\), modelIdIndex\(modelsData\.providers\)\)/);
	// 清理索引只含 models.json 里的供应商（pi 内置 provider 的设置不误伤）
	assert.match(modal, /function modelIdIndex\(providers: ModelsFile\["providers"\]\): ProviderModelIdIndex \{/);
});

test("探测器：新增页显示「保存后由 Pi 探测」，两处入口都带上逐模型 UA", () => {
	assert.match(table, /thinkingLevelsProbePending\?: boolean;/);
	assert.match(table, /props\.thinkingLevelsProbePending\s*\?\s*t\("config\.thinkingLevelsProbedAfterSave"\)/);
	assert.match(dialog, /thinkingLevelsProbePending=\{scopedProviderName === ""\}/);
	// 供应商页的测试连接是重新拼草稿：漏 modelOverrides 会让「需要特殊 UA 的模型」测出假失败
	const probeStart = dialog.indexOf("const probeProvider = buildProviderConfigFromDraft({");
	assert.ok(probeStart > 0);
	const probeCall = dialog.slice(probeStart, dialog.indexOf("});", probeStart));
	assert.match(probeCall, /\n\s*modelOverrides,/, "测试连接必须带上逐模型 UA");
});
