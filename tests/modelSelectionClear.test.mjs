import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WELCOME_MODEL_KEY, WELCOME_DSH_MODEL_KEY, WELCOME_THINKING_KEY } = loadTsCommonJs("src/renderer/src/utils/chatSessionBootstrap.ts");

function harness({ backend = "pi", status, agentId, fail = false } = {}) {
	const storage = new Map([
		[WELCOME_MODEL_KEY, "pi-selection"],
		[WELCOME_DSH_MODEL_KEY, "dsh-selection"],
		[WELCOME_THINKING_KEY, "high"],
	]);
	const calls = { updates: [], upserts: [], pending: [], notices: [], applied: 0 };
	const binding = { current: agentId ? { agentId } : undefined };
	const state = {
		record: status ? { id: "test-session", status, backend, model: { provider: "custom", modelId: "chosen" } } : undefined,
		runtime: binding.current,
		isDshSession: backend === "dsh",
		models: [],
		favoriteModels: [],
		favoritesLoaded: true,
		hiddenProviders: [],
		hiddenModels: [],
		currentModel: {},
		thinkingLevels: [],
		upsertSession: (value) => calls.upserts.push(value),
		setModelPending: (value) => calls.pending.push(value),
	};
	const { useSessionPreferenceController } = loadTsCommonJs("src/renderer/src/hooks/useSessionPreferenceController.ts", {
		globals: {
			localStorage: {
				removeItem: (key) => {
					if (fail && !status) throw new Error("storage unavailable");
					storage.delete(key);
				},
			},
		},
		stubs: {
			react: { useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}], useCallback: (fn) => fn, useEffect: () => {} },
			jotai: { useStore: () => ({ get: () => ({ "test-session": binding.current }) }) },
			"../atoms": { currentSessionIdAtom: {}, sessionRuntimeByIdAtom: {} },
			"./useSessionPreferenceState": { useSessionPreferenceState: () => state },
			"./usePendingModelApply": { usePendingModelApply: () => {} },
			"../components/session/SessionPaneServices": { useSessionPaneServices: () => ({}) },
			"../desktopApi": {
				desktopApi: {
					sessions: {
						updateRecord: async (id, patch) => {
							calls.updates.push({ id, patch });
							if (fail) throw new Error("save rejected");
							return { ...state.record, ...patch };
						},
					},
				},
			},
			"../utils/notice": { showNotice: (message) => calls.notices.push(message) },
			"../i18n": { t: (key) => key },
			"../utils/sessionCommands": { toSessionRuntimeTarget: (_id, runtime) => (runtime?.agentId ? runtime : null) },
		},
	});
	const controller = useSessionPreferenceController({ sessionId: "test-session", pickerOpen: true, thinkingPickerOpen: false, onApplied: () => calls.applied++ });
	return { controller, calls, storage, binding };
}

for (const backend of ["pi", "dsh"]) {
	test(`${backend} welcome clear removes only that backend's model preference`, async () => {
		const { controller, calls, storage } = harness({ backend });
		assert.equal(controller.canClearModel, true);
		await controller.clearModel();
		assert.equal(storage.has(backend === "dsh" ? WELCOME_DSH_MODEL_KEY : WELCOME_MODEL_KEY), false);
		assert.equal(storage.has(backend === "dsh" ? WELCOME_MODEL_KEY : WELCOME_DSH_MODEL_KEY), true);
		assert.equal(storage.get(WELCOME_THINKING_KEY), "high");
		assert.equal(calls.updates.length, 0);
		assert.deepEqual(calls.pending, [undefined]);
		assert.equal(calls.applied, 1);
	});

	test(`${backend} unstarted draft clears catalog model without changing welcome defaults`, async () => {
		const { controller, calls, storage } = harness({ backend, status: "draft" });
		await controller.clearModel();
		assert.equal(controller.canClearModel, true);
		assert.equal(calls.updates[0].id, "test-session");
		assert.equal(calls.updates[0].patch.model, null);
		assert.equal(calls.upserts[0].model, null);
		assert.equal(storage.size, 3);
		assert.equal(calls.applied, 1);
	});
}

test("active and newly bound runtimes cannot be cleared", async () => {
	for (const status of ["active", "draft"]) {
		const { controller, calls } = harness({ status, agentId: "running-agent" });
		assert.equal(controller.canClearModel, false);
		await controller.clearModel();
		assert.equal(calls.updates.length, 0);
		assert.equal(calls.applied, 0);
	}
	const { controller, calls, binding } = harness({ status: "draft" });
	binding.current = { agentId: "just-started" };
	await controller.clearModel();
	assert.equal(calls.updates.length, 0);
});

test("clear failures remain visible and keep the picker open", async () => {
	for (const status of [undefined, "draft"]) {
		const { controller, calls } = harness({ status, fail: true });
		await controller.clearModel();
		assert.equal(calls.notices.length, 1);
		assert.equal(calls.applied, 0);
		assert.equal(calls.pending.length, 0);
	}
});
