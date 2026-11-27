import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：导轨「共 N 条」与状态栏「N 轮」必须是同一个数。
 *
 * 事故（真机，2026-11-27）：面板「共 79 条」、状态栏「78 轮」，用户说「怎么有一个不存在的刻度」。
 * 截图里 78/79 号同时间戳、一条是另一条的前缀 —— 用户连发两条。
 *
 * 根因是两处各算：
 *   导轨 mergeOutlineRailItems：并集 = 目录 + 目录里没有的已加载项
 *   状态栏（旧）Math.max(countUserTurns(messages), directory.length)：折段计数 + 取较大值
 * 折段使状态栏少 1（连发只算一轮）；取 max 又会漏掉「目录里没有的已加载项」那一条。
 *
 * 现在的实现：状态栏直接调 mergeOutlineRailItems 取 length，一处可写。
 * 反例（能红）：把 sessionTurnCountOf 改回 Math.max 或 countUserTurns。
 */

const railModule = () => loadTsCommonJs("src/renderer/src/components/session/timeline/outlineRailTicks.ts");

test("导轨每条 user 一条；折段的 countUserTurns 在连发时少 1（差就是那个「多出来的刻度」）", () => {
	const { mergeOutlineRailItems } = railModule();
	const { countUserTurns } = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
	const burst = [
		{ id: "a", role: "user", title: "用 /skill:mobius 合作 跳转还是很慢呢", time: "" },
		{ id: "b", role: "user", title: "用 /skill:mobius 合作", time: "" },
	];
	assert.equal(mergeOutlineRailItems(burst, []).length, 2, "导轨：连发两条算两条");
	assert.equal(countUserTurns([{ role: "user" }, { role: "user" }]), 1, "折段：连发只算一轮");
});

test("状态栏口径在每种消息形态下都等于导轨的并集大小", () => {
	const { mergeOutlineRailItems, sessionTurnCountOf } = railModule();
	const loadedOf = (n) => Array.from({ length: n }, (_, i) => ({ id: "L" + i, entryId: "L" + i, role: "user", title: "t", time: "" }));

	const cases = [
		{ name: "一条 user，无目录", loaded: 1, dir: [] },
		{ name: "连发两条 user，无目录", loaded: 2, dir: [] },
		{ name: "已加载的都在目录里", loaded: 2, dir: ["L0", "L1"] },
		{ name: "窗口只有尾部，目录全量更大", loaded: 1, dir: ["d0", "d1", "d2", "d3", "d4"] },
		{ name: "刚发一条还没进索引（目录里没有它）", loaded: 2, dir: ["L0"] },
		{ name: "空", loaded: 0, dir: [] },
	];

	for (const c of cases) {
		const loaded = loadedOf(c.loaded);
		const merged = mergeOutlineRailItems(
			loaded,
			c.dir.map((entryId) => ({ entryId, title: "", time: "" })),
		).length;
		const bar = sessionTurnCountOf(loaded, c.dir);
		assert.equal(bar, merged, `${c.name}：状态栏 ${bar} vs 导轨 ${merged}`);
	}
});

test("「窗口只有尾部」时不能用 max 近似（max 数不到目录里没有的那一条）", () => {
	const { mergeOutlineRailItems, sessionTurnCountOf } = railModule();
	const loaded = [{ id: "L0", entryId: "L0", role: "user", title: "t", time: "" }];
	const dir = ["d0", "d1", "d2", "d3", "d4"];
	const merged = mergeOutlineRailItems(
		loaded,
		dir.map((entryId) => ({ entryId, title: "", time: "" })),
	).length;
	assert.equal(merged, 6, "并集 = 5 条目录 + 1 条不在目录里的已加载");
	assert.equal(sessionTurnCountOf(loaded, dir), 6, "状态栏要跟并集，不是 max(1,5)=5");
	assert.notEqual(Math.max(loaded.length, dir.length), merged, "max 在这里少 1 —— 这就是不能近似的理由");
});
