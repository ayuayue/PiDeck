import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 隐藏功能模块（issue #248）：清洗规则 + 侧栏过滤策略。
 * 两个模块都只有 type-only 的 renderer import，可直接在 vm 里加载。
 */
const { HIDEABLE_MODULE_IDS, HIDEABLE_SETTINGS_TAB_IDS, MAX_HIDDEN_MODULES, normalizeHiddenModules, isModuleHidden, toggleHiddenModule } = loadTsCommonJs("src/shared/hiddenModules.ts");
const { isSettingsTabHidden, resolveVisibleSettingsTabs, resolveInitialSettingsTab } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabVisibility.ts");
const { SETTINGS_TAB_LAYOUT, SETTINGS_TAB_IDS } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");

/** vm realm 的数组原型与宿主不同，deepEqual 前转成普通数组。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── shared/hiddenModules.ts ─────────────────────────────────────────────

test("可隐藏 tab 都是真实存在的设置 tab；dsh 是唯一的非 tab 模块", () => {
	for (const id of HIDEABLE_SETTINGS_TAB_IDS) {
		assert.ok(SETTINGS_TAB_IDS.includes(id), `${id} 不是 SETTINGS_TAB_IDS 里的 tab`);
	}
	assert.deepEqual(plain(HIDEABLE_MODULE_IDS), [...plain(HIDEABLE_SETTINGS_TAB_IDS), "dsh"]);
	// 应用基础项不可隐藏（外观放着开关本身，隐藏后无法找回）
	for (const id of ["common", "appearance", "shortcuts", "notification", "proxy", "dev", "storage", "backup", "editors"]) {
		assert.equal(HIDEABLE_SETTINGS_TAB_IDS.includes(id), false, `${id} 不应可隐藏`);
	}
});

test("normalizeHiddenModules：非数组回落空数组，只收非空字符串并去重去空白", () => {
	assert.deepEqual(plain(normalizeHiddenModules(undefined)), []);
	assert.deepEqual(plain(normalizeHiddenModules("im")), []);
	assert.deepEqual(plain(normalizeHiddenModules({ im: true })), []);
	assert.deepEqual(plain(normalizeHiddenModules(["im", " pet ", "", 42, null, "im", "   "])), ["im", "pet"]);
});

test("normalizeHiddenModules：容忍未知 id（可能来自更新版本），不按清单过滤", () => {
	assert.deepEqual(plain(normalizeHiddenModules(["future-module", "dsh"])), ["future-module", "dsh"]);
});

test("normalizeHiddenModules：按上限截断", () => {
	const many = Array.from({ length: MAX_HIDDEN_MODULES + 10 }, (_, i) => `m${i}`);
	assert.equal(normalizeHiddenModules(many).length, MAX_HIDDEN_MODULES);
});

test("toggleHiddenModule 不改入参且幂等；isModuleHidden 读成员关系", () => {
	const base = Object.freeze(["im"]);
	assert.deepEqual(plain(toggleHiddenModule(base, "dsh", true)), ["im", "dsh"]);
	assert.deepEqual(plain(toggleHiddenModule(base, "im", true)), ["im"]);
	assert.deepEqual(plain(toggleHiddenModule(base, "im", false)), []);
	assert.deepEqual(plain(toggleHiddenModule(base, "dsh", false)), ["im"]);
	assert.equal(isModuleHidden(["dsh"], "dsh"), true);
	assert.equal(isModuleHidden(["dsh"], "im"), false);
});

// ── settingsTabVisibility.ts ────────────────────────────────────────────

test("默认（空数组）不过滤任何 tab，布局原样输出", () => {
	assert.deepEqual(plain(resolveVisibleSettingsTabs([], new Set())), plain(SETTINGS_TAB_LAYOUT));
});

test("不可隐藏的 tab 即使出现在 hiddenModules 里也不会消失", () => {
	const visible = resolveVisibleSettingsTabs(["common", "appearance", "dsh", "unknown"], new Set());
	assert.deepEqual(plain(visible), plain(SETTINGS_TAB_LAYOUT));
	assert.equal(isSettingsTabHidden(["common"], "common"), false);
	assert.equal(isSettingsTabHidden(["im"], "im"), true);
});

test("隐藏簇首项时分割线顺延到该簇下一个可见项", () => {
	// 「扩展集成」簇首项是 im（dividerBefore）；隐藏 im 后 pet 应带上分割线
	const visible = resolveVisibleSettingsTabs(["im"], new Set());
	const ids = visible.map((e) => e.id);
	assert.equal(ids.includes("im"), false);
	assert.equal(visible.find((e) => e.id === "pet").dividerBefore, true);
	// 其余分割线位置不受影响
	assert.deepEqual(plain(visible.filter((e) => e.dividerBefore).map((e) => e.id)), ["pet", "web", "dev"]);
});

test("整簇隐藏时该簇分割线消失，不留连续两条线", () => {
	const visible = resolveVisibleSettingsTabs(["im", "pet", "vision", "imagegen", "acp", "hostplugins"], new Set());
	// 全簇隐藏后不残留分割线；仅隐部分成员时，分割线顺延到簇内下一个可见项（上一条测试）
	assert.deepEqual(plain(visible.filter((e) => e.dividerBefore).map((e) => e.id)), ["web", "dev"]);
});

test("revealedTabs 让隐藏 tab 临时出现在侧栏（深链 / 搜索找回）", () => {
	const visible = resolveVisibleSettingsTabs(["im", "pet"], new Set(["im"]));
	const ids = visible.map((e) => e.id);
	assert.equal(ids.includes("im"), true);
	assert.equal(ids.includes("pet"), false);
	assert.equal(visible.find((e) => e.id === "im").dividerBefore, true);
});

test("首个可见项永不带分割线", () => {
	// 把 common 之前人为放一条 divider 的布局：过滤后首项 divider 必须被抑制
	const layout = [{ id: "im", dividerBefore: true }, { id: "pet" }];
	const visible = resolveVisibleSettingsTabs([], new Set(), layout);
	assert.equal(visible[0].dividerBefore, undefined);
});

test("初始 tab：深链优先（即使指向隐藏 tab）；记忆值被隐藏时回退 common", () => {
	assert.equal(resolveInitialSettingsTab("im", "dev", ["im"]), "im");
	assert.equal(resolveInitialSettingsTab(undefined, "im", ["im"]), "common");
	assert.equal(resolveInitialSettingsTab(undefined, "dev", ["im"]), "dev");
	assert.equal(resolveInitialSettingsTab(undefined, "im", []), "im");
});
