import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：跳转挂载量必须是 O(1) —— 与目标离尾部多远无关。
 *
 * 用户原话：「跳转还是很慢，我想要 O(1)，而且跳转很卡」。
 *
 * 旧模型是尾窗（sliceLastAgentRuns 只留最后 N 轮）：「让目标进入窗口」等于把窗口扩到
 * 「目标到末尾」的全部轮数，挂载量随距离线性增长。实测 700 轮 / 每轮 18 条：
 *   跳第 690 轮挂 198 条、第 500 轮 3618 条、第 100 轮 10818 条、第 0 轮 12600 条（≈6.8MB）
 * 所以「卡」不是取页问题（32 轮取页已经把数据量压到 1.2MB），是挂载量问题。
 *
 * 锚定窗口（sliceAgentRunWindowFrom / selectTimelineTurnWindow 第三参）把「起点」变成独立参数：
 * 挂载轮数恒为 windowTurns，与起点无关。
 *
 * 反例（能红）：让 selectTimelineTurnWindow 忽略第三参、退回尾窗 —— 四次长度不再相等。
 */

const windowModule = () => loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

/** 700 轮、每轮 18 条：总 12600 条，接近真会话（12581 条 / 694 轮）。 */
function syntheticTimeline(turns = 700, perTurn = 18) {
	const items = [];
	for (let t = 0; t < turns; t += 1) {
		items.push({ kind: "agent-run" });
		for (let k = 1; k < perTurn; k += 1) items.push({ kind: "message" });
	}
	return items;
}

test("锚定窗口的挂载条数与起点无关（O(1)，不是尾窗的线性）", () => {
	const { selectTimelineTurnWindow } = windowModule();
	const items = syntheticTimeline();
	const WINDOW_TURNS = 8;
	const lengths = [0, 100, 500, 690].map((start) => selectTimelineTurnWindow(items, WINDOW_TURNS, start).length);
	const expected = WINDOW_TURNS * 18;
	for (const [index, length] of lengths.entries()) {
		assert.equal(length, expected, `起点 ${[0, 100, 500, 690][index]} 挂载 ${length} 条，应为 ${expected}（窗口 ${WINDOW_TURNS} 轮 × 18 条）`);
	}
	assert.equal(new Set(lengths).size, 1, "四个起点必须给出同一个长度：" + lengths.join(" / "));
});

test("对照：尾窗（不给起点）随目标距离线性增长 —— 这就是旧行为", () => {
	const { sliceLastAgentRuns } = windowModule();
	const items = syntheticTimeline();
	const nearTail = sliceLastAgentRuns(items, 11).length;
	const wholeSession = sliceLastAgentRuns(items, 701).length;
	assert.ok(wholeSession > nearTail * 10, `尾窗：11 轮 ${nearTail} 条 vs 701 轮 ${wholeSession} 条，应差一个数量级`);
});

test("起点超出总轮数时返回空，不抛、不越界", () => {
	const { selectTimelineTurnWindow } = windowModule();
	const items = syntheticTimeline(3, 4);
	assert.equal(selectTimelineTurnWindow(items, 8, 99).length, 0);
	assert.equal(selectTimelineTurnWindow(items, 8, -5).length, 12, "负数起点夹到 0：3 轮 × 4 条");
});
