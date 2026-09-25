import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function setup() {
	const load = createTsSandbox();
	return { ...load("src/renderer/src/atoms/session-atoms.ts"), ...load("src/renderer/src/atoms/recent-session-atoms.ts"), store: createStore() };
}
function record(id, extra = {}) {
	return { id, projectId: "project", title: id, source: "pi", environment: "native", preview: "", messageCount: 0, status: "draft", createdAt: 1, updatedAt: 1, ...extra };
}

test("recent Agent activity: visiting a catalog record does not add it; runtime binding does", () => {
	const a = setup();
	a.store.set(a.replaceProjectSessionsAtom, { projectId: "project", sessions: [record("s1")] });
	a.store.set(a.currentSessionIdAtom, "s1");
	assert.equal(a.store.get(a.recentSessionActivityAtom).length, 0);
	a.store.set(a.bindSessionRuntimeAtom, { sessionId: "s1", agentId: "agent-1", runtimeGeneration: 1, status: "running" });
	assert.equal(a.store.get(a.recentSessionActivityAtom)[0].sessionId, "s1");
});

test("recent Agent activity: 20 unique entries, revisiting reorders without duplicates", () => {
	const a = setup();
	for (let i = 1; i <= 21; i++) a.store.set(a.touchRecentSessionAtom, { sessionId: `s${i}`, projectId: "project" });
	assert.equal(a.store.get(a.recentSessionActivityAtom).length, 20);
	assert.equal(
		a.store.get(a.recentSessionActivityAtom).some((x) => x.sessionId === "s1"),
		false,
	);
	a.store.set(a.touchRecentSessionAtom, { sessionId: "s2", projectId: "project" });
	assert.equal(a.store.get(a.recentSessionActivityAtom)[0].sessionId, "s2");
	assert.equal(a.store.get(a.recentSessionActivityAtom).filter((x) => x.sessionId === "s2").length, 1);
});

test("recent Agent activity: anonymous binding excluded and deletion removes the index", () => {
	const a = setup();
	a.store.set(a.replaceProjectSessionsAtom, { projectId: "project", sessions: [record("normal"), record("private", { noSession: true })] });
	a.store.set(a.bindSessionRuntimeAtom, { sessionId: "private", agentId: "a-private", runtimeGeneration: 1, status: "running" });
	assert.equal(a.store.get(a.recentSessionActivityAtom).length, 0);
	a.store.set(a.bindSessionRuntimeAtom, { sessionId: "normal", agentId: "a-normal", runtimeGeneration: 1, status: "running" });
	a.store.set(a.removeSessionStateAtom, "normal");
	assert.equal(a.store.get(a.recentSessionActivityAtom).length, 0);
});

test("recent Agent activity: unchanged runtime polling does not reorder existing entries", () => {
	const a = setup();
	const runtime = { sessionId: "s1", projectId: "project", agentId: "a1", runtimeGeneration: 1, status: "idle", updatedAt: 1 };
	a.store.set(a.replaceSessionRuntimesAtom, [runtime]);
	a.store.set(a.touchRecentSessionAtom, { sessionId: "s2", projectId: "project" });
	const previous = a.store.get(a.recentSessionActivityAtom);
	a.store.set(a.replaceSessionRuntimesAtom, [{ ...runtime, updatedAt: 2 }]);
	assert.equal(a.store.get(a.recentSessionActivityAtom), previous);
});
