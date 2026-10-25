import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeImportedToolArguments } = loadTsCommonJs("src/main/sessions/importToolArguments.ts");

test("normalizeImportedToolArguments: 对象原样、JSON 字符串解析、数组包一层", () => {
	const asPlain = (value) => JSON.parse(JSON.stringify(value));
	assert.deepEqual(asPlain(normalizeImportedToolArguments({ path: "a.ts" })), { path: "a.ts" });
	assert.deepEqual(asPlain(normalizeImportedToolArguments('{"command":"ls"}')), { command: "ls" });
	assert.deepEqual(asPlain(normalizeImportedToolArguments(["a", "b"])), { items: ["a", "b"] });
	assert.deepEqual(asPlain(normalizeImportedToolArguments("not-json")), { value: "not-json" });
	assert.deepEqual(asPlain(normalizeImportedToolArguments(undefined)), {});
});
