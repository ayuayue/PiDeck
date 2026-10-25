import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isCollapsedPanelPixels, shouldCommitPanelPixels } from "../src/renderer/src/lib/shellPanelLayout.ts";

test("collapsed pixels are never committed", () => {
	assert.equal(isCollapsedPanelPixels(0), true);
	assert.equal(isCollapsedPanelPixels(1), true);
	assert.equal(isCollapsedPanelPixels(2), false);
	assert.equal(
		shouldCommitPanelPixels({
			px: 0,
			savedWidth: 320,
			isUserInteraction: true,
		}),
		null,
	);
});

test("programmatic layout changes never overwrite the saved width", () => {
	// 缩放、窗口拉伸、expand/resize 都不是用户调整，不能把临时布局像素写入缓存。
	assert.equal(
		shouldCommitPanelPixels({
			px: 180,
			savedWidth: 320,
			isUserInteraction: false,
		}),
		null,
	);
	assert.equal(
		shouldCommitPanelPixels({
			px: 400,
			savedWidth: 320,
			isUserInteraction: false,
		}),
		null,
	);
});

test("user drag to min size is still committed", () => {
	assert.equal(
		shouldCommitPanelPixels({
			px: 180,
			savedWidth: 320,
			isUserInteraction: true,
		}),
		180,
	);
});

test("user resize commits the new pixel width", () => {
	assert.equal(
		shouldCommitPanelPixels({
			px: 400,
			savedWidth: 320,
			isUserInteraction: true,
		}),
		400,
	);
	assert.equal(
		shouldCommitPanelPixels({
			px: 280,
			savedWidth: 320,
			isUserInteraction: true,
		}),
		280,
	);
});

test("equal sizes are ignored to keep resize effects idle", () => {
	assert.equal(
		shouldCommitPanelPixels({
			px: 320,
			savedWidth: 320,
			isUserInteraction: true,
		}),
		null,
	);
	assert.equal(
		shouldCommitPanelPixels({
			px: 321,
			savedWidth: 320,
			isUserInteraction: true,
		}),
		null,
	);
});

test("AppShell opens a collapsed drawer by resizing to the saved width", () => {
	const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
	assert.match(shell, /shouldCommitPanelPixels/);
	// expand() 无历史会落到 minSize，打开抽屉必须用保存宽度 resize。
	assert.match(shell, /panel\.resize\(drawerWidthRef\.current\)/);
	assert.match(shell, /panel\.resize\(listWidthRef\.current\)/);
	assert.doesNotMatch(shell, /panel\.expand\(\)/);
});
