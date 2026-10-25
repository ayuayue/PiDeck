/**
 * PetOverlay 动画调度回归守卫（2026-09-15 pet 动画定格事故）。
 *
 * 背景：e58106d3f 把常驻 rAF 换成 setTimeout 按需调度时，`check` 保留了 rAF 的
 * `(now: number)` 形参签名——setTimeout 回调不携带时间戳，`now` 恒为 undefined：
 * delta/acc 全 NaN → 帧号永不推进（宠物定格第一帧「动画全没了」），且
 * `Math.max(1, NaN)`=NaN 的延迟被 setTimeout 强转为 0ms 空转烧 CPU。
 *
 * 约定：setTimeout 驱动的调度器必须在回调体内自取 `performance.now()`，
 * 不允许保留 `(now: number)` 形参签名（rAF 时间戳来源）。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync("src/renderer/src/pet/PetOverlay.tsx", "utf8");

test("契约: PetOverlay 的 setTimeout 调度器自取 performance.now()（不依赖回调时间戳参数）", () => {
	// 调度器入口必须是零参签名（setTimeout 不传参）
	assert.match(source, /const check = \(\) => \{/, "check 不得保留 (now: number) 形参：setTimeout 回调收不到时间戳，NaN 会让动画定格");
	// 时间源必须在回调体内取
	assert.match(source, /const now = performance\.now\(\);/, "check 体内必须用 performance.now() 取时间");
});
