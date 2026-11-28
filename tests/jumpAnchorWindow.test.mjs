import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 旧实现是「转译 + vm，require 一律给 {}」：turnRenderWindow 新增本地 import 后，用例整片
 * 报「x is not a function」（2026-11-26）。统一走 createTsSandbox，按源文件目录解析依赖。
 */
const w = createTsSandbox()("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

/** 造 n 个 agent-run，每个带一条 history 消息，entryId 为 e<i>。 */
function runs(n) {
	return Array.from({ length: n }, (_, i) => ({
		kind: "agent-run",
		id: "run" + i,
		items: [{ kind: "message", message: { id: "_v-history-e" + i, meta: { entryId: "e" + i } } }],
	}));
}

test("锚点命中：窗口是围绕目标的 1 前 3 后，长度为 5", () => {
	// 只判「含目标」域太宽：返回 11 轮也算含。窗口大小是产品语义（铺满一屏但不拖慢挂载），
	// 必须钉死。反例（pr2 2026-11-25 实测）：锚点分支改成 items.slice(0, anchorIndex + 1)，
	// 返回 11 轮，只判 includes 的版本照样全绿。
	const items = runs(40);
	const win = w.resolveAnchoredTurnWindow(items, 3, "e20");
	// 双向：锚点上下各 JUMP_WINDOW_RUNS_EACH_SIDE(6) 轮。
	// 为什么不再是「1 前 3 后」：那 5 轮内容高 858px 恰好等于视口 858px（2026-11-25 日志），
	// scrollTop 被钳在 0，目标滚不到视口顶 → 24 帧后 give-up → 从第 1 条往下全跳不动。
	assert.equal(w.JUMP_WINDOW_RUNS_EACH_SIDE, 6, "每侧轮数是判据的一部分，改动必须同步这里");
	const ids = win.map((r) => r.id);
	assert.equal(ids[0], "run14", "向上 6 轮：run20 - 6");
	assert.equal(ids[ids.length - 1], "run26", "向下 6 轮：run20 + 6");
	assert.ok(win.length >= 11, "窗口必须显著大于 5 轮（可滚动的必要条件是内容高于视口），实际 " + win.length);
	assert.ok(win.length <= 13, "但也不能无界，上限 = 2×6+1，实际 " + win.length);
});

test("锚点未命中：窗口必须有界，不得返回全量（722 轮全挂 DOM 会卡死）", () => {
	const items = runs(200);
	const win = w.resolveAnchoredTurnWindow(items, 3, "e-nonexistent");
	// 上界必须是「窗口轮数」本身，不能只写 < items.length：那样返回 199 条也通过，
	// 而 199 条正是「722 轮全挂 DOM」那个卡死的前身。域要窄到 windowTurns 这个量。
	assert.ok(win.length <= 3, "未命中时窗口必须收窄到 windowTurns=3，实际 " + win.length);
	assert.ok(win.length < items.length, "未命中时不得返回全量：" + win.length + " / " + items.length);
	assert.ok(win.length > 0, "也不能返回空（会黑屏）");
});

test("无锚点：贴底窗口只保留尾部 N 轮", () => {
	const items = runs(50);
	const win = w.resolveAnchoredTurnWindow(items, 3, null);
	assert.equal(win.length, 3, "windowTurns=3 时应只剩 3 轮");
	assert.equal(win[win.length - 1].id, "run49", "保留的是尾部");
});

test("无锚点且轮数不足窗口：原样返回（引用不变，便于 memo）", () => {
	const items = runs(2);
	const win = w.resolveAnchoredTurnWindow(items, 10, undefined);
	assert.equal(win, items, "不足窗口时应返回原数组引用");
});
test("四路 id 匹配都在：搜索给的原始条目 id 必须能命中渲染项", () => {
	// 隐式契约（pr2 2026-11-25 指出）：主进程 sessionFindMatches 把 message.id（会话文件原始条目 id）
	// 交给渲染层，渲染层必须能拿它找到所在轮。这条契约没有任何断言守着——
	// 哪天 SessionHistoryReader 改了 id 生成（加前缀、换 uuid 源），搜索跳转会静默全断，
	// 而每一层单独看都对。
	const items = [
		{
			kind: "agent-run",
			id: "run0",
			items: [
				{ kind: "message", message: { id: "_v-history-x", meta: { entryId: "x" } } },
				{ kind: "message", message: { id: "y" } },
				{ kind: "tool-group", id: "z" },
			],
		},
	];
	assert.equal(w.findAgentRunIndexByItemId(items, "x"), 0, "原始条目 id 走 meta.entryId 那一路");
	assert.equal(w.findAgentRunIndexByItemId(items, "_v-history-x"), 0, "投影 id 走 record/message.id 那一路");
	assert.equal(w.findAgentRunIndexByItemId(items, "y"), 0, "message.id 那一路");
	assert.equal(w.findAgentRunIndexByItemId(items, "z"), 0, "record.id 那一路（工具组）");
	assert.equal(w.findAgentRunIndexByItemId(items, "nope"), -1, "不存在的 id 必须 -1");
});
