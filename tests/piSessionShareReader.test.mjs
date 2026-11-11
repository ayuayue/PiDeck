import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createPiSessionShareReader } = loadTsCommonJs("src/main/pi/piSessionShareReader.ts");
const { collectPiSessionShareMessages } = loadTsCommonJs("src/main/pi/piSessionShareMessages.ts");
const { buildSessionShareHtml } = loadTsCommonJs("src/main/sessions/sessionShareExport.ts");
const { DEFAULT_SESSION_SHARE_OPTIONS } = loadTsCommonJs("src/shared/types/sessionExport.ts");

test("actual pi export reader separates raw content blocks, keeps full tool payload for selection, and never changes JSONL", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "share-pi-reader-520-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "sample.jsonl");
	const resultText = `RESULT_START_520${"x".repeat(9000)}RESULT_MIDDLE_520${"x".repeat(9000)}RESULT_END_520`;
	const entries = [
		{ type: "session", version: 3, id: "h", parentId: null, cwd: dir },
		{ type: "message", id: "u", parentId: "h", message: { role: "user", content: [{ type: "text", text: "public question" }] } },
		{
			type: "message",
			id: "a",
			parentId: "u",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_READER_THINKING_520" },
					{ type: "toolCall", id: "c", name: "read", arguments: { file: "ARGUMENT_520" } },
				],
			},
		},
		{ type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: resultText }] } },
		{ type: "message", id: "r2", parentId: "r", message: { role: "toolResult", toolCallId: "c2", toolName: "image", content: [{ type: "image", mimeType: "image/png", data: "RkFLRV9JTUFHRQ==" }] } },
		{ type: "message", id: "final", parentId: "r2", message: { role: "assistant", content: [{ type: "text", text: "public answer" }] } },
	];
	const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	await writeFile(path, original);
	const reader = createPiSessionShareReader((key) => key);
	const collection = await collectPiSessionShareMessages({ readPage: (before) => reader.readSessionDisplayTurnPage(path, "_share", before, 20) });
	assert.equal(collection.truncated, false);
	const tool = collection.messages.find((item) => item.meta?.toolName === "read");
	assert.equal(tool.meta.fullText, resultText);
	const source = { ...collection, backend: "pi", title: "sample", cwd: dir };
	const context = { home: dir, exportedAt: 0, copy: { footer: "copy", warning: "review", partialNotice: "partial" } };
	const safe = buildSessionShareHtml(source, DEFAULT_SESSION_SHARE_OPTIONS, context).html;
	assert.ok(!safe.includes("PRIVATE_READER_THINKING_520"));
	assert.ok(!safe.includes("ARGUMENT_520"));
	assert.ok(!safe.includes("RESULT_MIDDLE_520"));
	const included = buildSessionShareHtml(source, { ...DEFAULT_SESSION_SHARE_OPTIONS, excludeToolArguments: false, excludeToolResults: false }, context).html;
	assert.ok(included.includes("ARGUMENT_520"));
	assert.ok(included.includes("RESULT_MIDDLE_520"));
	assert.ok(!included.includes("RkFLRV9JTUFHRQ=="));
	assert.equal(await readFile(path, "utf8"), original);
});
