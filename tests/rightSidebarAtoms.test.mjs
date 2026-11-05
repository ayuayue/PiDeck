import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/right-sidebar-atoms.ts");

// 2027-02 起「是否挂在右侧边栏」只看设置，不再由面板是否可见地展示某会话决定：
// 旧实现（rightSidebarStatusSessionIdAtom + atomFamily）在面板收起时会把横栏放回输入框上方。
test("单一布尔真值：默认关闭，写上即全局生效", () => {
	const store = createStore();
	assert.equal(store.get(atoms.sessionStatusInSidebarAtom), false);
	store.set(atoms.sessionStatusInSidebarAtom, true);
	assert.equal(store.get(atoms.sessionStatusInSidebarAtom), true);
	store.set(atoms.sessionStatusInSidebarAtom, false);
	assert.equal(store.get(atoms.sessionStatusInSidebarAtom), false);
});

test("按会话派生的旧 atom 已移除", () => {
	assert.equal(atoms.sessionStatusInSidebarAtomFamily, undefined);
	assert.equal(atoms.rightSidebarStatusSessionIdAtom, undefined);
});

// 「最近一轮 run」系列 atom 已随面板 files tab 一并移除（2027-02）：
// 文件修改改由每轮末尾的 chip 行（turn/TurnFileChanges）展示，不再需要跨组件发布 run。
test("latest-agent-run atoms are gone with the files tab", () => {
	assert.equal(atoms.sessionLatestAgentRunAtomFamily, undefined);
	assert.equal(atoms.publishSessionLatestAgentRunAtom, undefined);
});
