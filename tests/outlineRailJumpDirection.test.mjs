import assert from "node:assert/strict";
import test from "node:test";

import { mergeOutlineRailItems, planRailJump } from "../src/renderer/src/components/session/timeline/outlineRailTicks.ts";

/**
 * 刻度点击的跳转目标（重写后的契约）。
 *
 * 反例（2026-11-25 真机，右侧刻度轴）：点任何**灰色**刻度都跳到同一个地方。
 * 旧 planRailJump 把占位刻度的目标替换成「已加载的最后一条已加载项」：
 *   const anchor = items[targetIndex].pending === true ? lastLoadedItem(items) : items[targetIndex];
 * 理由写的是「占位项没有投影 id」——错的，OutlineRailItem 带 entryId
 * （id 就是 outline-pending:<entryId>）。所以目标必须原样交出去。
 *
 * 为什么这条必须钉住：它是「定位错误」的书面成因，而界面上表现为「跳不动」，
 * 两者看起来完全不同，看不出是同一行代码。
 */
const item = (id, pending, entryId) => ({ id, role: "user", title: id, time: "", pending, entryId });

test("灰色刻度：跳的是它自己的 entryId，不是已加载段的末尾", () => {
	const items = [item("m1", false, "e1"), item("m2", false, "e2"), item("outline-pending:live", true, "live")];
	assert.deepEqual(planRailJump(items, "outline-pending:live"), { kind: "jump", id: "live" });
});

test("灰色刻度在已加载区间之前：同样跳自己（不再「先向上补页」）", () => {
	const items = [item("outline-pending:a", true, "a"), item("outline-pending:b", true, "b"), item("m1", false, "e1")];
	assert.deepEqual(planRailJump(items, "outline-pending:b"), { kind: "jump", id: "b" });
});

test("冷会话（全灰）：仍然给出真实 entryId，由 controller 一次定位取页", () => {
	const items = [item("outline-pending:a", true, "a"), item("outline-pending:b", true, "b")];
	assert.deepEqual(planRailJump(items, "outline-pending:b"), { kind: "jump", id: "b" });
});

test("白色刻度：统一交 entryId（跨后端稳定，投影 id 随 agentId 变）", () => {
	// 投影 id（_viewer-history-xxx）只在当前渲染进程有效；entryId 是会话文件里的条目 id，
	// 重启、换后端都不变。统一交 entryId，调用方 resolveJumpMessageIndex 两路都认。
	assert.deepEqual(planRailJump([item("m1", false, "e1"), item("m2", false, "e2")], "m1"), { kind: "jump", id: "e1" });
});

test("没有 entryId 的灰刻度：退回 pendingEntryIdOf 解析出的 id，不落到别处", () => {
	const items = [item("m1", false, "e1"), { id: "outline-pending:zz", role: "user", title: "", time: "", pending: true }];
	assert.deepEqual(planRailJump(items, "outline-pending:zz"), { kind: "jump", id: "zz" });
});

test("目录全量构建后，每一项都能跳到自己（没有任何一项被换成邻项）", () => {
	const directory = [
		{ entryId: "e1", title: "一" },
		{ entryId: "e2", title: "二" },
		{ entryId: "e3", title: "三" },
	];
	const merged = mergeOutlineRailItems([{ ...item("m3", false, "e3") }], directory);
	for (const railItem of merged) {
		const plan = planRailJump(merged, railItem.id);
		const expected = railItem.entryId ?? railItem.id;
		assert.equal(plan.id, expected, "刻度 " + railItem.id + " 跳向了 " + plan.id);
	}
});
