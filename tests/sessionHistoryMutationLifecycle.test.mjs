import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

/** 历史动作使用完整消息快照，保留原始引用文本与图片。 */
function userMessage(overrides = {}) {
	return {
		id: "message-a",
		role: "user",
		text: '<quoted_context label="original">quoted text</quoted_context>\nquestion',
		images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		meta: { entryId: "entry-a" },
		...overrides,
	};
}

/** 执行真实 hook；稳定 ref 允许模拟确认等待期间的会话切换，计时器不访问真实环境。 */
function harness(options = {}) {
	const calls = [];
	const confirmations = [];
	const toasts = [];
	const overlays = [];
	const refs = [];
	let cursor = 0;
	const atoms = { setSessionHistoryMutationOverlayAtom: {}, cacheSessionMessagesAtom: {}, setSessionMessageLoadStateAtom: {} };
	const sessions = {
		activateRuntime: async (sessionId) => {
			calls.push(["activate", sessionId]);
			return options.activateResult ?? { ok: true, value: { agentId: `agent-${sessionId}`, runtimeGeneration: 1 } };
		},
		forkRuntimeSession: async (target, entryId, settings) => {
			calls.push(["fork", plain(target), entryId, settings ? plain(settings) : undefined]);
			return options.forkResult ?? { ok: true, value: { targetSessionId: `fork-${target.sessionId}`, text: userMessage().text } };
		},
		getRuntimeForkMessages: async () => ({ ok: true, value: { value: [] } }),
	};
	const load = createTsSandbox({
		stubs: {
			react: {
				useCallback: (fn) => fn,
				useEffect: () => {},
				useState: (value) => [value, () => {}],
				useRef: (value) => {
					const index = cursor++;
					refs[index] ??= { current: value };
					return refs[index];
				},
			},
			jotai: { useSetAtom: (atom) => (value) => atom === atoms.setSessionHistoryMutationOverlayAtom && overlays.push(plain(value)) },
			"../atoms/session-atoms": atoms,
			"../atoms/composer-atoms": {},
			"../desktopApi": { desktopApi: { sessions } },
			"../i18n": { t: (key) => key },
		},
		globals: { setTimeout: () => 0 },
	});
	const useHook = load("src/renderer/src/hooks/useSessionHistoryMutations.ts").useSessionHistoryMutations;
	let deps = {
		currentSessionId: "source-a",
		getRuntimeTargetForSession: (sessionId) => (options.cold ? undefined : { sessionId, agentId: `agent-${sessionId}`, runtimeGeneration: 1 }),
		getRuntimeTargetForAgent: () => undefined,
		isSessionRuntimeLive: () => options.live !== false,
		hasPersistedSessionFile: () => true,
		showConfirm: (config) => confirmations.push(config),
		clearConfirm: () => calls.push(["clear-confirm"]),
		showToast: (text, duration, kind) => toasts.push({ text, duration, kind }),
		translateAgentErrorMessage: (text) => text,
		submitPromptSnapshot: async (...args) => {
			calls.push(["send", ...plain(args)]);
			return options.delivery ?? true;
		},
		openReplacedRuntimeSession: async (...args) => calls.push(["open", ...args]),
		setCurrentSessionIdRef: (sessionId) => calls.push(["select", sessionId]),
		setPromptForAgent: () => {},
		isAgentCurrentlyBusy: () => false,
		resolveProjectId: (sessionId) => `project-${sessionId}`,
		isLastUserMessage: (sessionId) => {
			calls.push(["is-last", sessionId]);
			return true;
		},
	};
	const render = (patch = {}) => {
		deps = { ...deps, ...patch };
		cursor = 0;
		return useHook(deps);
	};
	return { hook: render(), render, sessions, calls, confirmations, toasts, overlays, flush: () => setImmediate() };
}

for (const kind of ["resend", "edit"]) {
	test(`${kind} confirmation retains the source session after focus changes`, async () => {
		const h = harness();
		const message = userMessage();
		if (kind === "resend") h.hook.resendUserMessage(message);
		else await h.hook.editMessage(message, "edited text");
		assert.equal(h.confirmations.length, 1);
		assert.deepEqual(h.calls, []);
		assert.deepEqual(h.overlays, []);
		h.render({ currentSessionId: "source-b" });
		h.confirmations[0].onConfirm();
		await h.flush();
		const fork = h.calls.find(([operation]) => operation === "fork");
		assert.deepEqual(fork, ["fork", { sessionId: "source-a", agentId: "agent-source-a", runtimeGeneration: 1 }, "entry-a", { mutationFork: true, branchMode: false }]);
		assert.deepEqual(
			h.calls.find(([operation]) => operation === "is-last"),
			["is-last", "source-a"],
		);
		assert.deepEqual(
			h.calls.find(([operation]) => operation === "open"),
			["open", "project-source-a", "fork-source-a"],
		);
		assert.deepEqual(
			h.calls.find(([operation]) => operation === "send"),
			["send", "fork-source-a", kind === "edit" ? "edited text" : message.text, message.images],
		);
		assert.deepEqual(h.overlays, [
			{ sessionId: "source-a", kind: kind === "edit" ? "editing" : "resending" },
			{ sessionId: "source-a", kind: null },
		]);
		assert.equal(h.toasts.length, 0);
	});
}

test("cancelling resend confirmation never activates, forks or sends", async () => {
	const h = harness();
	h.hook.resendUserMessage(userMessage());
	await h.flush();
	assert.equal(h.confirmations.length, 1);
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.overlays, []);
});

for (const phase of ["activate", "fork"]) {
	test(`resend ${phase} failure is reported locally, clears overlay and remains retryable`, async () => {
		const failed = { ok: false, error: { code: "SESSION_COMMAND_FAILED", debugDetails: `${phase} failed` } };
		const options = { live: false, cold: phase === "activate", ...(phase === "activate" ? { activateResult: failed } : { forkResult: failed }) };
		const h = harness(options);
		h.hook.resendUserMessage(userMessage());
		await h.flush();
		assert.equal(h.toasts.length, 1);
		assert.match(h.toasts[0].text, /message\.resendFailed/);
		assert.match(h.toasts[0].text, new RegExp(`${phase} failed`));
		assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
		assert.equal(
			h.calls.some(([operation]) => operation === "send" || operation === "open"),
			false,
		);
		delete options.activateResult;
		delete options.forkResult;
		h.hook.resendUserMessage(userMessage());
		await h.flush();
		assert.equal(h.calls.filter(([operation]) => operation === "send").length, 1);
		assert.equal(h.toasts.length, 1);
		assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
	});
}

test("cancelled fork clears resend overlay without opening or sending", async () => {
	const h = harness({ live: false, forkResult: { ok: true, value: { cancelled: true } } });
	h.hook.resendUserMessage(userMessage());
	await h.flush();
	assert.deepEqual(
		h.toasts.map(({ text }) => text),
		["app.forkCancelled"],
	);
	assert.equal(
		h.calls.some(([operation]) => operation === "send" || operation === "open"),
		false,
	);
	assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
});

test("missing fork anchor is visible and clears resend overlay without mutation", async () => {
	const h = harness({ live: false });
	h.hook.resendUserMessage(userMessage({ meta: {} }));
	await h.flush();
	assert.deepEqual(
		h.toasts.map(({ text }) => text),
		["app.forkMissingEntryId"],
	);
	assert.equal(
		h.calls.some(([operation]) => operation === "fork" || operation === "send"),
		false,
	);
	assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
});

for (const delivery of [false, "unknown"]) {
	test(`resend delivery ${delivery} is not retried and only certain failure gets a warning`, async () => {
		const h = harness({ live: false, delivery });
		h.hook.resendUserMessage(userMessage());
		await h.flush();
		assert.equal(h.calls.filter(([operation]) => operation === "send").length, 1);
		assert.deepEqual(
			h.toasts.map(({ text, kind }) => ({ text, kind })),
			delivery === false ? [{ text: "message.resendSendFailedRolledBack", kind: "warning" }] : [],
		);
		assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
	});
}
