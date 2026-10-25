import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/right-sidebar-atoms.ts");

test("面板只「占用」它正在展示的会话：分屏另一栏不受影响，切换后旧会话恢复", () => {
	const store = createStore();
	const a = atoms.sessionStatusInSidebarAtomFamily("session-a");
	const b = atoms.sessionStatusInSidebarAtomFamily("session-b");
	assert.equal(store.get(a), false);
	store.set(atoms.rightSidebarStatusSessionIdAtom, "session-a");
	assert.equal(store.get(a), true);
	assert.equal(store.get(b), false);
	store.set(atoms.rightSidebarStatusSessionIdAtom, "session-b");
	assert.equal(store.get(a), false);
	assert.equal(store.get(b), true);
	store.set(atoms.rightSidebarStatusSessionIdAtom, null);
	assert.equal(store.get(b), false);
});

test("切换面板会话只通知状态真正变化的会话", () => {
	const store = createStore();
	let notifyC = 0;
	store.sub(atoms.sessionStatusInSidebarAtomFamily("session-c"), () => {
		notifyC += 1;
	});
	store.set(atoms.rightSidebarStatusSessionIdAtom, "session-a");
	store.set(atoms.rightSidebarStatusSessionIdAtom, "session-b");
	assert.equal(notifyC, 0);
});

// 「最近一轮 run」系列 atom 已随面板 files tab 一并移除（2027-02）：
// 文件修改改由每轮末尾的 chip 行（turn/TurnFileChanges）展示，不再需要跨组件发布 run。
test("latest-agent-run atoms are gone with the files tab", () => {
	assert.equal(atoms.sessionLatestAgentRunAtomFamily, undefined);
	assert.equal(atoms.publishSessionLatestAgentRunAtom, undefined);
});
