import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：取一窗的**下标读取次数**必须与起点无关（O(1) 定位）。
 *
 * 布尔格上的莫比乌斯反演，落到一条链上就是差分：区间和 ↔ 端点差。
 * 尾窗是「从尾部数 N 轮」——累积量；反解「第 k 轮从哪开始」时，旧实现每次从头数一遍，
 * 代价随 k 线性。实测（700 轮 / 每轮 18 条，取 8 轮）：起点 0 读 289 个下标，
 * 起点 350 读 6589，2000 轮起点 1000 读 18289 —— 返回值一直是那 144 条，
 * 多出来的全是「数到起点」的白工。
 *
 * 改成端点表（buildAgentRunStarts，O(n) 一次 + WeakMap 缓存）后，定位是两次读数。
 * 判据用 Proxy 数下标读取：它测的是「摸了几次」，不是时间戳 —— 时间在 CI 上抖，读次数不抖。
 *
 * 反例（能红）：把 sliceByRunStarts 换回线性扫描（sliceAgentRunWindowFrom 的旧实现）。
 */

const windowModule = () => loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

/** 统计直接下标读取次数（不含 slice 复制内部那次）。 */
function countedArray(items) {
	let reads = 0;
	const proxy = new Proxy(items, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
			return Reflect.get(target, key, receiver);
		},
	});
	return { proxy, reads: () => reads };
}

function syntheticTimeline(turns, perTurn = 18) {
	const items = [];
	for (let t = 0; t < turns; t += 1) {
		items.push({ kind: "agent-run" });
		for (let k = 1; k < perTurn; k += 1) items.push({ kind: "message" });
	}
	return items;
}

test("取窗的读次数与起点无关：起点 0 与起点 1992 读一样多", () => {
	const { buildAgentRunStarts, sliceByRunStarts } = windowModule();
	const items = syntheticTimeline(2000);
	const starts = buildAgentRunStarts(items);
	const reads = [0, 500, 1000, 1992].map((start) => {
		const counted = countedArray(items);
		const out = sliceByRunStarts(counted.proxy, starts, start, 8);
		assert.equal(out.length, 8 * 18, `起点 ${start} 应取 8 轮 × 18 条`);
		return counted.reads();
	});
	assert.equal(new Set(reads).size, 1, "四个起点读次数必须相同，实际 " + reads.join(" / "));
	assert.ok(reads[0] <= 8 * 18 + 2, `读次数 ${reads[0]} 应约等于被复制的条数（8×18=144），不是全表扫描`);
});

test("同一份起点表反复取值：每次都只读被复制的那几条（缓存不是必要条件）", () => {
	const { buildAgentRunStarts, sliceByRunStarts } = windowModule();
	const items = syntheticTimeline(2000);
	const starts = buildAgentRunStarts(items);
	// 用真实数组（不是 Proxy）算一次总长度，再逐次量读次数
	const reads = [];
	for (const start of [0, 1000, 1992]) {
		const counted = countedArray(items);
		sliceByRunStarts(counted.proxy, starts, start, 8);
		reads.push(counted.reads());
	}
	assert.equal(new Set(reads).size, 1, "三次读次数必须相同：" + reads.join(" / "));
	assert.ok(reads[0] <= 8 * 18 + 2, "读次数应约等于复制条数 144，实际 " + reads[0]);
});

test("起点越界不抛：超出返回空，负数夹到 0", () => {
	const { buildAgentRunStarts, sliceByRunStarts } = windowModule();
	const items = syntheticTimeline(5, 4);
	const starts = buildAgentRunStarts(items);
	assert.equal(sliceByRunStarts(items, starts, 99, 8).length, 0);
	assert.equal(sliceByRunStarts(items, starts, -3, 2).length, 8, "负起点夹到 0：2 轮 × 4 条");
});
