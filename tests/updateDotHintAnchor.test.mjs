/**
 * 首次解释气泡（UpdateDotHint）锚定回归测试。
 * 曾现 bug：气泡以固定宽度 w-56（224px）右对齐（right-0）到 dock 最左侧的
 * 设置按钮（32px），侧栏最小宽 208px → 气泡左溢约 175px，被 aside 的
 * overflow-hidden 裁剪成窗口左缘的一条 49px 竖条——表现为「更新提示挤在
 * 屏幕左侧、一半在屏幕外面」。
 * 契约：气泡必须左缘锚定并铺满 dock 行（left-0 right-0），箭头指向设置按钮。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const hint = readFileSync("src/renderer/src/components/sidebar/UpdateDotHint.tsx", "utf8");
const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");

test("气泡锚定 dock 行左缘并铺满行宽（不溢出窗口左缘）", () => {
	// 左缘锚定 + 撑满 dock 行宽度；固定 224px 宽度或右对齐设置按钮都曾导致左溢。
	assert.match(hint, /className="[^"]*absolute bottom-full left-0 right-0/);
	assert.doesNotMatch(hint, /className="[^"]*bottom-full right-0/);
	assert.doesNotMatch(hint, /className="[^"]*\bw-56\b/);
});

test("箭头指向设置按钮（气泡内左侧定位），不随气泡宽度漂移", () => {
	// 设置按钮是 dock 最左一项（相对行左缘约 24px）：箭头锚左，不再钉在气泡右缘。
	assert.match(hint, /className="[^"]*-bottom-1 left-6 size-2 rotate-45/);
	assert.doesNotMatch(hint, /className="[^"]*-bottom-1 right-4 size-2 rotate-45/);
});

test("气泡挂在带 relative 的 dock 行容器，不再寄生在 32px 的 DockItem 内", () => {
	// 行容器提供相对定位锚点（气泡 bottom-full 相对整行而非单个按钮）。
	assert.match(sidebar, /relative flex shrink-0 items-center px-2 pb-2 pt-1/);
	// UpdateDotHint 直接挂在行容器、Dock 之前。
	assert.match(sidebar, /<UpdateDotHint[\s\S]*?\/>\s*<Dock size=\{32\}/);
	// DockItem 内不再渲染气泡。
	assert.doesNotMatch(sidebar, /<DockItem>[\s\S]*?<UpdateDotHint/);
});
