import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { INITIAL_PICKER_GROUP_SELECTION, applyPickerGroupAction, resolveGroupExpanded } = loadTsCommonJs("src/renderer/src/components/ui-shadcn/commandPickerExpansion.ts");

const DEFAULT_EXPANDED = new Set(["favorites", "provider:openai"]);

function assertEqualState(actual, expected) {
	// vm 上下文的 Map/Set 原型与宿主不同，deepStrictEqual 误报；用 JSON 比较。
	// actual.overrides 是沙箱 Map，expected.overrides 是普通对象字面量，分别取 entries。
	const entries = (value) => (typeof value?.entries === "function" ? [...value.entries()] : Object.entries(value));
	const normalize = (sel) => ({
		mode: sel.mode,
		overrides: Object.fromEntries(entries(sel.overrides).sort()),
	});
	assert.equal(JSON.stringify(normalize(actual)), JSON.stringify(normalize(expected)));
}

test("resolve: 默认集合内的分组展开，集合外折叠", () => {
	assert.equal(
		resolveGroupExpanded({
			selection: INITIAL_PICKER_GROUP_SELECTION,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "provider:openai",
		}),
		true,
	);
	assert.equal(
		resolveGroupExpanded({
			selection: INITIAL_PICKER_GROUP_SELECTION,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "provider:anthropic",
		}),
		false,
	);
});

test("resolve: defaultExpandedIds 为 null（未传）= 默认全展开", () => {
	assert.equal(
		resolveGroupExpanded({
			selection: INITIAL_PICKER_GROUP_SELECTION,
			defaultExpandedIds: null,
			searchActive: false,
			groupId: "provider:anything",
		}),
		true,
	);
});

test("resolve: 搜索期间强制展开，无视默认与覆盖", () => {
	const collapsedOverride = applyPickerGroupAction({
		selection: INITIAL_PICKER_GROUP_SELECTION,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "provider:openai" },
	});
	assert.equal(
		resolveGroupExpanded({
			selection: collapsedOverride,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: true,
			groupId: "provider:openai",
		}),
		true,
	);
});

test("resolve: 用户覆盖优先于默认集合", () => {
	const selection = applyPickerGroupAction({
		selection: INITIAL_PICKER_GROUP_SELECTION,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "provider:openai" },
	});
	// 默认展开 → toggle 后折叠（覆盖 false）
	assert.equal(
		resolveGroupExpanded({
			selection,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "provider:openai",
		}),
		false,
	);
	// 默认集合外的组无覆盖 → 仍折叠
	assert.equal(
		resolveGroupExpanded({
			selection,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "provider:anthropic",
		}),
		false,
	);
});

test("toggle: 默认展开→折叠、默认折叠→展开，两次再翻回", () => {
	const once = applyPickerGroupAction({
		selection: INITIAL_PICKER_GROUP_SELECTION,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "provider:openai" },
	});
	assertEqualState(once, { mode: "default", overrides: { "provider:openai": false } });

	const twice = applyPickerGroupAction({
		selection: once,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "provider:openai" },
	});
	assertEqualState(twice, { mode: "default", overrides: { "provider:openai": true } });

	const hidden = applyPickerGroupAction({
		selection: INITIAL_PICKER_GROUP_SELECTION,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "provider:anthropic" },
	});
	assertEqualState(hidden, { mode: "default", overrides: { "provider:anthropic": true } });
});

test("toggle: 清空用户覆盖后回到默认集合状态（数据影响恢复）", () => {
	const selection = applyPickerGroupAction({
		selection: INITIAL_PICKER_GROUP_SELECTION,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "provider:openai" },
	});
	assert.equal(
		resolveGroupExpanded({
			selection,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "provider:openai",
		}),
		false,
	);
	// 数据刷新后默认集合变化（如当前模型改名）：未覆盖的分组自动跟随
	const refreshedDefault = new Set(["favorites", "provider:anthropic"]);
	assert.equal(
		resolveGroupExpanded({
			selection,
			defaultExpandedIds: refreshedDefault,
			searchActive: false,
			groupId: "provider:openai",
		}),
		false, // 用户覆盖仍优先
	);
	assert.equal(
		resolveGroupExpanded({
			selection,
			defaultExpandedIds: refreshedDefault,
			searchActive: false,
			groupId: "provider:anthropic",
		}),
		true, // 无覆盖，跟随新默认集合
	);
});

test("expandAll: 全部展开并清空覆盖", () => {
	const selection = applyPickerGroupAction({
		selection: INITIAL_PICKER_GROUP_SELECTION,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "provider:openai" },
	});
	const all = applyPickerGroupAction({
		selection,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "expandAll" },
	});
	assertEqualState(all, { mode: "allExpanded", overrides: {} });
	assert.equal(
		resolveGroupExpanded({
			selection: all,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "provider:anthropic",
		}),
		true,
	);
});

test("collapseAll: 全部折叠；其后单组 toggle 只展开该组", () => {
	const all = applyPickerGroupAction({
		selection: INITIAL_PICKER_GROUP_SELECTION,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "collapseAll" },
	});
	assertEqualState(all, { mode: "allCollapsed", overrides: {} });
	assert.equal(
		resolveGroupExpanded({
			selection: all,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "favorites",
		}),
		false,
	);
	const one = applyPickerGroupAction({
		selection: all,
		defaultExpandedIds: DEFAULT_EXPANDED,
		action: { kind: "toggle", groupId: "favorites" },
	});
	assert.equal(
		resolveGroupExpanded({
			selection: one,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "favorites",
		}),
		true,
	);
	// 其余组仍折叠
	assert.equal(
		resolveGroupExpanded({
			selection: one,
			defaultExpandedIds: DEFAULT_EXPANDED,
			searchActive: false,
			groupId: "provider:openai",
		}),
		false,
	);
});
