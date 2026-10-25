import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * done 与 message 乱序：done 先到不得拆 live 身份；message 带 thinking 后才释放。
 */
const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");

function thinkingEvent(sessionId, agentId, payload) {
	return {
		kind: "event",
		sessionId,
		agentId,
		runtimeGeneration: 1,
		sourceChannel: "agents:thinking",
		payload,
	};
}

function messageEvent(sessionId, agentId, messages) {
	return {
		kind: "event",
		sessionId,
		agentId,
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: { messages },
	};
}

test("done before message keeps live thinking identity until History has text", () => {
	const store = createStore();
	const sessionId = "s1";
	const agentId = "a1";
	const messageId = "m1";
	const thinkingId = `msg-thinking-${messageId}`;

	store.set(atoms.bindSessionRuntimeAtom, {
		sessionId,
		agentId,
		runtimeGeneration: 1,
		status: "running",
	});

	store.set(
		atoms.applySessionRuntimeEventAtom,
		thinkingEvent(sessionId, agentId, {
			agentId,
			id: thinkingId,
			text: "partial reason",
			startedAt: 100,
			endedAt: 0,
			done: false,
		}),
	);
	assert.equal(store.get(atoms.liveThinkingIdBySessionAtom)[sessionId], thinkingId);
	assert.equal(store.get(atoms.streamingThinkingByIdAtom)[thinkingId]?.text, "partial reason");
	assert.equal(store.get(atoms.streamingThinkingByIdAtom)[thinkingId]?.streaming, true);

	// done 先于 message：身份必须保留
	store.set(
		atoms.applySessionRuntimeEventAtom,
		thinkingEvent(sessionId, agentId, {
			agentId,
			id: thinkingId,
			text: "final reason",
			startedAt: 100,
			endedAt: 200,
			done: true,
		}),
	);
	assert.equal(store.get(atoms.liveThinkingIdBySessionAtom)[sessionId], thinkingId);
	assert.equal(store.get(atoms.streamingThinkingByIdAtom)[thinkingId]?.text, "final reason");
	assert.equal(store.get(atoms.streamingThinkingByIdAtom)[thinkingId]?.streaming, false);

	// History 仍无 thinking：继续保留
	store.set(atoms.applySessionRuntimeEventAtom, messageEvent(sessionId, agentId, [{ id: messageId, agentId, role: "assistant", text: "hi", timestamp: 1 }]));
	assert.equal(store.get(atoms.liveThinkingIdBySessionAtom)[sessionId], thinkingId);

	// History 写入 thinking 后才卸 live
	store.set(
		atoms.applySessionRuntimeEventAtom,
		messageEvent(sessionId, agentId, [
			{
				id: messageId,
				agentId,
				role: "assistant",
				text: "hi",
				thinking: "final reason",
				timestamp: 1,
			},
		]),
	);
	assert.equal(store.get(atoms.liveThinkingIdBySessionAtom)[sessionId], undefined);
	assert.equal(store.get(atoms.streamingThinkingByIdAtom)[thinkingId], undefined);
});

test("message before done releases live identity immediately on done", () => {
	const store = createStore();
	const sessionId = "s2";
	const agentId = "a2";
	const messageId = "m2";
	const thinkingId = `msg-thinking-${messageId}`;

	store.set(atoms.bindSessionRuntimeAtom, {
		sessionId,
		agentId,
		runtimeGeneration: 1,
		status: "running",
	});

	store.set(
		atoms.applySessionRuntimeEventAtom,
		thinkingEvent(sessionId, agentId, {
			agentId,
			id: thinkingId,
			text: "reason",
			startedAt: 1,
			endedAt: 0,
			done: false,
		}),
	);

	store.set(
		atoms.applySessionRuntimeEventAtom,
		messageEvent(sessionId, agentId, [
			{
				id: messageId,
				agentId,
				role: "assistant",
				text: "ok",
				thinking: "reason",
				timestamp: 1,
			},
		]),
	);
	// message 先到且已有 thinking：即可释放（即使尚未 done）
	assert.equal(store.get(atoms.liveThinkingIdBySessionAtom)[sessionId], undefined);

	// 再来一段 live（模拟新一轮）后 done，History 已有则 done 时释放
	store.set(
		atoms.applySessionRuntimeEventAtom,
		thinkingEvent(sessionId, agentId, {
			agentId,
			id: thinkingId,
			text: "reason2",
			startedAt: 2,
			endedAt: 3,
			done: false,
		}),
	);
	assert.equal(store.get(atoms.liveThinkingIdBySessionAtom)[sessionId], thinkingId);

	store.set(
		atoms.applySessionRuntimeEventAtom,
		messageEvent(sessionId, agentId, [
			{
				id: messageId,
				agentId,
				role: "assistant",
				text: "ok",
				thinking: "reason2",
				timestamp: 1,
			},
		]),
	);
	assert.equal(store.get(atoms.liveThinkingIdBySessionAtom)[sessionId], undefined);
});
