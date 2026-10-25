/**
 * 过程组节点预算的健全性（渲染进程 DOM 规模回归）。
 *
 * 背景（2026-10 内存排查，真实数据）：某会话单轮 611 条消息、其中 123 条中间回复
 * 把这一轮切成 123 个过程组。渲染层实际观察到 5 秒内 DOM 从 1517 涨到 22608，
 * 并在约 20 分钟里稳定维持 2.2–2.5 万节点、渲染进程 RSS 峰值 1.37GB。
 *
 * 为什么轮数窗口拦不住：turnRenderWindow 只按「轮」裁剪，这个会话总共才 4 轮，
 * 保留 3 轮就留下了 1071/1076 条——裁剪几乎不生效。
 *
 * 本测试钉住两条不变量：
 * 1. 节点预算与成员预算都必须是有限正数（预算被误改成 Infinity/0 就等于取消保护）；
 * 2. 预算必须按「节点」计——中间回复与组头都算节点，不能只对工具条目计数，
 *    否则「一轮里大量中间回复」会绕过预算（正是本次踩到的形态）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { boundMountedSteps, TIMELINE_MOUNTED_STEP_LIMIT, PROCESS_GROUP_MEMBER_LIMIT, PROCESS_FOLD_NODE_LIMIT } = loadTsCommonJs("src/renderer/src/components/session/timeline/turnMountBudget.ts");

const items = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));

test("三个挂载预算都必须是有限正数", () => {
	for (const [name, value] of [
		["TIMELINE_MOUNTED_STEP_LIMIT", TIMELINE_MOUNTED_STEP_LIMIT],
		["PROCESS_GROUP_MEMBER_LIMIT", PROCESS_GROUP_MEMBER_LIMIT],
		["PROCESS_FOLD_NODE_LIMIT", PROCESS_FOLD_NODE_LIMIT],
	]) {
		assert.ok(Number.isFinite(value) && value > 0, `${name} 必须是有限正数，当前为 ${value}（预算失效=DOM 无上限）`);
	}
});

test("boundMountedSteps: 超出预算时只挂尾部，并给出「更早 N 条」计数", () => {
	const source = items(500);
	const windowed = boundMountedSteps(source, 120);
	assert.equal(windowed.items.length, 120);
	assert.equal(windowed.hiddenCount, 380);
	// 保留的必须是尾部（最新内容优先），而不是头部
	assert.equal(windowed.items[0].id, "n380");
	assert.equal(windowed.items.at(-1).id, "n499");
});

test("boundMountedSteps: 刚好等于预算时不做裁剪（保持原引用，便于 memo）", () => {
	const source = items(120);
	const windowed = boundMountedSteps(source, 120);
	assert.equal(windowed.hiddenCount, 0);
	assert.equal(windowed.items, source);
});

test("boundMountedSteps: 每档只多挂一批，超出后走早退返回原引用", () => {
	const source = items(500);
	const tiers = [
		[0, 120, 380],
		[1, 240, 260],
		[2, 360, 140],
		[3, 480, 20],
	];
	for (const [batches, mounted, hidden] of tiers) {
		const windowed = boundMountedSteps(source, 120, batches === 0 ? undefined : { anchor: 500, batches });
		assert.equal(windowed.items.length, mounted);
		assert.equal(windowed.hiddenCount, hidden);
		assert.notEqual(windowed.items, source);
	}
	const full = boundMountedSteps(source, 120, { anchor: 500, batches: 4 });
	assert.equal(full.items, source);
	assert.equal(full.hiddenCount, 0);
	assert.equal(source.length, 500, "不改原数组");
});

test("回归：单轮 123 个过程组 × 每组上限，必须被预算收敛到有限 DOM", () => {
	// 模拟实测形态：一轮 123 个节点（中间回复/组头），不是 123 个工具条目。
	// 节点预算必须对「非工具条目」同样生效，否则这类轮次完全绕过保护。
	const nodes = items(123);
	const windowed = boundMountedSteps(nodes, PROCESS_FOLD_NODE_LIMIT);
	assert.ok(windowed.items.length <= PROCESS_FOLD_NODE_LIMIT, "节点数必须受 PROCESS_FOLD_NODE_LIMIT 约束");
	assert.ok(windowed.hiddenCount > 0, "123 个节点超过 120 预算时必须给出折叠入口");

	// 单个过程组成员（实测单组最多 305 条工具结果）同样受成员预算约束
	const members = items(305);
	const bounded = boundMountedSteps(members, PROCESS_GROUP_MEMBER_LIMIT);
	assert.ok(bounded.items.length <= PROCESS_GROUP_MEMBER_LIMIT);
	assert.equal(bounded.items.length + bounded.hiddenCount, 305, "隐藏数与被挂载数之和必须等于总数（不静默丢内容）");
});
