/**
 * 桌宠动画与 prefers-reduced-motion 契约（2026-03 动效审计轮引入）：
 * 桌宠域的产品决策（PetOverlay L100-103 首创）：reduced-motion 下不完全冻结、
 * 降到 1/4 帧率近定格——桌宠是「活物」，静态帧失真；但 4 倍拉长帧间隔仍尊重系统偏好。
 * PetTab 设置预览画布曾裸跑 ~7fps sprite 循环（全仓唯一漏网的连续动画），
 * 2026-03 修复为同一 1/4 帧率降级策略。本测试锚定两处守卫，防止未来重构静默删除。
 * 新增连续 rAF 循环时先过 reduced-motion 判定（全局 CSS 开关只覆盖 CSS 动画，
 * JS 驱动的动画必须在绘制循环内自行判定）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(p, "utf8");

test("PetTab 预览循环：reduced-motion 降到 1/4 帧率（与 PetOverlay 同策略）", () => {
	const src = read("src/renderer/src/components/app/settings/PetTab.tsx");
	assert.ok(/reducedMotion\s*=\s*typeof window\.matchMedia[\s\S]{0,120}prefers-reduced-motion:\s*reduce\)"\)\.matches/.test(src), "PetTab 预览必须读 matchMedia 判定 reduced-motion");
	assert.ok(/const frameMs = reducedMotion \? 140 \* 4 : 140;/.test(src), "reduced-motion 下帧间隔须 4 倍拉长（1/4 帧率近定格），不得完全冻结");
	assert.ok(/Math\.floor\(\(now - startedAt\) \/ frameMs\) % frameCount/.test(src), "帧推进必须走 frameMs 变量（而非写死 140），否则降级不生效");
});

test("PetOverlay 本体：1/4 帧率守卫仍在", () => {
	const src = read("src/renderer/src/pet/PetOverlay.tsx");
	assert.ok(/reducedMotion\s*=\s*typeof window\.matchMedia[\s\S]{0,120}prefers-reduced-motion:\s*reduce\)"\)\.matches/.test(src), "PetOverlay 必须保留 matchMedia 判定");
	assert.ok(/reducedMotion \? 1000 \/ \(fps \/ 4\) : 1000 \/ fps/.test(src), "PetOverlay 帧率公式（1/4 降级）不得改动");
});
