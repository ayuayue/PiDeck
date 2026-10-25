import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const api = loadTsCommonJs("src/main/ipc/selectionToolIpc.ts");

test("selection window resize IPC validates untrusted dimensions", () => {
	const parse = api.parseSelectionToolResizeInput;
	assert.deepEqual({ ...parse({ width: 440, height: 46 }) }, { width: 440, height: 46 });
	for (const invalid of [null, undefined, 42, "440x46", {}, { width: 440 }, { width: 0, height: 46 }, { width: 440, height: -1 }, { width: Number.NaN, height: 46 }, { width: 2001, height: 46 }, { width: 440, height: Number.POSITIVE_INFINITY }]) {
		assert.equal(parse(invalid), null);
	}
});
