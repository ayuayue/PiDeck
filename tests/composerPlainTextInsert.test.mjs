import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadInsert() {
	const source = readFileSync("src/renderer/src/components/session/composer/tiptap/insertComposerPlainText.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "insertComposerPlainText.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) }, { filename: "insertComposerPlainText.ts" });
	return module.exports;
}

const { composerPlainTextInsertSteps } = loadInsert();

function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("composerPlainTextInsertSteps keeps ampersands as text, not HTML entities", () => {
	assertJsonEqual(composerPlainTextInsertSteps("A & B &amp; C"), [{ type: "text", text: "A & B &amp; C" }]);
});

test("composerPlainTextInsertSteps normalizes Windows newlines into hardBreaks", () => {
	assertJsonEqual(composerPlainTextInsertSteps("a\r\nb\nc\r"), [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }, { type: "hardBreak" }, { type: "text", text: "c" }, { type: "hardBreak" }]);
});
