// 回归测试：侧栏/抽屉拖拽状态必须在布局变更完成时（onLayoutChanged）统一回写，
// 禁止在 Panel onResize（每个 pointermove 触发一次）里 setState。
// 背景：拖拽期间每帧 setState 会让整个工作台重渲染，且 defaultSize 随动触发
// react-resizable-panels 重布局，两者叠加造成拖拽抖动。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

test("resize state commits via Group onLayoutChanged, not per-frame Panel onResize", () => {
	assert.match(shell, /onLayoutChanged=\{handleLayoutChanged\}/);
	assert.doesNotMatch(shell, /onResize=\{handle/);
});

test("viewport zoom/resize keeps sidebar and drawer widths in pixel mode", () => {
	// 容器变化不能按相对比例放大/缩小两侧面板；否则测得的临时像素会污染缓存。
	assert.match(shell, /id="list"[\s\S]*?groupResizeBehavior="preserve-pixel-size"/);
	assert.match(shell, /id="drawer"[\s\S]*?groupResizeBehavior="preserve-pixel-size"/);
	assert.match(shell, /new ResizeObserver\(syncActualWidths\)/);
	// ResizeObserver 只更新 CSS 定位变量，不能在窗口/缩放变化时写回持久化 state。
	assert.match(shell, /writeListLayoutVariables\(shell, width, true\)/);
	assert.match(shell, /writeDrawerLayoutVariables\(shell, width, true\)/);
	assert.doesNotMatch(shell, /setListWidth\(px\)/);
	assert.doesNotMatch(shell, /setDrawerWidth\(px\)/);
});

test("programmatic layout changes do not overwrite persisted widths", () => {
	// 缩放/窗口拉伸/程序化开合都不能走持久化 setter；只有用户交互才提交宽度。
	assert.match(shell, /if \(!meta\.isUserInteraction\) \{/);
	assert.match(shell, /if \(!meta\.isUserInteraction\) \{[\s\S]*?return;\s*\}[\s\S]*?const drawerPanel[\s\S]*?const next = shouldCommitPanelPixels\(/);
	assert.match(shell, /shouldCommitPanelPixels/);
});

test("splitter paints a single neutral diffused line", () => {
	const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	const block = foundation.slice(foundation.indexOf(".splitter {"), foundation.indexOf(".v-splitter {"));
	// separator 本体不画线（shadcn bg-border 会盖过后加载的 utility），必须显式 transparent，
	// 视觉只留 ::before，避免双线
	assert.match(block, /\.splitter \{[\s\S]*?background:\s*transparent !important/);
	// 分隔条不掺主题色，任何 accent 主题下都不发绿
	assert.doesNotMatch(block, /--color-accent/);
});
