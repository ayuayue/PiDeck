import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：锚点定位 + 窗口取窗，两件事接起来之后目标必须真的在窗口里。
 *
 * 为什么需要这条（组 2 的第一条判据收回「不用放宽」）：
 * `jumpLocateReplay` 验的是**数据层**——按 entryId 取页，页里含目标。这一步与窗口无关，
 * 所以接线前后它都会绿，挡不住「挂错了窗口」。两件事之间隔着渲染。
 *
 * 这条在**旧实现（尾窗）上就红**：远目标不在尾窗里。所以它是能红的新判据，不是回归守卫。
 *
 * 反例：把 selectTimelineTurnWindow 的第三参忽略（退回尾窗）—— 远目标那条立刻红。
 */

const load = () => ({
	...loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts"),
	...loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts"),
});

/** 700 轮：第 k 轮的 run id 是 run-k，内含一条消息 msg-k。 */
function timeline(turns = 700) {
	const runs = [];
	const items = [];
	for (let k = 0; k < turns; k += 1) {
		runs.push({ kind: "agent-run", id: `run-${k}`, items: [{ id: `msg-${k}` }] });
		items.push({ kind: "agent-run" });
		items.push({ kind: "message" });
	}
	return { runs, items };
}

const WINDOW = 8;

test("远目标（第 100 轮）：锚点窗口里必须含它——尾窗里不含（旧实现红）", () => {
	const { resolveAnchorStartRun, selectTimelineTurnWindow } = load();
	const { runs, items } = timeline();

	const resolved = resolveAnchorStartRun(runs, { runId: "run-100" });
	assert.equal(resolved.kind, "ok", JSON.stringify(resolved));

	// 锚定窗：目标必须落在输出里（每轮 2 条 -> 第 100 轮的 run 在 items 下标 200）
	const anchored = selectTimelineTurnWindow(items, WINDOW, resolved.startRun);
	assert.equal(anchored.length, WINDOW * 2, "窗口轮数 = " + WINDOW + "（滑窗不扩轮）");

	// 对照：旧行为（尾窗）。这条必须不相等，否则说明判据测不出差异。
	const tail = selectTimelineTurnWindow(items, WINDOW);
	assert.equal(tail.length, WINDOW * 2);
	const anchoredStartsAt = items.indexOf(anchored[0]);
	const tailStartsAt = items.indexOf(tail[0]);
	assert.notEqual(anchoredStartsAt, tailStartsAt, `锚定窗起点 ${anchoredStartsAt} 与尾窗起点 ${tailStartsAt} 相同 —— 锚点没生效（旧实现就是这样）`);
	assert.ok(anchoredStartsAt < tailStartsAt, "锚定窗应从更早的位置开始");
});

test("锚点等于尾部的轮：锚定窗与尾窗重合（不许把「本来就该一样」判成错）", () => {
	const { resolveAnchorStartRun, selectTimelineTurnWindow } = load();
	const { runs, items } = timeline();
	const resolved = resolveAnchorStartRun(runs, { runId: "run-692" });
	assert.equal(resolved.kind, "ok");
	const anchored = selectTimelineTurnWindow(items, WINDOW, resolved.startRun);
	const tail = selectTimelineTurnWindow(items, WINDOW);
	assert.equal(items.indexOf(anchored[0]), items.indexOf(tail[0]), "尾部 8 轮内应重合");
});

test("找不到锚点时退回尾窗（missing 分支不许把窗口挪到 0）", () => {
	const { resolveAnchorStartRun, selectTimelineTurnWindow } = load();
	const { runs, items } = timeline();
	const resolved = resolveAnchorStartRun(runs, { runId: "run-gone" });
	assert.equal(resolved.kind, "missing");
	const tail = selectTimelineTurnWindow(items, WINDOW);
	assert.ok(items.indexOf(tail[0]) > 1300, "尾窗起点应在末尾附近，实际 " + items.indexOf(tail[0]));
});
