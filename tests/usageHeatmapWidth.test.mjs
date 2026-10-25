import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 活跃热力图必须铺满容器宽度（回归守卫）。
 *
 * 曾经的实现把 SVG 写成固定 634px（53 × (10+2) − 2），而设置面板内容列约 940px，
 * 右侧留下一大片空白；同时周名标签画在 x=-4，落在 viewBox 之外被裁掉。
 * 现在按容器实测宽度算步长，标签列留在 viewBox 内。
 */
const heatmap = readFileSync("src/renderer/src/components/app/usageStats/UsageHeatmap.tsx", "utf8");

test("热力图按容器实测宽度铺满，不再写死像素宽", () => {
	assert.match(heatmap, /new\s+ResizeObserver\s*\(/);
	assert.match(heatmap, /clientWidth/);
	assert.match(heatmap, /width\s*=\s*"100%"/);
	// 固定像素宽的 svg 属性（width={width}）会绕过实测结果
	assert.doesNotMatch(heatmap, /<svg[^>]*width=\{width\}/);
	// 兜底步长必须存在：首帧还没测到宽度时不能渲染成 0 宽
	assert.match(heatmap, /FALLBACK_STEP/);
});

test("周名标签留在 viewBox 内（负坐标会被裁掉）", () => {
	assert.match(heatmap, /LABEL_GUTTER/);
	assert.doesNotMatch(heatmap, /x=\s*\{\s*-4\s*\}/);
	// 网格与标签都从 LABEL_GUTTER 之后起算
	assert.match(heatmap, /LABEL_GUTTER\s*\+\s*week\s*\*\s*cellStep/);
});
