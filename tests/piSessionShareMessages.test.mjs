import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { collectPiSessionShareMessages } = loadTsCommonJs("src/main/pi/piSessionShareMessages.ts");
const m = (id, role = "user", meta = undefined) => ({ id, agentId: "_viewer", role, text: id, timestamp: 0, ...(meta ? { meta } : {}) });

test("pi share reads older pages in order and preserves export projection results", async () => {
	const cursors = [];
	const readPage = async (before) => {
		cursors.push(before);
		return before === undefined ? { messages: [m("tool", "tool", { entryId: "tool-entry", toolName: "read", fullText: "FULL_TOOL_RESULT_520" }), m("answer", "assistant")], total: 3, nextBefore: 1, indexVersion: "v1" } : { messages: [m("edited question")], total: 3, nextBefore: null, indexVersion: "v1" };
	};
	const result = await collectPiSessionShareMessages({ readPage });
	assert.deepEqual(
		Array.from(result.messages, (x) => x.id),
		["edited question", "tool", "answer"],
	);
	assert.equal(result.truncated, false);
	assert.equal(result.messages[1].meta.fullText, "FULL_TOOL_RESULT_520");
	assert.deepEqual(cursors, [undefined, 1]);
});

test("pi share flags budget-limited snapshots and rejects failed, inconsistent or non-progressing pages", async () => {
	const readPage = async (before) => ({ messages: [m(String(before ?? 4))], total: 5, nextBefore: (before ?? 4) - 1, indexVersion: "v1" });
	const result = await collectPiSessionShareMessages({ readPage, limits: { maxPages: 2 } });
	assert.equal(result.truncated, true);
	assert.equal(result.messages.length, 2);
	await assert.rejects(collectPiSessionShareMessages({ readPage: async (before) => ({ messages: [], total: 4, nextBefore: before ?? 2 }) }), /SESSION_SHARE_READ_FAILED/);
	await assert.rejects(collectPiSessionShareMessages({ readPage: async (before) => ({ messages: [m("a")], total: 4, nextBefore: before === undefined ? 2 : null, indexVersion: before === undefined ? "v1" : "v2" }) }), /SESSION_SHARE_CHANGED/);
	await assert.rejects(
		collectPiSessionShareMessages({
			readPage: async () => {
				throw new Error("private path");
			},
		}),
		/SESSION_SHARE_READ_FAILED/,
	);
});
