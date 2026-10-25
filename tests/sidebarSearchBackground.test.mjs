import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 侧栏搜索改用 beUI MorphingSearch 命令面板，不再使用 shadcn Input + 搜索行内新建项目按钮。
 * 契约锁在组件结构上：MorphingSearch 挂载 + items 由 catalog 扁平化构建 + onQueryChange 同步 controller.search。
 */

const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");

test("sidebar search uses beUI MorphingSearch command palette", () => {
	assert.match(sidebar, /from "\.\.\/motion\/morphing-search"/);
	assert.match(sidebar, /<MorphingSearch/);
	assert.match(sidebar, /placeholder=\{t\("app\.searchSessions"\)\}/);
	assert.match(sidebar, /onQueryChange=\{\(query\) => controller\.setSearch\(query\)\}/);
	// 检索项由 catalog 扁平化构建：项目 + 会话，选中即打开/选中目标
	assert.match(sidebar, /id: `project:\$\{project\.id\}`/);
	assert.match(sidebar, /id: `session:\$\{session\.id\}`/);
	assert.match(sidebar, /actions\.sessions\.open\(project\.id, session\.id\)/);
	// 无匹配文案本地化
	assert.match(sidebar, /emptyMessage=\{t\("app\.searchNoResults"\)\}/);
});

test("sidebar search no longer renders shadcn Input or inline new-project button", () => {
	assert.doesNotMatch(sidebar, /from "\.\.\/ui-shadcn\/input"/);
	assert.doesNotMatch(sidebar, /<Input/);
	assert.doesNotMatch(sidebar, /className="round-add size-6 shrink-0"/);
	assert.doesNotMatch(sidebar, /<FolderPlus className="size-3\.5" \/>/);
	assert.doesNotMatch(sidebar, /className="search-row grid/);
});
