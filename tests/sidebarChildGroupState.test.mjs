import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 父会话下面两类子项的展开规则（纯函数）。
 *
 * 背景（用户反馈）：关联子会话原来常显，一个父会话挂 30 条就把侧栏撑成一条长列表。
 * 现在两类子项一律默认收起，父行只留 `🔗 N` / `🤖 N` 计数；展开是显式动作，
 * 而且两类分开记——收起 30 条会话不影响正在跑的子智能体。
 */
const { CHILD_GROUP_DEFAULT_EXPANDED, childGroupOverrideKey, resolveChildGroupExpanded } = loadTsCommonJs("src/renderer/src/utils/childGroupState.ts");

test("两类子项默认都收起，与数量无关", () => {
	assert.equal(CHILD_GROUP_DEFAULT_EXPANDED, false);
	const overrides = new Map();
	for (const count of [1, 5, 30]) {
		assert.equal(resolveChildGroupExpanded(overrides, "project:row", "linked", count), false, `linked/${count}`);
		assert.equal(resolveChildGroupExpanded(overrides, "project:row", "agents", count), false, `agents/${count}`);
	}
});

test("用户切换过的分组以覆盖值为准，两类分组互不影响", () => {
	const overrides = new Map();
	overrides.set(childGroupOverrideKey("project:row", "linked"), true);
	assert.equal(resolveChildGroupExpanded(overrides, "project:row", "linked", 30), true);
	assert.equal(resolveChildGroupExpanded(overrides, "project:row", "agents", 3), false, "展开会话不得连带展开子智能体");

	overrides.set(childGroupOverrideKey("project:row", "agents"), true);
	assert.equal(resolveChildGroupExpanded(overrides, "project:row", "agents", 3), true);

	// 覆盖按父行 + 子项类型分键：别的父行不受影响。
	assert.equal(resolveChildGroupExpanded(overrides, "project:other", "linked", 30), false);
	assert.equal(resolveChildGroupExpanded(overrides, "project:other", "agents", 3), false);

	// 也能显式收起（默认收起时的反向覆盖）。
	overrides.set(childGroupOverrideKey("project:row", "linked"), false);
	assert.equal(resolveChildGroupExpanded(overrides, "project:row", "linked", 30), false);
});

test("没有子项时恒为收起：覆盖值也不能展开空分组", () => {
	const overrides = new Map([[childGroupOverrideKey("project:row", "linked"), true]]);
	assert.equal(resolveChildGroupExpanded(overrides, "project:row", "linked", 0), false);
	assert.equal(resolveChildGroupExpanded(overrides, "project:row", "agents", 0), false);
});
