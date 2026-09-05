import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { twMerge } from "tailwind-merge";

// 侧栏行操作按钮防重叠契约（2027-01 用户反馈）：
// 三个树（ProjectTree/SessionTree/WorktreeTree）的行操作按钮是 absolute 浮层，
// hover 显现时会盖住行文本。修复策略：行文本用 group-hover:pr-* 在 hover 时压出
// 按钮宽度的右侧留白，文本截断让位但保持可见。所有宽度统一让位（不止窄侧栏）——
// 中等宽度下长项目名/长会话名同样会延伸到按钮下方（“+ 号叠在项目名上”反馈）。
// 注意：v1 曾用 opacity-0 整行淡出，用户反馈「文字变白不可读、须点击激活才能看到」，
// 已弃用（见本文件 doesNotMatch 断言防回退）。
// 本测试锁定：三棵树的行 hover 让位宽度与按钮浮层模式不被破坏。
// 注：WorktreeTree 用命名组 /workspace-row（主/子行共用 workspaceActionPaddingClass
// 裁剪出入 52px 让位）；SidebarContent 的 aside 已不再需要 @container 容器查询锚点。

const read = (p) => readFileSync(p, "utf8");

const prVariant = /@max-\[255px\]:group-hover(?:\/row)?:pr-/;

test("sidebar host needs no container query anchor", () => {
	const src = read("src/renderer/src/components/sidebar/SidebarContent.tsx");
	// 各树统一用 group-hover:pr-* 让位，不再按侧栏宽度用 @max-[255px] 分断点，
	// aside 上的 @container 锚点因此没有消费者，禁止回退到容器查询门控。
	assert.doesNotMatch(src, /chat-list-pane v3-braun @container/);
});

test("project row text yields to the hover action buttons at any width", () => {
	const src = read("src/renderer/src/components/sidebar/ProjectTree.tsx");
	// 项目名 conversation-body：hover 压出 64px 留白——浮层 right-1(4) + pr-1(4) +
	// 两个 size-6 按钮(52) + 4px 余量，刚好比 + / ⋯ 宽一点，不浪费文字空间；
	// 聚焦态（键盘导航）同样让位；transition 只动画 padding-right。
	// 所有宽度统一让位，不能只依赖窄侧栏断点，否则中等宽度下 + / ⋯ 会叠在长项目名上。
	assert.match(
		src,
		/conversation-body min-w-0 flex-1 transition-\[padding-right\] group-hover:pr-16 group-focus-within:pr-16/,
	);
	// 筛选按钮存在时（sourceFilter）共 3 个按钮，让位加宽到 88px
	assert.match(src, /sourceFilter !== null && "group-hover:pr-\[88px\] group-focus-within:pr-\[88px\]"/);
	// 旧的 116px/窄侧栏断点不得回退
	assert.doesNotMatch(src, /pr-29/);
	assert.doesNotMatch(src, prVariant);
	// 新建 DSH 会话入口已收敛到会话内的后端选择器，项目行不再提供独立机器人按钮
	assert.doesNotMatch(src, /createDraftDsh\(project\.id\)/);
	// 按钮浮层模式不变：absolute 不占位 + group-hover 显现
	assert.match(src, /pointer-events-none absolute top-1\/2 right-1 flex/);
	assert.match(src, /group-hover:pointer-events-auto group-hover:opacity-100/);
	// 淡出方案已弃用：文本不得再整行变透明
	assert.doesNotMatch(src, /conversation-body[^\n]*opacity-0/);
});

test("session rows yield to hover actions on narrow sidebar", () => {
	const src = read("src/renderer/src/components/sidebar/SessionTree.tsx");
	// agent 行、运行中会话行、历史会话行、普通会话行共 4 处 conversation-body 全部接入
	// （一个 size-6 更多按钮 → 28px 留白）
	const matches = src.match(
		/conversation-body min-w-0 flex-1 transition-\[padding-right\] group-hover\/row:pr-7 group-focus-within\/row:pr-7/g,
	);
	assert.ok(matches && matches.length === 4, `expected 4 row bodies, got ${matches?.length ?? 0}`);
	// 浮层模式不变
	assert.match(src, /row-more-actions pointer-events-none absolute top-1\/2 right-1/);
	assert.doesNotMatch(src, /conversation-body[^\n]*opacity-0/);
});

test("worktree rows yield to hover actions on narrow sidebar", () => {
	const src = read("src/renderer/src/components/sidebar/WorktreeTree.tsx");
	// 主工作区行与子行共用同一让位变量：2 按钮（pi/匿名）→ 52px 留白。
	// 改版后用命名组 /workspace-row，不再用 @max-[255px] 容器查询门控（与子行保持一致）。
	assert.match(
		src,
		/workspaceActionPaddingClass =\s*\n\s*"group-hover\/workspace-row:pr-\[52px\] group-focus-within\/workspace-row:pr-\[52px\]"/,
	);
	assert.match(src, /conversation-body min-w-0 flex-1 transition-\[padding-right\]/);
	// 子行按钮同样接入让位变量（workspaceSelectClass 带 transition-[…,padding-right]）
	assert.match(src, /workspaceActionPaddingClass,[\s\S]*?childActionsOpen && "pr-\[52px\]"/);
	// 新建 DSH 会话入口已收敛到会话内的后端选择器，工作区行不再提供独立机器人按钮
	assert.doesNotMatch(src, /createDraftDsh\(props\.project\.id\)/);
	assert.doesNotMatch(src, /createDraftDsh\(childProject\.id\)/);
	// 子行文本 span 原始形态（不再淡出/不再带过渡）
	assert.match(src, /<span className="min-w-0 flex-1 truncate font-medium">\{row\.branch\}<\/span>/);
	assert.match(src, /workspace-tree-directory max-w-20 shrink-0 truncate text-micro text-muted-foreground">\{row\.directory\}<\/span>/);
	// 浮层模式不变（absolute 不占位 + 命名组 hover 显现）
	assert.match(src, /workspace-tree-actions pointer-events-none absolute top-1\/2 right-1 flex/);
	assert.match(src, /group-hover\/workspace-row:pointer-events-auto group-hover\/workspace-row:opacity-100/);
	// 行文本不得再淡出
	assert.doesNotMatch(src, /group-hover(?:\/row)?:opacity-0/);
});

test("hover yield classes survive tailwind-merge", () => {
	// 防回归：cn() 的 tailwind-merge 不得吞掉 group-hover/group-focus-within 的 pr 让位类
	// （不同修饰键的 pr 互不冲突，均应保留）
	const merged = twMerge(
		"min-w-0 flex-1 truncate transition-[padding-right] group-hover:pr-16 group-focus-within:pr-16",
	);
	assert.match(merged, /group-hover:pr-16/);
	assert.match(merged, /group-focus-within:pr-16/);
	assert.match(merged, /transition-\[padding-right\]/);
	// 项目行筛选按钮出现时：同修饰键同组冲突，88px 版本应胜出（让位加宽）
	const filtered = twMerge(
		"transition-[padding-right] group-hover:pr-16 group-focus-within:pr-16",
		"group-hover:pr-[88px] group-focus-within:pr-[88px]",
	);
	assert.match(filtered, /group-hover:pr-\[88px\]/);
	assert.match(filtered, /group-focus-within:pr-\[88px\]/);
	assert.doesNotMatch(filtered, /pr-16/);
	// 子行同一规则：与 52px 让位类合并时同样保留
	const rowMerged = twMerge(
		"min-w-0 flex-1 truncate transition-[padding-right] group-hover/workspace-row:pr-[52px] group-focus-within/workspace-row:pr-[52px]",
	);
	assert.match(rowMerged, /group-hover\/workspace-row:pr-\[52px\]/);
	assert.match(rowMerged, /group-focus-within\/workspace-row:pr-\[52px\]/);
});
