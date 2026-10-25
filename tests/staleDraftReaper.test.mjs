import assert from "node:assert/strict";
import test from "node:test";
import { StaleDraftReaper, isReapableStaleDraft } from "../src/main/sessions/StaleDraftReaper.ts";

/** 构造最小 catalog entry（按 SessionCatalogEntry 必填字段）。 */
function entry(id, extra = {}) {
	return {
		id,
		projectId: "p1",
		title: "Untitled",
		source: "pi",
		environment: "native",
		status: "draft",
		createdAt: 1000,
		updatedAt: 1000,
		...extra,
	};
}

const NOW = 100_000;
const MIN = 60_000;

// ── 纯函数：isReapableStaleDraft ────────────────────────────────────────

test("零内容 pi 草稿闲置超时 → 可清理", () => {
	assert.equal(isReapableStaleDraft(entry("a", { updatedAt: NOW - 31 * MIN }), NOW, { staleMs: 30 * MIN }), true);
});

test("非 draft / 非 pi 后端 → 不可清理", () => {
	assert.equal(isReapableStaleDraft(entry("a", { status: "active" }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { backend: "dsh" }), NOW, {}), false);
	// DSH 中间态（pi 后端但已带 dshSessionId）同样豁免
	assert.equal(isReapableStaleDraft(entry("a", { dshSessionId: "d1" }), NOW, {}), false);
});

test("匿名/引导页会话（noSession）→ 不可清理", () => {
	assert.equal(isReapableStaleDraft(entry("a", { noSession: true }), NOW, {}), false);
});

test("已落盘或激活过（filePath/piSessionId）→ 不可清理", () => {
	assert.equal(isReapableStaleDraft(entry("a", { filePath: "/w/s.jsonl" }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { piSessionId: "pi-1" }), NOW, {}), false);
});

test("用户投入信号：命名/选模型/预选配置 → 不可清理", () => {
	assert.equal(isReapableStaleDraft(entry("a", { titleOrigin: "manual" }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { titleOrigin: "legacy" }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { model: { provider: "x", id: "m" } }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { permissionPreset: "read-only" }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { agentPreset: "code" }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { proxy: "on" }), NOW, {}), false);
	assert.equal(isReapableStaleDraft(entry("a", { importedSourceId: "src-1" }), NOW, {}), false);
});

test("闲置未超时 → 不可清理（默认 30 分钟阈值）", () => {
	assert.equal(isReapableStaleDraft(entry("a", { updatedAt: NOW - 29 * MIN }), NOW, {}), false);
	// 恰好到达阈值边界算超时
	assert.equal(isReapableStaleDraft(entry("a", { updatedAt: NOW - 30 * MIN }), NOW, {}), true);
});

test("正聚焦 / 有活绑定 → 不可清理", () => {
	assert.equal(isReapableStaleDraft(entry("a", { updatedAt: NOW - 31 * MIN }), NOW, { focusedSessionId: "a" }), false);
	assert.equal(isReapableStaleDraft(entry("a", { updatedAt: NOW - 31 * MIN }), NOW, { hasLiveRuntime: true }), false);
});

// ── 集成：StaleDraftReaper.sweep ────────────────────────────────────────

function makeHarness(entries, { focused, live = new Set(), failIds = new Set() } = {}) {
	const removed = [];
	const reapedProjects = [];
	const catalog = {
		listEntries: () => entries,
		removeWithDescendants: async (id) => {
			if (failIds.has(id)) throw new Error("boom");
			const victim = entries.findIndex((e) => e.id === id);
			if (victim < 0) return [];
			entries.splice(victim, 1);
			removed.push(id);
			return [id];
		},
	};
	const runtime = {
		getFocusedSession: () => focused,
		hasLiveRuntime: (id) => live.has(id),
	};
	const reaper = new StaleDraftReaper(
		catalog,
		runtime,
		(projectIds) => reapedProjects.push(...projectIds),
		undefined,
		5 * 60_000,
		() => NOW,
	);
	return { reaper, removed, reapedProjects, entries };
}

test("sweep：只删零内容闲置草稿，豁免项保留，并回传受影响项目", async () => {
	const stale = entry("stale", { updatedAt: NOW - 31 * MIN });
	const fresh = entry("fresh", { updatedAt: NOW });
	const named = entry("named", { updatedAt: NOW - 31 * MIN, titleOrigin: "manual" });
	const focusedOne = entry("focused", { updatedAt: NOW - 31 * MIN });
	const liveOne = entry("live", { updatedAt: NOW - 31 * MIN, projectId: "p2" });
	const { reaper, removed, reapedProjects, entries } = makeHarness([stale, fresh, named, focusedOne, liveOne], { focused: "focused", live: new Set(["live"]) });

	const ids = await reaper.sweep();

	assert.deepEqual(ids, ["stale"]);
	assert.deepEqual(removed, ["stale"]);
	// 广播按 projectId 去重回传（本次只删了 p1 的）
	assert.deepEqual(reapedProjects, ["p1"]);
	assert.deepEqual(
		entries.map((e) => e.id),
		["fresh", "named", "focused", "live"],
	);
});

test("sweep：无可清理项时不触发广播", async () => {
	const { reaper, reapedProjects } = makeHarness([entry("a", { updatedAt: NOW })]);
	const ids = await reaper.sweep();
	assert.deepEqual(ids, []);
	assert.deepEqual(reapedProjects, []);
});

test("sweep：单条删除失败不阻塞其余清理", async () => {
	const bad = entry("bad", { updatedAt: NOW - 31 * MIN });
	const good = entry("good", { updatedAt: NOW - 31 * MIN });
	const { reaper, removed, reapedProjects } = makeHarness([bad, good], { failIds: new Set(["bad"]) });

	const ids = await reaper.sweep();

	assert.deepEqual(ids, ["good"]);
	assert.deepEqual(removed, ["good"]);
	assert.deepEqual(reapedProjects, ["p1"]);
});

test("start/stop 幂等：重复调用不叠加定时器", () => {
	const { reaper } = makeHarness([]);
	reaper.start();
	reaper.start();
	reaper.stop();
	reaper.stop();
});
