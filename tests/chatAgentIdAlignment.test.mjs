import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const css = readRendererStyles();
const titleRowRule = css.match(/\.chat-title-row \{([\s\S]*?)\n\}/)?.[1];

test("agent ID card is 28px tall and remains vertically centered with the title", () => {
	assert.match(titleRowRule ?? "", /align-items:\s*center;/);
});
