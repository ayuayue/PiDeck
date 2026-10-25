import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadDomEventBridge() {
	const source = readFileSync("src/renderer/src/components/session/composer/tiptap/domEventBridge.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "domEventBridge.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}), console, Object }, { filename: "domEventBridge.ts" });
	return module.exports;
}

const { toComposerDomKeyboardEvent } = loadDomEventBridge();

test("toComposerDomKeyboardEvent exposes nativeEvent for React-shaped handlers", () => {
	const event = {
		key: "Enter",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		isComposing: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		defaultPrevented: false,
	};
	const patched = toComposerDomKeyboardEvent(event);
	assert.equal(patched.nativeEvent, event);
	assert.equal(patched.nativeEvent.isComposing, false);
	assert.equal(patched.key, "Enter");
});
