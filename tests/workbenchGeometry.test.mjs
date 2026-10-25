import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Session-first keeps the main dev workbench sidebar default width", () => {
	const source = readFileSync("src/renderer/src/hooks/useResize.ts", "utf8");
	assert.match(source, /const DEFAULT_LIST_WIDTH = 221;/);
});
