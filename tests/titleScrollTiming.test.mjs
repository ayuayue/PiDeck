import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { TITLE_SCROLL_PIXELS_PER_SECOND, titleScrollDurationMs } = loadTsCommonJs("src/renderer/src/components/sidebar/titleScrollTiming.ts");

for (const distance of [2, 30, 100, 300, 3000, 6000]) {
	test(`title scroll duration keeps ${distance}px at 30px/s without clamping`, () => {
		const durationMs = titleScrollDurationMs(distance);
		assert.equal(durationMs, (distance / 30) * 1000);
		assert.equal(distance / (durationMs / 1000), TITLE_SCROLL_PIXELS_PER_SECOND);
	});
}
