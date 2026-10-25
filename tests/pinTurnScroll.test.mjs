import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function loadAnimation() {
	let now = 0;
	let nextId = 0;
	const frames = new Map();
	const scroll = createTsSandbox({
		globals: {
			performance: { now: () => now },
			requestAnimationFrame: (callback) => {
				frames.set(++nextId, callback);
				return nextId;
			},
			cancelAnimationFrame: (id) => frames.delete(id),
			window: { matchMedia: () => ({ matches: false }) },
		},
	})("src/renderer/src/lib/pinTurnScroll.ts");
	return {
		...scroll,
		advance(time) {
			now = time;
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback(time);
		},
		pending: () => frames.size,
	};
}

test("long settle reposition starts gently instead of jumping hundreds of pixels on its first frame", () => {
	const animation = loadAnimation();
	const element = { scrollTop: 2400 };
	animation.animateScrollTop(element, 0);
	animation.advance(16);
	assert.ok(2400 - element.scrollTop < 20, `first frame moved ${2400 - element.scrollTop}px`);
});

test("settle reposition is monotonic, reaches the exact target and completes once", () => {
	const animation = loadAnimation();
	const element = { scrollTop: 2400 };
	let completed = 0;
	animation.animateScrollTop(element, 0, { onComplete: () => completed++ });
	let previous = element.scrollTop;
	const duration = animation.pinScrollDurationMs(2400);
	for (let time = 16; time < duration; time += 16) {
		animation.advance(time);
		assert.ok(element.scrollTop <= previous && element.scrollTop >= 0);
		previous = element.scrollTop;
	}
	animation.advance(duration);
	assert.equal(element.scrollTop, 0);
	assert.equal(completed, 1);
	assert.equal(animation.pending(), 0);
});

test("cancelling settle reposition leaves the reader in place without completing", () => {
	const animation = loadAnimation();
	const element = { scrollTop: 2400 };
	let completed = false;
	const cancel = animation.animateScrollTop(element, 0, {
		onComplete: () => {
			completed = true;
		},
	});
	animation.advance(120);
	cancel();
	const stopped = element.scrollTop;
	animation.advance(1500);
	assert.equal(element.scrollTop, stopped);
	assert.equal(completed, false);
	assert.equal(animation.pending(), 0);
});
