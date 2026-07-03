import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/RichInput.tsx", "utf8");

test("RichInput inserts multiline text without execCommand normalization", () => {
	assert.match(source, /function insertPlainTextAtSelection\(root: HTMLElement, text: string\): void/);
	assert.doesNotMatch(source, /execCommand\("insertText"/);
	assert.match(source, /insertPlainTextAtSelection\(root, event\.clipboardData\.getData\("text\/plain"\)\);\s*handleInput\(\);/s);
	assert.match(source, /insertPlainTextAtSelection\(root, "\\n"\);\s*handleInput\(\);/s);
});
