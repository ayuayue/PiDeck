import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/pi-thinking-atoms.ts");

const firstTarget = {
	agentId: "agent-a",
	runtimeGeneration: 1,
	provider: "relay",
	modelId: "gpt-5.6-luna",
};
const replacementTarget = {
	agentId: "agent-b",
	runtimeGeneration: 2,
	provider: "relay",
	modelId: "gpt-5.6-luna",
};

test("runtime thinking cache ignores a late response from a replaced agent", () => {
	const store = createStore();
	store.set(atoms.beginPiRuntimeThinkingLevelsAtom, {
		sessionId: "session-a",
		target: firstTarget,
	});
	store.set(atoms.beginPiRuntimeThinkingLevelsAtom, {
		sessionId: "session-a",
		target: replacementTarget,
	});
	store.set(atoms.resolvePiRuntimeThinkingLevelsAtom, {
		sessionId: "session-a",
		target: firstTarget,
		levels: ["off", "max"],
	});

	assert.deepEqual(JSON.parse(JSON.stringify(store.get(atoms.piRuntimeThinkingLevelsBySessionIdAtomFamily("session-a")))), { ...replacementTarget, status: "loading" });

	store.set(atoms.resolvePiRuntimeThinkingLevelsAtom, {
		sessionId: "session-a",
		target: replacementTarget,
		levels: ["off", "low", "high"],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(store.get(atoms.piRuntimeThinkingLevelsBySessionIdAtomFamily("session-a")))), { ...replacementTarget, status: "resolved", levels: ["off", "low", "high"] });
});

test("runtime thinking cache preserves an authoritative empty level list", () => {
	const store = createStore();
	store.set(atoms.beginPiRuntimeThinkingLevelsAtom, {
		sessionId: "session-a",
		target: firstTarget,
	});
	store.set(atoms.resolvePiRuntimeThinkingLevelsAtom, {
		sessionId: "session-a",
		target: firstTarget,
		levels: [],
	});

	const entry = store.get(atoms.piRuntimeThinkingLevelsBySessionIdAtomFamily("session-a"));
	assert.equal(entry?.status, "resolved");
	assert.deepEqual(JSON.parse(JSON.stringify(entry?.levels)), []);
});
