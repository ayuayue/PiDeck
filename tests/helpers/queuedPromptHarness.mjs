import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./createTsSandbox.mjs";
import { quickMessageHookHost } from "./quickMessageHookHost.mjs";

/** 队列与 IPC 回包的先后顺序由测试决定，不使用真实网络或等待。 */
export function deferredQueueResult() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

export function queuedPrompt(id, behavior = "followUp") {
	return { id, message: `expanded:${id}`, displayText: id, behavior, agentMode: "normal", timestamp: 1 };
}

/** 加载真实队列 hook/atoms；只替换 React 宿主、计时器、编辑器与外部投递能力。 */
export function queuedPromptHarness({ status = "idle", dispatch = async () => {} } = {}) {
	const store = createStore();
	const atoms = {};
	const host = quickMessageHookHost();
	const timers = new Map();
	const frames = new Map();
	const submissions = [];
	const notices = [];
	const cursorUpdates = [];
	const focused = [];
	let nextId = 0;
	const clock = {
		setTimeout(callback, delay) {
			const id = ++nextId;
			timers.set(id, { callback, delay });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
	};
	const frameClock = {
		requestAnimationFrame(callback) {
			const id = ++nextId;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame(id) {
			frames.delete(id);
		},
	};
	const load = createTsSandbox({
		globals: { Error, ...clock, ...frameClock, window: { ...clock, ...frameClock } },
		stubs: {
			react: host.react,
			jotai: { atom },
			"../atoms": atoms,
			"../i18n": { t: (key) => key },
		},
	});
	Object.assign(atoms, load("src/renderer/src/atoms/session-atoms.ts"), load("src/renderer/src/atoms/composer-atoms.ts"));
	const { useQueuedPrompt } = load("src/renderer/src/hooks/useQueuedPrompt.ts");
	const { PromptDeliveryUnknownError } = load("src/renderer/src/utils/promptErrors.ts");
	const displayAgentsRef = { current: [] };
	const queueFlushBySessionRef = { current: new Set() };
	const makeEditor = (id) => ({ focus: () => focused.push(id), scrollHeight: 80, scrollTop: 0 });
	const composerTextareaRef = { current: makeEditor("A") };
	const pendingComposerCaretRef = { current: null };
	function addSession(id, runtimeStatus = "idle", generation = 1) {
		store.set(atoms.upsertSessionAtom, { id, projectId: "project", title: id, source: "pi", environment: "native", preview: "", messageCount: 0, status: "draft", createdAt: 1, updatedAt: 1 });
		setRuntime(id, runtimeStatus, generation);
	}
	function setRuntime(id, runtimeStatus, generation = 1, state = {}) {
		const agentId = `agent-${id}-${generation}`;
		store.set(atoms.sessionRuntimeByIdAtom, (current) => ({ ...current, [id]: { agentId, runtimeGeneration: generation, status: runtimeStatus, updatedAt: 1, state } }));
		displayAgentsRef.current = [...displayAgentsRef.current.filter((agent) => agent.sessionId !== id), { id: agentId, sessionId: id, status: runtimeStatus }];
	}
	addSession("A", status);
	addSession("B");
	store.set(atoms.currentSessionIdAtom, "A");
	const options = {
		store,
		displayAgentsRef,
		queueFlushBySessionRef,
		composerTextareaRef,
		pendingComposerCaretRef,
		setComposerCursor: (value) => cursorUpdates.push(value),
		showToast: (...args) => notices.push(args),
		unknownDeliveryMessage: "delivery unknown",
		dispatchPromptSnapshot: async (...args) => {
			submissions.push(args);
			return dispatch(...args);
		},
	};
	const render = () => host.render(() => useQueuedPrompt(options));
	return {
		store,
		atoms,
		queue: render(),
		render,
		timers,
		frames,
		submissions,
		notices,
		focused,
		cursorUpdates,
		displayAgentsRef,
		queueFlushBySessionRef,
		composerTextareaRef,
		pendingComposerCaretRef,
		PromptDeliveryUnknownError,
		addSession,
		setRuntime,
		unmount: () => host.unmount(),
		selectSession(id) {
			store.set(atoms.currentSessionIdAtom, id);
			composerTextareaRef.current = makeEditor(id);
		},
		removeSession(id) {
			store.set(atoms.removeSessionStateAtom, id);
		},
		fireTimers(delay) {
			for (const [id, timer] of [...timers]) {
				if (timer.delay !== delay) continue;
				timers.delete(id);
				timer.callback();
			}
		},
		fireFrames() {
			for (const [id, callback] of [...frames]) {
				frames.delete(id);
				callback();
			}
		},
	};
}
