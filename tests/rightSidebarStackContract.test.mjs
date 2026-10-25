import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appShell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
const stack = readFileSync("src/renderer/src/components/workspace/RightSidebarStack.tsx", "utf8");

test("AppShell 用 RightSidebarStack 包住原抽屉宿主，水平 Group 结构不变", () => {
	assert.match(appShell, /drawerFooter\?: ReactNode/);
	assert.match(appShell, /<RightSidebarStack[\s\S]*?open=\{Boolean\(drawer\) && !drawerCollapsed\}[\s\S]*?bottom=\{drawerFooter\}[\s\S]*?<WorkspaceDrawerHost /);
	assert.match(appShell, /ResizablePanelGroup orientation="horizontal"/);
	// 嵌套 Group 只能在 drawer Panel 内部，不得夹进水平 Group 的直系子节点
	assert.ok(appShell.indexOf("<RightSidebarStack") > appShell.indexOf('id="drawer"'));
	assert.ok(appShell.indexOf("<RightSidebarStack") < appShell.indexOf("</ResizablePanelGroup>"));
});

test("RightSidebarStack：纵向分组、无 bottom 零 DOM 变化、禁双击、偏好只在用户操作时写", () => {
	assert.match(stack, /orientation="vertical"/);
	assert.match(stack, /if \(!props\.bottom\) return <>\{props\.top\}<\/>;/);
	assert.match(stack, /disableDoubleClick/);
	assert.match(stack, /meta\.isUserInteraction/);
	assert.match(stack, /new ResizeObserver/);
	assert.doesNotMatch(stack, /overscroll-contain/);
});

test("RightSidebarStack 外层容器不建立定位/变换上下文（.drawer-restore 的包含块必须仍是外壳）", () => {
	const container = stack.match(/<div ref=\{containerRef\} className="([^"]*)"/);
	assert.ok(container, "应能定位到外层容器");
	assert.doesNotMatch(container[1], /\b(relative|absolute|fixed|sticky|transform|translate-|scale-|rotate-|contain-)/);
});

test("分隔条：常显居中把手；抽屉关闭时禁用并移出无障碍树（不可被 Tab 聚焦）", () => {
	const handle = stack.match(/<ResizableHandle[\s\S]*?<\/ResizableHandle>/);
	assert.ok(handle, "应能定位到分隔条");
	assert.match(handle[0], /disabled=\{!props\.open\}/);
	assert.match(handle[0], /aria-hidden=\{!props\.open \|\| undefined\}/);
	assert.match(handle[0], /className="group\/sash /);
	// 把手：不吃指针事件（拖拽命中仍由分隔条负责），悬停/拖拽随分隔条高亮
	assert.match(handle[0], /<span aria-hidden="true" className="pointer-events-none [^"]*h-1 w-8 rounded-full[^"]*group-hover\/sash:[^"]*group-data-\[separator=active\]\/sash:/);
});

test("shadcn ResizableHandle 渲染调用方 children（否则自定义把手被 withHandle 分支覆盖）", () => {
	const resizable = readFileSync("src/renderer/src/components/ui-shadcn/resizable.tsx", "utf8");
	assert.match(resizable, /withHandle,\s*className,\s*children,\s*\.\.\.props/);
	assert.match(resizable, /\{children\}\s*\{withHandle && \(/);
});
