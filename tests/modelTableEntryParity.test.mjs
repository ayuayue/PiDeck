/**
 * 模型表两条入口的对齐契约：展开卡片（ModelsTab）↔ 新增/编辑供应商页（AddProviderDialog）。
 *
 * 背景：两处渲染的是同一个 `ModelsTable`，但回调由各自宿主拼装。历史上编辑页少了
 * 上移/下移、隐藏、逐模型 UA、每模型默认思考档位（弹窗内还停在旧的 xhigh/max 下拉），
 * 用户看到「同一个模型表，功能却不一样」。这里锁住「两处传入的 prop 集合一致」——
 * 以后新增行内操作时必须同时接线两条入口。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

/**
 * 取出文件里第一个 `<ModelsTable …/>` 的 prop 名集合。
 * 按大括号深度找元素结尾：内联对象/箭头函数体里也可能出现 `/>`，只看深度 0 的那个。
 */
function modelsTableProps(path) {
	const source = read(path);
	const start = source.indexOf("<ModelsTable");
	assert.ok(start >= 0, `${path}: 找不到 <ModelsTable>`);
	let depth = 0;
	let end = start;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") depth += 1;
		else if (char === "}") depth -= 1;
		else if (char === "/" && source[index + 1] === ">" && depth === 0) {
			end = index + 2;
			break;
		}
	}
	assert.ok(end > start, `${path}: <ModelsTable> 元素未闭合`);
	return new Set([...source.slice(start, end).matchAll(/(?:^|\n)[ \t]*([A-Za-z][A-Za-z0-9_]*)=/g)].map((match) => match[1]));
}

test("两条入口给模型表传的操作集完全一致（只豁免宿主上下文差异）", () => {
	const card = modelsTableProps("src/renderer/src/config/ModelsTab.tsx");
	const dialog = modelsTableProps("src/renderer/src/config/AddProviderDialog.tsx");
	// 豁免两项（都是宿主上下文差异，不是能力差异）：
	//   getRowKey————卡片多表同屏要 provider 前缀防 ref 串扰，编辑页单表无需；
	//   thinkingLevelsProbePending————新增页的 provider 未落盘，探测行显示「保存后由 Pi 探测」。
	const exemptions = new Set(["getRowKey", "thinkingLevelsProbePending"]);
	const onlyCard = [...card].filter((name) => !exemptions.has(name)).sort();
	const onlyDialog = [...dialog].filter((name) => !exemptions.has(name)).sort();
	assert.deepEqual(onlyDialog, onlyCard, "两条入口的模型表操作必须一致：新增操作时要同时接线两条入口");
	// 反向兜底：豁免项不能悄悄扩大（除上述两项外不允许任何单向 prop）
	assert.deepEqual([...card].filter((name) => !dialog.has(name)).sort(), ["getRowKey"]);
	assert.deepEqual([...dialog].filter((name) => !card.has(name)).sort(), ["thinkingLevelsProbePending"]);
	// 关键操作必须两处都在（防止「只删不接」把上面的集合断言蒙混过去）
	for (const name of ["onMoveModel", "onHideModel", "onUpdateModelUserAgent", "getModelUserAgentOverride", "onUpdateModelThinkingLevelDefault", "getModelThinkingLevelDefault", "getModelAvailableThinkingLevels"]) {
		assert.ok(card.has(name) && dialog.has(name), `${name} 必须在两条入口都接线`);
	}
});

test("两条入口的差异是「生效时机」而不是能力：页面按 modelId 记页内草稿，卡片即时写回", () => {
	const dialog = read("src/renderer/src/config/AddProviderDialog.tsx");
	// 差异只有一处：卡片没有保存按钮（即时生效），供应商页是表单（点保存才生效）。
	// 行内操作的「能力」两侧完全一致（见本文件第一个测试的 prop 集合断言）。
	assert.match(dialog, /const\s+scopedProviderName\s*=\s*props\.mode === "edit" \? \(props\.initial\?\.name \?\? ""\) : "";/);
	assert.match(dialog, /const\s+modelIdAt\s*=\s*\(index: number\) => models\[index\]\?\.id \?\? "";/);
	// 隐藏 / 默认档位 / UA 三份副本都按 modelId 建键，且只改页内 state（写回走 onConfirm 草稿）
	for (const state of ["setHiddenModelIds", "setThinkingDefaults", "setModelOverrides"]) {
		assert.ok(dialog.includes(`${state}((`), `${state} 必须由页内 handler 使用`);
	}
	assert.doesNotMatch(dialog, /props\.onUpdateModelUserAgent|props\.getModelUserAgentOverride|props\.onToggleHiddenModel|props\.isModelHidden/);
	assert.match(dialog, /onUpdateModelUserAgent=\{updateModelUserAgent\}/);
	assert.match(dialog, /getModelUserAgentOverride=\{readModelUserAgent\}/);
	// 页内改 ID 时三份副本一起搬（卡片侧由「保存前清孤儿」兜底，机制见 providerPageModelSettings 测试）
	assert.match(dialog, /renameRowSettings\(index, value\)/);
});

test("settings 回调与卡片 UA 写回在下游按 modelId 建键（不是行下标）", () => {
	const configModal = read("src/renderer/src/ConfigModal.tsx");
	const modelsTab = read("src/renderer/src/config/ModelsTab.tsx");
	// ConfigModal：写 settings.json 与 modelOverrides 都按 modelId；空 id 直接不生效。
	assert.match(configModal, /const handleUpdateModelThinkingLevelDefault = \(providerName: string, modelId: string, level: string\) => \{/);
	assert.match(configModal, /const handleUpdateModelUserAgent = \(providerName: string, modelId: string, value: string\) => \{/);
	assert.match(configModal, /getModelThinkingLevelDefault=\{settingsLoaded \? \(providerName, modelId\) => modelThinkingLevelOf\(settingsData, providerName, modelId\) \?\? "" : undefined\}/);
	assert.match(configModal, /getModelUserAgentOverride=\{\(providerName, modelId\) => getModelUserAgentOverride\(modelsData\.providers\[providerName\]\?\.modelOverrides, modelId\)\}/);
	// ModelsTab 卡片负责行下标 → modelId 的翻译（弹窗侧同样按 modelId，见上一个测试）
	assert.match(modelsTab, /props\.onUpdateModelThinkingLevelDefault!\(name, provider\.models\[i\]\?\.id \?\? "", value\)/);
	assert.match(modelsTab, /props\.onUpdateModelUserAgent!\(name, provider\.models\[i\]\?\.id \?\? "", value\)/);
});

test("供应商改名：按 provider 名建键的外部引用由替换写入接手（不留旧名字下的键）", () => {
	const configModal = read("src/renderer/src/ConfigModal.tsx");
	// settings.json 的 modelThinkingLevels 与 AppSettings.hiddenModels 都按 provider 名建键，
	// 改名不处理就会静默失效（默认档位被 clamp、已隐藏模型重新出现）。供应商页交回的是
	// 页内绝对快照，宿主按「旧名 → 最终名」替换式落盘：清旧前缀 + 写新前缀一次完成，
	// 因此不再需要单独的改名迁移模块（替换语义由 tests/modelThinkingLevels、tests/hiddenModels 锁住）。
	assert.match(configModal, /applyProviderPageModelSettings\(draft, oldName, newName\)/);
	assert.match(configModal, /replaceModelThinkingLevels\(settingsData, savedName, finalName, draft\.modelThinkingLevelDefaults\)/);
	assert.match(configModal, /replaceProviderHiddenIds\(hiddenModels, savedName, finalName, draft\.hiddenModelIds\)/);
});
