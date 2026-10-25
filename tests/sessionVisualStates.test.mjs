import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineStyles = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const events = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");

test("responding indicator reserves stable space across status changes", () => {
	assert.match(events, /data-kind=\{kind\}/);
	// 容器改为无框融入消息流：不得有 border/背景/固定宽度
	assert.doesNotMatch(timelineStyles, /\.responding-indicator\{[\s\S]*?border:/);
	assert.doesNotMatch(timelineStyles, /\.responding-indicator\{[\s\S]*?background:/);
	// 容器内部改为 beUI ReasoningText（自带最长短语占位防宽度跳动）
	assert.match(events, /ReasoningText/);
});

test("starting state has a distinct indicator before response states", () => {
	assert.match(events, /isStarting\?: boolean/);
	assert.match(events, /deriveRespondingKind/);
	assert.match(timelineStyles, /data-kind="starting"/);
	// 状态色仍区分（作用于前置指示器 currentColor）
	assert.match(timelineStyles, /\[data-kind="starting"\][\s\S]*color: var\(--color-warning/);
});
test("reduced motion keeps response state readable without animation", () => {
	assert.match(timelineStyles, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(timelineStyles, /animation:\s*none !important/);
	assert.match(timelineStyles, /transition:\s*none !important/);
	// 动画降级由 beUI ReasoningText 内部 useReducedMotion 处理（官方组件自带）
	const reasoning = readFileSync("src/renderer/src/components/agents/loading-states/reasoning-text.tsx", "utf8");
	assert.match(reasoning, /useReducedMotion/);
	assert.match(reasoning, /reduce/);
});

test("empty state exposes whether a project can be created", () => {
	assert.match(surface, /data-empty-state=\{props\.hasProject \? "project" : "no-project"\}/);
	assert.match(surface, /app\.emptyProjectTitleLead/);
	assert.match(surface, /app\.emptyNoProject/);
	assert.doesNotMatch(surface, /empty-state-cta/);
});
