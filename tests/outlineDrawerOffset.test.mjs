import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const styles = readRendererStyles();

test("right-side entries keep the same gap to the drawer splitter", () => {
	const outlineHover = styles.match(/\.outline-hover \{([\s\S]*?)\n\}/)?.[1];

	assert.ok(outlineHover, "right-side entry container styles must exist");
	assert.match(outlineHover, /right:\s*calc\(11px \+ var\(--drawer-splitter-w\) \+ max\(var\(--drawer-col-w\), min\(var\(--drawer-width\), 38vw\)\) \+ var\(--outline-content-w, 0px\)\);/);
});

/** 会话定位轴（刻度条）所在的容器规则块。 */
const paneBlock = styles.match(/\.outline-hover\.session-outline-pane \{([\s\S]*?)\n\}/)?.[1] ?? "";

test("会话定位轴贴消息区右缘，不得改到左缘", () => {
	assert.ok(paneBlock, "session outline pane styles must exist");
	// 右缘是设计基线（commit 3303200ae 曾把它挪到左缘，用户明确要求回右侧）
	assert.match(paneBlock, /right:\s*0;/);
	assert.doesNotMatch(paneBlock, /left:\s*0;/);
	assert.doesNotMatch(paneBlock, /align-items:\s*flex-start/);
});

test("定位轴常显：不得给它加 opacity 静默态（要隐藏的是预览卡，不是导轨）", () => {
	// 2026-10 用户澄清：导轨一直显示，只有预览卡悬停才出。
	// 曾误把整条导轨做成 opacity:0 → 悬停才浮现，用户看到「横条消失」。
	assert.doesNotMatch(styles, /\.outline-hover\.session-outline-pane\s*\{[^}]*opacity:\s*0/);
	assert.doesNotMatch(styles, /\.outline-hover\.session-outline-pane\s*>\s*\*/);
});

test("定位轴的底边跟随 --outline-bottom（终端坞打开时让位）", () => {
	// 写死 bottom: 24px 会让定位轴盖在终端上
	assert.doesNotMatch(paneBlock, /bottom:\s*24px/);
});
