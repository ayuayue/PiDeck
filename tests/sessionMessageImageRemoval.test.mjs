import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const message = {
	id: "message-a",
	role: "user",
	text: "keep text",
	images: [
		{ type: "image", data: "FIRST", mimeType: "image/png" },
		{ type: "image", data: "SECOND", mimeType: "image/png" },
	],
	meta: { entryId: "entry-a" },
};

/** 执行真实 hook + 文件操作包装器；只替换 IPC、React 与 atom setter。 */
function harness(options = {}) {
	const calls = [];
	const confirmations = [];
	const toasts = [];
	const writes = [];
	const refs = [];
	let cursor = 0;
	const atoms = { setSessionHistoryMutationOverlayAtom: {}, cacheSessionMessagesAtom: {}, setSessionMessageLoadStateAtom: {} };
	const sessions = {
		stopRuntime: async (target) => {
			calls.push(["stop", target.sessionId]);
			if (options.stopFails) return { ok: false, error: { code: "SESSION_RUNTIME_CHANGED" } };
			return { ok: true, value: undefined };
		},
		removeCatalogMessageImage: async (...args) => {
			calls.push(["remove", args[0]]);
			writes.push(plain(args));
			return options.removeResult ?? { ok: true, value: undefined };
		},
		readRecordMessagePage: async (sessionId) => {
			calls.push(["reload", sessionId]);
			return { messages: [{ id: "new", role: "user", text: "keep text" }], total: 1, nextBefore: null };
		},
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
			jotai: { useSetAtom: (atom) => (value) => calls.push([atom === atoms.setSessionHistoryMutationOverlayAtom ? "overlay" : atom === atoms.cacheSessionMessagesAtom ? "cache" : "load-state", plain(value)]) },
			"../atoms/session-atoms": atoms,
			"../atoms/composer-atoms": {},
			"../desktopApi": { desktopApi: { sessions } },
			"../i18n": { t: (key) => key },
		},
	});
	const useHook = load("src/renderer/src/hooks/useSessionHistoryMutations.ts").useSessionHistoryMutations;
	let current = {
		currentSessionId: "focused-b",
		hasPersistedSessionFile: () => options.persisted !== false,
		isSessionRuntimeLive: () => options.live !== false,
		getRuntimeTargetForSession: (sessionId) => ({ sessionId, agentId: `agent-${sessionId}`, runtimeGeneration: 1 }),
		showConfirm: (config) => confirmations.push(config),
		clearConfirm: () => calls.push(["clear-confirm"]),
		showToast: (text) => toasts.push(text),
		translateAgentErrorMessage: (text) => text,
	};
	const render = (patch = {}) => {
		current = { ...current, ...patch };
		cursor = 0;
		return useHook(current);
	};
	return { hook: render(), render, calls, confirmations, toasts, writes };
}

test("image removal waits for confirmation; cancelling never stops or writes", () => {
	const h = harness();
	h.hook.removeMessageImage("source-a", message, 1);
	assert.equal(h.confirmations.length, 1);
	assert.equal(h.confirmations[0].message, "message.removeImageStopBody");
	assert.equal(h.confirmations[0].danger, true);
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.writes, []);
});

test("image removal uses the source pane identity after focus changes and reloads only after persistence", async () => {
	const h = harness();
	h.hook.removeMessageImage("source-a", message, 1);
	h.render({ currentSessionId: "focused-c" });
	await h.confirmations[0].onConfirm();
	assert.deepEqual(
		h.calls.filter(([kind]) => ["stop", "remove", "reload"].includes(kind)),
		[
			["stop", "source-a"],
			["remove", "source-a"],
			["reload", "source-a"],
		],
	);
	assert.deepEqual(h.writes, [["source-a", "message-a", { index: 1, expectedImageCount: 2, expectedHash: createHash("sha256").update("SECOND").digest("hex") }, "entry-a"]]);
	assert.deepEqual(h.calls.filter(([kind]) => kind === "overlay").at(-1), ["overlay", { sessionId: "source-a", kind: null }]);
});

test("stopped image removal still confirms but does not stop a runtime", async () => {
	const h = harness({ live: false });
	h.hook.removeMessageImage("source-a", message, 0);
	assert.equal(h.confirmations[0].message, "message.removeImageBody");
	await h.confirmations[0].onConfirm();
	assert.equal(
		h.calls.some(([kind]) => kind === "stop"),
		false,
	);
	assert.equal(h.writes.length, 1);
});

test("stop or mutation failure does not reload or optimistically hide an image and clears overlay", async () => {
	for (const options of [{ stopFails: true }, { removeResult: { ok: false, error: { code: "MESSAGE_NOT_FOUND" } } }]) {
		const h = harness(options);
		h.hook.removeMessageImage("source-a", message, 1);
		await h.confirmations[0].onConfirm();
		assert.equal(
			h.calls.some(([kind]) => kind === "cache" || kind === "reload"),
			false,
		);
		assert.equal(h.toasts.length, 1);
		assert.match(h.toasts[0], /message.removeImageFailed/);
		assert.deepEqual(h.calls.filter(([kind]) => kind === "overlay").at(-1), ["overlay", { sessionId: "source-a", kind: null }]);
	}
});

test("anonymous, assistant, reference-only and invalid targets never submit a deletion", () => {
	const h = harness({ persisted: false });
	h.hook.removeMessageImage("source-a", message, 0);
	assert.deepEqual(h.toasts, ["message.removeImageUnsupported"]);
	const supported = harness();
	for (const index of [-1, 0.5, 2]) supported.hook.removeMessageImage("source-a", message, index);
	supported.hook.removeMessageImage("source-a", { ...message, role: "assistant" }, 0);
	supported.hook.removeMessageImage("source-a", { ...message, images: [{ type: "image", ref: "ref.png", mimeType: "image/png" }] }, 0);
	assert.equal(supported.confirmations.length, 0);
	assert.deepEqual(supported.calls, []);
});
