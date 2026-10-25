import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const marker = readFileSync("src/renderer/src/components/session/TimelineMarker.tsx", "utf8");
const toolCard = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
const events = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");

test("TimelineMarker keeps event kinds and tones explicit", () => {
	// compaction 已随「压缩摘要卡片下线」从 kind 联合中移除（压缩进行态由 RespondingIndicator 承担）
	assert.match(marker, /TimelineMarkerKind = "thinking" \| "tool" \| "diagnostic"/);
	assert.match(marker, /TimelineMarkerTone = "neutral" \| "active" \| "success" \| "warning" \| "error"/);
	assert.match(marker, /data-marker-kind=\{props\.kind\}/);
	assert.match(marker, /data-marker-tone=\{tone\}/);
	assert.match(marker, /bg-border-subtle/);
});

test("tool cards map execution status to marker tone without changing detail behavior", () => {
	assert.match(toolCard, /kind="tool"/);
	assert.match(toolCard, /tone=\{tone === "error" \? "error" : tone === "running" \? "active" : "success"\}/);
	assert.match(toolCard, /aria-expanded=\{expanded\}/);
	assert.match(toolCard, /getToolDetailText/);
	assert.match(toolCard, /tool-card-copy/);
});

test("thinking and diagnostic cards use the same marker shell (ask/compaction cards retired)", () => {
	for (const kind of ["thinking", "diagnostic"]) {
		assert.match(events, new RegExp(`kind=\\"${kind}\\"`));
	}
	// 压缩摘要卡片按产品决策下线（与 dsh 后端行为对齐）：压缩进行态由 RespondingIndicator
	// 「正在压缩」承担，compaction system 消息在 SessionMessageTimeline 里直接不渲染。
	// 此断言固化下线事实，防止卡片悄悄回来而没有走同一次评审。
	assert.doesNotMatch(events, /kind=\\"compaction\\"/);
	// ask_question 交互已收敛到 SessionRuntimeUiOverlay，AskQuestionCard 死代码删除：
	// 时间线不再有 kind=\\"ask\\" 的卡片（与 askUiStateMachine 测试注释同一语义）。
	assert.doesNotMatch(events, /kind=\\"ask\\"/);
	assert.match(events, /setExpanded\(\((\w+)\) => !\1\)/);
	// 旧断言 setExpanded(!expanded) 对应已废弃写法（函数式更新等价且更稳），不再断言实现细节
	assert.match(events, /data-message-id=\{props\.message\.id\}/);
});

test("thinking and tool process rows hide the left dot rail by default", () => {
	// Codex/Cursor：过程行身份在行内图标，左侧圆点+贯穿竖线是重复装饰。
	assert.match(marker, /function shouldHideRail/);
	assert.match(marker, /return kind === "thinking" \|\| kind === "tool"/);
	assert.match(marker, /const hideRail = shouldHideRail\(props\.kind, props\.hideRail\)/);
	const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
	assert.doesNotMatch(css, /\.execution-summary-details::before/);
	assert.doesNotMatch(css, /padding-left:\s*26px/);
	assert.doesNotMatch(css, /margin-left:\s*26px/);
});

// Chain of Thought 步骤节点升级：完成/失败不再是同色圆点，轨道节点直接承载
// 状态语义（✓/✗），扫一眼即可定位失败步骤。
test("marker rail nodes carry status icons for success and error tones", () => {
	// success → Check、error → X；active/neutral/warning 保持圆点（无图标映射）
	assert.match(marker, /success: <Check size=\{9\}/);
	assert.match(marker, /error: <X size=\{9\}/);
	assert.doesNotMatch(marker, /active: </);
	// 图标必须显式白色 stroke：tone 类把 color 设为底色，lucide 默认 currentColor
	// 会导致图标与底色同色不可见
	assert.match(marker, /strokeWidth=\{3\.5\} color="#fff"/);
	// ✓/✗ 节点放大为 14px 并微调基线
	assert.match(marker, /statusIcon && "mt-1 size-3\.5"/);
});

// 思考/工具默认无轨，即便显式开轨也不放大 ✓/✗；诊断等其他事件仍保留语义节点。
test("tool marker nodes skip the enlarged status icon", () => {
	assert.match(marker, /if \(kind === "tool" \|\| kind === "thinking"\) return undefined/);
	assert.match(marker, /kind: TimelineMarkerKind,/);
	assert.match(marker, /const statusIcon = hideRail \? undefined : getStatusIcon\(props\.kind, tone\);/);
	assert.match(marker, /\{statusIcon\}/);
});
