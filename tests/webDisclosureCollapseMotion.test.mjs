import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Web 端折叠开合动画契约（2026-10 motion 体验优化，第五批：桌面 parity）。
 *
 * 桌面端 composer 折叠条（7bd3733f0）与 DSH 安装表单（3febb1391）已统一走
 * ui-shadcn/collapsible；Web 端对应物仍是瞬时挂载（{open ? <div> : null}），
 * 开合高度硬跳。Web 构建本就依赖 Radix（Dialog/Tabs/Popover 等已在用），
 * 无新增依赖，直接复用同一原语（真高度渐变、Presence 等 exit 动画播完再卸载、
 * reduced-motion 自动回退）。
 *
 * 刻意不迁移（与桌面取舍逐条对齐）：
 * - WebTimeline 思考块：MarkdownStream isStreaming 会在展开期间逐帧长高，
 *   折叠原语的高度测量会被逐帧触发抖动外层（同桌面 TimelineEventCards/ProcessGroupStep）。
 * - WebSidebar 项目树展开：桌面 ProjectTree 刻意保持瞬跳（避免两棵会话树
 *   同时伸缩造成布局抖动，见 22337dfee），Web 同理。
 *
 * 正则一律空白容忍（\s*），格式化不应打红本契约。
 */

const read = (path) => readFileSync(`src/renderer/src/web/${path}`, "utf8");

test("WebSessionStrips StripShell 折叠体走共享折叠原语", () => {
	const source = read("WebSessionStrips.tsx");
	assert.match(source, /import \{\s*Collapsible,\s*CollapsibleContent\s*\}\s*from "@\/components\/ui-shadcn\/collapsible"/, "必须复用桌面同一原语，不自绘开合");
	assert.match(source, /<Collapsible\s+open=\{open\}\s+className="contents">/, "strip 折叠根必须受控且不生成盒子");
	assert.doesNotMatch(source, /\{open \? <div className="px-1 pt-0\.5 pb-2">/, "不得复活瞬时挂载");
	// 限高列表滚动契约不被顺手改动（webLayout 既有约定）
	assert.match(source, /max-h-40 flex-col gap-1 overflow-y-auto/, "限高滚动列表契约保持原样");
});

test("WebSessionStrips 子代理行详情走共享折叠原语", () => {
	const source = read("WebSessionStrips.tsx");
	assert.match(source, /<Collapsible\s+open=\{isOpen\}\s+className="contents">/, "行详情折叠根必须受控且不生成盒子");
	assert.doesNotMatch(source, /\{isOpen \? <pre/, "不得复活瞬时挂载");
	assert.match(source, /max-h-32 overflow-auto whitespace-pre-wrap/, "限高原文 pre 契约保持原样");
});

test("WebDshToolsPanel 安装表单开合走共享折叠原语", () => {
	const source = read("WebDshToolsPanel.tsx");
	assert.match(source, /import \{\s*Collapsible,\s*CollapsibleContent\s*\}\s*from "@\/components\/ui-shadcn\/collapsible"/);
	assert.match(source, /<Collapsible\s+open=\{showInstall\}\s+className="contents">/, "安装表单折叠根必须受控且不生成盒子");
	assert.doesNotMatch(source, /\{showInstall\s*&&\s*\(/, "不得复活瞬时挂载");
});

test("WebTimeline 思考块刻意不迁折叠原语（流式逐帧长高会抖动外层）", () => {
	const source = read("WebTimeline.tsx");
	assert.doesNotMatch(source, /ui-shadcn\/collapsible/, "流式思考块保持条件挂载 + 淡入（同桌面 TimelineEventCards 取舍）");
});

test("WebSidebar 项目树展开刻意不迁折叠原语（与桌面 ProjectTree 同取舍）", () => {
	const source = read("WebSidebar.tsx");
	assert.doesNotMatch(source, /ui-shadcn\/collapsible/, "项目树展开保持瞬跳：避免树伸缩造成布局抖动（22337dfee 同源取舍）");
});
