import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// settingsTabLayout.ts 只含 type-only import（编译期擦除），无运行时依赖，可直接加载。
const { SETTINGS_TAB_LAYOUT, SETTINGS_TAB_IDS } = loadTsCommonJs(
	"src/renderer/src/components/app/settings/settingsTabLayout.ts",
);

test("布局覆盖全部 15 个 tab 且不重复", () => {
	// loadTsCommonJs 在 vm 里执行，数组原型属于另一 realm，先展开到测试侧再比较
	const ids = [...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)];
	assert.equal(ids.length, 15);
	assert.equal(new Set(ids).size, ids.length);
	// SETTINGS_TAB_IDS 由布局派生，两者必须一致（单一事实来源）
	assert.deepEqual([...SETTINGS_TAB_IDS], ids);
});

test("展示顺序按 基础 → 扩展集成 → 开发者工具 → 开发与维护 排列", () => {
	assert.deepEqual([...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)], [
		"common", "appearance", "proxy",
		"im", "pet", "sound", "vision", "imagegen",
		"web", "editors", "git",
		"dev", "usage", "process", "storage",
	]);
});

test("分割线只出现在三个簇边界前，首项不带分割线", () => {
	assert.deepEqual([...SETTINGS_TAB_LAYOUT.filter((e) => e.dividerBefore).map((e) => e.id)], ["im", "web", "dev"]);
	assert.equal(SETTINGS_TAB_LAYOUT[0].dividerBefore, undefined);
});
