import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { formatExtensionErrorReason } = loadTsCommonJs("src/main/pi/extensionError.ts");

test("formatExtensionErrorReason: keeps string errors and prefixes the extension name", () => {
	assert.equal(formatExtensionErrorReason({ error: "boom" }), "boom");
	assert.equal(
		formatExtensionErrorReason({
			extensionName: "pi-deck-todo",
			error: "Cannot read properties of undefined",
		}),
		"pi-deck-todo: Cannot read properties of undefined",
	);
});

test("formatExtensionErrorReason: does not stringify objects as [object Object]", () => {
	assert.equal(
		formatExtensionErrorReason({
			extension: "ask_question",
			error: { message: "widget already closed" },
		}),
		"ask_question: widget already closed",
	);
	assert.equal(
		formatExtensionErrorReason({
			error: { reason: "timeout after 30s" },
		}),
		"timeout after 30s",
	);
	assert.doesNotMatch(formatExtensionErrorReason({ error: { code: "E_EXT", detail: "bad hook" } }), /\[object Object\]/);
});

test("AgentManager records extension_error without flipping session status", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /formatExtensionErrorReason\(typed\)/);
	assert.match(source, /from "\.\/extensionError"/);
	const start = source.indexOf('if (typed.type === "extension_error")');
	const end = source.indexOf("	private ", start);
	const block = source.slice(start, end);
	// 实现经 QueuedStartupDiagnostic 组装（role/i18nKey 变量传入 addLocalizedMessage）
	assert.match(block, /startupDiagnostics\.deliver\(agentId, diagnostic\)/);
	assert.match(block, /i18nKey: "diagnostic.extensionError"/);
	assert.doesNotMatch(block, /tab\.status\s*=\s*"error"/);
});
