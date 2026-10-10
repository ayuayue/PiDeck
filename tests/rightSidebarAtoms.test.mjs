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

test("最近一轮 run：发布、按会话隔离、卸载（undefined）后删除", () => {
	const store = createStore();
	const runA = { kind: "agent-run", id: "run-a", items: [], endedAt: 1 };
	const runB = { kind: "agent-run", id: "run-b", items: [], endedAt: 2 };
	const familyA = atoms.sessionLatestAgentRunAtomFamily("session-a");
	let notifyA = 0;
	store.sub(familyA, () => {
		notifyA += 1;
	});
	store.set(atoms.publishSessionLatestAgentRunAtom, { sessionId: "session-a", run: runA });
	assert.equal(store.get(familyA), runA);
	assert.equal(notifyA, 1);
	store.set(atoms.publishSessionLatestAgentRunAtom, { sessionId: "session-b", run: runB });
	assert.equal(notifyA, 1, "写别的会话不得通知本会话");
	store.set(atoms.publishSessionLatestAgentRunAtom, { sessionId: "session-a", run: runA });
	assert.equal(notifyA, 1, "同一 run 重复发布不得通知");
	store.set(atoms.publishSessionLatestAgentRunAtom, { sessionId: "session-a", run: undefined });
	assert.equal(store.get(familyA), undefined);
	assert.equal(store.get(atoms.sessionLatestAgentRunAtomFamily("session-b")), runB);
});
