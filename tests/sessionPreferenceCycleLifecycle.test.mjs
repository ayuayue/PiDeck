import assert from "node:assert/strict";
import test from "node:test";
import { createSessionPreferenceControllerHarness as harness, NEXT, selectedModel, SOURCE } from "./helpers/sessionPreferenceControllerHarness.mjs";
import { runtimeInfo } from "./helpers/sessionRunControlHarness.mjs";

/** 目录与收藏独立异步加载；通过读侧快照重绘，触发真实 controller 的待执行队列。 */
function finishLoading(h) {
	for (const preferences of Object.values(h.preferences)) {
		preferences.models = [selectedModel];
		preferences.favoritesLoaded = true;
		preferences.catalogLoading = false;
	}
	return h.render();
}

/** 待执行按键的来源可以退休，而分屏中的旧栏也可以继续挂载但不再聚焦。 */
function retireCycle(h, change) {
	if (change === "session" || change === "away-and-back") h.render(NEXT);
	if (change === "away-and-back") h.render(SOURCE);
	if (change === "runtime") h.runtimes[SOURCE] = runtimeInfo({ agentId: "replacement", runtimeGeneration: 2 });
	if (change === "generation") h.runtimes[SOURCE] = runtimeInfo({ runtimeGeneration: 2 });
	if (change === "detach") h.runtimes[SOURCE] = undefined;
	if (change === "backend") h.preferences[SOURCE].isDshSession = true;
	if (change === "focus") h.focus(NEXT);
}

for (const operation of ["model", "thinking"]) {
	const shortcutId = operation === "model" ? "cycleModel" : "cycleThinking";
	for (const waitingFor of ["catalog", "favorites"]) {
		const pendingOptions = { ready: waitingFor !== "catalog", favoritesLoaded: waitingFor !== "favorites" };
		for (const change of ["session", "away-and-back", "runtime", "generation", "detach", "backend", "focus"]) {
			test(`pending ${operation} cycle waiting for ${waitingFor} is discarded after ${change}`, () => {
				const h = harness(pendingOptions);
				h.shortcut(shortcutId);
				retireCycle(h, change);
				finishLoading(h);
				assert.deepEqual(h.calls.commands, [], "a deferred source shortcut cannot act on a replacement or unfocused pane");
				assert.deepEqual(h.calls.updates, []);
				assert.deepEqual(h.calls.notices, []);
				h.unmount();
			});
		}

		test(`pending ${operation} cycle waiting for ${waitingFor} is discarded after focus leaves and returns without a pane render`, () => {
			const h = harness(pendingOptions);
			h.shortcut(shortcutId);
			h.focus(NEXT);
			h.focus(SOURCE);
			finishLoading(h);
			assert.deepEqual(h.calls.commands, [], "returning focus cannot revive a shortcut from a previous focus lifetime");
			assert.deepEqual(h.calls.updates, []);
			assert.deepEqual(h.calls.notices, []);
			h.unmount();
		});

		test(`pending ${operation} cycle waiting for ${waitingFor} executes once on the unchanged source`, () => {
			const h = harness(pendingOptions);
			h.shortcut(shortcutId);
			finishLoading(h);
			h.render();
			assert.equal(h.calls.commands.length, 1);
			assert.equal(h.calls.commands[0][0], operation);
			assert.deepEqual(h.calls.commands[0][1], { sessionId: SOURCE, agentId: "agent-a", runtimeGeneration: 1 });
			if (operation === "thinking") assert.equal(h.calls.commands[0][2], "medium");
			h.unmount();
		});
	}

	test(`pending ${operation} cycle is not revived when an observed runtime replacement is restored`, () => {
		const h = harness({ ready: false });
		h.shortcut(shortcutId);
		h.runtimes[SOURCE] = runtimeInfo({ runtimeGeneration: 2 });
		h.render();
		h.runtimes[SOURCE] = runtimeInfo();
		finishLoading(h);
		assert.deepEqual(h.calls.commands, []);
		h.unmount();
	});

	test(`pending draft ${operation} cycle cannot transfer to a newly bound runtime`, () => {
		const h = harness({ bound: false, ready: false });
		h.shortcut(shortcutId);
		h.runtimes[SOURCE] = runtimeInfo();
		finishLoading(h);
		assert.deepEqual(h.calls.commands, []);
		assert.deepEqual(h.calls.updates, []);
		h.unmount();
	});

	test(`an unfocused pane ignores the ready ${operation} shortcut`, () => {
		const h = harness();
		h.focus(NEXT);
		h.shortcut(shortcutId);
		assert.deepEqual(h.calls.commands, []);
		h.unmount();
	});

	test(`a ready ${operation} shortcut uses the focused source immediately`, () => {
		const h = harness();
		h.shortcut(shortcutId);
		assert.equal(h.calls.commands.length, 1);
		assert.equal(h.calls.commands[0][1].sessionId, SOURCE);
		h.unmount();
	});
}

test("a retired shortcut cannot show a catalog-load error in the replacement pane", () => {
	const h = harness({ ready: false });
	h.shortcut("cycleModel");
	h.render(NEXT);
	h.preferences[NEXT].report = { ok: false };
	h.preferences[NEXT].catalogLoading = false;
	h.render();
	assert.deepEqual(h.calls.notices, []);
	h.unmount();
});

test("a current pending shortcut still reports a failed empty catalog once", () => {
	const h = harness({ ready: false });
	h.shortcut("cycleModel");
	h.preferences[SOURCE].report = { ok: false };
	h.preferences[SOURCE].catalogLoading = false;
	h.render();
	h.render();
	assert.deepEqual(h.calls.notices, ["app.cycleModelCatalogFailed"]);
	assert.deepEqual(h.calls.commands, []);
	h.unmount();
});

test("an unmounted controller releases its shortcut listener", () => {
	const h = harness({ ready: false });
	h.shortcut("cycleModel");
	h.unmount();
	assert.equal(h.shortcuts.size, 0);
	assert.equal(h.subscriptions.size, 0, "unmount releases focus tracking as well as the shortcut listener");
	h.shortcut("cycleThinking");
	assert.deepEqual(h.calls.commands, []);
});
