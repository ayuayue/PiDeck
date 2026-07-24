import assert from "node:assert/strict";
import test from "node:test";
import {
	alignEntryIdsForDisplayMessages,
	assertResendRootEntry,
	collectDescendantEntryIds,
	findLastUserMessageLine,
	takeActiveEntryId,
} from "../src/main/pi/sessionEntryIds.ts";

function extractText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

test("takeActiveEntryId always advances even when caller skips render", () => {
	const ids = ["u1", "a_empty", "t1", "u2"];
	let idx = 0;
	const a = takeActiveEntryId(ids, idx);
	assert.equal(a.entryId, "u1");
	idx = a.nextIndex;
	const b = takeActiveEntryId(ids, idx);
	assert.equal(b.entryId, "a_empty");
	idx = b.nextIndex;
	const c = takeActiveEntryId(ids, idx);
	assert.equal(c.entryId, "t1");
	idx = c.nextIndex;
	const d = takeActiveEntryId(ids, idx);
	assert.equal(d.entryId, "u2");
});

/**
 * 回归：工具回合里 assistant 只有 toolCall、无可见文本时，
 * 旧逻辑不推进 entryIndex，会导致后续用户消息拿到更早的 entryId。
 * 重发若用错 entryId 作根，会沿 parentId 删掉大半段历史。
 */
test("empty assistant tool-call must not shift later user entryIds", () => {
	const activeEntryIds = ["u1", "a1", "u2", "a2_empty", "t1", "a2", "u3", "a3"];
	const rawMessages = [
		{ role: "user", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer1" }] },
		{ role: "user", content: [{ type: "text", text: "second" }] },
		// 无文本，仅 toolCall —— UI 跳过，但 entry 槽位必须消费
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", id: "t1" }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer2" }] },
		{ role: "user", content: [{ type: "text", text: "third-resend-me" }] },
		{ role: "assistant", content: [{ type: "text", text: "partial" }] },
	];

	const aligned = alignEntryIdsForDisplayMessages(rawMessages, activeEntryIds, extractText);
	const u3 = aligned.find((m) => m.role === "user" && !m.skipped && m.entryId === "u3");
	assert.ok(u3, "last user message must keep entryId=u3");

	// 被跳过的 empty assistant 仍应对齐到 a2_empty
	const skippedAssistant = aligned.find((m) => m.entryId === "a2_empty");
	assert.ok(skippedAssistant?.skipped);

	// 模拟旧 bug：跳过 empty assistant 时不 ++，u3 会错绑到 a2
	let badIndex = 0;
	const bad = [];
	for (const typed of rawMessages) {
		if (typed.role !== "user" && typed.role !== "assistant" && typed.role !== "toolResult") continue;
		const entryId = activeEntryIds[badIndex];
		const text = extractText(typed.content);
		if ((typed.role === "user" || typed.role === "assistant") && !text.trim()) {
			// 旧 bug：return [] 且不 ++
			continue;
		}
		badIndex++;
		bad.push({ role: typed.role, entryId });
	}
	const badU3 = bad.find((m) => m.role === "user" && m.entryId !== "u1" && m.entryId !== "u2");
	// 旧逻辑下「第三条 user」会拿到 a2 而非 u3
	assert.equal(bad[bad.length - 2]?.entryId, "a2", "documents the old mis-alignment");
	assert.notEqual(badU3?.entryId, "u3");
});

test("collectDescendantEntryIds only removes root and its descendants", () => {
	const lines = [
		JSON.stringify({ type: "session", id: "s1" }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null }),
		JSON.stringify({
			type: "message",
			id: "u1",
			parentId: "m1",
			message: { role: "user", content: [{ type: "text", text: "first" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "a1",
			parentId: "u1",
			message: { role: "assistant", content: [{ type: "text", text: "a" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "u2",
			parentId: "a1",
			message: { role: "user", content: [{ type: "text", text: "resend-me" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "a2",
			parentId: "u2",
			message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
		}),
	];

	const removed = collectDescendantEntryIds(lines, "u2");
	assert.deepEqual([...removed].sort(), ["a2", "u2"]);
	assert.ok(!removed.has("u1"));
	assert.ok(!removed.has("a1"));
	assert.ok(!removed.has("m1"));
});

test("wrong early root would wipe history — assertResendRootEntry blocks non-user roots", () => {
	const assistantEntry = {
		type: "message",
		id: "a1",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
	};
	assert.throws(
		() => assertResendRootEntry(assistantEntry, "resend-me", extractText),
		/must be a user message/,
	);

	const wrongUser = {
		type: "message",
		id: "u1",
		message: { role: "user", content: [{ type: "text", text: "first" }] },
	};
	assert.throws(
		() => assertResendRootEntry(wrongUser, "resend-me", extractText),
		/text mismatch/,
	);
});

test("findLastUserMessageLine prefers the latest duplicate text", () => {
	const lines = [
		JSON.stringify({
			type: "message",
			id: "u1",
			message: { role: "user", content: [{ type: "text", text: "same" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "a1",
			message: { role: "assistant", content: [{ type: "text", text: "x" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "u2",
			message: { role: "user", content: [{ type: "text", text: "same" }] },
		}),
	];
	const found = findLastUserMessageLine(lines, "same", extractText);
	assert.equal(found?.entry.id, "u2");
	assert.equal(found?.lineIndex, 2);
});
