import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { getViewportBoundMenuPlacement } = loadTsCommonJs("src/renderer/src/components/app/git/floatingMenuPosition.ts");

const options = {
	preferredWidth: 240,
	maxHeight: 240,
	gap: 2,
};

describe("viewport-bound Git menu placement", () => {
	test("shifts a right-edge menu left so long branch labels remain on-screen", () => {
		const placement = getViewportBoundMenuPlacement({ left: 980, top: 100, bottom: 124 }, { width: 1024, height: 768 }, options);

		assert.equal(placement.left, 776);
		assert.equal(placement.top, 126);
		assert.equal(placement.bottom, "auto");
		assert.equal(placement.width, 240);
		assert.equal(placement.maxHeight, 240);
	});

	test("shrinks the menu to the narrow viewport instead of overflowing it", () => {
		const placement = getViewportBoundMenuPlacement({ left: 124, top: 40, bottom: 64 }, { width: 180, height: 500 }, options);

		assert.equal(placement.left, 8);
		assert.equal(placement.width, 164);
		assert.equal(placement.top, 66);
		assert.equal(placement.bottom, "auto");
	});

	test("opens upward when the available space below the trigger is too small", () => {
		const placement = getViewportBoundMenuPlacement({ left: 80, top: 700, bottom: 724 }, { width: 1024, height: 768 }, options);

		assert.equal(placement.left, 80);
		assert.equal(placement.top, "auto");
		assert.equal(placement.bottom, 70);
		assert.equal(placement.width, 240);
		assert.equal(placement.maxHeight, 240);
	});

	test("uses the trigger width as preferred width so drawer menus stay aligned", () => {
		const placement = getViewportBoundMenuPlacement({ left: 700, top: 80, bottom: 108 }, { width: 1024, height: 768 }, { preferredWidth: 280, maxHeight: 300, gap: 2 });

		assert.equal(placement.width, 280);
		assert.equal(placement.left, 700);
		assert.equal(placement.top, 110);
	});

	test("clamps a wide trigger-based menu into a narrow viewport instead of overflowing", () => {
		const placement = getViewportBoundMenuPlacement({ left: 40, top: 40, bottom: 64 }, { width: 200, height: 500 }, { preferredWidth: 280, maxHeight: 300, gap: 2 });

		assert.equal(placement.left, 8);
		assert.equal(placement.width, 184);
	});
});
