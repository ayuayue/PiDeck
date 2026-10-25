/**
 * 底栏图标规格契约（2027-02 用户反馈：下面那一排 logo 大小、间隙不统一）。
 *
 * 历史：2026-10 曾把 + / 盾牌 / 快捷消息从 28px 收到 24px、组内 gap-0，用来消掉「两条空列」；
 * 代价是底栏出现两种密度——左区 24px 盒子 + 2px 间距，右区（分支/增强/语音/发送）28px + 8px，
 * 飞书触发器还因为 8px 横向内边距宽到 30px，于是同一排里盒子宽高和间隙都对不齐。
 *
 * 现行规格（全底栏唯一一套）：图标控件一律 28×28 盒子（size-7）、字形 15px、控件间距 4px（gap-1）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const security = readFileSync("src/renderer/src/components/session/SecurityLevelMenu.tsx", "utf8");
const dshPermission = readFileSync("src/renderer/src/components/session/DshPermissionMenu.tsx", "utf8");
const quickMessages = readFileSync("src/renderer/src/components/session/QuickMessageMenu.tsx", "utf8");
const integrations = readFileSync("src/renderer/src/styles/integrations.css", "utf8");

test("会话级控制组与左/右区共用同一间距（gap-1），底栏不再摆竖线分界", () => {
	assert.match(composer, /composer-bottom-left[^"]*gap-1/, "左区图标间距 4px");
	assert.match(composer, /composer-bottom-right[^"]*gap-1/, "右区图标间距 4px");
	assert.match(composer, /<div className="flex shrink-0 items-center gap-1">/, "会话级控制组间距 4px");
	// 竖线分界整体移除（2026-10 用户反馈「回到最初的样子，没有也行」）：
	// 历史那条线因 Separator 竖向 h-full 被压掉一直是不可见的 1px 空列，修好后露出来反而多余。
	// 契约：不再 import 也不再渲染竖向 Separator，左区只靠间距分组。
	assert.doesNotMatch(composer, /ui-shadcn\/separator/);
	assert.doesNotMatch(composer, /<Separator orientation="vertical"/);
});

test("图标按钮统一 28×28（size-7）：+ / 安全等级 / DSH 权限 / 快捷消息", () => {
	assert.match(composer, /composer-bar-btn icon size-7 rounded-md/);
	assert.match(security, /composer-bar-btn security size-7 rounded-md/, "pi 安全等级触发按钮");
	assert.match(dshPermission, /composer-bar-btn security dsh size-7 rounded-md/, "DSH 权限触发按钮");
	assert.match(quickMessages, /composer-bar-btn quick-messages icon size-7 rounded-md/, "快捷消息触发按钮");
	// 回归：24px 盒子不再出现（与右区 28px 混排就是「大小不统一」的直接来源）
	assert.doesNotMatch(security, /security size-6/);
	assert.doesNotMatch(dshPermission, /security dsh size-6/);
	assert.doesNotMatch(quickMessages, /quick-messages icon size-6/);
	assert.doesNotMatch(composer, /composer-bar-btn icon size-6/);
});

test("字形统一 15px：「+」用 LayoutGrid，其余触发器同为 15px 图标", () => {
	// 用户明确要求「+」换成 layout-grid（四宫格），不是加号
	assert.match(composer, /<LayoutGrid size=\{15\} strokeWidth=\{2\}/);
	assert.doesNotMatch(composer, /<Plus\b/, "「+」图标已替换，不应再有 Plus");
	assert.match(security, /<Icon size=\{15\} strokeWidth=\{2\}/, "安全等级图标 15px");
	assert.match(quickMessages, /<MessageSquareText size=\{15\} strokeWidth=\{2\}/, "快捷消息图标 15px");
	// 右区字形原本 14px，与左区 15px 并排差一档
	assert.doesNotMatch(composer, /<GitBranch size=\{14\}/, "分支图标 15px");
});

test("飞书触发器收敛到 28×28：无横向内边距、与邻居同圆角", () => {
	const trigger = integrations.match(/\.composer-bottom-left \.feishu-link-trigger \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.ok(trigger, "必须能找到飞书触发器规则");
	assert.match(trigger, /width: var\(--control-height-sm\)/, "28px 宽，不再靠 padding 撑成 30px");
	assert.match(trigger, /height: var\(--control-height-sm\)/);
	assert.match(trigger, /padding: 0;/, "横向内边距收掉，否则 28px 盒子会变宽");
	assert.match(trigger, /justify-content: center/);
	assert.match(trigger, /border-radius: var\(--radius-md\)/, "圆角对齐 composer-bar-btn 的 rounded-md");
	assert.doesNotMatch(trigger, /padding: 0 8px/);
});
