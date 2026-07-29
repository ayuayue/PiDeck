import assert from "node:assert/strict";
import test from "node:test";
import {
	createStreamGateState,
	isStreamGateSealed,
	noteAbortSettled,
	openStreamGateForNewRun,
	sealStreamGate,
} from "../src/main/pi/streamGate.ts";

test("new gate accepts stream events", () => {
	const state = createStreamGateState();
	assert.equal(isStreamGateSealed(state), false);
});

test("abort seals until settled and next agent_start", () => {
	let state = createStreamGateState();
	state = openStreamGateForNewRun(state);
	assert.equal(isStreamGateSealed(state), false);

	state = sealStreamGate(state);
	assert.equal(isStreamGateSealed(state), true);

	// settled 本身不解封，只结束 waiting
	state = noteAbortSettled(state);
	assert.equal(isStreamGateSealed(state), true);

	// 下一轮 agent_start 才放行
	state = openStreamGateForNewRun(state);
	assert.equal(isStreamGateSealed(state), false);
});

test("agent_start before abort settled stays sealed until settled", () => {
	let state = createStreamGateState();
	state = openStreamGateForNewRun(state);
	state = sealStreamGate(state);
	assert.equal(isStreamGateSealed(state), true);

	// 用户立刻重发：agent_start 先到
	state = openStreamGateForNewRun(state);
	assert.equal(isStreamGateSealed(state), true);

	// 旧 run 的 settled 到达后才解封，避免残留 delta 混入新 run
	state = noteAbortSettled(state);
	assert.equal(isStreamGateSealed(state), false);
});

test("double abort stays sealed", () => {
	let state = createStreamGateState();
	state = openStreamGateForNewRun(state);
	state = sealStreamGate(state);
	state = sealStreamGate(state);
	assert.equal(isStreamGateSealed(state), true);
	state = noteAbortSettled(state);
	assert.equal(isStreamGateSealed(state), true);
});

test("abort before any agent_start still rejects until settled+start", () => {
	let state = createStreamGateState();
	state = sealStreamGate(state);
	assert.equal(isStreamGateSealed(state), true);
	state = noteAbortSettled(state);
	assert.equal(isStreamGateSealed(state), true);
	state = openStreamGateForNewRun(state);
	assert.equal(isStreamGateSealed(state), false);
});
