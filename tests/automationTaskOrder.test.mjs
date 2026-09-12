/**
 * 定时任务列表排序稳定性（2026-09-12 用户反馈「点了一个像是另一个被点击了」）：
 * 排序键必须是创建后不再变化的字段。早先按 updatedAt 降序时，用户点开关 →
 * updateTask bump updatedAt → 该卡片跳回首位、另一张卡占回原位，观感即「点错了对象」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/automation-atoms.ts");

/** 任务形状只需排序关心的字段 + 列表渲染用到的最小字段。 */
function task({ id, createdAt, updatedAt, enabled = true }) {
	return {
		id,
		name: "时间",
		projectId: "p",
		prompt: "输出当前时间",
		schedule: { type: "cron", expression: "* * * * *" },
		enabled,
		budget: { timeoutMs: 60000 },
		createdAt,
		updatedAt,
	};
}

function snapshot(tasks) {
	return {
		revision: 1,
		settings: { maxConcurrentRuns: 1, historyLimit: 200 },
		tasks,
		runs: [],
	};
}

/** vm realm 下的数组跨 realm，禁用 deepStrictEqual，比较拼出的字符串。 */
function order(store) {
	return store
		.get(atoms.automationTasksAtom)
		.map((t) => t.id)
		.join(",");
}

test("任务列表按 createdAt 降序：新建的排最前", () => {
	const store = createStore();
	store.set(
		atoms.automationSnapshotAtom,
		snapshot([
			task({ id: "old", createdAt: 1000, updatedAt: 9000 }),
			task({ id: "new", createdAt: 2000, updatedAt: 3000 }),
		]),
	);
	assert.equal(order(store), "new,old", "createdAt 更新的在前，与 updatedAt 无关");
});

test("停用/编辑 bump updatedAt 不换位：顺序不随 updatedAt 变化", () => {
	const store = createStore();
	const older = task({ id: "a", createdAt: 1000, updatedAt: 5000 });
	const newer = task({ id: "b", createdAt: 2000, updatedAt: 3000 });
	store.set(atoms.automationSnapshotAtom, snapshot([older, newer]));
	assert.equal(order(store), "b,a");

	// 用户点了列表第二张卡（a）的「停用」：主进程 updateTask 只改 enabled + updatedAt
	store.set(
		atoms.automationSnapshotAtom,
		snapshot([{ ...older, enabled: false, updatedAt: 99999 }, newer]),
	);
	assert.equal(order(store), "b,a", "卡片不因 updatedAt 被顶到首位（换位观感即「点了另一个」）");

	// 再停用另一张：顺序同样不变
	store.set(
		atoms.automationSnapshotAtom,
		snapshot([
			{ ...older, enabled: false, updatedAt: 99999 },
			{ ...newer, enabled: false, updatedAt: 100000 },
		]),
	);
	assert.equal(order(store), "b,a");
});

test("createdAt 相同时以 id 兜底，保证顺序确定", () => {
	const store = createStore();
	store.set(
		atoms.automationSnapshotAtom,
		snapshot([
			task({ id: "zzz", createdAt: 1000, updatedAt: 1 }),
			task({ id: "aaa", createdAt: 1000, updatedAt: 2 }),
		]),
	);
	assert.equal(order(store), "aaa,zzz");
});
