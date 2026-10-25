import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 高频面板折叠开合动画契约（2026-10 motion 体验优化，第六批）。
 *
 * 收尾批：把散落在各表面、与此前批次同构的「点行展开详情/列表」补齐到
 * ui-shadcn/collapsible（真高度渐变、Presence 等 exit 动画播完再卸载、
 * reduced-motion 自动回退）。共性仍是：展开内容为定稿数据，高度稳定。
 *
 * - SessionAgentPromptBar：会话输入框上方的智能体角色设定条（AGENTS.md 领域速查）
 * - SessionHistoryPanel：抽屉/历史弹窗里父会话下的子代理会话列表
 * - ComposerComponents ExtensionWidgetCard：输入框上下方的扩展 widget 卡
 *   （细节：限高滚动样式在 legacy 层 .extension-widget-card-content，原语基底的
 *   overflow-hidden 在 utilities 层会盖过它，必须补 overflow-y-auto utility）
 * - AnnouncementCenter：公告中心「已读归档」分区展开
 * - ImportModals：Codex 导入弹窗的子代理分组与孤儿子代理列表
 *
 * 刻意不迁移（守卫钉住，防误「补齐」）：
 * - TerminalDock 折叠：xterm 容器挂载/卸载是终端生命周期，不是布局折叠
 * - SessionContextMeter：portal 定位浮层（popover 语义），不是高度推挤折叠
 * - TurnFileChanges：chip 装箱测量系统（ResizeObserver + 探测层 + chipRowFit），
 *   展开是 chip 换行数变化而非单一盒高度
 * - stack-trace / command-picker：共享原语且结构嵌在 cmdk 扁平化列表里
 * - SessionTabsBar 分组展开：Tab 位移动画的范围刻意限定在「关闭收拢」（545161b35）
 *
 * 正则一律空白容忍（\s*），格式化不应打红本契约。
 */

const read = (path) => readFileSync(`src/renderer/src/${path}`, "utf8");

const CASES = [
	{
		path: "components/session/SessionAgentPromptBar.tsx",
		root: /<Collapsible\s+open=\{expanded\}\s+className="contents">/,
		forbidden: [/\{expanded\s*\?\s*\(/],
	},
	{
		path: "components/session/SessionHistoryPanel.tsx",
		root: /<Collapsible\s+open=\{isExpanded\}\s+className="contents">/,
		forbidden: [/\{isExpanded\s*&&/],
	},
	{
		path: "components/session/ComposerComponents.tsx",
		root: /<Collapsible\s+open=\{expanded\}\s+className="contents">/,
		// overflow-y-auto 必须补在 utility 层，否则原语的 overflow-hidden（utilities 层）
		// 会盖过 legacy 层 .extension-widget-card-content 的 overflow-y:auto，内部滚动失效
		required: [/<CollapsibleContent\s+className="extension-widget-card-content overflow-y-auto">/],
		forbidden: [/\{expanded\s*&&\s*\(\s*<div className="extension-widget-card-content">/],
	},
	{
		path: "components/sidebar/AnnouncementCenter.tsx",
		root: /<Collapsible\s+open=\{showRead\}\s+className="contents">/,
		forbidden: [/\{showRead\s*&&\s*readNotices\.map/],
	},
	{
		path: "components/app/ImportModals.tsx",
		root: /<Collapsible\s+open=\{showOrphanSubagents\}\s+className="contents">/,
		required: [/<Collapsible\s+open=\{expanded\s*&&\s*children\.length\s*>\s*0\}\s+className="contents">/],
		forbidden: [/\{showOrphanSubagents\s*&&\s*\(/],
	},
];

for (const { path, root, required = [], forbidden = [] } of CASES) {
	test(`${path} 折叠开合走共享折叠原语`, () => {
		const source = read(path);
		assert.match(source, /import \{\s*Collapsible,\s*CollapsibleContent\s*\}\s*from "[^"]*ui-shadcn\/collapsible"/, "必须引入共享折叠原语");
		assert.match(source, root, "折叠根必须受控且不生成盒子");
		assert.match(source, /<CollapsibleContent/, "折叠体必须包在 CollapsibleContent 里");
	});

	if (required.length > 0 || forbidden.length > 0) {
		test(`${path} 不复活瞬时挂载`, () => {
			const source = read(path);
			for (const pattern of required) assert.match(source, pattern);
			for (const pattern of forbidden) assert.doesNotMatch(source, pattern, "不得回退条件挂载（高度硬跳）");
		});
	}
}

test("WorkspaceSurface 修改文件摘要卡折叠走共享折叠原语", () => {
	const source = read("components/session/WorkspaceSurface.tsx");
	assert.match(source, /import \{\s*Collapsible,\s*CollapsibleContent\s*\}\s*from "[^"]*ui-shadcn\/collapsible"/, "必须引入共享折叠原语");
	// 受控开合：collapsed 归零时展开，语义与卡片头 aria-expanded={!collapsed} 对齐
	assert.match(source, /<Collapsible\s+open=\{!collapsed\}\s+className="contents">/, "折叠根必须受控且不生成盒子");
	assert.match(source, /<CollapsibleContent/, "文件列表必须包在 CollapsibleContent 里");
	assert.doesNotMatch(source, /\{!collapsed\s*&&\s*\(/, "不得回退条件挂载（高度硬跳）");
});

test("RewindCheckpointList 的 diff 预览开合走共享折叠原语", () => {
	const source = read("components/session/RewindCheckpointList.tsx");
	assert.match(source, /import \{\s*Collapsible,\s*CollapsibleContent\s*\}\s*from "[^"]*ui-shadcn\/collapsible"/, "必须引入共享折叠原语");
	// open 由数据推导（diff 已加载或加载中），与行按钮 onToggleDiff 的取/清语义对齐
	assert.match(source, /<Collapsible\s+open=\{diffVisible\}\s+className="contents">/, "折叠根必须受控且不生成盒子");
	assert.doesNotMatch(source, /\{diffVisible\s*&&\s*\(/, "不得回退条件挂载（高度硬跳）");
	// 限高滚动契约不被顺手改动
	assert.match(source, /max-h-40 overflow-auto/, "diff 预览限高滚动契约保持原样");
});

test("TerminalDock 折叠刻意不迁折叠原语（xterm 容器生命周期）", () => {
	assert.doesNotMatch(read("components/terminal/TerminalDock.tsx"), /ui-shadcn\/collapsible/, "终端面板折叠关平 xterm 挂载，不是布局折叠动画问题");
});

test("SessionContextMeter 刻意不迁折叠原语（portal 浮层）", () => {
	assert.doesNotMatch(read("components/session/SessionContextMeter.tsx"), /ui-shadcn\/collapsible/, "固定定位 popover 不做高度推挤动画");
});

test("TurnFileChanges 刻意不迁折叠原语（chip 装箱测量系统）", () => {
	assert.doesNotMatch(read("components/session/turn/TurnFileChanges.tsx"), /ui-shadcn\/collapsible/, "展开是 chip 换行数变化，装箱测量（ResizeObserver+探测层）不容忍中间态");
});

test("stack-trace / command-picker 刻意不迁折叠原语（cmdk 结构）", () => {
	assert.doesNotMatch(read("components/ui-shadcn/stack-trace.tsx"), /ui-shadcn\/collapsible/);
	assert.doesNotMatch(read("components/ui-shadcn/command-picker.tsx"), /ui-shadcn\/collapsible/, "命令面板组展开嵌在 cmdk 扁平化列表里，包 div 会破坏结构");
});

test("SessionTabsBar 分组展开刻意不迁折叠原语（Tab 位移范围限定）", () => {
	assert.doesNotMatch(read("components/session/SessionTabsBar.tsx"), /ui-shadcn\/collapsible/, "Tab 栏动画范围刻意限定在「关闭收拢」（见 545161b35 取舍）");
});
