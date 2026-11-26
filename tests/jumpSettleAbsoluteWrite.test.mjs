import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 落位写入的「一帧到底」判据（源码契约测试）。
 *
 * 为什么必须用源码断言：这段是 DOM 循环，离线跑不出可见行为，而它的失败形状是
 * 「写了 24 次、scrollTop 一次都没变」。日志（2026-11-25）实证：
 *   settle  target=118bbe10  rectTop=15247  scrollTop=1056  scrollHeight=16686  clientHeight=860
 *   settle-end  give-up  reason=frames  frames=24  driftPx=400
 * 目标在视口下方 15247px，每帧只补 drift=400px，24 帧共 9600px —— 追不上，
 * 漂移恒 400 直到 give-up，用户看到的是「停在了别处」（定位错误）。
 *
 * 判据：写入必须按「当前 scrollTop + 全部漂移」一次到位，且直写兜底（引擎 restoreAt
 * 会把自己的基准写回，把超范围写入还原）。
 */
const SRC = "src/renderer/src/hooks/session/timeline/useTimelineJumpNavigation.ts";
const src = readFileSync(SRC, "utf8");

test("落位按绝对值一帧写足，不做增量累加", () => {
	assert.match(src, /const next = Math\.max\(0, scrollBefore \+ decision\.delta\)/, "必须用全量 delta 计算目标位置");
});

test("写入后直写兜底，防止引擎把超范围位置还原", () => {
	// 反例：只有 apiAfter.restoreAt(next) 时，引擎按自己的基准还原，表现为 scrollAfter 恒等于 scrollBefore。
	assert.match(src, /timeline\.scrollTop = next;/, "必须有直写兜底");
});

test("每帧记录 scrollBefore / requested / scrollAfter / maxScroll（写入是否生效可读）", () => {
	for (const key of ["scrollBefore", "requested", "scrollAfter", "maxScroll"]) {
		assert.ok(src.includes(key + ":"), "日志缺字段 " + key);
	}
});

test("扩窗决策在直写之前短路，expand 分支不得写 scrollTop", () => {
	const expandAt = src.indexOf('if (decision.kind === "expand") {');
	const writeAt = src.indexOf("timeline.scrollTop = next;");
	assert.ok(expandAt > 0 && writeAt > expandAt, "expand 分支必须在写入之前 return");
});
