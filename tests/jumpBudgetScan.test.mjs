// 跳转耗时的参数扫描：批次多大才既快又不丢帧。
// 纯函数能算的是帧数与单帧消息量；能不能 60fps 渲染，只有真机能答。
// 所以这张表给的是「代价」，选哪个数要连真机帧时间一起看。
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const W = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts");
const S = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpSettle.ts");
const T = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

function session(n) {
	const messages = [];
	for (let i = 0; i < n; i += 1) {
		messages.push({ role: "user" });
		messages.push({ role: "assistant" });
	}
	return messages;
}

function withBatch(turns, batch) {
	const messages = session(turns);
	const needed = W.estimateJumpExpandTurns(messages, 0);
	let expanded = 0;
	let frames = 0;
	let maxPerFrame = 0;
	for (let guard = 0; guard < 100000; guard += 1) {
		const remain = needed - expanded;
		if (remain <= 0) break;
		const step = Math.min(batch, remain);
		maxPerFrame = Math.max(maxPerFrame, step);
		expanded += step;
		frames += 1;
	}
	return { need: needed, frames, maxPerFrame, ms: Math.round((frames * 1000) / 60) };
}

test("参数扫描：批次 x 帧数 x 单帧挂载量", () => {
	console.log("  批次 | 1000 轮帧数 | 耗时 | 单帧最多轮 | 按每轮 10 条算单帧消息");
	const rows = [];
	for (const batch of [8, 16, 24, 32, 48]) {
		const r = withBatch(1000, batch);
		rows.push({ batch, ...r });
		console.log(`  ${String(batch).padStart(4)} | ${String(r.frames).padStart(10)} | ${String(r.ms + "ms").padStart(6)} | ${String(r.maxPerFrame).padStart(10)} | ${String(r.maxPerFrame * 10).padStart(18)}`);
	}
	for (let i = 1; i < rows.length; i += 1) {
		assert.ok(rows[i].frames < rows[i - 1].frames, "批次变大，帧数必须变小");
		assert.ok(rows[i].maxPerFrame >= rows[i - 1].maxPerFrame, "批次变大，单帧挂载不能变小");
	}
	// 为什么不提批次：一轮实际不止 2 条（长思考 + 工具调用可到 10 条）。
	// 8 轮 x 10 条 = 80 条/帧，是源码注释写的「单帧能稳定渲染的量级」；
	// 提到 24 就是 240 条/帧，等于拿丢帧换 1.4 秒。没有真机帧时间之前不动它。
	const current = rows.find((r) => r.batch === 8);
	assert.ok(current.maxPerFrame * 10 <= 100, "当前批次单帧不超过 100 条，这才是 8 轮的依据");
});

test("当前批次：1000 轮的总耗时上限", () => {
	const batch = T.TURN_WINDOW_EXPAND_STEP ?? 8;
	const r = withBatch(1000, 8);
	const settleMs = Math.round((S.JUMP_SETTLE_MAX_FRAMES * 1000) / 60);
	console.log(`  扩窗 ${r.frames} 帧 ≈ ${r.ms}ms，settle 上限 ${settleMs}ms，最坏合计 ≈ ${r.ms + settleMs}ms`);
	assert.ok(r.frames > 0);
});
