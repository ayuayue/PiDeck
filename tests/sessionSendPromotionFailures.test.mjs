import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const BOOTSTRAP_ID = "renderer:chat-bootstrap";
const SESSION_ID = "catalog-session";

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/** 用真实 composer/cache atoms 提升会话，避免测试桩遗漏发送状态迁移。 */
function createSendHarness({ sessionId = BOOTSTRAP_ID, draft = "read &reference", attachments = [], templates = [], prepareMessage, enqueue } = {}) {
	const store = createStore();
	const atoms = {};
	const errors = [];
	const submissions = [];
	let requestSequence = 0;
	const refs = [];
	let refIndex = 0;
	const load = createTsSandbox({
		globals: {
			Error,
			crypto: { randomUUID: () => `request-${++requestSequence}` },
		},
		stubs: {
			jotai: {
				atom,
				useStore: () => store,
				useSetAtom: (target) => (input) => store.set(target, input),
			},
			react: {
				useRef: (value) => {
					const index = refIndex++;
					return (refs[index] ??= { current: value });
				},
			},
			"../atoms": atoms,
			"../i18n": {
				t: (key, params) => (params?.name ? `${key}: ${params.name}` : key),
				translateI18nDescriptor: (_descriptor, fallback) => fallback,
			},
			"../utils/dshRuntimeHint": {
				maybeHintMissingDshRunnerNode: () => {},
			},
		},
	});
	Object.assign(atoms, load("src/renderer/src/atoms/session-atoms.ts"), load("src/renderer/src/atoms/composer-atoms.ts"));
	const { useSessionSend } = load("src/renderer/src/hooks/useSessionSend.ts");
	store.set(atoms.setSessionDraftAtom, { sessionId, value: draft });
	store.set(atoms.setSessionAttachmentsAtom, { sessionId, value: attachments });
	store.set(atoms.setSessionDraftAtom, { sessionId: "unrelated-session", value: "leave this draft alone" });
	store.set(atoms.currentSessionIdAtom, sessionId);
	const options = {
		sessionId,
		templates,
		prepareMessage,
		enqueue,
		compact: async () => {},
		ensureSessionId: async (sourceSessionId) => {
			if (sourceSessionId !== BOOTSTRAP_ID) return sourceSessionId;
			store.set(atoms.promoteSessionMessagesCacheAtom, { fromSessionId: sourceSessionId, toSessionId: SESSION_ID });
			store.set(atoms.promoteSessionComposerStateAtom, { fromSessionId: sourceSessionId, toSessionId: SESSION_ID });
			store.set(atoms.currentSessionIdAtom, SESSION_ID);
			return SESSION_ID;
		},
		sendPrompt: async (input) => {
			submissions.push(input);
			return { accepted: true };
		},
		showError: (message) => errors.push(message),
	};
	// 提升后 React 会用真实 sessionId 重渲染 hook；useRef 中的发送锁保持不变。
	const render = (renderedSessionId = sessionId) => {
		refIndex = 0;
		return useSessionSend({ ...options, sessionId: renderedSessionId });
	};
	return { store, atoms, send: render(), render, errors, submissions };
}

function emptyTemplate() {
	return { name: "empty", path: "/prompts/empty.md", description: "empty template", content: "---\ndescription: empty template\n---\n" };
}

test("preparation failure after promotion settles the real Session and preserves new input for retry", async () => {
	const preparation = createDeferred();
	const preparationStarted = createDeferred();
	const originalImage = { type: "image", data: "original", mimeType: "image/png" };
	const nextImage = { type: "image", data: "next", mimeType: "image/png" };
	let preparationCalls = 0;
	const harness = createSendHarness({
		attachments: [originalImage],
		prepareMessage: async (message) => {
			preparationCalls += 1;
			preparationStarted.resolve();
			return preparationCalls === 1 ? preparation.promise : message;
		},
	});
	const { store, atoms } = harness;
	const pending = harness.send();
	// 按真实预处理入口同步，不假设跨 VM promise 只需一个 microtask。
	await preparationStarted.promise;
	assert.equal(preparationCalls, 1);
	assert.equal(store.get(atoms.currentSessionSendStateAtom).status, "activating");
	assert.equal(store.get(atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined);
	store.set(atoms.setSessionDraftAtom, { sessionId: SESSION_ID, value: "new input" });
	store.set(atoms.setSessionAttachmentsAtom, { sessionId: SESSION_ID, value: [nextImage] });
	preparation.reject(new Error("reference unavailable"));
	await pending;

	assert.equal(store.get(atoms.currentSessionSendStateAtom).status, "error", "the visible Session must not remain activating");
	assert.equal(store.get(atoms.currentSessionSendStateAtom).requestId, "request-1");
	assert.equal(store.get(atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined, "the retired bootstrap identity must stay empty");
	assert.equal(store.get(atoms.sessionDraftByIdAtom)[SESSION_ID], "read &reference\n\nnew input");
	assert.deepEqual([...store.get(atoms.sessionAttachmentsByIdAtom)[SESSION_ID]], [originalImage, nextImage]);
	assert.equal(store.get(atoms.sessionDraftByIdAtom)["unrelated-session"], "leave this draft alone");
	assert.equal(harness.submissions.length, 0);
	assert.deepEqual(harness.errors, ["reference unavailable"]);

	await harness.render(SESSION_ID)();
	assert.equal(harness.submissions.length, 1, "the promoted Composer must allow retry");
	assert.equal(harness.submissions[0].sessionId, SESSION_ID);
	assert.equal(store.get(atoms.currentSessionSendStateAtom).status, "idle");
});

test("preparation failure without promotion remains scoped to the original Session", async () => {
	const harness = createSendHarness({
		sessionId: SESSION_ID,
		prepareMessage: async () => {
			throw new Error("reference unavailable");
		},
	});
	await harness.send();
	assert.equal(harness.store.get(harness.atoms.currentSessionSendStateAtom).status, "error");
	assert.equal(harness.store.get(harness.atoms.sessionDraftByIdAtom)[SESSION_ID], "read &reference");
	assert.equal(harness.submissions.length, 0);
});

test("an empty template is rejected on the promoted Session instead of reaching the transport", async () => {
	const templates = [emptyTemplate()];
	const harness = createSendHarness({ draft: "/empty", templates });
	await harness.send();
	assert.equal(harness.submissions.length, 0, "the real template expander preserves /empty, so blank-body detection must use its verdict");
	assert.equal(harness.store.get(harness.atoms.currentSessionSendStateAtom).status, "error");
	assert.equal(harness.store.get(harness.atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined);
	assert.equal(harness.store.get(harness.atoms.sessionDraftByIdAtom)[SESSION_ID], "/empty");
	assert.equal(harness.errors.length, 1);
	assert.match(harness.errors[0], /app\.promptTemplateEmptyBody.*empty/);

	templates[0].content = "A useful template";
	await harness.render(SESSION_ID)();
	assert.equal(harness.submissions.length, 1);
	assert.match(harness.submissions[0].message, /A useful template/);
});

test("an empty template cannot enter the local queue after Session promotion", async () => {
	const queued = [];
	const harness = createSendHarness({
		draft: "/empty",
		templates: [emptyTemplate()],
		enqueue: (sessionId, snapshot) => {
			queued.push({ sessionId, snapshot });
			return true;
		},
	});
	await harness.send("followUp");
	assert.equal(queued.length, 0, "a blank template must be rejected before enqueue");
	assert.equal(harness.submissions.length, 0);
	assert.equal(harness.store.get(harness.atoms.currentSessionSendStateAtom).status, "error");
	assert.equal(harness.store.get(harness.atoms.sessionSendStateByIdAtom)[BOOTSTRAP_ID], undefined);
	assert.equal(harness.store.get(harness.atoms.sessionDraftByIdAtom)[SESSION_ID], "/empty");
});
