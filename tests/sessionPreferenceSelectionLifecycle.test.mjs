import assert from "node:assert/strict";
import test from "node:test";
import { deferred, plain, runtimeInfo } from "./helpers/sessionRunControlHarness.mjs";
import { actualSelection, createSessionPreferenceControllerHarness as harness, NEXT, selectedModel, SOURCE } from "./helpers/sessionPreferenceControllerHarness.mjs";

const operations = [
	{ name: "model", method: "setRuntimeModel", apply: (controller) => controller.applyModel(selectedModel) },
	{ name: "thinking", method: "setRuntimeThinking", apply: (controller) => controller.applyThinking("max") },
];

for (const operation of operations) {
	for (const change of ["session", "runtime", "generation", "detach", "unmount", "away-and-back"]) {
		test(`a late ${operation.name} selection is not published after ${change}`, async () => {
			const h = harness();
			const wait = deferred();
			const perform = h.sessions[operation.method];
			h.sessions[operation.method] = async (target) => {
				await wait.promise;
				return perform(target);
			};
			const nextBefore = plain(h.records[NEXT]);
			const pending = operation.apply(h.controller);
			if (change === "session" || change === "away-and-back") h.render(NEXT);
			if (change === "away-and-back") h.render(SOURCE);
			if (change === "runtime") h.runtimes[SOURCE] = runtimeInfo({ agentId: "replacement", runtimeGeneration: 2 });
			if (change === "generation") h.runtimes[SOURCE] = runtimeInfo({ runtimeGeneration: 2 });
			if (change === "detach") h.runtimes[SOURCE] = undefined;
			if (change === "unmount") h.unmount();
			wait.resolve();
			await pending;
			assert.deepEqual(h.calls.upserts, [], "source readback must not update a replacement pane or runtime");
			assert.deepEqual(h.calls.pending, []);
			assert.deepEqual(h.calls.applied, [], "a retired request cannot close the current picker");
			assert.deepEqual(h.records[NEXT], nextBefore);
		});
	}

	test(`a current ${operation.name} selection still publishes Pi's actual value`, async () => {
		const h = harness();
		await operation.apply(h.controller);
		assert.equal(h.calls.upserts.length, 1);
		assert.equal(h.calls.upserts[0].id, SOURCE);
		assert.equal(h.calls.upserts[0].thinkingLevel, "high");
		if (operation.name === "model") assert.deepEqual(h.calls.upserts[0].model, { provider: "selected", modelId: "chosen", modelName: "Pi model" });
		assert.deepEqual(h.calls.applied, [SOURCE]);
	});

	for (const changedTarget of [false, true]) {
		test(`a retired ${operation.name} command cannot downgrade to a catalog write (${changedTarget ? "replacement binding" : "same logical binding"})`, async () => {
			const h = harness();
			const wait = deferred();
			h.sessions[operation.method] = async () => {
				await wait.promise;
				return { ok: false, error: { code: "SESSION_RUNTIME_CHANGED", debugDetails: "runtime changed" } };
			};
			const pending = operation.apply(h.controller);
			if (changedTarget) h.runtimes[SOURCE] = runtimeInfo({ agentId: "replacement", runtimeGeneration: 2 });
			wait.resolve();
			await pending;
			assert.deepEqual(h.calls.updates, [], "the renderer must preserve the main-process fail-closed result");
			assert.deepEqual(h.calls.upserts, []);
			assert.deepEqual(h.calls.applied, []);
		});
	}

	test(`an unavailable current runtime retains the ${operation.name} next-start preference fallback`, async () => {
		const h = harness();
		h.sessions[operation.method] = async () => ({ ok: false, error: { code: "SESSION_RUNTIME_UNAVAILABLE" } });
		await operation.apply(h.controller);
		assert.equal(h.calls.updates.length, 1);
		assert.equal(h.calls.updates[0].id, SOURCE);
		assert.deepEqual(h.calls.applied, [SOURCE]);
	});

	for (const change of ["session", "runtime"]) {
		test(`a saved ${operation.name} preference is not republished after ${change}`, async () => {
			const h = harness({ bound: false });
			const wait = deferred();
			const perform = h.sessions.updateRecord;
			h.sessions.updateRecord = async (id, patch) => {
				await wait.promise;
				return perform(id, patch);
			};
			const pending = operation.apply(h.controller);
			if (change === "session") h.render(NEXT);
			else h.runtimes[SOURCE] = runtimeInfo();
			wait.resolve();
			await pending;
			assert.equal(h.calls.updates.length, 1, "the original catalog save is allowed to finish");
			assert.equal(h.calls.updates[0].id, SOURCE);
			assert.deepEqual(h.calls.upserts, []);
			assert.deepEqual(h.calls.applied, []);
		});
	}

	test(`a ${operation.name} selection without a runtime still saves its preference`, async () => {
		const h = harness({ bound: false });
		await operation.apply(h.controller);
		assert.equal(h.calls.updates.length, 1);
		assert.equal(h.calls.updates[0].id, SOURCE);
		assert.deepEqual(h.calls.applied, [SOURCE]);
	});
}

test("busy model lookup cannot offer a source-runtime restart after switching sessions", async () => {
	const h = harness();
	const wait = deferred();
	h.sessions.setRuntimeModel = async () => ({ ok: false, error: { code: "SESSION_RUNTIME_BUSY" } });
	h.sessions.listRuntimeModels = async (target) => {
		h.render(NEXT);
		await wait.promise;
		return { ok: true, value: { target, value: [] } };
	};
	const pending = h.controller.applyModel(selectedModel);
	wait.resolve();
	await pending;
	assert.deepEqual(h.calls.applied, []);
	assert.equal(h.render(NEXT).restartTarget, null);
	assert.deepEqual(h.calls.updates, []);
});

for (const code of ["SESSION_RUNTIME_CHANGED", "SESSION_RUNTIME_BUSY"]) {
	test(`busy model snapshot ${code} ${code === "SESSION_RUNTIME_CHANGED" ? "cannot downgrade to a record save" : "retains next-round queuing"}`, async () => {
		const h = harness();
		h.sessions.setRuntimeModel = async () => ({ ok: false, error: { code: "SESSION_RUNTIME_BUSY" } });
		h.sessions.listRuntimeModels = async () => ({ ok: false, error: { code } });
		await h.controller.applyModel(selectedModel);
		if (code === "SESSION_RUNTIME_CHANGED") {
			assert.deepEqual(h.calls.updates, []);
			assert.deepEqual(h.calls.pending, []);
			assert.deepEqual(h.calls.applied, []);
			assert.deepEqual(h.calls.notices, ["sessionCommand.runtimeChanged"]);
		} else {
			assert.equal(h.calls.updates.length, 1);
			assert.equal(h.calls.updates[0].id, SOURCE);
			assert.deepEqual(h.calls.pending[0], { sessionId: SOURCE, value: { from: { provider: "saved", modelId: "old", modelName: "Saved" }, to: { provider: "selected", modelId: "chosen", modelName: "Chosen model" } } });
			assert.deepEqual(h.calls.applied, [SOURCE]);
		}
	});
}

test("a current busy model absent from the snapshot still offers its restart confirmation", async () => {
	const h = harness();
	h.sessions.setRuntimeModel = async () => ({ ok: false, error: { code: "SESSION_RUNTIME_BUSY" } });
	h.sessions.listRuntimeModels = async (target) => ({ ok: true, value: { target, value: [] } });
	await h.controller.applyModel(selectedModel);
	assert.deepEqual(h.calls.updates, []);
	assert.deepEqual(h.calls.applied, [SOURCE]);
	assert.deepEqual(plain(h.render().restartTarget), { handle: { sessionId: SOURCE, agentId: "agent-a", runtimeGeneration: 1 }, model: "selected/chosen" });
});

/** 确认弹窗授权的是当时的栏生命周期与绑定，切走再回来不能复活授权。 */
function retireSelection(h, change) {
	if (change === "session" || change === "away-and-back") h.render(NEXT);
	if (change === "away-and-back") h.render(SOURCE);
	if (change === "runtime") h.runtimes[SOURCE] = runtimeInfo({ agentId: "replacement", runtimeGeneration: 2 });
	if (change === "generation") h.runtimes[SOURCE] = runtimeInfo({ runtimeGeneration: 2 });
	if (change === "detach") h.runtimes[SOURCE] = undefined;
	if (change === "unmount") h.unmount();
}

/** 通过真实模型命令的 needsRestart 返回值打开确认，不直接改 controller 内部 ref。 */
async function offerRestart(h, model = selectedModel) {
	h.sessions.setRuntimeModel = async () => ({ ok: false, error: { code: "SESSION_MODEL_NOT_FOUND", needsRestart: true } });
	await h.render().applyModel(model);
	return h.render();
}

for (const change of ["session", "runtime", "unmount", "away-and-back"]) {
	test(`a late draft model clear is not published after ${change}`, async () => {
		const h = harness({ bound: false });
		h.records[SOURCE] = { ...h.records[SOURCE], status: "draft" };
		const wait = deferred();
		const perform = h.sessions.updateRecord;
		h.sessions.updateRecord = async (id, patch) => {
			await wait.promise;
			return perform(id, patch);
		};
		const pending = h.render().clearModel();
		retireSelection(h, change);
		wait.resolve();
		await pending;
		assert.deepEqual(h.calls.updates, [{ id: SOURCE, patch: { model: null } }], "the already issued source save may finish");
		assert.deepEqual(h.calls.upserts, []);
		assert.deepEqual(h.calls.pending, []);
		assert.deepEqual(h.calls.applied, []);
		assert.deepEqual(h.calls.notices, []);
	});
}

test("a retained draft clear callback cannot save after the pane changes sessions", async () => {
	const h = harness({ bound: false });
	h.records[SOURCE] = { ...h.records[SOURCE], status: "draft" };
	const controller = h.render();
	h.render(NEXT);
	await controller.clearModel();
	assert.deepEqual(h.calls.updates, []);
	assert.deepEqual(h.calls.upserts, []);
	assert.deepEqual(h.calls.pending, []);
	assert.deepEqual(h.calls.applied, []);
});

for (const change of ["session", "runtime", "unmount"]) {
	test(`a retired draft clear failure is not shown after ${change}`, async () => {
		const h = harness({ bound: false });
		h.records[SOURCE] = { ...h.records[SOURCE], status: "draft" };
		const wait = deferred();
		h.sessions.updateRecord = () => wait.promise;
		const pending = h.render().clearModel();
		retireSelection(h, change);
		wait.reject(new Error("source save failed"));
		await pending;
		assert.deepEqual(h.calls.notices, []);
		assert.deepEqual(h.calls.applied, []);
	});
}

for (const change of ["session", "runtime", "generation", "detach", "unmount", "away-and-back"]) {
	test(`a model restart confirmation cannot save or restart after ${change}`, async () => {
		const h = harness();
		const controller = await offerRestart(h);
		retireSelection(h, change);
		await controller.confirmRestart();
		assert.deepEqual(h.calls.updates, []);
		assert.deepEqual(h.calls.upserts, []);
		assert.deepEqual(h.calls.pending, []);
		assert.deepEqual(h.calls.restarts, []);
		assert.deepEqual(h.calls.notices, []);
	});

	test(`a pending model restart save cannot publish or restart after ${change}`, async () => {
		const h = harness();
		const controller = await offerRestart(h);
		const wait = deferred();
		const perform = h.sessions.updateRecord;
		h.sessions.updateRecord = async (id, patch) => {
			await wait.promise;
			return perform(id, patch);
		};
		const pending = controller.confirmRestart();
		retireSelection(h, change);
		wait.resolve();
		await pending;
		assert.deepEqual(h.calls.updates, [{ id: SOURCE, patch: { model: { provider: "selected", modelId: "chosen", modelName: "Chosen model" } } }]);
		assert.deepEqual(h.calls.upserts, []);
		assert.deepEqual(h.calls.pending, []);
		assert.deepEqual(h.calls.restarts, []);
		assert.deepEqual(h.calls.notices, []);
	});
}

test("a retired restart save failure is not shown in the replacement pane", async () => {
	const h = harness();
	const controller = await offerRestart(h);
	const wait = deferred();
	h.sessions.updateRecord = () => wait.promise;
	const pending = controller.confirmRestart();
	h.render(NEXT);
	wait.reject(new Error("source restart save failed"));
	await pending;
	assert.deepEqual(h.calls.notices, []);
	assert.deepEqual(h.calls.restarts, []);
});

test("closing the dialog before confirmation still saves and restarts the authorized source", async () => {
	const h = harness();
	const controller = await offerRestart(h);
	controller.cancelRestart();
	await controller.confirmRestart();
	assert.deepEqual(h.calls.updates, [{ id: SOURCE, patch: { model: { provider: "selected", modelId: "chosen", modelName: "Chosen model" } } }]);
	assert.equal(h.calls.upserts[0].id, SOURCE);
	assert.deepEqual(h.calls.pending, [{ sessionId: SOURCE, value: null }]);
	assert.deepEqual(h.calls.restarts, ["agent-a"]);
	assert.equal(h.render().restartTarget, null);
	assert.equal(h.render().restarting, false);
});

test("cancelling a model restart closes its dialog without saving or restarting", async () => {
	const h = harness();
	const controller = await offerRestart(h);
	controller.cancelRestart();
	assert.equal(h.render().restartTarget, null);
	assert.deepEqual(h.calls.updates, []);
	assert.deepEqual(h.calls.restarts, []);
});

test("two model restart confirmations in one render perform only one save and restart", async () => {
	const h = harness();
	const controller = await offerRestart(h);
	const wait = deferred();
	const perform = h.sessions.updateRecord;
	h.sessions.updateRecord = async (id, patch) => {
		await wait.promise;
		return perform(id, patch);
	};
	const first = controller.confirmRestart();
	const second = controller.confirmRestart();
	wait.resolve();
	await Promise.all([first, second]);
	assert.equal(h.calls.updates.length, 1);
	assert.deepEqual(h.calls.restarts, ["agent-a"]);
	assert.equal(h.render().restarting, false);
});

test("a failed restart save cannot discard a newer model confirmation", async () => {
	const h = harness();
	const controller = await offerRestart(h);
	const wait = deferred();
	const perform = h.sessions.updateRecord;
	h.sessions.updateRecord = () => wait.promise;
	const pending = controller.confirmRestart();
	const nextModel = { ...selectedModel, id: "next", name: "Next model" };
	await offerRestart(h, nextModel);
	wait.reject(new Error("first save failed"));
	await pending;
	h.sessions.updateRecord = perform;
	await h.render().confirmRestart();
	assert.deepEqual(h.calls.updates, [{ id: SOURCE, patch: { model: { provider: "selected", modelId: "next", modelName: "Next model" } } }]);
	assert.deepEqual(h.calls.restarts, ["agent-a"]);
	assert.deepEqual(h.calls.notices, ["first save failed"]);
});

test("a retired restart save cannot clear a replacement pane's newer intent or lock", async () => {
	const h = harness();
	const oldController = await offerRestart(h);
	const sourceWait = deferred();
	const nextWait = deferred();
	const nextStarted = deferred();
	const perform = h.sessions.updateRecord;
	h.sessions.updateRecord = async (id, patch) => {
		if (id === SOURCE) await sourceWait.promise;
		else {
			nextStarted.resolve();
			await nextWait.promise;
		}
		return perform(id, patch);
	};
	const sourceSave = oldController.confirmRestart();
	h.render(NEXT);
	const nextController = await offerRestart(h, { ...selectedModel, id: "next", name: "Next model" });
	const nextSave = nextController.confirmRestart();
	const accepted = await Promise.race([nextStarted.promise.then(() => true), nextSave.then(() => false)]);
	assert.equal(accepted, true, "a retired source save cannot block a current pane's new confirmation");
	sourceWait.resolve();
	await sourceSave;
	assert.equal(h.render().restarting, true, "the old finally cannot release the newer lock");
	await h.render().confirmRestart();
	nextWait.resolve();
	await nextSave;
	assert.deepEqual(
		h.calls.updates.map(({ id }) => id),
		[SOURCE, NEXT],
	);
	assert.deepEqual(
		h.calls.upserts.map(({ id }) => id),
		[NEXT],
	);
	assert.deepEqual(h.calls.restarts, ["agent-b"]);
	assert.equal(h.render().restarting, false);
});

test("a retained confirmation callback cannot confirm a newer model offered in the same pane", async () => {
	const h = harness();
	const oldController = await offerRestart(h);
	const newController = await offerRestart(h, { ...selectedModel, id: "next", name: "Next model" });
	await oldController.confirmRestart();
	assert.deepEqual(h.calls.updates, []);
	assert.deepEqual(h.calls.restarts, []);
	await newController.confirmRestart();
	assert.equal(h.calls.updates[0].patch.model.modelId, "next");
	assert.deepEqual(h.calls.restarts, ["agent-a"]);
});

test("a retained cancel callback cannot dismiss a newer model confirmation", async () => {
	const h = harness();
	const oldController = await offerRestart(h);
	await offerRestart(h, { ...selectedModel, id: "next", name: "Next model" });
	oldController.cancelRestart();
	assert.equal(h.render().restartTarget?.model, "selected/next");
	assert.deepEqual(h.calls.updates, []);
	assert.deepEqual(h.calls.restarts, []);
});

test("a current restart failure is visible and releases the confirmation lock", async () => {
	const h = harness();
	h.services.restartActiveAgent = async () => {
		throw new Error("restart failed");
	};
	await (await offerRestart(h)).confirmRestart();
	assert.deepEqual(h.calls.notices, ["restart failed"]);
	assert.equal(h.render().restarting, false);
	h.services.restartActiveAgent = async (agentId) => h.calls.restarts.push(agentId);
	await (await offerRestart(h)).confirmRestart();
	assert.deepEqual(h.calls.restarts, ["agent-a"]);
});
