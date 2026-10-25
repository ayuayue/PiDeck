import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const appShell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
const styles = readRendererStyles();

function cssRule(selector) {
	return styles.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1];
}

test("drawer motion is delegated to resizable panels, not CSS grid transition", () => {
	const shell = cssRule("\\.wechat-shell");
	const drawer = cssRule("\\.detail-drawer");
	const closedDrawer = cssRule('\\.detail-drawer:not\\(\\[data-open="true"\\]\\)');

	assert.ok(shell, "shell styles must exist");
	// #115 U5：三栏宽度由 react-resizable-panels 接管，shell 不再使用 grid 轨道过渡
	assert.doesNotMatch(shell, /transition:\s*grid-template-columns/);
	assert.match(shell, /display:\s*flex/);

	assert.ok(drawer, "drawer styles must exist");
	assert.doesNotMatch(drawer, /(?:transform|will-change)\s*:/);
	assert.doesNotMatch(drawer, /transition\s*:\s*transform/);

	assert.ok(closedDrawer, "closed drawer styles must exist");
	assert.match(closedDrawer, /pointer-events:\s*none/);
	assert.doesNotMatch(closedDrawer, /transform\s*:/);
});

test("drawer keeps its content mounted through the layout transition", () => {
	// #115 U5：三栏宽度交给 react-resizable-panels（px 状态只同步 CSS 变量，不进 grid 轨道）；
	// 抽屉内容经 renderPanel 持续挂载，折叠/展开只动面板宽度不卸载内容。
	assert.match(appShell, /WorkspaceDrawerHost/);
	assert.match(appShell, /renderPanel=\{\(panel\) => drawerContent\(panel\)\}/);
	// CSS 变量仍承担「受约束渲染宽度」同步（--drawer-col-w 由面板 onLayoutChanged 提交值驱动）
	assert.match(appShell, /"--drawer-col-w": /);
	assert.match(appShell, /renderedWidth/);
	// #115 U5 常驻挂载：drawer=null 时折叠 0 宽而不是条件卸载；宽度变量由
	// writeDrawerLayoutVariables 统一写入（visible ? width : 0）
	assert.match(appShell, /writeDrawerLayoutVariables/);
	assert.match(appShell, /const renderedWidth = visible \? width : 0/);
	assert.match(appShell, /"--drawer-col-w", `\$\{renderedWidth\}px`/);
});

test("closed drawer does not reserve horizontal gutter", () => {
	// 关闭时必须仍可 collapse（未钉住时 collapsible，钉住后禁折叠防误拖）
	assert.match(appShell, /id="drawer"[\s\S]*?collapsible=\{!drawerPinned\}/);
	assert.doesNotMatch(appShell, /collapsible=\{Boolean\(drawer\)\}/);
	// CSS 兜底：未打开时强制 0 宽，避免偶发 1px/minSize 缝
	assert.match(styles, /\.wechat-shell:not\(\.drawer-open\) \.shell-panel-drawer \{[\s\S]*?max-width:\s*0 !important;/);
});

test("file rows use the integer control line-height token", () => {
	const fileRow = cssRule("\\.file-node-row");

	assert.ok(fileRow, "file row styles must exist");
	assert.match(fileRow, /line-height:\s*var\(--line-height-control\)/);
	assert.doesNotMatch(fileRow, /line-height:\s*1\.28/);
});

test("file rows animate their hover highlight like sidebar rows", () => {
	// 2027-01 用户反馈：侧栏行 hover 有平滑过渡，文件列表 hover 高亮是瞬切，体验不一致。
	// 文件行 class 必须带与侧栏行同款的 transition-[background-color,border-color,box-shadow]
	// + duration-base；legacy .file-node-row:hover 的颜色变化由此过渡驱动。
	// 行组件已迁到 FileTreeRows.tsx（WorkspaceSurface > 600 行红线）：行 class 断言读新宿主
	const surface = readFileSync("src/renderer/src/components/session/FileTreeRows.tsx", "utf8");
	// 行必须是块级 flex：inline-flex 会在 block 容器里多出 5px 行盒空隙（行距 33px），
	// 相邻行的引导线会裂成一段一段，所以这里连 display 一起锁死。
	assert.match(surface, /file-node-row flex h-\[28px\][\s\S]*?transition-\[background-color,border-color,box-shadow\] duration-base[\s\S]*?hover:bg-muted/);
});
