import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function harness() {
	const values = new Map();
	const atoms = {
		sessionRuntimeBySessionIdAtomFamily: (id) => `runtime:${id}`,
		sessionRecordByIdAtomFamily: (id) => `record:${id}`,
		currentSessionRuntimeAtom: "focused-runtime",
	};
	const { useSessionPromptDispatch } = createTsSandbox({
		stubs: {
			react: { useCallback: (fn) => fn, useRef: (value) => ({ current: value }) },
			jotai: {},
			"../../atoms": atoms,
			"../../i18n": { t: (key) => key },
			"../../desktopApi": { desktopApi: {} },
			"../../composerBehavior": {},
		},
	})("src/renderer/src/hooks/session/useSessionPromptDispatch.ts");
	const dispatch = useSessionPromptDispatch({ store: { get: (key) => values.get(key) }, currentSessionId: "source", currentSessionIdRef: {}, activeAgentIdRef: {}, setSessionDraft() {}, showToast() {} });
	return { values, isBusy: dispatch.isAgentCurrentlyBusy };
}

test("history actions read their own session runtime even when another pane is focused", () => {
	const h = harness();
	h.values.set("focused-runtime", { status: "idle" });
	h.values.set("runtime:source", { status: "running" });
	h.values.set("runtime:other", { status: "idle" });
	assert.equal(h.isBusy(), true);
	assert.equal(h.isBusy("source"), true);
	assert.equal(h.isBusy("other"), false);
});

test("ACP settled turn and terminal runtimes do not retain a stale busy state", () => {
	const h = harness();
	h.values.set("record:source", { backend: "acp" });
	h.values.set("runtime:source", { status: "running", state: { isTurnActive: false } });
	assert.equal(h.isBusy(), false);
	h.values.set("runtime:source", { status: "closed", state: { isStreaming: true } });
	assert.equal(h.isBusy(), false);
});
