import assert from "node:assert/strict";
import test from "node:test";
import { IdleAgentReleaser, planIdleAgentRelease } from "../src/main/sessions/IdleAgentReleaser.ts";

/** 构造最小 AgentTab（按 shared/types/agent.ts 必填字段）。 */
function tab(id, status, extra = {}) {
	return {
		id,
		projectId: "p1",
		cwd: `/w/${id}`,
		title: id,
		status,
		createdAt: 1000,
		...extra,
	};
}

const NOW = 100_000;
const MIN = 60_000;

// ── 纯函数：planIdleAgentRelease ────────────────────────────────────────

test("开关关闭：不释放且清空计时（重新开启从零计时）", () => {
	const tabs = [tab("a", "idle"), tab("b", "idle")];
	const plan = planIdleAgentRelease(tabs, new Map([["a", NOW - 10 * MIN]]), NOW, {
		autoRelease: false,
		keepCount: 5,
		timeoutMs: MIN,
	});
	assert.deepEqual([...plan.toRelease], []);
	assert.equal(plan.idleSinceById.size, 0);
});

test("无 idle agent：不释放、不产生计时", () => {
	const plan = planIdleAgentRelease([tab("a", "running"), tab("b", "starting"), tab("c", "error")], new Map(), NOW, { autoRelease: true, keepCount: 5, timeoutMs: MIN });
	assert.deepEqual([...plan.toRelease], []);
	assert.equal(plan.idleSinceById.size, 0);
});

test("首次观测到 idle：记录起始时间，未超时不算候选", () => {
	const plan = planIdleAgentRelease([tab("a", "idle")], new Map(), NOW, {
		autoRelease: true,
		keepCount: 5,
		timeoutMs: 10 * MIN,
	});
	assert.deepEqual([...plan.toRelease], []);
	assert.equal(plan.idleSinceById.get("a"), NOW);
});

test("闲置未达阈值：即使超出保留数也不释放", () => {
	const prev = new Map([["a", NOW - MIN]]); // 刚满 1 分钟
	const plan = planIdleAgentRelease([tab("a", "idle"), tab("b", "idle")], prev, NOW + 5000, {
		autoRelease: true,
		keepCount: 1,
		timeoutMs: 2 * MIN,
	});
	assert.deepEqual([...plan.toRelease], []);
});

test("闲置超时但未超保留数：不释放", () => {
	const prev = new Map([
		["a", NOW - 10 * MIN],
		["b", NOW - 5 * MIN],
	]);
	const plan = planIdleAgentRelease([tab("a", "idle"), tab("b", "idle")], prev, NOW, {
		autoRelease: true,
		keepCount: 5,
		timeoutMs: MIN,
	});
	assert.deepEqual([...plan.toRelease], []);
});

test("超保留数：按闲置最久优先释放超出部分", () => {
	const prev = new Map([
		["oldest", NOW - 30 * MIN],
		["old", NOW - 20 * MIN],
		["mid", NOW - 15 * MIN],
		["recent", NOW - 8 * MIN],
	]);
	const plan = planIdleAgentRelease([tab("oldest", "idle"), tab("old", "idle"), tab("mid", "idle"), tab("recent", "idle")], prev, NOW, { autoRelease: true, keepCount: 2, timeoutMs: MIN });
	// 保留最「新」闲置的 2 个（recent/mid），释放最久的 2 个，顺序即闲置时长倒序
	assert.deepEqual([...plan.toRelease], ["oldest", "old"]);
});

test("聚焦会话豁免：即使闲置超时也不释放，且不占保留名额", () => {
	const prev = new Map([
		["focus", NOW - 60 * MIN],
		["other1", NOW - 50 * MIN],
		["other2", NOW - 40 * MIN],
	]);
	const plan = planIdleAgentRelease([tab("focus", "idle"), tab("other1", "idle"), tab("other2", "idle")], prev, NOW, { autoRelease: true, keepCount: 1, timeoutMs: MIN, focusedAgentId: "focus" });
	// focus 豁免；候选 = other1/other2，keepCount=1 → 释放闲置最久的 other1
	assert.deepEqual([...plan.toRelease], ["other1"]);
});

test("聚焦会话是唯一超时者：一个都不释放", () => {
	const plan = planIdleAgentRelease([tab("focus", "idle")], new Map([["focus", NOW - MIN]]), NOW, {
		autoRelease: true,
		keepCount: 1,
		timeoutMs: MIN,
		focusedAgentId: "focus",
	});
	assert.deepEqual([...plan.toRelease], []);
});

test("恢复 busy 后计时重置：再次 idle 从新时刻起算", () => {
	// a：上一轮 idle 起点是 30 分钟前；本轮已 running → 计时剔除
	const running = planIdleAgentRelease([tab("a", "running")], new Map([["a", NOW - 30 * MIN]]), NOW, {
		autoRelease: true,
		keepCount: 1,
		timeoutMs: MIN,
	});
	assert.equal(running.idleSinceById.has("a"), false);
	// 下一轮 a 又 idle：从本轮 NOW 起算，不继承 30 分钟前的旧起点
	const again = planIdleAgentRelease([tab("a", "idle")], running.idleSinceById, NOW, {
		autoRelease: true,
		keepCount: 1,
		timeoutMs: MIN,
	});
	assert.equal(again.idleSinceById.get("a"), NOW);
	assert.deepEqual([...again.toRelease], []);
});

test("已退出的 agent 计时被清理", () => {
	const plan = planIdleAgentRelease(
		[tab("a", "idle")],
		new Map([
			["a", NOW - MIN],
			["ghost", NOW - MIN],
		]),
		NOW,
		{ autoRelease: true, keepCount: 1, timeoutMs: MIN },
	);
	assert.equal(plan.idleSinceById.has("ghost"), false);
	assert.equal(plan.idleSinceById.has("a"), true);
});

test("坏配置兜底：0/负数/NaN 被钳制，不会误释放或崩溃", () => {
	// timeoutMs=0 → 钳到 1ms；但首轮刚记录起点（now===since），0>=1 不成立 → 不释放
	const plan1 = planIdleAgentRelease([tab("a", "idle")], new Map(), NOW, {
		autoRelease: true,
		keepCount: NaN,
		timeoutMs: 0,
	});
	assert.deepEqual([...plan1.toRelease], []);
	// keepCount=NaN → 兜底 5；6 个已超时 → 释放最久 1 个（idleSince 相同，稳定序取首个）
	const prev = new Map([
		["a", NOW - MIN],
		["b", NOW - MIN],
		["c", NOW - MIN],
		["d", NOW - MIN],
		["e", NOW - MIN],
		["f", NOW - MIN],
	]);
	const plan2 = planIdleAgentRelease([tab("a", "idle"), tab("b", "idle"), tab("c", "idle"), tab("d", "idle"), tab("e", "idle"), tab("f", "idle")], prev, NOW, { autoRelease: true, keepCount: NaN, timeoutMs: 0 });
	assert.deepEqual([...plan2.toRelease], ["a"]);
});

// ── IdleAgentReleaser：轮询器行为（mock 依赖 + mock 时钟） ──────────────

/** 构造带 mock 的 releaser。stopAgentById 默认 ok；命中 failAgents 返回失败。 */
function makeReleaser() {
	const state = {
		settings: { idleAgentAutoRelease: true, idleAgentKeepCount: 5, idleAgentTimeoutMin: 1 },
		tabs: [],
		focusedSessionId: undefined,
		failAgents: new Set(),
		stopped: [],
	};
	const coordinator = {
		getFocusedSession: () => state.focusedSessionId,
		getAgentId: () => (state.focusedSessionId ? "agent-focus" : undefined),
		stopAgentById: async (agentId) => {
			if (state.failAgents.has(agentId)) {
				return { ok: false, error: { code: "mock-fail" } };
			}
			state.stopped.push(agentId);
			return { ok: true };
		},
	};
	const agents = { list: () => state.tabs };
	const releaser = new IdleAgentReleaser(coordinator, agents, () => state.settings, undefined, 60_000);
	return { releaser, state };
}

test("releaser.sweep：开关关闭时不停止任何 agent", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const { releaser, state } = makeReleaser();
	state.settings.idleAgentAutoRelease = false;
	state.tabs = [tab("a", "idle"), tab("b", "idle")];
	await releaser.sweep();
	t.mock.timers.tick(10 * MIN);
	await releaser.sweep();
	assert.deepEqual(state.stopped, []);
});

test("releaser.sweep：首轮只记录计时，超时后才释放最久闲置的", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const { releaser, state } = makeReleaser();
	state.settings.idleAgentKeepCount = 1;
	state.tabs = [tab("a", "idle"), tab("b", "idle"), tab("c", "idle")];
	await releaser.sweep(); // t0：记录 idle 起点
	assert.deepEqual(state.stopped, []);
	t.mock.timers.tick(2 * MIN); // 拨快 2 分钟（idleAgentTimeoutMin=1 → 全部超时）
	await releaser.sweep();
	// 3 个全超时、保留 1 个（idleSince 相同，稳定序保留 c），释放 a/b
	assert.deepEqual([...state.stopped].sort(), ["a", "b"]);
	assert.equal(state.stopped.includes("c"), false);
});

test("releaser.sweep：聚焦会话豁免释放", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const { releaser, state } = makeReleaser();
	state.settings.idleAgentKeepCount = 1;
	state.focusedSessionId = "s1";
	state.tabs = [tab("agent-focus", "idle"), tab("agent-other", "idle"), tab("agent-x", "idle"), tab("agent-y", "idle")];
	await releaser.sweep();
	t.mock.timers.tick(2 * MIN);
	await releaser.sweep();
	// 候选 = other/x/y（3 个，focus 豁免），keepCount=1 → 释放 2 个最久闲置的
	assert.deepEqual([...state.stopped].sort(), ["agent-other", "agent-x"]);
	assert.equal(state.stopped.includes("agent-focus"), false);
});

test("releaser.sweep：stopAgentById 失败不抛出，其余照常释放", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const { releaser, state } = makeReleaser();
	state.settings.idleAgentKeepCount = 1;
	state.failAgents.add("a");
	state.tabs = [tab("a", "idle"), tab("b", "idle"), tab("c", "idle")];
	await releaser.sweep();
	t.mock.timers.tick(2 * MIN);
	await releaser.sweep();
	// a 释放失败（不抛异常），b 释放成功；c 是保留项
	assert.deepEqual([...state.stopped].sort(), ["b"]);
});

test("releaser.sweep：释放成功后触发 onAgentReleased 收尾回调", async (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const { state } = makeReleaser();
	const released = [];
	const withCallback = new IdleAgentReleaser(
		{
			getFocusedSession: () => state.focusedSessionId,
			getAgentId: () => undefined,
			stopAgentById: async (agentId) => {
				state.stopped.push(agentId);
				return { ok: true, value: { sessionId: "s", agentId, runtimeGeneration: 1 } };
			},
		},
		{ list: () => state.tabs },
		() => state.settings,
		undefined,
		60_000,
		(agentId, target) => released.push({ agentId, target }),
	);
	state.settings.idleAgentKeepCount = 1;
	state.tabs = [tab("a", "idle"), tab("b", "idle")];
	await withCallback.sweep(); // 记录起点
	t.mock.timers.tick(2 * MIN);
	await withCallback.sweep();
	assert.equal(released.length, 1);
	assert.equal(released[0].agentId, "a");
	assert.deepEqual(released[0].target, { sessionId: "s", agentId: "a", runtimeGeneration: 1 });
});

test("releaser.start/stop：幂等，stop 后不再轮询", async () => {
	const { releaser, state } = makeReleaser();
	releaser.start();
	releaser.start(); // 重复 start 不叠加定时器
	releaser.stop();
	releaser.stop(); // 重复 stop 安全
	state.tabs = [tab("a", "idle")];
	await releaser.sweep(); // 手动 sweep 仍可用（不依赖定时器）
	assert.ok(Array.isArray(state.stopped));
});
