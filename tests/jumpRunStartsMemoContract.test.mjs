import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * 调用方侧判据：锚点窗口必须 memo 一次，不许每帧重建身份索引。
 *
 * O(1) 是条件命题：同一份 reconciledRuns 由 WeakMap 持有索引后，
 * 目标查找和有界切窗不随目标距尾部增长；数组引用变化时才重建索引。
 * 消费端必须把 resolveAnchoredTurnWindow 放进 useMemo，不能在渲染体内直接调用。
 *
 * 反例：把 resolveAnchoredTurnWindow(...) 从 useMemo 里挪到渲染体内，
 * 每次流式更新都会重新做全量身份索引。
 */

const TRW = "src/renderer/src/components/session/timeline/turnRenderWindow.ts";
const CALL_SITES = ["src/renderer/src/components/session/SessionMessageTimeline.tsx"];
const WINDOW_CALL = /(resolveAnchoredTurnWindow|buildAgentRunStarts|selectTimelineTurnWindow)\s*\(/;

test("调用方必须 memo 取锚点窗口（否则每帧 O(n) 重建）", () => {
	for (const file of CALL_SITES) {
		const src = fs.readFileSync(file, "utf8");
		const lines = src.split("\n");
		const callLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => WINDOW_CALL.test(line) && !line.trimStart().startsWith("//"));
		assert.ok(callLines.length > 0, `${file} 里找不到锚点窗口调用点 —— 判据前提失效，不是通过`);
		for (const { line, index } of callLines) {
			const window = lines.slice(Math.max(0, index - 6), index + 1).join("\n");
			assert.ok(/useMemo\s*\(/.test(window), `${file}:${index + 1} 的锚点窗口调用不在 useMemo 内 —— 每帧新索引 = 用户又卡：\n    ${line.trim()}`);
		}
	}
});

test("锚点窗口与旧起点表 API 仍在（判据前提失效时要自己红）", () => {
	const src = fs.readFileSync(TRW, "utf8");
	assert.match(src, /export function resolveAnchoredTurnWindow/, "resolveAnchoredTurnWindow 被改名/删除");
	assert.match(src, /export function buildAgentRunStarts/, "buildAgentRunStarts 被改名/删除");
	assert.match(src, /export function sliceByRunStarts/, "sliceByRunStarts 被改名/删除");
});
