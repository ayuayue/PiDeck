import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function harness(overrides = {}) {
	const host = quickMessageHookHost();
	const calls = { prepare: [], save: [], release: [], full: [], close: 0 };
	const preview = { previewId: "preview-1", backend: "pi", html: "<p>reviewed</p>", inventory: { messages: 1, thinking: 1, toolArguments: 1, toolResults: 1, images: 0, systemMessages: 0, workspace: false }, redactedFields: 0, truncated: false };
	const api = {
		sessions: {
			prepareShareExport: async (input) => {
				calls.prepare.push(input);
				return { ok: true, value: preview };
			},
			saveShareExport: async (id) => {
				calls.save.push(id);
				return { ok: true, value: { path: "shared-session.html" } };
			},
			releaseShareExport: async (id) => {
				calls.release.push(id);
			},
			exportRecordHtml: async (id) => {
				calls.full.push(id);
				return { path: "official.html" };
			},
			...overrides,
		},
	};
	const { useSessionShareExport } = loadTsCommonJs("src/renderer/src/hooks/useSessionShareExport.ts", {
		stubs: {
			react: host.react,
			jotai: { useStore: () => ({ get: () => undefined }) },
			"../desktopApi": { desktopApi: api },
			"../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => id },
			"../utils/sessionCommands": { toSessionRuntimeTarget: () => undefined, isLiveRuntimeStatus: () => false },
			"../utils/notice": { showNotice: () => {} },
			"../i18n": { t: (key) => key },
		},
	});
	const render = () =>
		host.render(() =>
			useSessionShareExport("session-stable-id", () => {
				calls.close += 1;
			}),
		);
	return { host, calls, preview, render };
}

test("sharing requires a reviewed preview and explicit confirmation; changing an option invalidates the artifact", async () => {
	const h = harness();
	let state = h.render();
	await state.save();
	assert.deepEqual(h.calls.save, []);
	await state.prepare();
	state = h.render();
	assert.equal(state.preview.html, "<p>reviewed</p>");
	assert.equal(h.calls.prepare[0].sessionId, "session-stable-id");
	assert.equal(h.calls.prepare[0].options.excludeThinking, true);
	await state.save();
	assert.deepEqual(h.calls.save, [], "preview alone is not approval");
	state.setConfirmed(true);
	state = h.render();
	state.updateOption("excludeToolArguments", false);
	state = h.render();
	assert.equal(state.preview, null);
	assert.equal(state.confirmed, false);
	assert.equal(state.inventory.toolArguments, 1, "inventory survives the options edit");
	assert.deepEqual(h.calls.release, ["preview-1"]);
	await state.save();
	assert.deepEqual(h.calls.save, []);
	await state.prepare();
	state = h.render();
	state.setConfirmed(true);
	state = h.render();
	await state.save();
	assert.deepEqual(h.calls.save, ["preview-1"]);
	assert.equal(h.calls.close, 1);
	h.host.unmount();
});

test("late preview replies after dialog close are released and never become saveable", async () => {
	let resolve;
	const h = harness({
		prepareShareExport: () =>
			new Promise((done) => {
				resolve = done;
			}),
	});
	const pending = h.render().prepare();
	h.host.unmount();
	resolve({ ok: true, value: h.preview });
	await pending;
	assert.deepEqual(h.calls.release, ["preview-1"]);
	assert.deepEqual(h.calls.save, []);
});

test("complete export keeps the native path and failures never masquerade as a preview", async () => {
	const h = harness({ prepareShareExport: async () => ({ ok: false, error: "SESSION_SHARE_UNSUPPORTED" }) });
	await h.render().prepare();
	let state = h.render();
	assert.equal(state.preview, null);
	assert.equal(state.error, "sessionShare.unsupported");
	await state.exportComplete();
	assert.deepEqual(h.calls.full, ["session-stable-id"]);
	assert.equal(h.calls.close, 1);
	h.host.unmount();
});
