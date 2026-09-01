import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(
	readFileSync("src/renderer/src/utils/voiceTranscriptionInsert.ts", "utf8"),
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { module, exports: module.exports });
const { resolveVoiceTranscriptionInsertion } = module.exports;

const target = { sessionId: "s1", draft: "hello world!", from: 6, to: 11 };

test("replaces the captured selection and returns a paired caret", () => {
	const result = resolveVoiceTranscriptionInsertion({
		target,
		currentSessionId: "s1",
		currentDraft: target.draft,
		text: "PiDeck",
	});
	assert.equal(result.ok, true);
	assert.equal(result.value, "hello PiDeck!");
	assert.equal(result.caret, 12);
});

test("preserves a later edit wholly before or after the captured selection", () => {
	const before = resolveVoiceTranscriptionInsertion({
		target,
		currentSessionId: "s1",
		currentDraft: "Say hello world!",
		text: "PiDeck",
	});
	assert.equal(before.value, "Say hello PiDeck!");
	const after = resolveVoiceTranscriptionInsertion({
		target,
		currentSessionId: "s1",
		currentDraft: "hello world! Again",
		text: "PiDeck",
	});
	assert.equal(after.value, "hello PiDeck! Again");
});

test("rejects overlapping edits, ambiguous caret edits, and session switches", () => {
	assert.equal(resolveVoiceTranscriptionInsertion({
		target,
		currentSessionId: "s1",
		currentDraft: "hello changed!",
		text: "PiDeck",
	}).ok, false);
	assert.equal(resolveVoiceTranscriptionInsertion({
		target: { sessionId: "s1", draft: "abc", from: 1, to: 1 },
		currentSessionId: "s1",
		currentDraft: "aXbc",
		text: "voice",
	}).ok, false);
	assert.equal(resolveVoiceTranscriptionInsertion({
		target,
		currentSessionId: "s2",
		currentDraft: target.draft,
		text: "PiDeck",
	}).ok, false);
});
