import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 回归：「加载更多对话」按钮出现但点了没反应（2026-10 现场）。
 *
 * 现场证据（app-2026-10-31.log，同一 agent 连续 6 次缓存命中、间隔 300ms、字段逐字相同）：
 *   {"start":0,"pos":1,"pageCount":1,"nextBeforeEntryId":"734fb2ee","nextBefore":990}
 * 缓存页永远只有 1 条、锚点永远是同一个 entryId —— 续页原地踏步。
 *
 * 根因：窗口首条是压缩摘要卡片（无 entryId）时，锚点回退去**整个 list** 里找第一条带
 * entryId 的消息，命中的正是 list[pos]（本次请求的锚点自身），nextBefore 于是恒等于
 * 上一页的值。正确边界：回退只能在 [0, start) 里倒序取最近的一条；取不到就交回文件路径。
 */

const SESSION_PATH = "C:/project/sessions/s.jsonl";

function createManager(messages, positions) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set("agent-live", {
		tab: {
			id: "agent-live",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			sessionPath: SESSION_PATH,
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	});
	manager.messages.set("agent-live", messages);
	manager.sessionHistoryReader = {
		resolveEntryPosition: async (_path, entryId) => positions[entryId],
		resolveEntryIdAtPosition: async (_path, position) => Object.keys(positions).find((id) => positions[id] === position),
		getActiveEntryCount: async () => 1000,
		getSessionIndexVersion: async () => "index-1",
	};
	return manager;
}

function msg(role, entryId) {
	return { role, content: entryId ?? "", meta: entryId ? { entryId } : {} };
}

test("窗口首条无 entryId 且缓存里无更早条目：返回 null 交给文件路径（旧写法会原地踏步）", async () => {
	// pos=1、start=0、page 只有 list[0]（压缩摘要卡片，无 entryId）——现场复刻。
	const messages = [msg("assistant"), msg("user", "734fb2ee"), msg("assistant", "a2"), msg("user", "u3")];
	const manager = createManager(messages, { "734fb2ee": 990, a2: 991, u3: 992 });
	const page = await manager.tryReadRuntimeTurnPage(SESSION_PATH, "agent-live", { beforeEntryId: "734fb2ee", turnCount: 3 });
	assert.equal(page, null, "取不到更早锚点时必须交回文件路径，不得返回原地踏步的同一页");
});

test("窗口首条无 entryId 但 page 内有带 entryId 的消息：用它当锚点，续页继续往前推进", async () => {
	// page = [摘要卡片, user(anchorA)]，锚点应前进到 anchorA。
	const messages = [msg("assistant"), msg("user", "anchorA"), msg("assistant", "a1"), msg("user", "u2"), msg("assistant", "a2")];
	const manager = createManager(messages, { anchorA: 500, a1: 501, u2: 502, a2: 503 });
	const page = await manager.tryReadRuntimeTurnPage(SESSION_PATH, "agent-live", { beforeEntryId: "a2", turnCount: 2 });
	assert.ok(page, "缓存命中应返回一页");
	assert.equal(page.nextBeforeEntryId, "anchorA");
	assert.equal(page.nextBefore, 500);
	assert.ok(page.messages.length > 0);
});

test("回退锚点在 page 之前倒序取最近的一条，不会跳过中间内容", async () => {
	// [older, closest, card(无 entryId), target]：start=2，page=[card]，
	// 回退必须取 closest；正序扫描会取到更早的 older，跳过 closest 那一轮。
	const messages = [msg("user", "older"), msg("assistant", "closest"), msg("user"), msg("user", "target")];
	const manager = createManager(messages, { older: 100, closest: 101, target: 300 });
	const page = await manager.tryReadRuntimeTurnPage(SESSION_PATH, "agent-live", { beforeEntryId: "target", turnCount: 1 });
	assert.ok(page, "缓存命中应返回一页");
	assert.equal(page.nextBeforeEntryId, "closest", "倒序扫描必须取离窗口最近的条目");
	assert.equal(page.nextBefore, 101);
});
