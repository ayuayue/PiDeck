import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * 调用方侧判据：起点表必须 memo 一次，不许每次渲染重建。
 *
 * 为什么单列一条（而不是并进 O(1) 那条）：O(1) 是**条件命题** ——
 *   「若消费者持有同一份 starts，则取窗定位 O(1)」。
 * 「持有同一份」是调用方的责任，函数证明不了。实测：用 Proxy 包一层（新引用），
 * WeakMap 不命中，读次数从 144 回到 36000。
 *
 * 这条是能红的源码断言（例外情形：本判据守的正是「写法」，写法就是被守的对象；
 * 消费端行为由 jumpWindowO1Locate 的三态覆盖）。
 *
 * 反例：把 buildAgentRunStarts(...) 从 useMemo 里挪到渲染体内直接调用。
 */

const TRW = "src/renderer/src/components/session/timeline/turnRenderWindow.ts";

/** 现有调用方（新增调用方时在这里加一行，并同时确认它 memo 了）。 */
const CALL_SITES = ["src/renderer/src/components/session/SessionMessageTimeline.tsx"];

test("调用方必须 memo 取窗（否则每帧 O(n) 重建）", () => {
	for (const file of CALL_SITES) {
		const src = fs.readFileSync(file, "utf8");
		const lines = src.split("\n");
		const callLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => /(buildAgentRunStarts|selectTimelineTurnWindow)\s*\(/.test(line) && !line.trimStart().startsWith("//"));
		// 0 个调用点必须红：那时判据对任何写法都沉默，而沉默读起来和「没问题」一样。
		// 这个形状我刚被教过一次（coverage 判据把「正文提到」当成「有编号」）。
		assert.ok(callLines.length > 0, `${file} 里找不到 buildAgentRunStarts / selectTimelineTurnWindow 的调用点 —— 判据前提失效，不是通过`);
		for (const { line, index } of callLines) {
			// 同一行或最近 6 行内必须出现 useMemo(
			const window = lines.slice(Math.max(0, index - 6), index + 1).join("\n");
			assert.ok(/useMemo\s*\(/.test(window), `${file}:${index + 1} 的 buildAgentRunStarts 不在 useMemo 内 —— 每帧新数组 = 缓存全失效 = 用户又卡：\n    ${line.trim()}`);
		}
	}
});

test("起点表 API 仍在（判据前提不成立时要自己红，不是静默通过）", () => {
	const src = fs.readFileSync(TRW, "utf8");
	assert.match(src, /export function buildAgentRunStarts/, "buildAgentRunStarts 被改名/删除，本判据前提失效");
	assert.match(src, /export function sliceByRunStarts/, "sliceByRunStarts 被改名/删除");
});
