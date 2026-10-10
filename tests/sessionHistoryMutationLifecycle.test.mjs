import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

/** 精确暂停 IPC 阶段，不依赖真实运行时或计时等待。 */
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

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
	const states = [];
	let cursor = 0;
	let stateCursor = 0;
	const atoms = { setSessionHistoryMutationOverlayAtom: {}, cacheSessionMessagesAtom: {}, setSessionMessageLoadStateAtom: {} };
	const composerAtoms = { setSessionQuotesAtom: {} };
	const sessions = {
		activateRuntime: async (sessionId) => {
			calls.push(["activate", sessionId]);
			return options.activateResult ?? { ok: true, value: { agentId: `agent-${sessionId}`, runtimeGeneration: 1 } };
		},
		forkRuntimeSession: async (target, entryId, settings) => {
			calls.push(["fork", plain(target), entryId, settings ? plain(settings) : undefined]);
			return options.forkResult ?? { ok: true, value: { targetSessionId: `fork-${target.sessionId}`, text: userMessage().text } };
		},
		getRuntimeForkMessages: async (target) => {
			calls.push(["fork-messages", plain(target)]);
			return options.forkMessages ?? { ok: true, value: { value: [] } };
		},
	};
	const load = createTsSandbox({
		stubs: {
			react: {
				useCallback: (fn) => fn,
				useEffect: () => {},
				useState: (value) => {
					const index = stateCursor++;
					states[index] ??= { current: value };
					return [
						states[index].current,
						(next) => {
							states[index].current = next;
						},
					];
				},
				useRef: (value) => {
					const index = cursor++;
					refs[index] ??= { current: value };
					return refs[index];
				},
			},
			jotai: {
				useSetAtom: (atom) => (value) => {
					if (atom === atoms.setSessionHistoryMutationOverlayAtom) overlays.push(plain(value));
					if (atom === composerAtoms.setSessionQuotesAtom) calls.push(["quotes", value.sessionId, plain(value.value({}))]);
				},
			},
			"../atoms/session-atoms": atoms,
			"../atoms/composer-atoms": composerAtoms,
			"../desktopApi": { desktopApi: { sessions } },
			"../i18n": { t: (key) => key },
		},
		globals: {
			setTimeout: () => 0,
			CustomEvent,
			window: {
				dispatchEvent: (event) => {
					calls.push(["draft-event", event.type, plain(event.detail)]);
					return true;
				},
			},
		},
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
		isAgentCurrentlyBusy: () => options.busy === true,
		resolveProjectId: (sessionId) => `project-${sessionId}`,
		isLastUserMessage: (sessionId) => {
			calls.push(["is-last", sessionId]);
			return true;
		},
	};
	const render = (patch = {}) => {
		deps = { ...deps, ...patch };
		cursor = 0;
		stateCursor = 0;
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

for (const phase of ["activate", "anchor"]) {
	test(`explicit fork retains source identity while ${phase} waits and focus changes`, async () => {
		const gate = deferred();
		const h = harness(phase === "activate" ? { cold: true, activateResult: gate.promise } : { forkMessages: gate.promise });
		const message = userMessage(phase === "anchor" ? { meta: {} } : {});
		const pending = h.hook.forkFromUserMessage(message);
		await h.flush();
		h.render({ currentSessionId: "source-b" });
		gate.resolve(phase === "activate" ? { ok: true, value: { agentId: "agent-source-a", runtimeGeneration: 7 } } : { ok: true, value: { value: [{ entryId: "entry-a", text: message.text }] } });
		await pending;
		assert.deepEqual(
			h.calls.find(([operation]) => operation === "fork"),
			["fork", { sessionId: "source-a", agentId: "agent-source-a", runtimeGeneration: phase === "activate" ? 7 : 1 }, "entry-a", undefined],
		);
		assert.deepEqual(
			h.calls.find(([operation]) => operation === "open"),
			["open", "project-source-a", "fork-source-a"],
		);
		assert.equal(h.calls.filter(([operation]) => operation === "activate").length, phase === "activate" ? 1 : 0);
		assert.ok(h.overlays.every(({ sessionId }) => sessionId === "source-a"));
		assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
		assert.equal(
			h.calls.some(([operation]) => operation === "send"),
			false,
		);
	});

	test(`explicit fork locks both entry points synchronously throughout ${phase} preparation`, async () => {
		const gate = deferred();
		const h = harness(phase === "activate" ? { cold: true, activateResult: gate.promise } : { forkMessages: gate.promise });
		const message = userMessage(phase === "anchor" ? { meta: {} } : {});
		const pending = [h.hook.forkFromUserMessage(message), h.hook.forkFromUserMessage(message), h.hook.forkAtEntry("other-entry", "other text", "branch:other-entry")];
		const busyMessageId = h.render().forkingMessageId;
		gate.resolve(phase === "activate" ? { ok: true, value: { agentId: "agent-source-a", runtimeGeneration: 1 } } : { ok: true, value: { value: [{ entryId: "entry-a", text: message.text }] } });
		await Promise.all(pending);
		assert.equal(h.calls.filter(([operation]) => operation === (phase === "activate" ? "activate" : "fork-messages")).length, 1);
		assert.equal(h.calls.filter(([operation]) => operation === "fork").length, 1);
		assert.equal(busyMessageId, message.id);
		assert.equal(h.render().forkingMessageId, null);
	});
}

for (const phase of ["activate", "fork"]) {
	for (const failure of ["command", "transport"]) {
		test(`explicit fork ${phase} ${failure} failure is caught, clears progress and allows retry`, async () => {
			const failed = { ok: false, error: { code: "SESSION_COMMAND_FAILED", debugDetails: `${phase} failed` } };
			const options = { cold: phase === "activate" };
			const key = phase === "activate" ? "activateResult" : "forkResult";
			if (failure === "command") options[key] = failed;
			const h = harness(options);
			const method = phase === "activate" ? "activateRuntime" : "forkRuntimeSession";
			const original = h.sessions[method];
			if (failure === "transport")
				h.sessions[method] = async () => {
					throw new Error(`${phase} transport failed`);
				};
			await assert.doesNotReject(h.hook.forkFromUserMessage(userMessage()));
			assert.deepEqual(
				h.toasts.map(({ text }) => text),
				["app.forkFailed"],
			);
			assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
			assert.equal(h.render().forkingMessageId, null);
			assert.equal(
				h.calls.some(([operation]) => operation === "open" || operation === "draft-event"),
				false,
			);
			delete options[key];
			h.sessions[method] = original;
			await h.hook.forkFromUserMessage(userMessage());
			assert.equal(h.calls.filter(([operation]) => operation === "open").length, 1);
			assert.deepEqual(
				h.toasts.map(({ text }) => text),
				["app.forkFailed", "app.forkDone"],
			);
		});
	}
}

test("branch-tree entry point rejects same-turn duplicates and releases the lock after completion", async () => {
	const gate = deferred();
	const options = { forkResult: gate.promise };
	const h = harness(options);
	const pending = [h.hook.forkAtEntry("entry-a", "original text", "branch:entry-a"), h.hook.forkAtEntry("entry-b", "other text", "branch:entry-b")];
	const busyMessageId = h.render().forkingMessageId;
	gate.resolve({ ok: true, value: { targetSessionId: "fork-source-a", text: "original text" } });
	await Promise.all(pending);
	assert.equal(h.calls.filter(([operation]) => operation === "fork").length, 1);
	assert.equal(busyMessageId, "branch:entry-a");
	assert.equal(h.render().forkingMessageId, null);
	delete options.forkResult;
	await h.hook.forkAtEntry("entry-b", "other text", "branch:entry-b");
	assert.equal(h.calls.filter(([operation]) => operation === "fork").length, 2);
});

for (const outcome of ["cancelled", "missing-anchor"]) {
	test(`explicit fork ${outcome} leaves the draft untouched and remains retryable`, async () => {
		const options = { cold: true, ...(outcome === "cancelled" ? { forkResult: { ok: true, value: { cancelled: true } } } : {}) };
		const h = harness(options);
		await h.hook.forkFromUserMessage(userMessage(outcome === "missing-anchor" ? { meta: {} } : {}));
		assert.deepEqual(
			h.toasts.map(({ text }) => text),
			[outcome === "cancelled" ? "app.forkCancelled" : "app.forkMissingEntryId"],
		);
		assert.equal(
			h.calls.some(([operation]) => operation === "open" || operation === "draft-event" || operation === "send"),
			false,
		);
		assert.deepEqual(h.overlays.at(-1), { sessionId: "source-a", kind: null });
		assert.equal(h.render().forkingMessageId, null);
		delete options.forkResult;
		await h.hook.forkFromUserMessage(userMessage());
		assert.equal(h.calls.filter(([operation]) => operation === "open").length, 1);
	});
}

test("explicit fork restores quotes and images into the forked draft without auto-sending", async () => {
	const message = userMessage({ text: '<quoted_context label="original" message_id="quoted-message">\nquoted text\n</quoted_context>\nquestion' });
	const h = harness({ forkResult: { ok: true, value: { targetSessionId: "fork-source-a", text: "" } } });
	await h.hook.forkFromUserMessage(message);
	const quotes = h.calls.find(([operation]) => operation === "quotes");
	assert.equal(quotes[1], "fork-source-a");
	const snippet = Object.values(quotes[2])[0];
	assert.equal(snippet.messageId, "quoted-message");
	assert.equal(snippet.text, "quoted text");
	assert.deepEqual(
		h.calls.find(([operation]) => operation === "draft-event"),
		["draft-event", "user-message-edit", { text: `#${snippet.id} question`, images: message.images }],
	);
	assert.equal(
		h.calls.some(([operation]) => operation === "send"),
		false,
	);
	assert.deepEqual(
		h.toasts.map(({ text }) => text),
		["app.forkDone"],
	);
});

for (const unavailable of ["busy", "no-session"]) {
	test(`explicit fork refuses ${unavailable} before starting either entry point`, async () => {
		const h = harness({ busy: unavailable === "busy" });
		const hook = unavailable === "no-session" ? h.render({ currentSessionId: undefined }) : h.hook;
		await hook.forkFromUserMessage(userMessage());
		await hook.forkAtEntry("entry-a", "text", "branch:entry-a");
		assert.deepEqual(h.calls, []);
		assert.deepEqual(h.overlays, []);
		assert.deepEqual(h.toasts, []);
	});
}
