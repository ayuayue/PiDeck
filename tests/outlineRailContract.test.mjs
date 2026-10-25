import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 会话定位轴的源码契约（2026-10 重构后）。
 *
 * 这里只钉「接错线就会静默变形」的几条：给 beUI 官方组件的分叉点、预览卡的触发条件、
 * 滚轮转发、以及已经删掉的滚动子系统不许长回来。纯计算部分见 outlineRailTicks.test.mjs，
 * 定位/显隐的 CSS 契约见 outlineDrawerOffset.test.mjs。
 *
 * 为什么要源码断言：`preview-rail.tsx` 是 `npx shadcn add @beui/preview-rail --overwrite`
 * 的目标，被覆盖后这些行为会**静默消失**（类型检查抓不到），本文件是那次覆盖的报警器。
 */

const railSource = readFileSync("src/renderer/src/components/motion/preview-rail.tsx", "utf8");
const outlineSource = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");

test("预览卡只跟「真正指向的那一项」，不跟高亮项（否则不悬停也常显卡片）", () => {
	// highlightedId 含「当前活动刻度」（highlightActive 时为 selectedId），只该驱动刻度缩放；
	// 卡片必须挂 displayedId（hoveredId ?? pinnedId ?? focusedId）
	assert.match(railSource, /const\s+displayedId\s*=\s*hoveredId\s*\?\?\s*pinnedId\s*\?\?\s*focusedId/);
	assert.match(railSource, /const\s+previewIndex\s*=\s*displayedId\s*\?\s*items\.findIndex\([\s\S]*?displayedId[\s\S]*?\)\s*:\s*-1/);
	assert.match(railSource, /const\s+previewItem\s*=\s*previewIndex\s*>=\s*0\s*\?\s*items\[previewIndex\]\s*:\s*undefined/);
	assert.match(railSource, /showPreview\s*&&\s*previewItem\s*\?/);
	// 反例：卡片门控不能建立在 highlightedId 派生的 index 上
	assert.doesNotMatch(railSource, /showPreview\s*&&\s*displayedItem/);
});

test("预览卡位置是纯计算（不再量 DOM、不写 style.top）", () => {
	assert.match(railSource, /function\s+resolveCardTop\(/);
	assert.match(railSource, /resolveCardTop\(previewIndex,\s*itemSize,\s*items\.length\)/);
	// 命令式定位已删除：卡片位置不该再靠 ref 量高度
	assert.doesNotMatch(railSource, /cardRef/);
	assert.doesNotMatch(railSource, /placeCard/);
	assert.doesNotMatch(railSource, /style\.top\s*=/);
});

test("官方版渲染的 N 个占位格子不再存在（只渲染一张卡）", () => {
	// 官方为对齐卡片会 map 出 items.length 个占位 div；PiDeck 改成单张绝对定位
	assert.doesNotMatch(railSource, /items\.map\(\(item\)\s*=>\s*\(\s*<div\s+key=\{item\.id\}\s+style=/);
});

test("未加载刻度淡一档，且由 pending 映射而来", () => {
	assert.match(railSource, /muted\?:/);
	assert.match(railSource, /item\.muted\s*&&\s*"opacity-60"/);
	assert.match(outlineSource, /muted:\s*item\.pending\s*===\s*true/);
});

test("滚轮在刻度上转发给时间线（导轨是滚动视口的兄弟节点）", () => {
	// 必须非 passive：React 的 onWheel 是 passive，preventDefault 会被忽略
	assert.match(outlineSource, /addEventListener\(\s*"wheel"\s*,\s*onWheel\s*,\s*\{\s*passive:\s*false\s*\}\s*\)/);
	assert.match(outlineSource, /forward\(event\.deltaY\)/);
});

test("窗口按源下标截取后再规划间距（顺序反了会永远只显示最新一批）", () => {
	assert.match(outlineSource, /windowRailItems\(\s*props\.items\s*,\s*activeSourceIndex\s*\)/);
	assert.match(outlineSource, /planRailTicks\(\s*visibleItems\s*,/);
	assert.match(outlineSource, /outlineItemIndex\.get\(railActiveId\)/);
});

test("已删除的滚动子系统不许长回来（上限 30 条之后它只在极端窄高下才可能触发）", () => {
	assert.doesNotMatch(railSource, /railMaxHeight/);
	assert.doesNotMatch(railSource, /onWheelFallback/);
	assert.doesNotMatch(railSource, /maskImage|scrollerMask|scrollTopRef|FOLLOW_SAFE_BAND_PX/);
	assert.doesNotMatch(outlineSource, /railMaxHeight=/);
});

test("beUI 分叉点在文件头有清单（--overwrite 后照单重施）", () => {
	assert.match(railSource, /beui\.dev\/components\/motion\/preview-rail/);
	for (const keyword of ["muted", "预览卡只渲染一张", "resolveCardTop", "140ms"]) {
		assert.match(railSource, new RegExp(keyword), `头注释缺 ${keyword}`);
	}
});
