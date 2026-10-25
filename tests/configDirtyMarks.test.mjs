import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// configDirtyMarks.ts 现引入 deepEqual（运行时依赖），用 loadTsCommonJs 走完整依赖图加载。
const { dirtyKeysClearedByReload, orderDirtyKeysForSave, ALL_CONFIG_DIRTY_KEYS, reconcileConfigDirty } = loadTsCommonJs("src/renderer/src/config/configDirtyMarks.ts");

// ── dirtyKeysClearedByReload：loadConfig 重载后应清除的脏标记 ──

test("重载 models 清除自身与 raw，并顺带清除 settings（每模型默认档位的草稿源）", () => {
	// models 分支也会加载 settings.json（每模型默认思考档位写的就是它），
	// 未保存的 settings 草稿会被磁盘内容覆盖 → 必须一起清（脏草稿则由 preserved 挡住）。
	assert.deepEqual(new Set(dirtyKeysClearedByReload("models")), new Set(["config:models", "config:raw", "config:settings"]));
});

test("重载 settings 同时清除被顺带重载的 models/auth 脏标记（假脏标记根因）", () => {
	assert.deepEqual(new Set(dirtyKeysClearedByReload("settings")), new Set(["config:settings", "config:raw", "config:models", "config:auth"]));
});

test("重载 auth/trust/mcp 清除自身与 raw", () => {
	assert.deepEqual(new Set(dirtyKeysClearedByReload("auth")), new Set(["config:auth", "config:raw"]));
	assert.deepEqual(new Set(dirtyKeysClearedByReload("trust")), new Set(["config:trust", "config:raw"]));
	assert.deepEqual(new Set(dirtyKeysClearedByReload("mcp")), new Set(["config:mcp", "config:raw"]));
});

test("重载 raw 只清除自身（去重，不产生重复 key）", () => {
	assert.deepEqual(Array.from(dirtyKeysClearedByReload("raw")), ["config:raw"]);
});

test("ALL_CONFIG_DIRTY_KEYS 覆盖全部 config 组文件键（不含 skills/prompts）", () => {
	assert.deepEqual(Array.from(ALL_CONFIG_DIRTY_KEYS), ["config:models", "config:auth", "config:settings", "config:trust", "config:mcp", "config:raw"]);
});

// ── reconcileConfigDirty：改回原值自动摘掉脏标记 ──
// 说明：普通对象字面量跨 vm realm 会被 deepEqual 的 isPlainObject 判为非普通对象
// （见 deepEqual.test.mjs 说明），这里用数组/原始值（Array.isArray 跨 realm 可靠）验证
// 「改回原值自动摘掉脏标记」的核心语义；对象分支由 deepEqual.test.mjs 自测覆盖。

test("改回原值后脏标记自动消失（假脏标记根因）", () => {
	const keys = new Set(["config:models"]);
	const baseline = ["m1", "m2"];
	reconcileConfigDirty(keys, "config:models", ["m1", "m2"], baseline);
	assert.deepEqual(Array.from(keys), []);
});

test("真实差异加入脏标记；再改回又清除（幂等）", () => {
	const baseline = ["m1", "m2"];
	const keys = new Set();
	// 修改
	reconcileConfigDirty(keys, "config:models", ["m1", "m3"], baseline);
	assert.deepEqual(Array.from(keys), ["config:models"]);
	// 改回原值
	reconcileConfigDirty(keys, "config:models", ["m1", "m2"], baseline);
	assert.deepEqual(Array.from(keys), []);
});

test("嵌套数组按结构比较：内容相同无差异，顺序变化算差异", () => {
	const keys = new Set();
	const baseline = [
		[1, 2],
		[3, 4],
	];
	// 同内容：无差异
	reconcileConfigDirty(
		keys,
		"config:settings",
		[
			[1, 2],
			[3, 4],
		],
		baseline,
	);
	assert.deepEqual(Array.from(keys), []);
	// 数组元素顺序变化：真实差异
	reconcileConfigDirty(
		keys,
		"config:settings",
		[
			[3, 4],
			[1, 2],
		],
		baseline,
	);
	assert.deepEqual(Array.from(keys), ["config:settings"]);
});

// ── orderDirtyKeysForSave：settings 必须最后保存 ──

test("保存全部脏来源时 settings 排最后（它的重载会连带刷新 models/auth/raw）", () => {
	// 顺序错（settings 先）会把尚未保存的 models/auth 草稿冲成磁盘内容，静默丢改动。
	assert.deepEqual(Array.from(orderDirtyKeysForSave(["config:settings", "config:models", "config:auth"])), ["config:models", "config:auth", "config:settings"]);
	// 其余键保持调用方相对顺序；dsh 不受影响。
	assert.deepEqual(Array.from(orderDirtyKeysForSave(["dsh", "config:trust", "config:raw"])), ["dsh", "config:trust", "config:raw"]);
	// 不含 settings 时原样返回；空输入得到空数组。
	assert.deepEqual(Array.from(orderDirtyKeysForSave(["config:mcp"])), ["config:mcp"]);
	assert.deepEqual(Array.from(orderDirtyKeysForSave([])), []);
});

// ── 装配契约：ConfigModal 已接入核算规则 ──

test("嵌入配置管理的顶部保存仍复用 models 保存入口", () => {
	const source = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 新增/编辑 provider 是 models 页内子页面，不能因为内容切换而丢失顶部保存路由。
	assert.match(source, /const currentTabKey = backendPane === "dsh" \? "dsh" : sectionTabValue\(section, tab\);/);
	assert.match(source, /await saveByKey\(currentTabKey\);/);
	assert.match(source, /模型页的新增\/编辑供应商是一个页内子页面/);
});

test("provider 页向外暴露当前草稿，标题栏保存会先提交再触发落盘", () => {
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	const modelsTab = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
	const dialog = readFileSync("src/renderer/src/config/AddProviderDialog.tsx", "utf8");
	// 表单 state 只存在 AddProviderDialog；卸载前清理入口，避免下一次打开误提交旧草稿。
	assert.match(dialog, /onRequestSave\?: \(save: \(\(\) => void\) \| undefined\) => void/);
	assert.match(dialog, /props\.onRequestSave\?\.\(submit\)/);
	assert.match(dialog, /return \(\) => props\.onRequestSave\?\.\(undefined\)/);
	assert.match(modelsTab, /onRequestSave=\{\(save\) => \{/);
	assert.match(modelsTab, /props\.providerPageSaveRef\.current = save/);
	assert.match(modal, /providerPageSaveRef\.current\?\.\(\)/);
	assert.match(modal, /下一轮 state 更新会重新进入 models 保存路径/);
});

test("ConfigModal 的 loadConfig 与 handleImport 使用统一核算规则", () => {
	const source = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 脏草稿保留：被重载覆盖的 key 若仍是脏的（preserved）则跳过 setState + clearDirty，
	// 否则切 tab 会丢草稿；保存/导入路径 force:true 时才强制对齐磁盘。
	assert.match(source, /if \(!preserved\.has\(key\)\) clearDirty\(key\)/);
	assert.match(source, /dirtyKeysPreservedOnReload\(target, dirtyTabsRef\.current\)/);
	assert.match(source, /loadConfig\("models", \{ force: true \}\)/);
	assert.match(source, /for \(const key of ALL_CONFIG_DIRTY_KEYS\) clearDirty\(key\)/);
	assert.match(source, /import \{\s*ALL_CONFIG_DIRTY_KEYS,\s*dirtyKeysClearedByReload,\s*dirtyKeysPreservedOnReload,\s*orderDirtyKeysForSave,\s*reconcileConfigDirty\s*\} from "\.\/config\/configDirtyMarks"/);
	// reconcile 已收敛到 configDirtyMarks（不再在 ConfigModal 内重复定义）
	assert.match(source, /reconcileConfigDirty\(next, "config:models", modelsData, baselineModelsRef\.current\)/);
	// 旧的仅清当前 tab 的写法必须移除
	assert.doesNotMatch(source, /clearDirty\(target === "raw" \? "config:raw" : `config:\$\{target\}`\)/);
});

// ── 装配契约：每模型默认档位的 settings 草稿链路 ──

test("模型页保存顺带落盘 settings 草稿，且不整页重载（避免冲掉 auth/raw 草稿）", () => {
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 保存 models 后若 settings 仍是脏的 → 走「只写不重载」保存。
	assert.match(modal, /dirtyTabsRef\.current\.has\("config:settings"\)[\s\S]{0,40}?saveSettingsDraftOnly\(\)/);
	// 「只写不重载」路径必须自己同步基准快照，否则脏检测会把刚清掉的黄点标回来。
	// 快照取的是清理后的对象（落盘前会按模型列表清孤儿档位键）。
	assert.match(modal, /baselineSettingsRef\.current = deepClone\(pruned\)/);
	// 两条「保存全部」路径都要用排好序的键列表（settings 最后）。
	const orderedUses = modal.match(/for \(const key of orderDirtyKeysForSave\(roots\)\)/g) ?? [];
	assert.equal(orderedUses.length, 2, "saveAllDirty 与保存并关闭都必须按 orderDirtyKeysForSave 顺序保存");
});

test("models 页加载 settings 失败时不渲染编辑入口（settingsLoaded 门控）", () => {
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	const modelsTab = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
	// models 分支并行读 settings；读失败只降级，settingsLoaded 保持 false。
	assert.match(modal, /const \[res, settingsRes\] = await Promise\.all\(\[api\.config\.getModels\(\), api\.config\.getSettings\(\)\.catch\(\(\) => null\)\]\)/);
	assert.match(modal, /setSettingsLoaded\(true\)/);
	// 编辑入口的成对回调都用 settingsLoaded 门控，未加载成功时整块不渲染。
	assert.match(modal, /onUpdateModelThinkingLevelDefault=\{settingsLoaded \? handleUpdateModelThinkingLevelDefault : undefined\}/);
	assert.match(modal, /getModelThinkingLevelDefault=\{settingsLoaded \?/);
	// 每模型默认档位写 settings.json，脏标记必须记在 config:settings 上（不能记成 models）。
	// 键按 modelId 拼（卡片与编辑页共用此回调；它们各自把行下标翻译成 modelId）。
	assert.match(modal, /withModelThinkingLevelDefault\(previous, providerName, modelId, level\)\)[\s\S]{0,60}?markDirty\("config:settings"\)/);
	// 目录/只读展示与编辑入口在同一个共享表格里（ModelsTab 传 Pi capability 快照）。
	assert.match(modelsTab, /useAvailableThinkingLevels\(\)/);
	assert.match(modelsTab, /getModelAvailableThinkingLevels=\{\(i\) => \{/);
});
