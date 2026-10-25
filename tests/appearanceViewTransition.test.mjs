import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { applyAppearanceWithTransition } = loadTsCommonJs("src/renderer/src/hooks/appearance/appearanceTransition.ts");

function createTransitionHost({ visibilityState = "visible", onStart } = {}) {
	return {
		visibilityState,
		startViewTransition(update) {
			onStart?.();
			update();
			return {
				ready: Promise.resolve(),
			};
		},
	};
}

test("startup appearance updates stay direct until authoritative settings have a baseline", () => {
	let applyCount = 0;
	let transitionCount = 0;
	const host = createTransitionHost({ onStart: () => transitionCount++ });

	applyAppearanceWithTransition({
		host,
		apply: () => applyCount++,
		settingsLoaded: false,
		hasAppliedAuthoritativeAppearance: false,
		prefersReducedMotion: false,
	});
	applyAppearanceWithTransition({
		host,
		apply: () => applyCount++,
		settingsLoaded: true,
		hasAppliedAuthoritativeAppearance: false,
		prefersReducedMotion: false,
	});

	assert.equal(applyCount, 2);
	assert.equal(transitionCount, 0);
});

test("a later visible appearance update consumes a skipped transition rejection", () => {
	let applyCount = 0;
	let rejectionHandlerAttached = 0;
	const host = {
		visibilityState: "visible",
		startViewTransition(update) {
			update();
			return {
				ready: {
					catch(handler) {
						rejectionHandlerAttached++;
						handler(new DOMException("Transition was skipped", "AbortError"));
						return Promise.resolve();
					},
				},
			};
		},
	};

	applyAppearanceWithTransition({
		host,
		apply: () => applyCount++,
		settingsLoaded: true,
		hasAppliedAuthoritativeAppearance: true,
		prefersReducedMotion: false,
	});

	assert.equal(applyCount, 1);
	assert.equal(rejectionHandlerAttached, 1);
});

test("hidden documents and reduced-motion preference bypass view transitions", () => {
	for (const scenario of [
		{ visibilityState: "hidden", prefersReducedMotion: false },
		{ visibilityState: "visible", prefersReducedMotion: true },
	]) {
		let applyCount = 0;
		let transitionCount = 0;
		const host = createTransitionHost({ visibilityState: scenario.visibilityState, onStart: () => transitionCount++ });

		applyAppearanceWithTransition({
			host,
			apply: () => applyCount++,
			settingsLoaded: true,
			hasAppliedAuthoritativeAppearance: true,
			prefersReducedMotion: scenario.prefersReducedMotion,
		});

		assert.equal(applyCount, 1);
		assert.equal(transitionCount, 0);
	}
});

test("a synchronous View Transition API failure falls back to a direct update", () => {
	let applyCount = 0;
	const host = {
		visibilityState: "visible",
		startViewTransition() {
			throw new DOMException("Document is not active", "InvalidStateError");
		},
	};

	applyAppearanceWithTransition({
		host,
		apply: () => applyCount++,
		settingsLoaded: true,
		hasAppliedAuthoritativeAppearance: true,
		prefersReducedMotion: false,
	});

	assert.equal(applyCount, 1);
});

test("App passes settings readiness into the appearance lifecycle", () => {
	const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(appSource, /useAppAppearance\(\{\s*settings,\s*systemLanguage,\s*settingsLoaded,?\s*\}\)/);
});
