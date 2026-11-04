import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// ACP 重放窗口（docs/acp-replay-batching-plan.md Phase 2）：条数预算优先、轮边界对齐。
const { resolveAcpWindowStart, ACP_WINDOW_MAX_MESSAGES, ACP_WINDOW_MAX_TURNS } = loadTsCommonJs("src/main/acp/acpReplayWindow.ts");

const user = (index) => ({ id: `u${index}`, role: "user", text: "q" });
const assistant = (index) => ({ id: `a${index}`, role: "assistant", text: "a" });
const tool = (index) => ({ id: `t${index}`, role: "tool", text: "r" });

/** 造 n 轮，每轮 = 1 条 user + 若干条 tool + 1 条 assistant。 */
function turns(count, toolsPerTurn) {
	const messages = [];
	for (let turn = 0; turn < count; turn += 1) {
		messages.push(user(turn));
		for (let toolIndex = 0; toolIndex < toolsPerTurn; toolIndex += 1) messages.push(tool(turn * 100 + toolIndex));
		messages.push(assistant(turn));
	}
	return messages;
}

test("empty session has an empty window", () => {
	assert.equal(resolveAcpWindowStart([]), 0);
});

test("short histories keep the whole window", () => {
	const messages = turns(3, 2); // 12 条
	assert.equal(resolveAcpWindowStart(messages), 0);
});

test("dense turns are cut by the message budget, not by turn count", () => {
	// 6 轮 × 40 条 = 240 条：9 轮上限吃不满，按 100 条预算从尾部对齐到轮起点
	const messages = turns(6, 38); // 每条轮 40 条
	const start = resolveAcpWindowStart(messages);
	assert.ok(messages.length - start >= ACP_WINDOW_MAX_MESSAGES, "窗口至少覆盖条数预算");
	assert.ok(messages.length - start <= ACP_WINDOW_MAX_MESSAGES + 40, "不应多带一整轮以上");
	assert.equal(messages[start].role, "user", "窗口必须停在轮起点");
});

test("sparse histories are cut by the turn limit", () => {
	const messages = turns(20, 0); // 每轮 2 条，共 40 条
	const start = resolveAcpWindowStart(messages);
	assert.equal(start, 20 * 2 - ACP_WINDOW_MAX_TURNS * 2);
	assert.equal(messages[start].role, "user");
});

test("a window never starts mid-turn", () => {
	const messages = turns(8, 30);
	for (const budget of [1, 50, 100, 150, 400]) {
		const start = resolveAcpWindowStart(messages, { maxMessages: budget });
		assert.equal(messages[start]?.role, "user", `budget=${budget} 时窗口起点必须是轮起点`);
	}
});

test("projection without any turn structure falls back to a tail slice", () => {
	const messages = Array.from({ length: 150 }, (_, index) => tool(index));
	const start = resolveAcpWindowStart(messages);
	assert.equal(start, 50);
	assert.equal(messages.length - start, ACP_WINDOW_MAX_MESSAGES);
});

test("consecutive user messages count as one turn (same rule as countUserTurns)", () => {
	const messages = [user(1), user(2), assistant(3), user(4), assistant(5)];
	// 两轮：第一条 user 起一轮，第二条 user 并入同一轮
	assert.equal(resolveAcpWindowStart(messages, { maxMessages: 1, maxTurns: 1 }), 3);
});
