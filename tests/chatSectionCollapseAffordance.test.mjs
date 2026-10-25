import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * #387：聊天会话全部删除后，新会话「不显示」——现场实际是聊天分组被折叠，而折叠态没有任何
 * 可见差异（展开/折叠共用同一个 ChevronsDownUp 图标），空列表与收起分组在界面上完全一样，
 * 刷新/重启都不会改变持久化的折叠集合，用户只能判断成「会话没被记录」。
 *
 * 本文件锁定三条修复契约（纯源码/词典契约；侧栏渲染没有可离线断言的纯函数）：
 * 1. 聊天分组的折叠控件必须随状态改变箭头方向；
 * 2. 展开且为空时必须渲染明确空态，不能静默 return null；
 * 3. 分组内「新建会话」必须先展开分组，新会话才不会被折叠态藏掉。
 */

const PROJECT_TREE = "src/renderer/src/components/sidebar/ProjectTree.tsx";
const SESSION_TREE = "src/renderer/src/components/sidebar/SessionTree.tsx";

function sliceBetween(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, "missing start marker: " + startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(end, -1, "missing end marker: " + endMarker);
	return source.slice(start, end);
}

test("chat section collapse control exposes its state (issue #387)", () => {
	const projectTree = readFileSync(PROJECT_TREE, "utf8");
	const chatSection = sliceBetween(projectTree, "const chatSection = chatProjects.map", "const projectsSection = (");

	// 1) 箭头随折叠态旋转：展开时 rotate-90，折叠时朝右——与工作区项目行同一语义。
	assert.match(chatSection, /<ChevronRight\s+size=\{14\}\s+className=\{cn\("transition-transform", !collapsed && "rotate-90"\)\}/, "collapse icon must rotate with state");
	// 同一个静态图标必须彻底消失，否则两种状态仍然无差别。
	assert.doesNotMatch(chatSection, /ChevronsDownUp/, "chat collapse button must not keep the state-agnostic icon");
	// 2) 无障碍文案仍然状态相关，保证悬停/读屏也能判断收起与否。
	assert.match(chatSection, /title=\{collapsed \? t\("app\.projectExpand"\) : t\("app\.projectCollapse"\)\}/);
	assert.match(chatSection, /aria-expanded=\{!collapsed\}/);
});

test("chat section renders an explicit empty state instead of nothing (issue #387)", () => {
	const projectTree = readFileSync(PROJECT_TREE, "utf8");
	const sessionTree = readFileSync(SESSION_TREE, "utf8");
	const chatSection = sliceBetween(projectTree, "const chatSection = chatProjects.map", "const projectsSection = (");

	// 聊天分组展开且无行时传空态，并带 testid 供 e2e 断言（空列表 != 列表损坏）。
	assert.match(chatSection, /emptyState=\{/);
	assert.match(chatSection, /data-testid="chat-empty-sessions"/);
	assert.match(chatSection, /t\("app\.chatEmptySessions"\)/);
	// SessionTree 必须有 emptyState 渲染分支；静默 return null 仅对未传空态的调用方（工作区项目）保留。
	assert.match(sessionTree, /emptyState\?: ReactNode/);
	assert.match(sessionTree, /if \(!hasRows && !retainingExit\) return props\.emptyState \? <>\{props\.emptyState\}<\/> : null;/);
});

test("creating a session reveals its (possibly collapsed) group (issue #387)", () => {
	const projectTree = readFileSync(PROJECT_TREE, "utf8");
	const chatSection = sliceBetween(projectTree, "const chatSection = chatProjects.map", "const projectsSection = (");
	const projectRow = sliceBetween(projectTree, "const renderProject = (project: Project) => {", "const chatProjects = rootProjects.filter");

	// 聊天标题栏「+」：先展开再建，否则建完仍看不到行。
	assert.match(chatSection, /props\.controller\.revealProject\(project\.id\);\s*void props\.actions\.sessions\.createDraft\(project\.id\);/);
	// 工作区项目行「+」同理（同一条产品规则，不能只修聊天分组）。
	assert.match(projectRow, /props\.controller\.revealProject\(project\.id\);\s*void props\.actions\.sessions\.createDraft\(project\.id\);/);
});

test("chat empty-state copy exists in every dictionary", () => {
	for (const locale of ["zh-CN", "en-US", "zh-TW"]) {
		const dictionary = readFileSync("src/renderer/src/i18n/rendererCopy." + locale + ".ts", "utf8");
		assert.match(dictionary, /"app\.chatEmptySessions": ".+"/, "missing app.chatEmptySessions in " + locale);
	}
});
