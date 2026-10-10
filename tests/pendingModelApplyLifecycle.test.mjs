import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { actualSelection, createSessionPreferenceControllerHarness as harness, NEXT, selectedModel, SOURCE } from "./helpers/sessionPreferenceControllerHarness.mjs";
import { deferred, plain, runtimeInfo, sourceTarget } from "./helpers/sessionRunControlHarness.mjs";

/** 队列保留对象身份；替换同一会话的意图也必须淘汰先前请求。 */
function pendingModel(modelId = "chosen") {
	return { from: { provider: "saved", modelId: "old", modelName: "Saved" }, to: { provider: "selected", modelId, modelName: "Chosen model" } };
}

/** 在真实 controller 的 pending hook 中暂停命令，不启动真实 runtime。 */
function beginPendingApply() {
	const h = harness({ pendingApply: true });
	const wait = deferred();
	h.pendingModels[SOURCE] = pendingModel();
	h.sessions.setRuntimeModel = (target) => {
		h.calls.commands.push(plain(target));
		return wait.promise;
	};
	h.render();
	assert.deepEqual(h.calls.commands, [sourceTarget]);
	return { h, wait };
}

const outcomes = [
	{ name: "success", result: { ok: true, value: { target: sourceTarget, value: actualSelection } } },
	{ name: "unavailable", result: { ok: false, error: { code: "SESSION_RUNTIME_UNAVAILABLE" } } },
	{ name: "restart", result: { ok: false, error: { code: "SESSION_MODEL_NOT_FOUND", needsRestart: true } } },
	{ name: "failure", result: { ok: false, error: { code: "SESSION_COMMAND_FAILED" } } },
];

for (const change of ["runtime", "generation", "detach", "new-pending", "same-model-new-intent"]) {
	for (const outcome of outcomes) {
		test(`pending model ${outcome.name} cannot publish after ${change} before a renderer update`, async () => {
			const { h, wait } = beginPendingApply();
			if (change === "runtime") h.runtimes[SOURCE] = runtimeInfo({ agentId: "replacement", runtimeGeneration: 2 });
			if (change === "generation") h.runtimes[SOURCE] = runtimeInfo({ runtimeGeneration: 2 });
			if (change === "detach") h.runtimes[SOURCE] = undefined;
			if (change === "new-pending") h.pendingModels[SOURCE] = pendingModel("newer");
			if (change === "same-model-new-intent") h.pendingModels[SOURCE] = pendingModel();
			const pending = h.pendingModels[SOURCE];
			wait.resolve(outcome.result);
			await setImmediate();
			assert.deepEqual(h.calls.upserts, [], "the retired readback must not overwrite the current model");
			assert.deepEqual(h.calls.pending, [], "the retired request must not clear a current pending selection");
			assert.deepEqual(h.calls.applied, [], "a retired restart offer cannot close the current picker");
			assert.deepEqual(h.calls.notices, [], "errors belong to the retired request, not the replacement");
			assert.equal(h.pendingModels[SOURCE], pending);
			h.unmount();
		});
	}
}

for (const change of ["session", "unmount"]) {
	test(`pending model completion is ignored after ${change}`, async () => {
		const { h, wait } = beginPendingApply();
		if (change === "session") h.render(NEXT);
		else h.unmount();
		wait.resolve(outcomes[0].result);
		await setImmediate();
		assert.deepEqual(h.calls.upserts, []);
		assert.deepEqual(h.calls.pending, []);
		assert.deepEqual(h.calls.notices, []);
		h.unmount();
	});
}

test("a busy model selection applies exactly once after idle and publishes runtime readback", async () => {
	const h = harness({ pendingApply: true });
	h.runtimes[SOURCE] = runtimeInfo({ status: "running" });
	const apply = h.sessions.setRuntimeModel;
	h.sessions.setRuntimeModel = async () => ({ ok: false, error: { code: "SESSION_RUNTIME_BUSY" } });
	await h.render().applyModel(selectedModel);
	assert.deepEqual(plain(h.pendingModels[SOURCE]), pendingModel());
	h.sessions.setRuntimeModel = apply;
	h.render();
	assert.deepEqual(h.calls.commands, [], "running runtime must retain the pending choice");
	h.calls.upserts.length = 0;
	h.runtimes[SOURCE] = runtimeInfo();
	h.render();
	await setImmediate();
	assert.equal(h.calls.commands.length, 1);
	assert.equal(h.calls.upserts.length, 1);
	assert.deepEqual(h.calls.upserts[0].model, { provider: "selected", modelId: "chosen", modelName: "Pi model" });
	assert.equal(h.calls.upserts[0].thinkingLevel, "high");
	assert.equal(h.pendingModels[SOURCE], undefined);
	h.render();
	await setImmediate();
	assert.equal(h.calls.commands.length, 1);
	h.unmount();
});

test("a pending model waits through starting and applies when the same runtime becomes idle", async () => {
	const h = harness({ pendingApply: true });
	h.pendingModels[SOURCE] = pendingModel();
	h.runtimes[SOURCE] = runtimeInfo({ status: "starting" });
	h.render();
	await setImmediate();
	assert.deepEqual(h.calls.commands, [], "starting has a binding but is not ready for a model command");
	assert.ok(h.pendingModels[SOURCE]);
	h.runtimes[SOURCE] = runtimeInfo();
	h.render();
	await setImmediate();
	assert.equal(h.calls.commands.length, 1);
	assert.equal(h.pendingModels[SOURCE], undefined);
	h.unmount();
});

for (const status of ["error", "closed", "detached"]) {
	test(`a ${status} runtime clears only the obsolete pending badge without sending a model command`, async () => {
		const h = harness({ pendingApply: true });
		h.pendingModels[SOURCE] = pendingModel();
		h.runtimes[SOURCE] = runtimeInfo({ status });
		h.render();
		await setImmediate();
		assert.deepEqual(h.calls.commands, [], "terminal bindings are not usable runtimes");
		assert.deepEqual(h.calls.upserts, [], "the saved next-start preference must be preserved");
		assert.equal(h.pendingModels[SOURCE], undefined);
		h.unmount();
	});
}

test("restart is offered once per pending choice and binding, but a replacement runtime can apply it", async () => {
	const h = harness({ pendingApply: true });
	const apply = h.sessions.setRuntimeModel;
	let rejected = 0;
	h.sessions.setRuntimeModel = async () => {
		rejected++;
		return outcomes[2].result;
	};
	h.pendingModels[SOURCE] = pendingModel();
	h.render();
	await setImmediate();
	const confirmation = h.render();
	assert.ok(confirmation.restartTarget);
	confirmation.cancelRestart();
	h.runtimes[SOURCE] = runtimeInfo({ status: "running" });
	h.render();
	h.runtimes[SOURCE] = runtimeInfo();
	h.render();
	await setImmediate();
	assert.equal(rejected, 1, "cancelled restart offers must not repeatedly reopen on runtime refreshes");
	assert.equal(h.render().restartTarget, null);
	h.sessions.setRuntimeModel = apply;
	h.runtimes[SOURCE] = runtimeInfo({ agentId: "replacement", runtimeGeneration: 2 });
	h.render();
	await setImmediate();
	assert.equal(h.calls.commands.length, 1, "a block from a retired binding cannot disable its replacement");
	assert.equal(h.calls.commands[0][1].agentId, "replacement");
	assert.equal(h.pendingModels[SOURCE], undefined);
	h.unmount();
});

test("a restart-blocked pending badge is cleared when its runtime closes", async () => {
	const h = harness({ pendingApply: true });
	h.pendingModels[SOURCE] = pendingModel();
	h.sessions.setRuntimeModel = async () => outcomes[2].result;
	h.render();
	await setImmediate();
	assert.ok(h.render().restartTarget);
	h.runtimes[SOURCE] = runtimeInfo({ status: "closed" });
	h.render();
	assert.equal(h.pendingModels[SOURCE], undefined);
	assert.deepEqual(h.calls.upserts, []);
	h.unmount();
});

for (const status of ["error", "closed", "detached"]) {
	test(`pending model readback is ignored when its runtime becomes ${status} before render`, async () => {
		const { h, wait } = beginPendingApply();
		h.runtimes[SOURCE] = runtimeInfo({ status });
		wait.resolve(outcomes[0].result);
		await setImmediate();
		assert.deepEqual(h.calls.upserts, []);
		assert.deepEqual(h.calls.pending, []);
		h.render();
		assert.equal(h.pendingModels[SOURCE], undefined);
		h.unmount();
	});
}

test("a pending choice without a runtime clears its badge without writing the saved preference", () => {
	const h = harness({ pendingApply: true, bound: false });
	h.pendingModels[SOURCE] = pendingModel();
	h.render();
	assert.equal(h.pendingModels[SOURCE], undefined);
	assert.deepEqual(h.calls.commands, []);
	assert.deepEqual(h.calls.upserts, []);
	assert.deepEqual(h.calls.updates, []);
	h.unmount();
});

test("streaming still defers pending application when runtime status is already idle", async () => {
	const h = harness({ pendingApply: true });
	h.pendingModels[SOURCE] = pendingModel();
	h.runtimes[SOURCE] = { ...runtimeInfo(), state: { isStreaming: true } };
	h.render();
	await setImmediate();
	assert.deepEqual(h.calls.commands, []);
	h.runtimes[SOURCE] = { ...runtimeInfo(), state: { isStreaming: false } };
	h.render();
	await setImmediate();
	assert.equal(h.calls.commands.length, 1);
	assert.equal(h.pendingModels[SOURCE], undefined);
	h.unmount();
});

test("a replaced request cannot block or clear the newer pending application", async () => {
	const { h, wait } = beginPendingApply();
	const next = deferred();
	h.pendingModels[SOURCE] = pendingModel("newer");
	h.sessions.setRuntimeModel = (target) => {
		h.calls.commands.push(plain(target));
		return next.promise;
	};
	h.render();
	assert.equal(h.calls.commands.length, 2);
	wait.resolve(outcomes[2].result);
	await setImmediate();
	assert.deepEqual(h.calls.applied, []);
	assert.deepEqual(h.calls.pending, []);
	assert.equal(h.render().restartTarget, null);
	assert.equal(h.calls.commands.length, 2);
	next.resolve({ ok: true, value: { target: sourceTarget, value: { ...actualSelection, modelId: "newer" } } });
	await setImmediate();
	assert.equal(h.calls.upserts.length, 1);
	assert.equal(h.calls.upserts[0].model.modelId, "newer");
	assert.equal(h.pendingModels[SOURCE], undefined);
	h.unmount();
});

for (const code of ["SESSION_RUNTIME_UNAVAILABLE", "SESSION_RUNTIME_CHANGED"]) {
	test(`current ${code} clears only the pending badge`, async () => {
		const { h, wait } = beginPendingApply();
		wait.resolve({ ok: false, error: { code } });
		await setImmediate();
		assert.equal(h.pendingModels[SOURCE], undefined);
		assert.deepEqual(h.calls.upserts, []);
		assert.deepEqual(h.calls.updates, []);
		assert.deepEqual(h.calls.notices, []);
		h.unmount();
	});
}

test("a current pending failure remains visible and can retry after the next busy-to-idle transition", async () => {
	const { h, wait } = beginPendingApply();
	wait.resolve(outcomes[3].result);
	await setImmediate();
	assert.deepEqual(h.calls.notices, ["sessionCommand.commandFailed"]);
	assert.ok(h.pendingModels[SOURCE]);
	assert.deepEqual(h.calls.upserts, []);
	h.sessions.setRuntimeModel = async (target) => ({ ok: true, value: { target, value: actualSelection } });
	h.runtimes[SOURCE] = runtimeInfo({ status: "running" });
	h.render();
	h.runtimes[SOURCE] = runtimeInfo();
	h.render();
	await setImmediate();
	assert.equal(h.calls.upserts.length, 1);
	assert.equal(h.pendingModels[SOURCE], undefined);
	h.unmount();
});
