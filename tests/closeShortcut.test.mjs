import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const useCloseShortcutPath = "src/renderer/src/hooks/useCloseSessionTabShortcut.ts";
const atoms = {
	activeWorkspacePageAtom: "page",
	currentSessionIdAtom: "current",
	sessionRuntimeByIdAtom: "runtimes",
	settingsDirtyForWindowCloseAtom: "settingsDirty",
	sessionDraftByIdAtom: "drafts",
	sessionSendStateByIdAtom: "sends",
};

class Surface {
	isConnected = true;
	constructor(kind, id, parent) {
		this.kind = kind;
		this.id = id;
		this.parent = parent;
	}
	getAttribute(name) {
		return (name === "data-close-scope" ? this.kind : this.id) ?? null;
	}
	closest() {
		return this.kind ? this : (this.parent?.closest() ?? null);
	}
}

function setup() {
	let shortcut;
	let now = 0;
	let dialog = null;
	const interactions = [];
	const state = { runtimes: {}, sends: {}, drafts: {}, settingsDirty: false };
	const handlers = new Map();
	const body = new Surface();
	const document = {
		body,
		activeElement: body,
		querySelector: () => null,
		querySelectorAll: () => [],
		addEventListener: (event, handler) => handlers.set(event, handler),
		removeEventListener: (event) => handlers.delete(event),
	};
	const overlays = {
		get confirmDialog() {
			return dialog;
		},
		showConfirm(config) {
			interactions.push("confirm");
			dialog = config;
		},
		clearConfirm() {
			dialog = null;
		},
	};
	const load = createTsSandbox({
		stubs: {
			react: { useEffect: (effect) => effect(), useEffectEvent: (callback) => callback },
			jotai: { useStore: () => ({ get: (atom) => state[atom], sub: () => () => {} }) },
			"../atoms": atoms,
			"../atoms/composer-atoms": atoms,
			"../i18n": { t: (key) => key },
			"../desktopApi": {
				desktopApi: {
					app: {
						onShortcutTriggered: (callback) => {
							shortcut = callback;
							return () => {};
						},
						minimizeWindow: async () => interactions.push("minimize"),
					},
					terminal: { liveCount: async () => state.terminalCount ?? 0 },
				},
			},
		},
		globals: { document, Element: Surface, performance: { now: () => now }, requestAnimationFrame: () => {} },
	});
	const { useCloseSessionTabShortcut, closeEditorWithConfirmation } = load(useCloseShortcutPath);
	const deps = {
		closeTab: (id) => interactions.push(`session:${id}`),
		abortAgent: async (id) => interactions.push(`abort:${id}`),
		sessionTabIds: ["s1", "s2"],
		pageTabs: ["settings", "favorites"].map((id) => ({ id, onClose: () => interactions.push(`page:${id}`) })),
		closeEditor: (id) => interactions.push(`editor:${id}`),
		dirtyEditorCount: 0,
		overlays,
		showToast: (message) => interactions.push(message),
	};
	useCloseSessionTabShortcut(deps);
	return {
		state,
		interactions,
		deps,
		closeEditorWithConfirmation,
		get dialog() {
			return dialog;
		},
		focus: (target) => {
			document.activeElement = target;
			handlers.get("focusin")();
		},
		point: (target) => {
			document.activeElement = body;
			handlers.get("pointerdown")({ target });
		},
		press: async (time = 500) => {
			now += time;
			shortcut("closeSessionTab");
			await new Promise(setImmediate);
		},
	};
}

test("Settings and Favorites close their own scopes while a session remains selected", async () => {
	const h = setup();
	h.state.current = "s1";
	h.focus(new Surface("page", "settings"));
	await h.press();
	h.point(new Surface("page", "favorites"));
	await h.press();
	assert.deepEqual(h.interactions, ["page:settings", "page:favorites"]);
});

test("the focused editor wins over the containing session and a burst does not close its parent", async () => {
	const h = setup();
	const session = new Surface("session", "s2");
	h.focus(new Surface(undefined, undefined, new Surface("editor", "file", session)));
	await h.press();
	h.focus(session);
	await h.press(40);
	await h.press(500);
	assert.deepEqual(h.interactions, ["editor:file", "session:s2"]);
});

test("a running session prompts once, can be canceled, and aborts the correct agent only upon confirmation", async () => {
	const h = setup();
	h.state.current = "s1";
	h.state.runtimes.s2 = { status: "running", agentId: "worker", runtimeGeneration: 1 };
	h.state.sends.s2 = { status: "sending" };
	h.state.drafts.s2 = "unfinished draft";
	h.focus(new Surface("session", "s2"));
	await h.press();
	await h.press();
	assert.deepEqual(h.interactions, ["confirm"]);
	assert.match(h.dialog.message, /tabs\.closeRunningBody.*tabs\.closeDraftBody/);
	h.deps.overlays.clearConfirm();
	await h.press();
	h.dialog.onConfirm();
	assert.deepEqual(h.interactions, ["confirm", "confirm", "abort:worker", "session:s2"]);
});

test("window chrome aggregates risk across tabs and minimizes without closing a session", async () => {
	const h = setup();
	h.point(new Surface());
	h.state.sends.s1 = { status: "activating" };
	h.state.terminalCount = 2;
	h.state.settingsDirty = true;
	h.deps.dirtyEditorCount = 1;
	await h.press();
	assert.deepEqual(h.interactions, ["confirm"]);
	assert.match(h.dialog.message, /tabs\.minimizeDirtyFiles.*tabs\.minimizeDirtySettings.*tabs\.minimizeRunningSessions.*tabs\.minimizeTerminals/);
	h.dialog.onConfirm();
	assert.deepEqual(h.interactions, ["confirm", "minimize"]);
});

test("window chrome minimizes an idle workspace without a prompt", async () => {
	const h = setup();
	h.state.current = "s1";
	await h.press();
	assert.deepEqual(h.interactions, ["minimize"]);
});

test("a dirty editor closes only after confirmation, while a clean editor closes directly", () => {
	const h = setup();
	const close = (id) => h.interactions.push(`editor:${id}`);
	h.closeEditorWithConfirmation({ id: "dirty", filePath: "/project/dirty" }, () => true, close, h.deps.overlays);
	assert.deepEqual(h.interactions, ["confirm"]);
	h.dialog.onConfirm();
	h.closeEditorWithConfirmation({ id: "clean", filePath: "/project/clean" }, () => false, close, h.deps.overlays);
	assert.deepEqual(h.interactions, ["confirm", "editor:dirty", "editor:clean"]);
});
