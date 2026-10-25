import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const composerAtoms = loadTsCommonJs("src/renderer/src/atoms/composer-atoms.ts", {
	stubs: { "./session-atoms": { currentSessionIdAtom: {} } },
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const image = { type: "image", data: "AAAA", mimeType: "image/png" };

/** Exercise the real replay listener with session-scoped atoms and effect cleanup. */
function createReplay() {
	const store = createStore();
	const listeners = new Map();
	const cleanups = [];
	let prompt;
	let focused = 0;
	const args = {
		setPrompt: (value) => {
			prompt = value;
		},
		pendingComposerCaretRef: { current: null },
		composerRef: {
			current: {
				focus: () => {
					focused += 1;
				},
			},
		},
		currentSessionIdRef: { current: "session-a" },
	};
	const load = createTsSandbox({
		stubs: {
			react: { useEffect: (effect) => cleanups.push(effect()), useRef: (value) => ({ current: value }) },
			jotai: { useSetAtom: (atom) => (value) => store.set(atom, value) },
			"../atoms": composerAtoms,
			"../atoms/composer-atoms": composerAtoms,
		},
		globals: {
			window: {
				addEventListener: (name, handler) => listeners.set(name, handler),
				removeEventListener: (name, handler) => {
					if (listeners.get(name) === handler) listeners.delete(name);
				},
			},
			requestAnimationFrame: (callback) => callback(),
		},
	});
	load("src/renderer/src/hooks/useUserMessageEditReplay.ts").useUserMessageEditReplay(args);
	return {
		store,
		args,
		emit: (detail) => listeners.get("user-message-edit")?.({ detail }),
		prompt: () => prompt,
		focused: () => focused,
		dispose: () => cleanups.forEach((cleanup) => cleanup?.()),
		listenerCount: () => listeners.size,
	};
}

test("edit replay restores message images and replaces only the active session attachments", () => {
	const h = createReplay();
	h.store.set(composerAtoms.setSessionAttachmentsAtom, { sessionId: "session-a", value: [{ ...image, data: "OLD" }] });
	h.store.set(composerAtoms.setSessionAttachmentsAtom, { sessionId: "session-b", value: [{ ...image, data: "OTHER" }] });
	h.emit({ text: "edit me", images: [image] });
	assert.equal(h.prompt(), "edit me");
	assert.deepEqual(plain(h.store.get(composerAtoms.sessionAttachmentsByIdAtom)), { "session-a": [image], "session-b": [{ ...image, data: "OTHER" }] });
	assert.equal(h.args.pendingComposerCaretRef.current, 7);
	assert.equal(h.focused(), 1);
});

test("image-only replay accepts empty text and preserves ref attachments without hydrating", () => {
	const h = createReplay();
	const reference = { type: "image", ref: `${"a".repeat(64)}.png`, mimeType: "image/png" };
	h.emit({ text: "", images: [reference] });
	assert.equal(h.prompt(), "");
	assert.deepEqual(plain(h.store.get(composerAtoms.sessionAttachmentsByIdAtom)["session-a"]), [reference]);
});

test("text-only replay clears stale images and uses the latest session identity", () => {
	const h = createReplay();
	h.store.set(composerAtoms.setSessionAttachmentsAtom, { sessionId: "session-a", value: [image] });
	h.store.set(composerAtoms.setSessionAttachmentsAtom, { sessionId: "session-b", value: [image] });
	h.args.currentSessionIdRef.current = "session-b";
	h.emit({ text: "text only" });
	assert.deepEqual(plain(h.store.get(composerAtoms.sessionAttachmentsByIdAtom)), { "session-a": [image] });
});

test("replay still rebuilds quote chips alongside images and unregisters on unmount", () => {
	const h = createReplay();
	h.emit({ text: '<quoted_context label="quote" message_id="message-1">\nquoted text\n</quoted_context>\n\nquestion', images: [image] });
	assert.match(h.prompt(), /#q\w+/);
	assert.match(h.prompt(), /question$/);
	const quotes = Object.values(h.store.get(composerAtoms.sessionQuotesByIdAtom)["session-a"]);
	assert.equal(quotes.length, 1);
	assert.equal(quotes[0].text, "quoted text");
	assert.deepEqual(plain(h.store.get(composerAtoms.sessionAttachmentsByIdAtom)["session-a"]), [image]);
	h.dispose();
	assert.equal(h.listenerCount(), 0);
});

test("user bubble edit replay includes images in its event", () => {
	const source = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	assert.match(source, /new\s+CustomEvent\(\s*"user-message-edit",\s*\{\s*detail:\s*\{\s*text:\s*message\.text,\s*images:\s*message\.images\s*\}/);
});

/** Exercise forkFromUserMessage rather than matching its implementation text. */
test("fork replay carries message attachments to the new session composer", async () => {
	const events = [];
	const sourceTarget = { sessionId: "source", agentId: "agent-1", runtimeGeneration: 1 };
	const load = createTsSandbox({
		stubs: {
			react: { useCallback: (fn) => fn, useEffect: () => {}, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] },
			jotai: { useSetAtom: () => () => {} },
			"../atoms/session-atoms": {},
			"../atoms/composer-atoms": composerAtoms,
			"../desktopApi": { desktopApi: { sessions: { forkRuntimeSession: async () => ({ ok: true, value: { targetSessionId: "forked", text: "original" } }) } } },
			"../i18n": { t: (key) => key },
		},
		globals: {
			CustomEvent: class {
				constructor(type, options) {
					this.type = type;
					this.detail = options.detail;
				}
			},
			window: { dispatchEvent: (event) => events.push(event) },
		},
	});
	let activeSessionId = "source";
	const drafts = [];
	const hook = load("src/renderer/src/hooks/useSessionHistoryMutations.ts").useSessionHistoryMutations({
		currentSessionId: "source",
		getRuntimeTargetForSession: () => sourceTarget,
		isAgentCurrentlyBusy: () => false,
		resolveProjectId: () => "project-1",
		openReplacedRuntimeSession: async (_projectId, targetSessionId) => {
			assert.equal(targetSessionId, "forked");
		},
		setCurrentSessionIdRef: (id) => {
			activeSessionId = id;
		},
		setPromptForAgent: (id, text) => drafts.push({ id, text }),
		showToast: () => {},
		translateAgentErrorMessage: (value) => value,
	});
	await hook.forkFromUserMessage({ id: "message-1", role: "user", text: "original", images: [image], meta: { entryId: "entry-1" } });
	assert.equal(activeSessionId, "forked");
	assert.deepEqual(drafts, [{ id: "forked", text: "original" }]);
	assert.equal(events.length, 1);
	assert.deepEqual(plain(events[0].detail), { text: "original", images: [image] });
});
