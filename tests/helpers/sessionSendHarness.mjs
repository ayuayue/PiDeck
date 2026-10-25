import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./createTsSandbox.mjs";

export const BOOTSTRAP_ID = "renderer:chat-bootstrap";
const EMPTY_RESERVED = new Set();
export const SESSION_ID = "catalog-session";

/** 显式控制异步边界，不以 sleep 猜测跨 VM promise 的完成顺序。 */
export function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/** 正式会话具有完整 catalog 身份；bootstrap 直到提升前都没有 record。 */
export function sessionRecord(id = SESSION_ID, overrides = {}) {
	return { id, projectId: "project-1", title: "Test session", source: "pi", environment: "native", preview: "", messageCount: 0, status: "draft", createdAt: 1, updatedAt: 1, ...overrides };
}

/** 用真实 composer/cache atoms 提升、移除会话，避免测试桩遗漏发送状态迁移。 */
export function createSendHarness({ sessionId = BOOTSTRAP_ID, draft = "read &reference", attachments = [], quotes = {}, templates = [], beforePromotion, prepareMessage, sendPrompt, enqueue, ensureTemplates, reservedCommandNames } = {}) {
	const store = createStore();
	const atoms = {};
	const errors = [];
	const unknowns = [];
	const history = [];
	const submissions = [];
	let requestSequence = 0;
	let refs = [];
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
	if (sessionId !== BOOTSTRAP_ID) store.set(atoms.upsertSessionAtom, sessionRecord(sessionId));
	store.set(atoms.setSessionDraftAtom, { sessionId, value: draft });
	store.set(atoms.setSessionAttachmentsAtom, { sessionId, value: attachments });
	store.set(atoms.setSessionQuotesAtom, { sessionId, value: quotes });
	store.set(atoms.setSessionDraftAtom, { sessionId: "unrelated-session", value: "leave this draft alone" });
	store.set(atoms.currentSessionIdAtom, sessionId);
	const options = {
		sessionId,
		// 发送期按需读取（模板表可能晚于首次渲染就绪）；harness 传固定清单即可
		getTemplates: () => templates,
		ensureTemplates,
		getReservedCommandNames: () => reservedCommandNames ?? EMPTY_RESERVED,
		prepareMessage,
		enqueue,
		compact: async () => {},
		ensureSessionId: async (sourceSessionId) => {
			await beforePromotion?.(sourceSessionId);
			if (sourceSessionId !== BOOTSTRAP_ID) return sourceSessionId;
			store.set(atoms.upsertSessionAtom, sessionRecord());
			store.set(atoms.promoteSessionMessagesCacheAtom, { fromSessionId: sourceSessionId, toSessionId: SESSION_ID });
			store.set(atoms.promoteSessionComposerStateAtom, { fromSessionId: sourceSessionId, toSessionId: SESSION_ID });
			store.set(atoms.currentSessionIdAtom, SESSION_ID);
			return SESSION_ID;
		},
		sendPrompt: async (input) => {
			submissions.push(input);
			return sendPrompt ? sendPrompt(input) : { accepted: true };
		},
		showError: (message) => errors.push(message),
		showUnknown: () => unknowns.push(true),
		recordPromptHistory: (id, message) => history.push({ sessionId: id, message }),
	};
	// 提升后 React 会用真实 sessionId 重渲染；新挂载则拥有另一组 refs，但共享 store。
	const render = (renderedSessionId = sessionId) => {
		refIndex = 0;
		return useSessionSend({ ...options, sessionId: renderedSessionId });
	};
	const mount = (renderedSessionId = sessionId) => {
		refs = [];
		return render(renderedSessionId);
	};
	return { store, atoms, send: render(), render, mount, errors, unknowns, history, submissions };
}
