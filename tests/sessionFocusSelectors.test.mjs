import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 只隔离会话数据来源；聚焦切片使用生产 selector 和真实 Jotai 通知机制。 */
function harness() {
	const currentSessionIdAtom = atom(undefined);
	const { sessionFocusedByIdAtomFamily } = loadTsCommonJs("src/renderer/src/atoms/session-selectors.ts", {
		stubs: {
			"./session-atoms": { currentSessionIdAtom },
			"../utils/sessionDisplayName": {},
			"../utils/sessionRecordDisplay": {},
		},
	});
	return { store: createStore(), currentSessionIdAtom, sessionFocusedByIdAtomFamily };
}

test("a session focus selector only reports whether its own pane is focused", () => {
	const h = harness();
	const focusA = h.sessionFocusedByIdAtomFamily("a");
	const focusB = h.sessionFocusedByIdAtomFamily("b");
	assert.equal(h.sessionFocusedByIdAtomFamily("a"), focusA);
	assert.equal(h.store.get(focusA), false);
	h.store.set(h.currentSessionIdAtom, "a");
	assert.equal(h.store.get(focusA), true);
	assert.equal(h.store.get(focusB), false);
	h.store.set(h.currentSessionIdAtom, "b");
	assert.equal(h.store.get(focusA), false);
	assert.equal(h.store.get(focusB), true);
	h.store.set(h.currentSessionIdAtom, undefined);
	assert.equal(h.store.get(focusA), false);
	assert.equal(h.store.get(focusB), false);
});

test("a session focus subscriber is not notified when focus moves between other panes", () => {
	const h = harness();
	const focusA = h.sessionFocusedByIdAtomFamily("a");
	const values = [];
	const off = h.store.sub(focusA, () => values.push(h.store.get(focusA)));
	h.store.set(h.currentSessionIdAtom, "a");
	h.store.set(h.currentSessionIdAtom, "b");
	h.store.set(h.currentSessionIdAtom, "c");
	h.store.set(h.currentSessionIdAtom, "a");
	assert.deepEqual(values, [true, false, true]);
	off();
	h.store.set(h.currentSessionIdAtom, undefined);
	assert.deepEqual(values, [true, false, true]);
});
