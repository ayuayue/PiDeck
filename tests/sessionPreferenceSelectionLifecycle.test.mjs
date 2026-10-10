import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { deferred, plain, runtimeInfo, sessionRecord } from "./helpers/sessionRunControlHarness.mjs";

const SOURCE = "source-a";
const NEXT = "next-b";
const selectedModel = { provider: "selected", id: "chosen", name: "Chosen model" };
const actualSelection = { provider: "selected", modelId: "chosen", modelName: "Pi model", thinkingLevel: "high" };

/** 执行真实 controller；稳定 ref/effect 支持切换会话、卸载和 IPC 等待期间换绑。 */
function harness({ bound = true } = {}) {
	const calls = { commands: [], updates: [], upserts: [], pending: [], applied: [], notices: [] };
	const records = {
		[SOURCE]: { ...sessionRecord(SOURCE), model: { provider: "saved", modelId: "old", modelName: "Saved" }, thinkingLevel: "low" },
		[NEXT]: { ...sessionRecord(NEXT), model: { provider: "other", modelId: "next", modelName: "Other" }, thinkingLevel: "medium" },
	};
	const runtimes = { [SOURCE]: bound ? runtimeInfo() : undefined, [NEXT]: runtimeInfo({ sessionId: NEXT, agentId: "agent-b" }) };
	const refs = [];
	const states = [];
	const effects = [];
	let refCursor = 0;
	let stateCursor = 0;
	let effectCursor = 0;
	let currentSessionId = SOURCE;
	const runtimeAtom = {};
	const focusedAtom = {};
	const sessions = {
		setRuntimeModel: async (target) => {
			calls.commands.push(["model", plain(target)]);
			return { ok: true, value: { target, value: actualSelection } };
		},
		setRuntimeThinking: async (target) => {
			calls.commands.push(["thinking", plain(target)]);
			return { ok: true, value: { target, value: { thinkingLevel: "high" } } };
		},
		listRuntimeModels: async (target) => ({ ok: true, value: { target, value: [selectedModel] } }),
		updateRecord: async (id, patch) => {
			calls.updates.push({ id, patch: plain(patch) });
			records[id] = { ...records[id], ...patch };
			return records[id];
		},
	};
	const load = createTsSandbox({
		globals: { Error },
		stubs: {
			react: {
				useRef: (initial) => {
					const index = refCursor++;
					refs[index] ??= { current: initial };
					return refs[index];
				},
				useState: (initial) => {
					const index = stateCursor++;
					states[index] ??= { current: initial };
					return [states[index].current, (value) => (states[index].current = typeof value === "function" ? value(states[index].current) : value)];
				},
				useCallback: (callback) => callback,
				useEffect: (setup, dependencies) => {
					const index = effectCursor++;
					const previous = effects[index];
					if (previous && dependencies?.every((value, i) => Object.is(value, previous.dependencies?.[i]))) return;
					previous?.cleanup?.();
					effects[index] = { dependencies, cleanup: setup() };
				},
			},
			jotai: { useStore: () => ({ get: (atom) => (atom === runtimeAtom ? runtimes : currentSessionId) }) },
			"../atoms": { currentSessionIdAtom: focusedAtom, sessionRuntimeByIdAtom: runtimeAtom },
			"./useSessionPreferenceState": {
				useSessionPreferenceState: ({ sessionId }) => ({
					record: records[sessionId],
					runtime: runtimes[sessionId],
					isDshSession: false,
					models: [selectedModel],
					favoriteModels: ["selected/chosen"],
					favoritesLoaded: true,
					hiddenProviders: [],
					hiddenModels: [],
					currentModel: records[sessionId].model,
					thinkingLevels: [],
					upsertSession: (record) => calls.upserts.push(plain(record)),
					setModelPending: (value) => calls.pending.push({ sessionId, value: value ? plain(value) : null }),
				}),
			},
			"./usePendingModelApply": { usePendingModelApply: () => {} },
			"../components/session/SessionPaneServices": { useSessionPaneServices: () => ({}) },
			"../desktopApi": { desktopApi: { sessions, app: { onShortcutTriggered: () => () => {} } } },
			"../utils/notice": { showNotice: (message) => calls.notices.push(message) },
			"../i18n": { t: (key) => key },
		},
	});
	const { useSessionPreferenceController } = load("src/renderer/src/hooks/useSessionPreferenceController.ts");
	const render = (sessionId = currentSessionId) => {
		currentSessionId = sessionId;
		refCursor = stateCursor = effectCursor = 0;
		return useSessionPreferenceController({ sessionId, pickerOpen: true, thinkingPickerOpen: true, onApplied: () => calls.applied.push(sessionId) });
	};
	const unmount = () => {
		for (const effect of effects) effect?.cleanup?.();
	};
	return { controller: render(), render, unmount, sessions, runtimes, records, calls };
}

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
