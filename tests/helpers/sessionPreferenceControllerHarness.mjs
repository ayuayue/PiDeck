import { createTsSandbox } from "./createTsSandbox.mjs";
import { plain, runtimeInfo, sessionRecord } from "./sessionRunControlHarness.mjs";

export const SOURCE = "source-a";
export const NEXT = "next-b";
export const selectedModel = { provider: "selected", id: "chosen", name: "Chosen model" };
export const actualSelection = { provider: "selected", modelId: "chosen", modelName: "Pi model", thinkingLevel: "high" };

/** 执行真实 controller；稳定 ref/effect 支持换栏、换绑及目录等待，聚焦身份独立于挂载栏。 */
export function createSessionPreferenceControllerHarness({ bound = true, ready = true, favoritesLoaded = true, pendingApply = false } = {}) {
	const calls = { commands: [], updates: [], upserts: [], pending: [], applied: [], notices: [], restarts: [] };
	const records = {
		[SOURCE]: { ...sessionRecord(SOURCE), model: { provider: "saved", modelId: "old", modelName: "Saved" }, thinkingLevel: "low" },
		[NEXT]: { ...sessionRecord(NEXT), model: { provider: "other", modelId: "next", modelName: "Other" }, thinkingLevel: "medium" },
	};
	const runtimes = { [SOURCE]: bound ? runtimeInfo() : undefined, [NEXT]: runtimeInfo({ sessionId: NEXT, agentId: "agent-b" }) };
	const preferences = {
		[SOURCE]: { models: ready ? [selectedModel] : [], favoriteModels: ["selected/chosen"], favoritesLoaded, report: null, catalogLoading: !ready, isDshSession: false },
		[NEXT]: { models: ready ? [selectedModel] : [], favoriteModels: ["selected/chosen"], favoritesLoaded, report: null, catalogLoading: !ready, isDshSession: false },
	};
	const pendingModels = {};
	const shortcuts = new Set();
	const refs = [];
	const states = [];
	const effects = [];
	let refCursor = 0;
	let stateCursor = 0;
	let effectCursor = 0;
	let paneSessionId = SOURCE;
	let focusedSessionId = SOURCE;
	const runtimeAtom = {};
	const pendingAtom = {};
	const focusedAtom = {};
	const focusAtoms = new Map();
	const sessionFocusedByIdAtomFamily = (sessionId) => {
		if (!focusAtoms.has(sessionId)) focusAtoms.set(sessionId, { sessionId });
		return focusAtoms.get(sessionId);
	};
	const subscriptions = new Map();
	// Jotai store 的身份稳定；本栏焦点切片只通知进入/离开，不依赖本栏重绘。
	const store = {
		get: (atom) => (atom === runtimeAtom ? runtimes : atom === pendingAtom ? pendingModels : atom === focusedAtom ? focusedSessionId : focusedSessionId === atom.sessionId),
		sub: (atom, listener) => {
			const listeners = subscriptions.get(atom) ?? new Set();
			subscriptions.set(atom, listeners);
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) subscriptions.delete(atom);
			};
		},
	};
	const sessions = {
		setRuntimeModel: async (target, provider, modelId, modelName) => {
			calls.commands.push(["model", plain(target), { provider, modelId, modelName }]);
			return { ok: true, value: { target, value: actualSelection } };
		},
		setRuntimeThinking: async (target, level) => {
			calls.commands.push(["thinking", plain(target), level]);
			return { ok: true, value: { target, value: { thinkingLevel: "high" } } };
		},
		listRuntimeModels: async (target) => ({ ok: true, value: { target, value: [selectedModel] } }),
		updateRecord: async (id, patch) => {
			calls.updates.push({ id, patch: plain(patch) });
			records[id] = { ...records[id], ...patch };
			return records[id];
		},
	};
	const services = { restartActiveAgent: async (agentId) => calls.restarts.push(agentId) };
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
			jotai: { useStore: () => store },
			"../atoms": { currentSessionIdAtom: focusedAtom, sessionRuntimeByIdAtom: runtimeAtom, modelPendingByIdAtom: pendingAtom, sessionFocusedByIdAtomFamily },
			"./useSessionPreferenceState": {
				useSessionPreferenceState: ({ sessionId }) => ({
					record: records[sessionId],
					runtime: runtimes[sessionId],
					hiddenProviders: [],
					hiddenModels: [],
					currentModel: records[sessionId].model,
					currentThinkingLevel: records[sessionId].thinkingLevel,
					thinkingLevels: ["low", "medium", "high"].map((value) => ({ value })),
					...preferences[sessionId],
					modelPending: pendingModels[sessionId],
					upsertSession: (record) => calls.upserts.push(plain(record)),
					setModelPending: (value) => {
						pendingModels[sessionId] = value;
						calls.pending.push({ sessionId, value: value ? plain(value) : null });
					},
				}),
			},
			...(pendingApply ? {} : { "./usePendingModelApply": { usePendingModelApply: () => {} } }),
			"../components/session/SessionPaneServices": { useSessionPaneServices: () => services },
			"../desktopApi": {
				desktopApi: {
					sessions,
					app: {
						onShortcutTriggered: (listener) => {
							shortcuts.add(listener);
							return () => shortcuts.delete(listener);
						},
					},
				},
			},
			"../utils/notice": { showNotice: (message) => calls.notices.push(message) },
			"../i18n": { t: (key) => key },
		},
	});
	const { useSessionPreferenceController } = load("src/renderer/src/hooks/useSessionPreferenceController.ts");
	const render = (sessionId = paneSessionId) => {
		paneSessionId = sessionId;
		refCursor = stateCursor = effectCursor = 0;
		return useSessionPreferenceController({ sessionId, pickerOpen: true, thinkingPickerOpen: true, onApplied: () => calls.applied.push(sessionId) });
	};
	const unmount = () => {
		for (const effect of effects) effect?.cleanup?.();
	};
	const focus = (sessionId) => {
		if (focusedSessionId === sessionId) return;
		const previous = focusedSessionId;
		focusedSessionId = sessionId;
		for (const [atom, listeners] of subscriptions) {
			if (atom !== focusedAtom && (atom.sessionId === previous) === (atom.sessionId === sessionId)) continue;
			for (const listener of [...listeners]) listener();
		}
	};
	const shortcut = (id) => {
		for (const listener of [...shortcuts]) listener(id);
	};
	return { controller: render(), render, unmount, focus, shortcut, shortcuts, subscriptions, sessions, runtimes, records, preferences, pendingModels, calls, services };
}
