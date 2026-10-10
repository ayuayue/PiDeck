import { createTsSandbox } from "./createTsSandbox.mjs";

export const plain = (value) => JSON.parse(JSON.stringify(value));
export const sourceTarget = { sessionId: "source-a", agentId: "agent-a", runtimeGeneration: 1 };

/** 精确暂停 IPC，不启动真实进程或等待计时器。 */
export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** 最小完整的 Agent 展示对象，身份仍由 runtime 投影决定。 */
export function agent(id = "agent-a", projectId = "project-a") {
	return { id, projectId, cwd: "/project", title: id, status: "idle", createdAt: 1 };
}

/** 完整会话记录与 IPC 返回值，避免用不合法枚举或缺字段数据掩盖真实边界。 */
export function sessionRecord(id = "source-a", projectId = "project-a") {
	return { id, projectId, title: "Source", source: "pi", environment: "native", status: "active", preview: "", messageCount: 1, createdAt: 1, updatedAt: 1 };
}

export function runtimeInfo({ sessionId = "source-a", agentId = "agent-a", runtimeGeneration = 1, status = "idle" } = {}) {
	return { sessionId, agentId, runtimeGeneration, status, projectId: "project-a", cwd: "/project", createdAt: 1 };
}

export function replacement() {
	return { previousTarget: sourceTarget, runtime: runtimeInfo({ agentId: "replacement", runtimeGeneration: 2 }), session: sessionRecord() };
}

export function queuedPrompt(status) {
	return { id: "queued-a", message: "Queued prompt", displayText: "Queued prompt", behavior: "followUp", agentMode: "normal", timestamp: 1, status };
}

export function messagePage(text = "disk history") {
	return { messages: [{ id: "message-a", role: "user", text, timestamp: 1 }], total: 1, nextBefore: null };
}

/** 执行真实 hook，稳定 ref/state 与 atom 数据支持模拟同轮点击、重新渲染及异步换绑。 */
export function harness(options = {}) {
	const calls = [];
	const toasts = [];
	const confirmations = [];
	const runtimeEvents = [];
	const overlays = [];
	const cacheWrites = [];
	const loadStates = [];
	const cache = {};
	const loads = {};
	const overlayKinds = {};
	const refs = [];
	const states = [];
	let refCursor = 0;
	let stateCursor = 0;
	const atoms = {
		applySessionRuntimeEventAtom: {},
		cacheSessionMessagesAtom: {},
		sessionRecordsAtom: {},
		sessionMessagesCacheAtom: {},
		sessionMessageLoadStateAtom: {},
		sessionHistoryMutationOverlayByIdAtom: {},
		setSessionHistoryMutationOverlayAtom: {},
		setSessionMessageLoadStateAtom: {},
	};
	const runtimes = new Map([["source-a", { ...runtimeInfo({ status: options.status ?? "idle" }), state: { modelId: "current-model" } }]]);
	const records = { "source-a": sessionRecord() };
	const store = {
		get: (atom) => {
			if (atom === atoms.sessionRecordsAtom) return records;
			if (atom === atoms.sessionMessagesCacheAtom) return cache;
			if (atom === atoms.sessionMessageLoadStateAtom) return loads;
			if (atom === atoms.sessionHistoryMutationOverlayByIdAtom) return overlayKinds;
			if (atom.kind === "runtime") return runtimes.get(atom.id);
			if (atom.kind === "agent-session") return [...runtimes].find(([, runtime]) => runtime.agentId === atom.id)?.[0];
			return undefined;
		},
		set: (atom, update) => {
			if (atom !== atoms.sessionMessageLoadStateAtom) return;
			const next = typeof update === "function" ? update(loads) : update;
			if (next === loads) return;
			for (const id of Object.keys(loads)) delete loads[id];
			Object.assign(loads, next);
		},
	};
	const sessions = {
		getRuntimeState: async (target) => {
			calls.push(["get-state", plain(target)]);
			return { ok: true, value: { target, value: { modelId: "refreshed-model" } } };
		},
		restartRuntime: async (target) => {
			calls.push(["restart", plain(target)]);
			return { ok: true, value: replacement() };
		},
		activateRuntime: async (sessionId) => {
			calls.push(["activate", sessionId]);
			return { ok: true, value: runtimeInfo({ sessionId, agentId: "replacement", runtimeGeneration: 2 }) };
		},
		cloneRuntime: async (target) => {
			calls.push(["clone", plain(target)]);
			return { ok: true, value: { targetSessionId: "clone-a" } };
		},
		stopRuntime: async (target) => {
			calls.push(["stop", plain(target)]);
			return { ok: true, value: undefined };
		},
		readRecordMessagePage: async (...args) => {
			calls.push(["reload", ...args]);
			return messagePage();
		},
	};
	const load = createTsSandbox({
		globals: { Error },
		stubs: {
			react: {
				useCallback: (fn) => fn,
				useRef: (initial) => {
					const index = refCursor++;
					refs[index] ??= { current: initial };
					return refs[index];
				},
				useState: (initial) => {
					const index = stateCursor++;
					states[index] ??= { current: initial };
					return [
						states[index].current,
						(next) => {
							states[index].current = typeof next === "function" ? next(states[index].current) : next;
						},
					];
				},
			},
			jotai: {
				useStore: () => store,
				useSetAtom: (atom) => (event) => {
					if (atom === atoms.applySessionRuntimeEventAtom) runtimeEvents.push(plain(event));
					if (atom === atoms.setSessionHistoryMutationOverlayAtom) {
						overlays.push(plain(event));
						if (event.kind === null) delete overlayKinds[event.sessionId];
						else overlayKinds[event.sessionId] = event.kind;
					}
					if (atom === atoms.cacheSessionMessagesAtom) {
						cacheWrites.push(plain(event));
						cache[event.sessionId] = event;
					}
					if (atom === atoms.setSessionMessageLoadStateAtom) {
						loadStates.push(plain(event));
						loads[event.sessionId] = event.state;
					}
				},
			},
			"../../atoms/session-atoms": atoms,
			"../../atoms/session-selectors": {
				sessionRuntimeBySessionIdAtomFamily: (id) => ({ kind: "runtime", id }),
				sessionIdByRuntimeAgentIdAtomFamily: (id) => ({ kind: "agent-session", id }),
			},
			"../../atoms/dsh-atoms": { dshRuntimeStatusAtom: {} },
			"../../atoms/app-ui-atoms": { openSettingsAtom: {} },
			"../../utils/dshRuntimeHint": {},
			"../../rendererUtils": { isPendingAgentId: (id) => id.startsWith("pending-") },
			"../../desktopApi": { desktopApi: { sessions } },
			"../../i18n": { t: (key) => key },
			"../i18n": { t: (key) => key },
		},
	});
	const useHook = load("src/renderer/src/hooks/session/useSessionRunControl.ts").useSessionRunControl;
	let deps = {
		agents: [agent()],
		activeAgent: agent(),
		activeAgentId: "agent-a",
		activeProjectId: "project-a",
		showToast: (text) => toasts.push(text),
		overlays: { showConfirm: (config) => confirmations.push(config), clearConfirm: () => calls.push(["clear-confirm"]) },
		refreshProjectSessions: async (projectId) => calls.push(["refresh-project", projectId]),
		selectSessionCommand: async (...args) => calls.push(["select", ...args]),
		registerOpenSession: (...args) => calls.push(["register", ...args]),
		getSessionRecord: (id) => records[id],
		pendingAgentsRef: { current: [] },
		setPendingAgents: () => {},
		queueFlushBySessionRef: { current: new Set() },
		queuedPromptsRef: { current: {} },
	};
	const render = (patch = {}) => {
		deps = { ...deps, ...patch };
		refCursor = 0;
		stateCursor = 0;
		return useHook(deps);
	};
	return { hook: render(), render, deps, sessions, runtimes, records, calls, toasts, confirmations, runtimeEvents, overlays, cacheWrites, loadStates, cache, loads, overlayKinds };
}
