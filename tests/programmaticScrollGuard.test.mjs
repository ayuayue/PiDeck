import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const guard = createTsSandbox()("src/renderer/src/hooks/timeline/programmaticScrollGuard.ts");

test("timed programmatic-scroll suppression expires without an explicit cleanup callback", () => {
	const state = guard.createProgrammaticScrollGuard();
	guard.beginProgrammaticScroll(state, 1_000, 120);

	assert.equal(guard.isProgrammaticScrollActive(state, 1_119), true);
	assert.equal(guard.isProgrammaticScrollActive(state, 1_120), false);
	assert.equal(guard.isProgrammaticScrollActive(state, 5_000), false);
});

test("a next-frame mark does not shorten an active timed suppression", () => {
	const state = guard.createProgrammaticScrollGuard();
	guard.beginProgrammaticScroll(state, 1_000, 120);
	const frameGeneration = guard.beginProgrammaticScroll(state, 1_050, 0);
	guard.finishProgrammaticScrollFrame(state, frameGeneration);

	assert.equal(guard.isProgrammaticScrollActive(state, 1_119), true);
	assert.equal(guard.isProgrammaticScrollActive(state, 1_120), false);
});

test("an older next-frame cleanup cannot clear a newer suppression window", () => {
	const state = guard.createProgrammaticScrollGuard();
	const firstGeneration = guard.beginProgrammaticScroll(state, 1_000, 0);
	assert.equal(guard.isProgrammaticScrollActive(state, 1_000), true);

	guard.beginProgrammaticScroll(state, 1_001, 120);
	guard.finishProgrammaticScrollFrame(state, firstGeneration);
	assert.equal(guard.isProgrammaticScrollActive(state, 1_100), true);
	assert.equal(guard.isProgrammaticScrollActive(state, 1_121), false);

	guard.clearProgrammaticScroll(state);
	assert.equal(guard.isProgrammaticScrollActive(state, 1_001), false);
});
